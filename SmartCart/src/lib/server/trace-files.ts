import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const filenames = { summary: 'smartcart-summary.log', detail: 'smartcart.log' };
type TraceFileKind = keyof typeof filenames;
type TraceFileWriter = (line: string) => void;

function createWriter(directory: string, filename: string): TraceFileWriter {
  const path = join(directory, filename);
  let pending: string[] = [];
  let ready = false;
  let draining = false;
  let disabled = false;

  async function drain(): Promise<void> {
    try {
      if (!ready) {
        await mkdir(directory, { recursive: true });
        ready = true;
      }
      while (pending.length) {
        const batch = pending;
        pending = [];
        await appendFile(path, batch.join(''), { encoding: 'utf8', mode: 0o600 });
      }
    } catch {
      disabled = true;
      pending = [];
      console.warn(`[smartcart] Could not append to logs/${filename}. This file writer is disabled until the server restarts.`);
    } finally {
      draining = false;
    }
  }

  return line => {
    if (disabled) return;
    pending.push(`${line}\n`);
    if (draining) return;
    draining = true;
    void drain();
  };
}

// Separate route bundles and dev reloads share the same per-file append queues.
const globalStore = globalThis as typeof globalThis & {
  __smartcartTraceFileWriters?: Partial<Record<TraceFileKind, TraceFileWriter>>;
};

export function appendTraceLine(kind: TraceFileKind, line: string): void {
  const environment = process.env.NODE_ENV;
  if (environment !== 'development' && environment !== 'production') return;
  const writers = (globalStore.__smartcartTraceFileWriters ??= {});
  const write = (writers[kind] ??= createWriter(join(process.cwd(), 'logs'), filenames[kind]));
  write(line);
}
