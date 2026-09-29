import type { Readable } from 'node:stream';
import { decideStoreAssignment } from '../domain/retailOwnership.js';
import { validateRetailRows, type RowError, type StockRow } from '../domain/retailRows.js';
import { matchRetailSku, type MappingDecision } from '../domain/skuMapping.js';
import { deriveAvailabilityStatus } from '../domain/storeTruth.js';
import { Errors } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { FileStorageProvider, UploadTarget } from '../ports/fileStorage.js';
import type {
  AuditRepository,
  InventoryRepository,
  InventoryUpsert,
  MappingRecord,
  MappingRepository,
  ProductRepository,
  RetailerRepository,
  RetailImportCounts,
  RetailImportRecord,
  RetailImportRepository,
  StoreRepository,
} from '../ports/repositories.js';
import { RetailFileFormatError, type RetailFileParser } from '../ports/retailFile.js';

/** docs/06_INTEGRATION_CONTRACTS.md §12: 10 MB per file, enforced at upload and re-checked on read. */
export const RETAIL_FILE_MAX_BYTES = 10 * 1024 * 1024;

export interface RetailImportDeps {
  files: FileStorageProvider;
  parser: RetailFileParser;
  imports: RetailImportRepository;
  stores: StoreRepository;
  retailers: RetailerRepository;
  products: ProductRepository;
  mappings: MappingRepository;
  inventory: InventoryRepository;
  audit: AuditRepository;
}

export interface ImportActor {
  type: 'USER' | 'SYSTEM';
  id: string;
}

export interface RetailImportReport {
  record: RetailImportRecord;
  rowErrors: RowError[];
}

class FileTooLarge extends Error {}

async function readAll(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > maxBytes) {
      stream.destroy();
      throw new FileTooLarge();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

const SKU_ERROR: Record<
  Exclude<MappingDecision['status'], 'AUTO_MATCHED'>,
  { code: RowError['code']; message: string }
> = {
  UNMAPPED: { code: 'UNKNOWN_SKU', message: 'This SKU matches no product in the synced catalogue.' },
  CONFLICT: {
    code: 'SKU_CONFLICT',
    message: 'This SKU matches more than one catalogue product; fix the catalogue or file.',
  },
  MANUAL_MATCH_REQUIRED: {
    code: 'SKU_NEEDS_REVIEW',
    message: 'This SKU only nearly matches a catalogue SKU; it was not matched automatically.',
  },
};

/**
 * Retail CSV ingestion (docs/04_DATA_MODEL.md §9–§10.1, docs/06_INTEGRATION_CONTRACTS.md §4, §6a, §12):
 *   create (upload target) → browser upload → process: validate → normalize → SKU mapping → Firestore.
 * An import is an upsert: stores and SKUs absent from the file are left untouched.
 * Ingestion never sets a store's Retail Admin, and never moves a store between retailers.
 */
export class RetailImportService {
  constructor(private readonly deps: RetailImportDeps) {}

  async create(
    brandId: string,
    actor: ImportActor,
    fileName: string,
  ): Promise<{ record: RetailImportRecord; upload: UploadTarget }> {
    const importId = newId('imp');
    const fileKey = `retail-imports/${brandId}/${importId}.csv`;
    const upload = await this.deps.files.createUploadTarget(fileKey, 'text/csv', RETAIL_FILE_MAX_BYTES);
    const record: RetailImportRecord = {
      importId,
      brandId,
      fileKey,
      fileName,
      uploadedBy: actor.id,
      status: 'UPLOADED',
      failureCode: null,
      rowErrorsReference: null,
      rowsProcessed: 0,
      rowsValid: 0,
      rowsInvalid: 0,
      mappingsCreated: 0,
      mappingsFailed: 0,
      createdAt: null,
      completedAt: null,
    };
    await this.deps.imports.create(record);
    await this.audit(brandId, actor, 'RETAIL_IMPORT_CREATED', importId);
    return { record: (await this.deps.imports.get(brandId, importId)) ?? record, upload };
  }

  async process(brandId: string, actor: ImportActor, importId: string): Promise<RetailImportReport> {
    const record = await this.deps.imports.get(brandId, importId);
    if (!record) throw Errors.notFound();

    let content: Buffer;
    try {
      content = await readAll(await this.deps.files.openRead(record.fileKey), RETAIL_FILE_MAX_BYTES);
    } catch (err) {
      if (err instanceof FileTooLarge) return this.fail(brandId, actor, importId, 'FILE_TOO_LARGE');
      throw Errors.conflict('FILE_NOT_UPLOADED', 'Upload the file before processing this import.');
    }
    if (!(await this.deps.imports.claimForProcessing(brandId, importId))) {
      throw Errors.conflict('IMPORT_ALREADY_PROCESSED', 'This import has already been processed.');
    }

    try {
      return await this.run(brandId, actor, importId, content);
    } catch (err) {
      await this.deps.imports.finish(brandId, importId, {
        ...ZERO,
        status: 'FAILED',
        failureCode: 'PROCESSING_FAILED',
        rowErrorsReference: null,
      });
      throw err;
    }
  }

  private async run(brandId: string, actor: ImportActor, importId: string, content: Buffer) {
    let parsed;
    try {
      parsed = this.deps.parser.parse(content);
    } catch (err) {
      if (err instanceof RetailFileFormatError) return this.fail(brandId, actor, importId, 'INVALID_CSV');
      throw err;
    }
    const validated = validateRetailRows(parsed.header, parsed.rows);
    if (!validated.ok) return this.fail(brandId, actor, importId, 'MISSING_COLUMNS', validated.missingColumns);

    const errors = [...validated.errors];
    const rowError = (row: StockRow, code: RowError['code'], message: string) =>
      errors.push({ line: row.line, storeId: row.storeId, sku: row.sku, code, field: null, message });

    // 1. Ownership: retailer_id must exist in this brand; a store owned by another
    //    retailer is a conflict (domain/retailOwnership.ts), never moved.
    const retailerIds = new Set((await this.deps.retailers.list(brandId)).map((r) => r.retailerId));
    const existingStores = new Map((await this.deps.stores.list(brandId)).map((s) => [s.storeId, s]));
    const rejectedStores = new Map<string, { code: RowError['code']; message: string }>();
    for (const store of validated.stores.values()) {
      if (!store.retailerId) continue;
      if (!retailerIds.has(store.retailerId)) {
        rejectedStores.set(store.storeId, {
          code: 'UNKNOWN_RETAILER',
          message: 'retailer_id is not a retailer of this brand.',
        });
        continue;
      }
      const existing = existingStores.get(store.storeId);
      const decision = decideStoreAssignment({
        store: existing
          ? { storeId: store.storeId, retailerId: existing.retailerId, retailAdminUserId: existing.retailAdminUserId }
          : { storeId: store.storeId, retailerId: null, retailAdminUserId: null },
        target: { retailerId: store.retailerId },
      });
      if (!decision.ok) {
        rejectedStores.set(store.storeId, {
          code: 'RETAILER_CONFLICT',
          message: 'This store already belongs to another retailer; it was not moved.',
        });
      }
    }

    // 2. SKU mapping, once per distinct retail SKU of the remaining rows.
    const catalog = (await this.deps.products.listVariants(brandId)).map((v) => ({
      variantId: v.variantId,
      canonicalSku: v.canonicalSku,
      barcode: v.barcode,
    }));
    const stockRows = validated.stockRows.filter((row) => {
      const rejected = rejectedStores.get(row.storeId);
      if (rejected) rowError(row, rejected.code, rejected.message);
      return !rejected;
    });
    const decisions = new Map<string, MappingDecision>();
    for (const row of stockRows) if (!decisions.has(row.sku)) decisions.set(row.sku, matchRetailSku(row.sku, catalog));

    const inventory: InventoryUpsert[] = [];
    for (const row of stockRows) {
      const d = decisions.get(row.sku)!;
      if (d.status !== 'AUTO_MATCHED') {
        const e = SKU_ERROR[d.status];
        rowError(row, e.code, e.message);
        continue;
      }
      inventory.push({
        storeId: row.storeId,
        sku: row.sku,
        canonicalSku: d.canonicalSku!,
        variantId: d.variantId!,
        quantity: row.quantity,
        offlinePrice: row.offlinePrice,
      });
    }

    // 3. Persist: stores (never retailer / admin fields), ownership, mappings, stock.
    const storesToWrite = [...validated.stores.values()].filter((s) => !rejectedStores.has(s.storeId));
    await this.deps.stores.upsertFromImport(
      brandId,
      storesToWrite.map(({ retailerId: _retailerId, ...fields }) => fields),
    );
    for (const store of storesToWrite) {
      if (store.retailerId)
        await this.deps.stores.assignRetailer(brandId, store.storeId, store.retailerId, decideStoreAssignment);
    }
    const mappings: MappingRecord[] = [...decisions].map(([sku, d]) => ({
      mappingId: `rf_${sku}`,
      brandId,
      sourceSystem: 'RETAIL_FILE',
      sourceIdentifier: sku,
      canonicalSku: d.canonicalSku,
      variantId: d.variantId,
      mappingStatus: d.status,
      mappingReason: d.reason,
      updatedAt: null,
    }));
    await this.deps.mappings.upsertMany(brandId, mappings);
    await this.deps.inventory.upsertStock(brandId, inventory, deriveAvailabilityStatus);

    // 4. Report.
    errors.sort((a, b) => a.line - b.line);
    const invalidLines = new Set(errors.map((e) => e.line)).size;
    const counts: RetailImportCounts = {
      rowsProcessed: parsed.rows.length,
      rowsValid: parsed.rows.length - invalidLines,
      rowsInvalid: invalidLines,
      mappingsCreated: mappings.filter((m) => m.mappingStatus === 'AUTO_MATCHED').length,
      mappingsFailed: mappings.filter((m) => m.mappingStatus !== 'AUTO_MATCHED').length,
    };
    const rowErrorsReference = await this.writeRowErrors(brandId, importId, errors);
    await this.deps.imports.finish(brandId, importId, {
      ...counts,
      status: 'COMPLETED',
      failureCode: null,
      rowErrorsReference,
    });
    await this.audit(brandId, actor, 'RETAIL_IMPORT_PROCESSED', importId);
    return { record: (await this.deps.imports.get(brandId, importId))!, rowErrors: errors };
  }

  list(brandId: string): Promise<RetailImportRecord[]> {
    return this.deps.imports.list(brandId, 20);
  }

  async get(brandId: string, importId: string): Promise<RetailImportReport> {
    const record = await this.deps.imports.get(brandId, importId);
    if (!record) throw Errors.notFound();
    let rowErrors: RowError[] = [];
    if (record.rowErrorsReference) {
      const buf = await readAll(await this.deps.files.openRead(record.rowErrorsReference), RETAIL_FILE_MAX_BYTES * 4);
      rowErrors = (JSON.parse(buf.toString('utf8')) as { errors: RowError[] }).errors;
    }
    return { record, rowErrors };
  }

  private async fail(
    brandId: string,
    actor: ImportActor,
    importId: string,
    failureCode: string,
    missingColumns: string[] = [],
  ): Promise<RetailImportReport> {
    const errors: RowError[] = missingColumns.map((column) => ({
      line: 1,
      storeId: null,
      sku: null,
      code: 'MISSING_VALUE',
      field: column,
      message: `Required column "${column}" is missing.`,
    }));
    const rowErrorsReference = errors.length ? await this.writeRowErrors(brandId, importId, errors) : null;
    await this.deps.imports.finish(brandId, importId, { ...ZERO, status: 'FAILED', failureCode, rowErrorsReference });
    await this.audit(brandId, actor, 'RETAIL_IMPORT_FAILED', importId);
    return { record: (await this.deps.imports.get(brandId, importId))!, rowErrors: errors };
  }

  private async writeRowErrors(brandId: string, importId: string, errors: RowError[]): Promise<string> {
    const key = `retail-imports/${brandId}/${importId}.errors.json`;
    await this.deps.files.write(key, JSON.stringify({ import_id: importId, errors }), 'application/json');
    return key;
  }

  private audit(brandId: string, actor: ImportActor, action: string, importId: string) {
    return this.deps.audit.recordBrandEvent({
      brandId,
      actorType: actor.type,
      actorId: actor.id,
      action,
      targetType: 'RETAIL_IMPORT',
      targetId: importId,
      result: 'SUCCESS',
      reasonCode: null,
    });
  }
}

const ZERO: RetailImportCounts = {
  rowsProcessed: 0,
  rowsValid: 0,
  rowsInvalid: 0,
  mappingsCreated: 0,
  mappingsFailed: 0,
};
