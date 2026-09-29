import { parse } from 'csv-parse/sync';
import { RetailFileFormatError, type ParsedRetailFile, type RetailFileParser } from '../../ports/retailFile.js';

/**
 * CSV → header + raw rows (UTF-8, optional BOM, CRLF or LF, RFC 4180 quoting).
 * Format only: no validation or business rules (those live in domain/retailRows.ts).
 */
export class CsvRetailFileParser implements RetailFileParser {
  parse(content: Buffer): ParsedRetailFile {
    let records: { record: string[]; info: { lines: number } }[];
    try {
      records = parse(content, {
        bom: true,
        info: true,
        relax_column_count: true,
        skip_empty_lines: true,
      }) as unknown as { record: string[]; info: { lines: number } }[];
    } catch {
      throw new RetailFileFormatError('The file is not a valid CSV file.');
    }
    if (records.length === 0) throw new RetailFileFormatError('The file is empty.');

    const header = records[0]!.record.map((h) => h.trim());
    // `info.lines` is the physical line on which the record ends, so blank lines and
    // quoted multi-line cells never shift the line numbers reported to the user.
    const rows = records.slice(1).map(({ record, info }) => ({
      line: info.lines,
      values: Object.fromEntries(header.map((column, c) => [column, (record[c] ?? '').trim()])),
    }));
    return { header, rows };
  }
}
