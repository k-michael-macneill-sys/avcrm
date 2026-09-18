import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { acceptBytes, authorizeRead, issueTarget, readStream } from '../services/uploads';
import { UPLOAD_PURPOSES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { unauthorized } from '../utils/errors';
import { parse } from '../utils/validate';

export const uploadsRouter = Router();

const issueSchema = z.object({
  purpose: z.enum(UPLOAD_PURPOSES),
  content_type: z.string().trim().min(3).max(100),
  file_name: z.string().trim().min(1).max(255).nullable().default(null),
});

/** Step one: ask where to put a file. */
uploadsRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = parse(issueSchema, req.body);
    if (!req.user) throw unauthorized();

    res.status(201).json({ data: await issueTarget(body, req.user) });
  }),
);

/**
 * Step two: send them.
 *
 * Deliberately outside requireAuth — the signed token in the path is the
 * permission, which is what makes this swappable for a bucket's presigned
 * URL. There is no body parser on this route either, so `req` is still the
 * raw stream and a 12MB photo never lands in memory.
 */
uploadsRouter.put(
  '/:token',
  asyncHandler(async (req, res) => {
    const stored = await acceptBytes(
      req.params.token ?? '',
      req.header('content-type'),
      req.header('content-length'),
      req,
    );

    res.status(201).json({
      data: {
        key: stored.key,
        byte_size: stored.byte_size,
        content_type: stored.content_type,
      },
    });
  }),
);

/** Reading one back, authorized by what the file is and who is asking. */
export const filesRouter = Router();

filesRouter.use(requireAuth);

filesRouter.get(
  '/*',
  asyncHandler(async (req, res) => {
    const key = (req.params as Record<string, string>)[0] ?? '';
    if (!req.user) throw unauthorized();

    const upload = await authorizeRead(key, req.user);

    res.setHeader('Content-Type', upload.content_type);
    // Never let a shared cache hold someone's signature.
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (upload.byte_size) res.setHeader('Content-Length', String(upload.byte_size));

    const stream = readStream(key);
    stream.on('error', () => {
      // The row says stored but the bytes are gone: a real 404, and worth
      // knowing about.
      if (!res.headersSent) res.status(404).json({
        error: { code: 'not_found', message: 'That file is no longer in storage' },
      });
    });
    stream.pipe(res);
  }),
);
