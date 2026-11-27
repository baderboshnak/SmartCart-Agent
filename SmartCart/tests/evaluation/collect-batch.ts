/**
 * Downloads and scores the first replies from the Gemini batch job that the approved campaign
 * already submitted and paid for. It only reads the job (one free status request): it never
 * submits, generates or retries paid work, and it leaves the campaign journal unchanged.
 *
 *   node --preserve-symlinks --preserve-symlinks-main --import tsx tests/evaluation/collect-batch.ts --allow-live
 */
import { readFileSync } from 'node:fs';
import type { GenerateContentResponse } from '@google/genai';
import { loadEnvFileForScripts } from '@/lib/env';
import { textMicros, textUsage } from './approved-budget';
import { prepareFirstTurns } from './approved-first-turns';
import { counts, saveReport } from './report';
import type { EvaluationCase } from './types';

const API_ORIGIN = 'https://generativelanguage.googleapis.com/v1beta/';

interface InlineResponse { response?: GenerateContentResponse; error?: unknown; metadata?: { key?: string } }
interface BatchOperation {
  name?: string;
  done?: boolean;
  metadata?: { state?: string; displayName?: string };
  response?: { inlinedResponses?: InlineResponse[] | { inlinedResponses?: InlineResponse[] } };
  error?: { code?: number; message?: string };
}

async function main() {
  if (!process.argv.includes('--allow-live')) {
    console.error('This reads a job from the Gemini API (free, no generation). Re-run with --allow-live to confirm.');
    process.exitCode = 2;
    return;
  }
  const ledger = JSON.parse(readFileSync('reports/evaluation/approved-live-ledger.json', 'utf8')) as { batch?: { name?: string; ids?: string[] } };
  const name = ledger.batch?.name ?? '';
  const ids = new Set(ledger.batch?.ids ?? []);
  if (!/^batches\/[a-z\d-]{1,180}$/iu.test(name) || !ids.size) throw new Error('The campaign journal has no submitted batch.');
  loadEnvFileForScripts();
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is required.');

  const response = await fetch(API_ORIGIN + name, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(65_000), headers: { 'x-goog-api-key': apiKey }
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`Batch status returned HTTP ${response.status}. ${failure.error?.message?.replaceAll(apiKey, '[redacted]').slice(0, 260) ?? ''}`);
  }
  const job = await response.json() as BatchOperation;
  const state = job.metadata?.state ?? 'unknown';
  console.log(`Batch ${name}: ${state}${job.done ? ' (done)' : ''}.`);
  if (!job.done) {
    console.log('Not finished yet. Nothing was scored; run this again later.');
    return;
  }
  const inline = job.response?.inlinedResponses;
  const rows = Array.isArray(inline) ? inline : inline?.inlinedResponses ?? [];
  const byId = new Map(rows.flatMap(row => row.metadata?.key ? [[row.metadata.key, row] as const] : []));
  if (rows.length && byId.size !== rows.length) throw new Error('Batch replies could not be mapped one-to-one to scenario IDs.');

  const prepared = await prepareFirstTurns();
  const cases: EvaluationCase[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let micros = 0;
  for (const entry of prepared.cases.filter(row => ids.has(row.id))) {
    const returned = byId.get(entry.id);
    if (!returned?.response) {
      cases.push({ id: entry.id, title: entry.title, request: entry.request, category: entry.category, expected: entry.expected,
        status: 'skip', component: 'Gemini batch provider', actual: returned?.error ?? job.error ?? 'No response for this scenario.' });
      continue;
    }
    const usage = textUsage(returned.response);
    if (usage) {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      micros += textMicros(usage.inputTokens, usage.outputTokens, true);
    }
    cases.push(await entry.score(returned.response));
  }

  const summary = counts(cases);
  const files = await saveReport({
    schemaVersion: 1, generatedAt: new Date().toISOString(), runner: 'smartcart-batch-first-replies', externalAiRequests: 1,
    sections: [{
      name: 'Gemini first replies (approved batch, collected)', mode: 'LIVE', cases,
      metrics: { batch: name, state, responses: rows.length, inputTokens, outputTokens, alreadyBilledUsd: Number((micros / 1_000_000).toFixed(4)) },
      notes: [
        'Each reply is the real model answer to the first customer message, scored with production tool schemas and validators on isolated synthetic carts.',
        'Later turns, product matching and final answers are outside this section. The cost was billed when Google ran the batch, at batch rates.'
      ]
    }],
    recommendations: []
  }, 'batch-first-replies');
  console.log(`${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped of ${cases.length}. ` +
    `${inputTokens.toLocaleString('en-US')} input and ${outputTokens.toLocaleString('en-US')} output tokens, $${(micros / 1_000_000).toFixed(4)} already billed.`);
  console.log(files.html);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
