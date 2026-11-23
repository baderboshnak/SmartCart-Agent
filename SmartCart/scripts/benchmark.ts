/**
 * Measure the deterministic pipeline against the MongoDB Atlas catalog.
 * Matching uses a local stand-in, so no Gemini calls are made.
 *   npm run benchmark
 */
import { performance } from 'node:perf_hooks';
import type { CallModel } from '@engine/smartcart-matcher.mjs';
import { findProducts } from '@/lib/db/products.repository';
import type { Cart, CartItem } from '@/lib/shared/types';
import { CartPipeline } from '@/lib/shopping/pipeline';
import { openScriptDatabase, parseArgs, runScript, stringFlag } from './lib/cli';

const elapsed = (start: number) => Math.round((performance.now() - start) * 100) / 100;

// Accepts plain fixed-size products whose names start with the searched word.
const standIn: CallModel = async ({ prompt }) => {
  const product = JSON.parse(/^Product wanted: (.*)$/mu.exec(prompt)?.[1] ?? '""') as string;
  const heads: Record<string, RegExp> = { milk: /^חלב\s/u, eggs: /^ביצים/u, bread: /^לחם/u };
  const rows = JSON.parse(prompt.slice(prompt.lastIndexOf('\nProducts: ') + 11)) as Array<{ id: string; name: string }>;
  return { decisions: rows.map(row => ({ id: row.id, identity: heads[product]?.test(row.name) ? 'MATCH' : 'NO_MATCH', requirementChecks: [], reason: 'benchmark stand-in', preferencesMet: [] })) };
};

runScript(async () => {
  const { flags } = parseArgs();
  const { client, db, dbName } = await openScriptDatabase(stringFlag(flags, 'db'));
  try {
    const searches: Record<string, { candidates: number; milliseconds: number }> = {};
    for (const term of ['חלב', 'ביצים', 'לחם', 'מוצרלה', 'גבינה צהובה', 'שוקולד', 'שמן זית']) {
      await findProducts(db, { terms: [term], limit: 800 }); // warm up the connection and cache
      const start = performance.now();
      const found = await findProducts(db, { terms: [term], limit: 800 });
      searches[term] = { candidates: found.totalMatched, milliseconds: elapsed(start) };
    }
    const item = (id: string, product: string, term: string, amount: number, unit: string): CartItem => ({
      id, product, searchTerms: [term], requirements: [], preferences: [], constraintEvidence: [],
      quantity: { amount, unit }, origin: { type: 'DIRECT' }, addedAt: new Date()
    });
    const now = new Date();
    const cart: Cart = {
      _id: 'cart_benchmark', sessionId: 'benchmark', revision: 0, itemsVersion: 1, mode: 'balanced', maxPremiumPct: 15, budget: null,
      items: [item('itm_1', 'milk', 'חלב', 2, 'l'), item('itm_2', 'eggs', 'ביצים', 12, 'units'), item('itm_3', 'bread', 'לחם', 500, 'g')],
      recipePlans: [], selectedStoreKey: null, calculation: null, createdAt: now, updatedAt: now, expiresAt: now
    };
    let modelCalls = 0;
    const pipeline = new CartPipeline({
      db,
      // db is passed for search; the stand-in matcher model avoids Gemini and the cache key uses a unique model name.
      matcher: { model: `benchmark-${Date.now()}`, callModel: async args => { modelCalls++; return standIn(args); } }
    });
    const start = performance.now();
    const calculation = await pipeline.calculate(cart);
    const pipelineMs = elapsed(start);
    console.log(JSON.stringify({
      database: dbName,
      searchMilliseconds: searches,
      pipeline: {
        items: cart.items.length,
        candidates: calculation.itemDiagnostics.map(entry => ({ product: entry.product, candidates: entry.candidates, matched: entry.matched })),
        status: calculation.status,
        verificationPassed: calculation.verification.passed,
        matcherStandInCalls: modelCalls,
        totalMilliseconds: pipelineMs
      },
      heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1024 ** 2 * 10) / 10,
      realGeminiCalls: 0
    }, null, 2));
  } finally {
    // The stand-in decisions were cached under a unique model name; remove them.
    await db.collection('match_cache').deleteMany({ model: /^benchmark-/u });
    await client.close();
  }
});
