import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ClarificationArgsSchema, EmptyArgsSchema, ExplainArgsSchema, ItemIdsArgsSchema,
  SearchProductsArgsSchema, UpdateCartArgsSchema
} from '@/lib/agent/schemas';
import type { EvaluationCase, EvaluationSection } from './types';

const DEFAULT_TRACE = new URL('../../logs/smartcart.log', import.meta.url);
const ARCHIVED_TURN = /^\S+Z \[smartcart agent [0-9a-f-]+\] (?:(?:WARN|ERROR) )?» turn (\d+): Gemini (?:replied|returned an empty reply) after .+? \+\d+ms(?:: (.*))?$/u;
const TERMINAL_TURN = /^\[smartcart agent [0-9a-f-]+\] \+.* turn \d+: Gemini (?:replied|returned an empty reply) after /u;
const DETAIL_LINE = /^    │ (.*)$/u;
const LOSSY_RECORD = /(?:…\s*\d+ more characters|\[shown above\]|\[redacted\]|<redacted>|details could not be formatted)/iu;

const RecordedTurn = z.strictObject({
  model: z.string().optional(),
  finishReason: z.string().optional(),
  finishMessage: z.string().optional(),
  text: z.string().optional(),
  toolCalls: z.array(z.strictObject({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) })).optional(),
  tokens: z.strictObject({ in: z.number().int().nonnegative(), out: z.number().int().nonnegative(), thinking: z.number().int().nonnegative() })
});

const schemas: ReadonlyMap<string, z.ZodType> = new Map([
  ['getCurrentCart', EmptyArgsSchema], ['updateCart', UpdateCartArgsSchema], ['searchProducts', SearchProductsArgsSchema],
  ['matchProducts', ItemIdsArgsSchema], ['calculatePurchaseOptions', ItemIdsArgsSchema], ['optimizeBasket', EmptyArgsSchema],
  ['compareStores', EmptyArgsSchema], ['explainRecommendation', ExplainArgsSchema], ['requestClarification', ClarificationArgsSchema]
] as [string, z.ZodType][]);

type Recording = { line: number; turn: number; payload: string };

function extractRecordings(content: string): { recordings: Recording[]; terminalPreviews: number } {
  const rows = content.split(/\r?\n/u);
  const recordings: Recording[] = [];
  let terminalPreviews = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (TERMINAL_TURN.test(row)) terminalPreviews++;
    const match = ARCHIVED_TURN.exec(row);
    if (!match) continue;
    const line = index + 1;
    const detail: string[] = [];
    if (match[2] !== undefined) detail.push(match[2]);
    while (DETAIL_LINE.test(rows[index + 1] ?? '')) detail.push(DETAIL_LINE.exec(rows[++index]!)![1]!);
    recordings.push({ line, turn: Number(match[1]), payload: detail.join('\n') });
  }
  return { recordings, terminalPreviews };
}

function parseRecording(payload: string): z.infer<typeof RecordedTurn> | null {
  if (!payload || LOSSY_RECORD.test(payload)) return null;
  try {
    const result = RecordedTurn.safeParse(JSON.parse(payload));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Replay the actual archived function arguments through current production tool schemas. */
export async function runReplay(sources: readonly (string | URL)[] = [DEFAULT_TRACE]): Promise<EvaluationSection> {
  const cases: EvaluationCase[] = [];
  const models = new Map<string, number>();
  let archivedTurns = 0;
  let terminalPreviews = 0;
  let incompleteTurns = 0;
  let textOrEmptyTurns = 0;
  let replayedCalls = 0;
  for (const [sourceIndex, source] of sources.entries()) {
    const name = basename(typeof source === 'string' ? source : fileURLToPath(source));
    let raw: string;
    try {
      raw = await readFile(source, 'utf8');
    } catch (error) {
      cases.push({ id: `replay-source-${sourceIndex}`, title: 'Archived agent trace is unavailable', status: 'skip', actual: { source: name, code: (error as NodeJS.ErrnoException).code ?? 'READ_FAILED' } });
      continue;
    }
    const found = extractRecordings(raw);
    archivedTurns += found.recordings.length;
    terminalPreviews += found.terminalPreviews;
    for (const record of found.recordings) {
      const id = `replay-${sourceIndex + 1}-${record.line}`;
      const receipt = `${name}:${record.line}, recorded turn ${record.turn}`;
      const projection = parseRecording(record.payload);
      if (!projection) {
        incompleteTurns++;
        cases.push({ id, title: 'Incomplete or lossy response record', status: 'skip', category: 'recording-integrity', logs: [receipt], actual: 'Missing, malformed, clipped or redacted projection' });
        continue;
      }
      const model = projection.model && /^[a-z\d.-]{1,100}$/iu.test(projection.model) ? projection.model : 'unknown';
      models.set(model, (models.get(model) ?? 0) + 1);
      if (!projection.toolCalls?.length) {
        textOrEmptyTurns++;
        continue;
      }
      const sha256 = createHash('sha256').update(record.payload).digest('hex');
      for (const [index, call] of projection.toolCalls.entries()) {
        replayedCalls++;
        const schema = schemas.get(call.tool);
        const validation = schema?.safeParse(call.arguments);
        cases.push({
          id: `${id}-${index + 1}`, title: schema ? `Recorded ${call.tool} arguments` : 'Recorded unknown tool call',
          category: 'tool-schema', component: 'agent/schemas', status: validation?.success ? 'pass' : 'fail',
          expected: 'An allowlisted tool call whose recorded arguments pass the current schema',
          actual: {
            model, tokenCounts: projection.tokens, payloadSha256: sha256,
            result: validation?.success ? 'accepted' : validation ? 'rejected arguments' : 'unknown tool',
            ...(validation && !validation.success ? { issues: validation.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })) } : {})
          },
          logs: [receipt]
        });
      }
    }
  }
  cases.push(
    { id: 'replay-matcher', title: 'Raw semantic matcher responses', category: 'matching', status: 'requires-live', actual: 'Local matching traces contain aggregate counts and selected examples. No complete recorded Gemini batch was available for replay.' },
    { id: 'replay-agent-end-to-end', title: 'Agent planning and final answer correctness', category: 'agent', status: 'requires-live', actual: 'Archived turn projections omit signed model parts and historical tool-state snapshots. Held-out model accuracy needs independent labels or a future live run.' },
    { id: 'replay-voice', title: 'Real Gemini Live speech quality and latency', category: 'voice', status: 'requires-live', actual: 'Recorded transcript excerpts and event timings do not include replayable audio and protocol messages.' }
  );
  return {
    name: 'Real response projection replay', mode: 'REPLAY', cases,
    metrics: { archivedTurns, terminalPreviews, incompleteTurns, textOrEmptyTurns, replayedCalls, models: Object.fromEntries(models), externalAiRequests: 0 },
    notes: [
      'Only complete archived Gemini turn projections are eligible. Terminal previews and lossy payloads are excluded without reconstruction.',
      'Recorded tool arguments are replayed through the current allowlist and schemas. This measures schema compatibility, not the model’s accuracy, semantic grounding, final basket correctness or complete model protocol behavior.',
      'The report contains source locations, payload digests and schema issue paths, without customer messages, raw model responses or transcripts.'
    ]
  };
}
