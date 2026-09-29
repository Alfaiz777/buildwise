import express, { Router } from 'express';
import { RETAIL_FILE_MAX_BYTES } from '../application/retailImportService.js';
import { getBrandPrincipal } from '../auth/authorize.js';
import { Errors } from '../lib/errors.js';
import type { LocalUploadReceiver } from '../ports/fileStorage.js';

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * PUT /api/local-files/uploads/:uploadId: the LocalFileStorageProvider upload target
 * (docs/06_INTEGRATION_CONTRACTS.md §6a). Local profile only (mounted only when the
 * composition root wires a LocalUploadReceiver), authenticated, BRAND scope, 10 MB max.
 * An upload for another brand is indistinguishable from an unknown upload (404).
 */
export function localFilesRouter(receiver: LocalUploadReceiver): Router {
  const router = Router();
  router.put(
    '/uploads/:uploadId',
    express.raw({ type: () => true, limit: RETAIL_FILE_MAX_BYTES }),
    async (req, res) => {
      const principal = getBrandPrincipal(res);
      const uploadId = req.params.uploadId;
      const pending =
        typeof uploadId === 'string' && UPLOAD_ID.test(uploadId) ? receiver.describeUpload(uploadId) : null;
      if (!pending || !pending.key.startsWith(`retail-imports/${principal.brandId}/`)) throw Errors.notFound();

      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.length === 0) throw Errors.invalidRequest('The uploaded file is empty.');
      if (body.length > pending.maxBytes)
        throw Errors.unprocessable('FILE_TOO_LARGE', 'The file is larger than 10 MB.');
      await receiver.acceptUpload(uploadId!, body);
      res.json({ upload_id: uploadId, size_bytes: body.length });
    },
  );
  return router;
}
