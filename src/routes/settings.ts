import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireCorporate, resolveActor } from '../middleware/auth';
import { recordAudit } from '../services/audit';
import {
  publicView,
  readIntegration,
  saveIntegration,
  SMS_KEY,
} from '../services/integrations';
import { deliverSms } from '../services/sms';
import { SMS_PROVIDERS } from '../services/smsProviders';
import { SendFailure } from '../services/transport';
import { asyncHandler } from '../utils/async';
import { ApiError, unauthorized } from '../utils/errors';
import { parse } from '../utils/validate';

/**
 * The administrator's side of the system: which outside service this company
 * uses, and the credentials for it. Corporate only, because a branch manager
 * changing the SMS account changes it for every branch.
 *
 * Credentials go in and never come back out. A GET says which secret fields
 * have a value stored, not what they are.
 */
export const settingsRouter = Router();

settingsRouter.use(requireAuth, requireCorporate);

/**
 * The catalogue, so the screen renders itself from what the server supports
 * rather than from a copy of this list kept in the client.
 */
settingsRouter.get(
  '/sms/providers',
  asyncHandler(async (_req, res) => {
    res.json({
      data: SMS_PROVIDERS.map((provider) => ({
        id: provider.id,
        label: provider.label,
        help: provider.help,
        fields: provider.fields.map((field) => ({
          name: field.name,
          label: field.label,
          secret: field.secret ?? false,
          required: field.required ?? false,
          placeholder: field.placeholder ?? null,
          help: field.help ?? null,
        })),
      })),
    });
  }),
);

settingsRouter.get(
  '/sms',
  asyncHandler(async (_req, res) => {
    res.json({ data: publicView(await readIntegration(SMS_KEY)) });
  }),
);

const saveSchema = z.object({
  provider: z.string().trim().min(1),
  is_enabled: z.boolean().default(false),
  /** Everything that is safe to read back. */
  settings: z.record(z.string(), z.string().trim()).default({}),
  /**
   * Only what is being changed. A field left out keeps what is stored, which
   * is how the screen can show "saved" where a credential is rather than
   * making an admin retype it to change the sending number.
   */
  secrets: z.record(z.string(), z.string()).default({}),
});

settingsRouter.put(
  '/sms',
  asyncHandler(async (req, res) => {
    const body = parse(saveSchema, req.body);
    if (!req.user) throw unauthorized();

    const before = publicView(await readIntegration(SMS_KEY));
    const saved = await saveIntegration(SMS_KEY, body, req.user.id);

    // Worth auditing: this is the switch that decides whether customers are
    // texted at all, and whose account pays for it. The credential itself is
    // not in `saved`, so it cannot leak into the log.
    await recordAudit(resolveActor(req), {
      action: 'integration.updated',
      entity_type: 'integration_setting',
      entity_id: saved.id,
      before,
      after: saved,
    });

    res.json({ data: saved });
  }),
);

const testSchema = z.object({
  to: z.string().trim().min(5, 'A phone number is needed to send a test to'),
  body: z.string().trim().min(1).max(320).optional(),
});

/**
 * Proves the credentials work before anything real depends on them. Sends
 * through the saved provider whether or not it is switched on — testing
 * before going live is the point.
 */
settingsRouter.post(
  '/sms/test',
  asyncHandler(async (req, res) => {
    const body = parse(testSchema, req.body);

    let result;
    try {
      result = await deliverSms(
        body.to,
        body.body ?? 'Avalanche CRM test message. If you got this, SMS is working.',
        { ignoreEnabled: true },
      );
    } catch (err) {
      // A refused test is the answer the admin asked for, not a server fault.
      // It has to come back readable — "401: authenticate" is what tells them
      // the token is wrong; a 500 and a stack trace tells them nothing.
      if (err instanceof SendFailure) {
        throw new ApiError(
          err.permanent ? 400 : 502,
          'sms_send_failed',
          `The gateway did not accept it — ${err.message}`,
          { permanent: err.permanent, code: err.code ?? null },
        );
      }
      throw err;
    }

    res.json({ data: { sent_to: body.to, provider_message_id: result.provider_message_id } });
  }),
);
