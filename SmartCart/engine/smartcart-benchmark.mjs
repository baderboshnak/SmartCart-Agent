import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { buildCatalog, searchCatalog } from './smartcart-search.mjs';
import { matchProducts } from './smartcart-matcher.mjs';
import { buildQuantityPriceOptions } from './smartcart-quantity-price.mjs';
import { optimizeBaskets } from './smartcart-basket-optimizer.mjs';
import { createItemContext } from './smartcart-pipeline-context.mjs';

// Offline throughput check over a catalog JSON file (defaults to the test fixture).
// The production catalog lives in MongoDB; see scripts/benchmark.ts.
const catalogPath = process.argv[2] ?? new URL('../tests/fixtures/catalog-sample.json', import.meta.url);
const elapsed = start => Math.round((performance.now() - start) * 100) / 100;
const beforeRead = performance.now();
const products = JSON.parse(await readFile(catalogPath, 'utf8'));
const readAndParseMs = elapsed(beforeRead);
const plan = { userRequest: 'I want 2 liters of milk', items: [{
  product: 'milk', searchTerms: ['חלב'], requirements: [], preferences: [],
  quantity: { amount: 2, unit: 'l' }
}] };
const item = plan.items[0];
const start = performance.now();
const context = createItemContext(plan, 0);
const beforeIndex = performance.now();
const catalog = buildCatalog(products);
const indexMs = elapsed(beforeIndex);
const beforeSearch = performance.now();
const { results: candidates } = searchCatalog(catalog, item);
const searchMs = elapsed(beforeSearch);
const callMetrics = { calls: 0, promptUtf8Bytes: 0, largestBatch: 0 };
const beforeMatch = performance.now();
const matches = await matchProducts({
  item, context, products: candidates,
  callModel: async ({ prompt }) => {
    callMetrics.calls++;
    callMetrics.promptUtf8Bytes += Buffer.byteLength(prompt, 'utf8');
    const rows = JSON.parse(prompt.slice(prompt.lastIndexOf('\nProducts: ') + '\nProducts: '.length));
    callMetrics.largestBatch = Math.max(callMetrics.largestBatch, rows.length);
    return { decisions: rows.map(row => {
      const identity = /^(?:חלב)\s/u.test(row.name) && /\d\s*%/u.test(row.name) ? 'MATCH' : 'NO_MATCH';
      return {
        id: row.id, candidate: 'Mock used to measure program throughput', identityEvidence: row.name,
        relation: identity === 'MATCH' ? 'SAME_PRODUCT' : 'RELATED_DIFFERENT', identity,
        requirementChecks: [], preferencesMet: []
      };
    }) };
  }
});
const matchMs = elapsed(beforeMatch);
const beforePricing = performance.now();
const options = buildQuantityPriceOptions(matches);
const pricingMs = elapsed(beforePricing);
const beforeBasket = performance.now();
const basket = optimizeBaskets([options], { request: plan });
const basketMs = elapsed(beforeBasket);
console.log(JSON.stringify({
  catalogRecords: products.length,
  candidates: candidates.length,
  evaluated: matches.totalCandidates,
  pricingOptions: options.optionCount,
  completeStores: basket.completeStores,
  mockedGemini: callMetrics,
  milliseconds: { readAndParse: readAndParseMs, index: indexMs, search: searchMs, match: matchMs,
    pricing: pricingMs, basket: basketMs, pipeline: elapsed(start), total: elapsed(beforeRead) },
  heapUsedMiBAtEnd: Math.round(process.memoryUsage().heapUsed / 1024 ** 2 * 10) / 10,
  tokenUsage: null,
  realGeminiCalls: 0
}, null, 2));
