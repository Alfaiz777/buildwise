/**
 * RetailFileParser port (docs/06_INTEGRATION_CONTRACTS.md §4): turns an uploaded retail
 * file into header + raw rows. Format only — every validation and business rule lives in
 * domain/retailRows.ts and application/retailImportService.ts, identical in every profile.
 * The prototype accepts CSV only (docs/00 §11.8 Change 10).
 */

export interface RawRetailRow {
  /** 1-based line number in the file (the header is line 1). */
  line: number;
  /** Cell values keyed by trimmed header name; missing cells are ''. */
  values: Record<string, string>;
}

export interface ParsedRetailFile {
  header: string[];
  rows: RawRetailRow[];
}

export class RetailFileFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetailFileFormatError';
  }
}

export interface RetailFileParser {
  /** Throws RetailFileFormatError when the file is not parseable at all. */
  parse(content: Buffer): ParsedRetailFile;
}
