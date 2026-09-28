import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CommerceEvent } from '../../domain/events.js';
import type { EventSink } from '../../ports/events.js';

/**
 * Local-profile analytics export: append-only JSON Lines, one file per UTC day,
 * under `<dataDir>/events`. The BigQuery equivalent arrives in phase G2.
 */
export class LocalEventSink implements EventSink {
  readonly name = 'LOCAL' as const;
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = resolve(dataDir, 'events');
  }

  fileFor(timestamp: string): string {
    return join(this.dir, `events-${timestamp.slice(0, 10)}.jsonl`);
  }

  async emit(events: CommerceEvent[]): Promise<void> {
    if (events.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    const byFile = new Map<string, string[]>();
    for (const event of events) {
      const file = this.fileFor(event.timestamp);
      byFile.set(file, [...(byFile.get(file) ?? []), JSON.stringify(event)]);
    }
    for (const [file, lines] of byFile) {
      await appendFile(file, `${lines.join('\n')}\n`, 'utf8');
    }
  }
}
