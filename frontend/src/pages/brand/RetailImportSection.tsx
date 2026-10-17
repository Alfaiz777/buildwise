import { Check, FileUp } from 'lucide-react';
import { useState, type DragEvent, type FormEvent } from 'react';
import { useApi } from '../../api/apiContext';
import { errorMessage } from '../../components/ConsoleShell';
import { Badge, Button, Card, StatusPill } from '../../components/ui';
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
  // UI-P3: where the import is — 0 choose a file, 1 uploading, 2 checking the rows, 3 imported.
  const [stage, setStage] = useState(0);
  const [dragging, setDragging] = useState(false);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!file || file.size === 0) return setFailure('Choose a CSV file first.');
    setBusy(true);
    setFailure(null);
    setStage(1);
    try {
      const created = await api.post<CreatedImport>('/api/brand/retail-imports', { file_name: file.name });
      await api.upload(created.upload.url, file, { 'Content-Type': 'text/csv', ...created.upload.headers });
      setStage(2);
      setReport(
        await api.post<RetailImportReport>(`/api/brand/retail-imports/${created.import.import_id}/process`, {}),
      );
      setStage(3);
      form.reset();
      setFile(null);
      props.onImported();
    } catch (err) {
      setFailure(errorMessage(err));
      setStage(0);
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

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      setFile(dropped);
      setStage(0);
    }
  };
  const done = (i: number) => stage === 3 || stage > i + 1;
  const current = (i: number) => stage !== 3 && stage === i + 1;

  return (
    <Card title="Retail import" id="retail-import" description="Your retail partners' stock, from one CSV file.">
      <p className="muted small">
        Upload a CSV in the canonical retail format (one row per store × SKU, up to 10 MB). Stores are created or
        updated, stock is replaced per store and SKU, and every rejected row is listed below.
      </p>
      <p className="small">
        <a href="/samples/retail-stock-sample.csv" download="retail-stock-sample.csv">
          Download sample CSV
        </a>{' '}
        <span className="muted">— the canonical columns, with six synthetic Ahmedabad stores in two areas.</span>
      </p>
      <ol className="nw-steps" aria-label="Import steps">
        {['Upload', 'Check', 'Import'].map((t, i) => (
          <li
            key={t}
            className={`nw-steps__step${done(i) ? ' is-done' : ''}${current(i) ? ' is-current' : ''}`}
            aria-current={current(i) ? 'step' : undefined}
          >
            <span className="nw-steps__dot" aria-hidden="true">
              {done(i) ? <Check size={12} /> : i + 1}
            </span>
            {t}
          </li>
        ))}
      </ol>
      <form className="nw-upload" onSubmit={upload}>
        <label
          className={`nw-drop${dragging ? ' is-dragging' : ''}${file ? ' has-file' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <FileUp size={24} aria-hidden="true" />
          <span>
            {file ? (
              <>
                <strong>{file.name}</strong> · ready to import
              </>
            ) : (
              <>
                <strong>Drop the CSV here</strong> or choose a file
              </>
            )}
          </span>
          <input
            name="file"
            type="file"
            accept=".csv,text/csv"
            aria-label="Retail CSV file"
            required={!file}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setStage(0);
            }}
          />
        </label>
        <Button type="submit" variant="brand" loading={busy}>
          {busy ? 'Importing…' : 'Upload and import'}
        </Button>
      </form>
      {failure && (
        <p role="alert" className="error">
          {failure}
        </p>
      )}

      {report && (
        <div className="report" aria-label="Import report">
          <h3>
            Report: {report.file_name} <StatusPill status={report.status} />
          </h3>
          {report.failure_code && <p className="error">File rejected: {report.failure_code}</p>}
          <p className="small">
            {report.rows_valid} of {report.rows_processed} rows imported · {report.rows_invalid} rows rejected ·{' '}
            {report.mappings_created} SKUs mapped · {report.mappings_failed} SKUs not mapped
          </p>
          <div className="nw-report-tiles" aria-hidden="true">
            <span className="nw-report-tile nw-report-tile--ok">
              <strong>{report.rows_valid}</strong> imported
            </span>
            <span className={`nw-report-tile${report.rows_invalid ? ' nw-report-tile--bad' : ''}`}>
              <strong>{report.rows_invalid}</strong> rejected
            </span>
            <span className="nw-report-tile">
              <strong>{report.mappings_created}</strong> SKUs mapped
            </span>
            <span className={`nw-report-tile${report.mappings_failed ? ' nw-report-tile--bad' : ''}`}>
              <strong>{report.mappings_failed}</strong> not mapped
            </span>
          </div>
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
        <ol className="nw-history" aria-label="Import history">
          {props.imports?.map((i) => {
            const tone = i.status === 'FAILED' ? 'bad' : i.rows_invalid ? 'warn' : 'ok';
            return (
              <li key={i.import_id} className={`nw-history__item nw-history__item--${tone}`}>
                <span className="nw-history__dot" aria-hidden="true" />
                <div className="nw-history__body">
                  <span>
                    <strong>{i.file_name}</strong>{' '}
                    <Badge tone={i.status === 'FAILED' ? 'danger' : i.status === 'COMPLETED' ? 'success' : 'neutral'}>
                      {label(i.status)}
                    </Badge>
                  </span>
                  <span className="small muted">
                    {i.rows_valid} / {i.rows_processed} rows imported · {i.rows_invalid} rejected ·{' '}
                    {formatDateTime(i.completed_at)}
                  </span>
                </div>
                <Button variant="secondary" size="sm" onClick={() => void open(i.import_id)}>
                  View report
                </Button>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
