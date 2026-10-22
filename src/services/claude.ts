import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { config } from '../config';
import { ApiError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Claude, as the bookkeeping uses it: one document in, one JSON answer out,
 * checked against a schema before anything is written.
 *
 * The answer is constrained to the schema on Anthropic's side (structured
 * outputs) and checked again here, because a value that parses is not yet a
 * value the books should hold. Refusals are retried on Anthropic's default
 * fallback model server-side, so a receipt Claude declines to read is rare
 * rather than final.
 */

export type DocumentBlock = Anthropic.Beta.BetaContentBlockParam;

/** Whether an API key is configured. Without one the scanning is off and manual entry carries on. */
export function claudeEnabled(): boolean {
  return config.claude.apiKey !== null;
}

let client: Anthropic | null = null;

function claude(): Anthropic {
  if (!config.claude.apiKey) {
    throw new ApiError(409, 'claude_not_configured', 'Receipt scanning is off: set ANTHROPIC_API_KEY to turn it on.');
  }
  client ??= new Anthropic({ apiKey: config.claude.apiKey, baseURL: config.claude.apiBase, maxRetries: 2 });
  return client;
}

/** A file the bookkeeping reads, as the content block Claude takes it in. */
export function documentBlock(bytes: Buffer, contentType: string): DocumentBlock {
  if (contentType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } };
  }
  if (contentType === 'image/jpeg' || contentType === 'image/png' || contentType === 'image/webp') {
    return { type: 'image', source: { type: 'base64', media_type: contentType, data: bytes.toString('base64') } };
  }
  // A CSV export, or anything else that is text.
  return { type: 'text', text: bytes.toString('utf8') };
}

export interface ExtractRequest<T> {
  /** The standing instructions: what to read and how to decide. */
  system: string;
  /** The document, then any instruction about this one. */
  content: DocumentBlock[];
  /** The answer's shape, as JSON Schema, for structured outputs. */
  schema: Record<string, unknown>;
  /** The same shape, checked here. */
  validate: z.ZodType<T>;
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  /** For the log line, never the content. */
  label: string;
}

export async function extract<T>(request: ExtractRequest<T>): Promise<T> {
  const stream = claude().beta.messages.stream({
    model: config.claude.model,
    max_tokens: request.maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: request.system,
    messages: [{ role: 'user', content: request.content }],
    output_config: { effort: request.effort, format: { type: 'json_schema', schema: request.schema } },
  });

  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new ApiError(502, 'claude_auth', 'Claude turned down the API key. Check ANTHROPIC_API_KEY.');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new ApiError(503, 'claude_busy', 'Claude is busy right now. Try again in a minute.');
    }
    if (err instanceof Anthropic.BadRequestError) {
      logger.warn({ err, label: request.label }, 'Claude refused the request');
      throw new ApiError(422, 'claude_bad_request', 'Claude could not read that file. Try a clearer photo or a PDF.');
    }
    if (err instanceof Anthropic.APIError || err instanceof Anthropic.APIConnectionError) {
      logger.warn({ err, label: request.label }, 'Claude request failed');
      throw new ApiError(502, 'claude_unavailable', 'Could not reach Claude. Try again shortly.');
    }
    throw err;
  }

  logger.info(
    {
      label: request.label,
      model: message.model,
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      stop_reason: message.stop_reason,
    },
    'Claude read a document',
  );

  if (message.stop_reason === 'refusal') {
    throw new ApiError(422, 'claude_refused', 'Claude declined to read that file. Enter it by hand instead.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new ApiError(422, 'claude_too_long', 'That file has more in it than can be read in one go. Split it and try again.');
  }

  const text = message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(502, 'claude_bad_answer', 'Claude’s answer could not be read. Try again.');
  }
  const checked = request.validate.safeParse(parsed);
  if (!checked.success) {
    logger.warn({ label: request.label, issues: checked.error.issues }, 'Claude answer did not match the schema');
    throw new ApiError(502, 'claude_bad_answer', 'Claude’s answer could not be read. Try again.');
  }
  return checked.data;
}
