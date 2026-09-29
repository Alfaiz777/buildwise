import { Router } from 'express';
import { z } from 'zod';
import type { RetailImportReport, RetailImportService } from '../application/retailImportService.js';
import { getBrandPrincipal } from '../auth/authorize.js';
import type { RowError } from '../domain/retailRows.js';
import { Errors } from '../lib/errors.js';
import { parseInput } from '../lib/validation.js';
import type { RetailImportRecord } from '../ports/repositories.js';

/**
 * /api/brand/retail-imports: brand retail CSV ingestion (docs/06_INTEGRATION_CONTRACTS.md
 * §6a, §12, §14). BRAND_ADMIN only (mounted behind requireScope('BRAND')); audited.
 *   POST /                   → import_id + upload target (the browser PUTs the file there)
 *   POST /:importId/process  → validate → normalize → map → Firestore; returns the report
 *   GET  /, /:importId       → history; report with row errors
 */

const CreateImport = z.object({
  file_name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/\.csv$/i, 'Only .csv files are accepted'),
});

const IMPORT_ID = /^imp_[0-9a-f]{16}$/;

export const importJson = (r: RetailImportRecord) => ({
  import_id: r.importId,
  file_name: r.fileName,
  status: r.status,
  failure_code: r.failureCode,
  uploaded_by: r.uploadedBy,
  rows_processed: r.rowsProcessed,
  rows_valid: r.rowsValid,
  rows_invalid: r.rowsInvalid,
  mappings_created: r.mappingsCreated,
  mappings_failed: r.mappingsFailed,
  created_at: r.createdAt,
  completed_at: r.completedAt,
});

const rowErrorJson = (e: RowError) => ({
  line: e.line,
  store_id: e.storeId,
  sku: e.sku,
  code: e.code,
  field: e.field,
  message: e.message,
});

const reportJson = (r: RetailImportReport) => ({ ...importJson(r.record), row_errors: r.rowErrors.map(rowErrorJson) });

function importIdParam(value: unknown): string {
  if (typeof value !== 'string' || !IMPORT_ID.test(value)) throw Errors.notFound();
  return value;
}

export function retailImportsRouter(imports: RetailImportService): Router {
  const router = Router();
  const actorOf = (userId: string) => ({ type: 'USER' as const, id: userId });

  router.post('/', async (req, res) => {
    const principal = getBrandPrincipal(res);
    const { file_name } = parseInput(CreateImport, req.body);
    const { record, upload } = await imports.create(principal.brandId, actorOf(principal.userId), file_name);
    res.status(201).json({
      import: importJson(record),
      upload: { method: upload.method, url: upload.url, headers: upload.headers, expires_at: upload.expiresAt },
    });
  });

  router.get('/', async (_req, res) => {
    const records = await imports.list(getBrandPrincipal(res).brandId);
    res.json({ imports: records.map(importJson) });
  });

  router.get('/:importId', async (req, res) => {
    const report = await imports.get(getBrandPrincipal(res).brandId, importIdParam(req.params.importId));
    res.json(reportJson(report));
  });

  router.post('/:importId/process', async (req, res) => {
    const principal = getBrandPrincipal(res);
    const report = await imports.process(
      principal.brandId,
      actorOf(principal.userId),
      importIdParam(req.params.importId),
    );
    res.json(reportJson(report));
  });

  return router;
}
