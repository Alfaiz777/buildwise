import { useState, type FormEvent } from 'react';
import { useApi } from '../../api/apiContext';
import { errorMessage, Section } from '../../components/ConsoleShell';
import { label } from '../../lib/labels';
import { formatDateTime, type RetailImport, type RetailImportReport } from './types';

const MAX_ERRORS_SHOWN = 50;

interface CreatedImport {
  import: RetailImport;
  upload: { method: 'PUT'; url: string; headers: Record<string, string>; expires_at: string };
}

/**
 * Retail CSV import (docs/06_INTEGRATION_CONTRACTS.md §6a): create the import → PUT the
 * file to its upload target → process → show the report with row errors.
 */
export function RetailImportSection(props: {
  imports: RetailImport[] | null;
  error: string | null;
  onImported: () => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [report, setReport] = useState<RetailImportReport | null>(null);
  const [file, setFile] = useState<File | null>(null);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!file || file.size === 0) return setFailure('Choose a CSV file first.');
    setBusy(true);
    setFailure(null);
    try {
      const created = await api.post<CreatedImport>('/api/brand/retail-imports', { file_name: file.name });
      await api.upload(created.upload.url, file, created.upload.headers['Content-Type'] ?? 'text/csv');
      setReport(
        await api.post<RetailImportReport>(`/api/brand/retail-imports/${created.import.import_id}/process`, {}),
      );
      form.reset();
      setFile(null);
      props.onImported();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function open(importId: string) {
    setFailure(null);
    try {
      setReport(await api.get<RetailImportReport>(`/api/brand/retail-imports/${importId}`));
    } catch (err) {
      setFailure(errorMessage(err));
    }
  }

  return (
    <Section title="Retail import" id="retail-import">
      <p className="muted small">
        Upload a CSV in the canonical retail format (one row per store × SKU, up to 10 MB). Stores are created or
        updated, stock is replaced per store and SKU, and every rejected row is listed below.
      </p>
      <p className="small">
        <a href="/samples/retail-stock-sample.csv" download="retail-stock-sample.csv">
          Download sample CSV
        </a>{' '}
        <span className="muted">— the canonical columns, with synthetic Mumbai and Pune stores.</span>
      </p>
      <form className="inline" onSubmit={upload}>
        <input
          name="file"
          type="file"
          accept=".csv,text/csv"
          aria-label="Retail CSV file"
          required
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Importing…' : 'Upload and import'}
        </button>
      </form>
      {failure && (
        <p role="alert" className="error">
          {failure}
        </p>
      )}

      {report && (
        <div className="report" aria-label="Import report">
          <h3>
            Report: {report.file_name} <span className="badge">{label(report.status)}</span>
          </h3>
          {report.failure_code && <p className="error">File rejected: {report.failure_code}</p>}
          <p className="small">
            {report.rows_valid} of {report.rows_processed} rows imported · {report.rows_invalid} rows rejected ·{' '}
            {report.mappings_created} SKUs mapped · {report.mappings_failed} SKUs not mapped
          </p>
          {report.row_errors.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Store</th>
                  <th>SKU</th>
                  <th>Error</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {report.row_errors.slice(0, MAX_ERRORS_SHOWN).map((e, i) => (
                  <tr key={`${e.line}-${i}`}>
                    <td>{e.line}</td>
                    <td className="mono">{e.store_id ?? '—'}</td>
                    <td className="mono">{e.sku ?? '—'}</td>
                    <td className="mono small">{e.code}</td>
                    <td className="small">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {report.row_errors.length > MAX_ERRORS_SHOWN && (
            <p className="muted small">
              Showing the first {MAX_ERRORS_SHOWN} of {report.row_errors.length} row errors.
            </p>
          )}
        </div>
      )}

      <h3>Import history</h3>
      {props.error && <p className="error">{props.error}</p>}
      {props.imports?.length === 0 ? (
        <p className="muted">No imports yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Status</th>
              <th>Rows imported</th>
              <th>Rejected</th>
              <th>Completed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.imports?.map((i) => (
              <tr key={i.import_id}>
                <td>{i.file_name}</td>
                <td>{label(i.status)}</td>
                <td>
                  {i.rows_valid} / {i.rows_processed}
                </td>
                <td>{i.rows_invalid}</td>
                <td className="small">{formatDateTime(i.completed_at)}</td>
                <td>
                  <button type="button" className="secondary" onClick={() => void open(i.import_id)}>
                    View report
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
