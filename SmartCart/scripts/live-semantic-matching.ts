/**
 * Opt-in evaluation of semantic product matching with REAL Gemini calls (this spends Gemini credits).
 *   npm run test:live:matching -- --allow-live [--skip-catalog] [--only <case id,...>] [--matcher <engine matcher module>]
 *
 * Mocked answers cannot show that Gemini understands a request, so this sends the labelled cases in
 * tests/fixtures/semantic-match-cases.ts through the production matcher: the same prompt, Gemini call
 * (GEMINI_MODEL), answer validation and pricing. No database is used and nothing is cached.
 *   1. Labelled requests: each goes to Gemini once, with all of its candidates in one batch.
 *   2. Catalog run: the catalog-sample offers found for "חלב" are matched for a plain milk request in
 *      batches of 25, as the app does, then priced. Condensed or flavored milk must not match, and the
 *      basket must buy plain milk.
 * --matcher loads another engine matcher module (such as the previous version) to compare results.
 * Exit code 1 when any labelled decision or the catalog check fails.
 */
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { optimizeBaskets } from '@engine/smartcart-basket-optimizer.mjs';
import type { CatalogRecord, EngineItem } from '@engine/engine-types.mjs';
import * as currentMatcher from '@engine/smartcart-matcher.mjs';
import type { CallModel, MatchResults, MatchRow } from '@engine/smartcart-matcher.mjs';
import { buildQuantityPriceOptions } from '@engine/smartcart-quantity-price.mjs';
import { createGeminiMatcher } from '@/lib/agent/gemini';
import { getGeminiConfig, loadEnvFileForScripts } from '@/lib/env';
import { matchItemCandidates } from '@/lib/shopping/matching';
import { CATALOG_MILK, caseItem, caseProducts, SEMANTIC_CASES, type Expected, type SemanticCandidate } from '../tests/fixtures/semantic-match-cases';
import { fixtureSearch } from '../tests/helpers/fixtures';
import { parseArgs, runScript, stringFlag } from './lib/cli';

type Outcome = 'MATCH' | 'REJECT' | 'UNCERTAIN';
type Matcher = Pick<typeof currentMatcher, 'matchProducts'>;

/** Run tasks with at most `limit` in flight, keeping their order. */
async function inParallel<T, R>(values: T[], limit: number, task: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await task(values[index]!);
    }
  }));
  return results;
}

function rowsById(results: MatchResults): Map<string, { outcome: Outcome; row: MatchRow }> {
  const rows = new Map<string, { outcome: Outcome; row: MatchRow }>();
  for (const row of results.matches) rows.set(row.product._id, { outcome: 'MATCH', row });
  for (const row of results.rejected) rows.set(row.product._id, { outcome: 'REJECT', row });
  for (const row of results.uncertain) rows.set(row.product._id, { outcome: 'UNCERTAIN', row });
  return rows;
}

const passes = (expected: Expected, actual: Outcome) =>
  expected === 'DEBATABLE' || (expected === 'NOT_MATCH' ? actual !== 'MATCH' : actual === expected);

runScript(async () => {
  const { flags } = parseArgs();
  if (!flags.has('allow-live')) {
    console.error('This script calls the real Gemini API and spends credits. Re-run with --allow-live to confirm.');
    return 2;
  }
  loadEnvFileForScripts();
  const config = getGeminiConfig();
  const matcherPath = stringFlag(flags, 'matcher');
  const external: Matcher | null = matcherPath ? await import(pathToFileURL(resolve(matcherPath)).href) : null;
  const only = stringFlag(flags, 'only')?.split(',').map(id => id.trim()).filter(Boolean);

  const usage = { calls: 0, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, callMs: 0 };
  const gemini = createGeminiMatcher(config, {
    timeoutMs: 60_000,
    onUsage: tokens => {
      usage.promptTokens += tokens.promptTokens;
      usage.outputTokens += tokens.outputTokens;
      usage.thoughtTokens += tokens.thoughtTokens;
    }
  });
  const callModel: CallModel = async args => {
    usage.calls++;
    const started = performance.now();
    try {
      return await gemini(args);
    } finally {
      usage.callMs += performance.now() - started;
    }
  };
  /**
   * The app's matcher by default: one reading of the request, then parallel batches of 25, with
   * nothing cached. With --matcher, that module's batches only (older matchers have no reading).
   */
  const check = async (item: EngineItem, products: CatalogRecord[]): Promise<MatchResults> => {
    if (!external) {
      return (await matchItemCandidates(item, products, { db: null, callModel, model: config.model, batchSize: 25, concurrency: 8 })).results;
    }
    const batches: CatalogRecord[][] = [];
    for (let start = 0; start < products.length; start += 25) batches.push(products.slice(start, start + 25));
    const parts = await inParallel(batches, 8, batch => external.matchProducts({ item, products: batch, batchSize: 25, maxAttempts: 4, callModel }));
    return {
      item, totalCandidates: products.length, requestReadings: [...new Set(parts.flatMap(part => part.requestReadings ?? []))],
      matches: parts.flatMap(part => part.matches), rejected: parts.flatMap(part => part.rejected), uncertain: parts.flatMap(part => part.uncertain)
    };
  };
  console.log(`Model ${config.model}, matcher ${matcherPath ?? `current (${currentMatcher.MATCHER_VERSION}, ${currentMatcher.MATCHER_FINGERPRINT.slice(0, 12)})`}\n`);

  // 1. Labelled requests.
  const cases = SEMANTIC_CASES.filter(entry => !only || only.includes(entry.id));
  const evaluated = await inParallel(cases, 6, async entry => {
    const products = caseProducts(entry);
    const results = await check(caseItem(entry), products);
    const rows = rowsById(results);
    return {
      entry, readings: results.requestReadings ?? [],
      checks: products.map((product, index) => {
        const label: SemanticCandidate = entry.candidates[index]!;
        const found = rows.get(product._id)!;
        return { label, actual: found.outcome, reason: found.row.reason, pass: passes(label.expected, found.outcome) };
      })
    };
  });

  const all = evaluated.flatMap(({ entry, checks }) => checks.map(check => ({ ...check, entry })));
  for (const { entry, readings, checks } of evaluated) {
    const requirements = entry.requirements?.length ? ` + required ${JSON.stringify(entry.requirements)}` : '';
    console.log(`${entry.id} (${entry.language}${entry.unseen ? ', unseen category' : ''}): "${entry.product}"${requirements}`);
    if (readings.length) console.log(`  Gemini read it as: ${readings[0]}`);
    for (const check of checks) {
      const verdict = check.pass ? `✓ ${check.actual}` : `✗ expected ${check.label.expected}, got ${check.actual}`;
      console.log(`  ${verdict.padEnd(32)} ${check.label.name} [${check.label.kind}] — ${check.reason}`);
    }
  }

  const scored = all.filter(check => check.label.expected !== 'DEBATABLE');
  const share = (filter: (check: typeof all[number]) => boolean) => {
    const group = scored.filter(filter);
    return `${group.filter(check => check.pass).length}/${group.length}`;
  };
  const summary = {
    model: config.model,
    matcher: matcherPath ?? currentMatcher.MATCHER_VERSION,
    requests: cases.length,
    decisions: scored.length,
    correct: scored.filter(check => check.pass).length,
    falsePositives: scored.filter(check => check.actual === 'MATCH' && check.label.expected !== 'MATCH').map(check => `${check.entry.id}: ${check.label.name}`),
    falseNegatives: scored.filter(check => check.label.expected === 'MATCH' && check.actual !== 'MATCH').map(check => `${check.entry.id}: ${check.label.name} (${check.actual})`),
    otherMisses: scored.filter(check => !check.pass && check.actual !== 'MATCH' && check.label.expected !== 'MATCH').map(check => `${check.entry.id}: ${check.label.name} (expected ${check.label.expected}, got ${check.actual})`),
    debatableNotScored: all.filter(check => check.label.expected === 'DEBATABLE').map(check => `${check.entry.id}: ${check.label.name} → ${check.actual}`),
    byLanguage: Object.fromEntries((['he', 'en', 'ar'] as const).map(language => [language, share(check => check.entry.language === language)])),
    unseenCategories: share(check => check.entry.unseen === true),
    explicitRequests: share(check => check.label.kind === 'explicit request'),
    genericRequestRejections: share(check => check.label.expected === 'REJECT' && !check.entry.requirements?.length)
  };
  const labelledUsage = { ...usage };

  // 2. Catalog run for a plain milk request.
  let catalog: Record<string, unknown> | null = null;
  let catalogPassed = true;
  if (!flags.has('skip-catalog')) {
    const offers = fixtureSearch(['חלב']);
    const wanted: EngineItem = { product: 'חלב', searchTerms: ['חלב'], requirements: [], preferences: [], quantity: { amount: 0, unit: 'unspecified' }, constraintEvidence: [] };
    const started = performance.now();
    const callsBefore = usage.calls;
    const merged = await check(wanted, offers);
    const wallMs = Math.round(performance.now() - started);
    const label = (name: string) => CATALOG_MILK.notPlain.includes(name) ? 'notPlain'
      : CATALOG_MILK.plain.includes(name) ? 'plain' : CATALOG_MILK.ambiguous.test(name) ? 'ambiguous' : 'other';
    const rows = rowsById(merged);
    const named = (filter: (name: string, outcome: Outcome) => boolean) => offers
      .filter(offer => filter(offer.name, rows.get(offer._id)!.outcome))
      .map(offer => `${offer.name} (${rows.get(offer._id)!.outcome}: ${rows.get(offer._id)!.row.reason})`);
    const options = buildQuantityPriceOptions(merged);
    const basket = optimizeBaskets([options]).recommendedBasket;
    const bought = basket?.items.flatMap(line => line.products.map(product => product.productName)) ?? [];
    const wrongMatches = named((name, outcome) => outcome === 'MATCH' && ['notPlain', 'other'].includes(label(name)));
    catalogPassed = wrongMatches.length === 0 && bought.length > 0 && bought.every(name => label(name) === 'plain');
    catalog = {
      candidates: offers.length,
      geminiCalls: usage.calls - callsBefore,
      wallMs,
      readings: merged.requestReadings,
      matched: merged.matches.length,
      uncertain: merged.uncertain.length,
      rejected: merged.rejected.length,
      plainMilkMatched: `${named((name, outcome) => outcome === 'MATCH' && label(name) === 'plain').length}/${named(name => label(name) === 'plain').length}`,
      wrongMatches,
      plainMilkMissed: named((name, outcome) => outcome !== 'MATCH' && label(name) === 'plain'),
      ambiguousDecisions: named(name => label(name) === 'ambiguous'),
      cheapestPerStore: options.stores.map(store => `${store.retailer} ${store.storeId}: ${store.bestFixedPackage?.productName ?? 'none'} ₪${store.bestFixedPackage?.totalPriceIls ?? '-'}`),
      basketBuys: bought,
      passed: catalogPassed
    };
  }

  const perCall = (value: number) => Math.round(value / Math.max(usage.calls, 1));
  console.log(`\n${JSON.stringify({
    ...summary,
    labelledUsage: { calls: labelledUsage.calls, promptTokens: labelledUsage.promptTokens, outputTokens: labelledUsage.outputTokens },
    ...(catalog ? { catalog } : {}),
    totalUsage: {
      calls: usage.calls, promptTokens: usage.promptTokens, outputTokens: usage.outputTokens, thoughtTokens: usage.thoughtTokens,
      promptTokensPerCall: perCall(usage.promptTokens), outputTokensPerCall: perCall(usage.outputTokens), msPerCall: perCall(usage.callMs)
    }
  }, null, 2)}`);
  return summary.correct === summary.decisions && catalogPassed ? 0 : 1;
});
