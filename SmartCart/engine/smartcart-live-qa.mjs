import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

function redact(error) {
  const key = process.env.GEMINI_API_KEY;
  const message = String(error?.message ?? error);
  return (key ? message.split(key).join('[redacted]') : message)
    .replace(/([?&]key=)[^&\s"']+/giu, '$1[redacted]');
}

function elapsed(since) {
  return Math.round((performance.now() - since) * 100) / 100;
}

// Expectations and candidate samples are independent fixtures.
const expectedMilk = { item: /milk|חלב|حليب/iu, amount: 2, unit: 'l', mandatory: [/3\s*%/u] };
const tnuva = /tnuva|תנובה|تنوفا/iu;
const expectedEggs = { item: /eggs|ביצ|بيض/iu, amount: 12, unit: 'units' };
const expectedBread = { item: /bread|לחם|خبز/iu, amount: 500, unit: 'g' };
const expectedCheese = { item: /mozzarella|מוצרלה|موزاريلا/iu, amount: 500, unit: 'g',
  mandatory: [/shred|grat|מגורד|مبشور/iu] };
const milkCodes = ['7290000042015', '7290000042435', '7290004131074'];
const eggCodes = ['7290001201572', '742259241895'];
const breadCodes = ['7290000002026', '379623'];
const cheeseCodes = ['7290110324025', '7290014762909', '1794142', '7290014692817', '7290000554600'];
const multiCodes = [...milkCodes, ...eggCodes, ...breadCodes, ...cheeseCodes];
const multi = [expectedMilk, expectedEggs, expectedBread, expectedCheese];
const cases = [
  { request: '2 liters of 3% milk, preferably Tnuva.', codes: milkCodes, expectComplete: true,
    expected: [{ ...expectedMilk, optional: [tnuva] }] },
  { request: '500 g shredded mozzarella, only Tnuva.', codes: cheeseCodes, expectComplete: true,
    expected: [{ ...expectedCheese, mandatory: [...expectedCheese.mandatory, tnuva] }] },
  { request: '12 eggs and one loaf of bread.', codes: [...eggCodes, ...breadCodes],
    expected: [expectedEggs, { ...expectedBread, amount: 1, unit: 'loaf' }] },
  { request: '2 liters of lactose-free milk and gluten-free bread.',
    codes: [...milkCodes, ...breadCodes, '7290110563462', '7290013121028'], expectComplete: true,
    expected: [
      { ...expectedMilk, mandatory: [/lactose[- ]free/iu] },
      { ...expectedBread, amount: 0, unit: 'unspecified', mandatory: [/gluten[- ]free/iu] }
    ] },
  { request: '2 liters of 3% milk, 12 eggs, 500 g bread, and 500 g shredded mozzarella.',
    codes: multiCodes, expected: multi, expectComplete: true },
  { request: 'אני רוצה 2 ליטר חלב 3%, 12 ביצים, 500 גרם לחם ו-500 גרם מוצרלה מגורדת.',
    codes: multiCodes, expected: multi, expectComplete: true },
  { request: 'بدي 2 لتر حليب 3%، 12 بيضة، 500 غرام خبز، و500 غرام موزاريلا مبشورة.',
    codes: multiCodes, expected: multi, expectComplete: true },
  { request: 'I want milk that is both 1% and 3% fat.', expectValidationError: /contradic|conflict/iu },
  { request: 'I want milk, preferably Tnuva, and shredded mozzarella, preferably Gad.',
    codes: [...milkCodes, ...cheeseCodes], expectComplete: true,
    expected: [
      { ...expectedMilk, amount: 0, unit: 'unspecified', mandatory: [], optional: [tnuva] },
      { ...expectedCheese, amount: 0, unit: 'unspecified', optional: [/Gad|גד/iu] }
    ] },
  { request: 'I want lunar pebble cereal.', codes: [], expectComplete: false,
    expected: [{ item: /cereal/iu, amount: 0, unit: 'unspecified' }] }
];

async function runLiveChecks() {
  const [
    { understandShoppingRequest, callLiveFunction }, { normalizeAmount },
    { matchProducts }, { buildCatalog, searchCatalog }, { createItemContext },
    { buildQuantityPriceOptions }, { optimizeBaskets }
  ] = await Promise.all([
    import('./smartcart-llm.mjs'), import('./smartcart-package.mjs'),
    import('./smartcart-matcher.mjs'), import('./smartcart-search.mjs'), import('./smartcart-pipeline-context.mjs'),
    import('./smartcart-quantity-price.mjs'), import('./smartcart-basket-optimizer.mjs')
  ]);
  if (!process.env.GEMINI_API_KEY) {
    console.error('Set GEMINI_API_KEY before running the opt-in live tests.');
    process.exitCode = 2;
    return;
  }
  // Scenario offers are a subset of the deterministic catalog fixture.
  const catalog = JSON.parse(await readFile(new URL('../tests/fixtures/catalog-sample.json', import.meta.url), 'utf8'));
  let failed = 0;
  for (const scenario of cases) {
    const start = performance.now();
    const report = {
      request: scenario.request, status: 'passed', calls: 0, promptUtf8Bytes: 0, apiMilliseconds: 0,
      observedApiCost: null, items: [], candidateReports: [], basket: null, requirementViolations: []
    };
    const callModel = async args => {
      report.calls++;
      report.promptUtf8Bytes += Buffer.byteLength(args.prompt, 'utf8');
      const before = performance.now();
      try { return await callLiveFunction(args); }
      finally { report.apiMilliseconds += elapsed(before); }
    };
    try {
      if (scenario.expectValidationError) {
        await assert.rejects(() => understandShoppingRequest(scenario.request, { callModel }),
          scenario.expectValidationError);
      } else {
        const plan = await understandShoppingRequest(scenario.request, { callModel });
        report.items = plan.items ?? [];
        assert.equal(report.items.length, scenario.expected.length, 'Requested item coverage');
        for (const [index, expected] of scenario.expected.entries()) {
          const item = plan.items[index];
          assert.match(item.product, expected.item);
          if (expected.unit === 'unspecified') assert.deepEqual(item.quantity, { amount: 0, unit: 'unspecified' });
          else if (expected.unit === 'loaf') assert.deepEqual(item.quantity, { amount: expected.amount, unit: expected.unit });
          else assert.deepEqual(normalizeAmount(item.quantity.amount, item.quantity.unit),
            normalizeAmount(expected.amount, expected.unit), item.product);
          const mandatory = expected.mandatory ?? [];
          const optional = expected.optional ?? [];
          assert.equal(item.requirements.length, mandatory.length, item.product + ' mandatory requirements');
          assert.equal(item.preferences.length, optional.length, item.product + ' preferences');
          for (const check of mandatory) assert.ok(item.requirements.some(value => check.test(value)), String(check));
          for (const check of optional) assert.ok(item.preferences.some(value => check.test(value)), String(check));
        }
        const sample = buildCatalog(catalog.filter(product => scenario.codes.includes(product.productCode)));
        const files = [];
        for (const [index, item] of plan.items.entries()) {
          const { results: products } = searchCatalog(sample, item);
          const matches = await matchProducts({ item, products, context: createItemContext(plan, index), callModel });
          const summarize = rows => rows.map(row => ({
            productId: row.product._id, name: row.product.name, identity: row.identityStatus,
            requirements: row.requirementChecks, preferencesMet: row.preferencesMet
          }));
          report.candidateReports.push({
            index, candidates: products.map(row => row._id),
            matches: summarize(matches.matches), rejected: summarize(matches.rejected),
            uncertain: summarize(matches.uncertain)
          });
          files.push(buildQuantityPriceOptions(matches));
        }
        const result = optimizeBaskets(files, { request: plan });
        report.basket = result.recommendedBasket;
        report.excludedStores = result.excludedStores;
        report.requirementViolations = (report.basket?.items ?? []).flatMap(line =>
          line.products.flatMap(product => product.requirementChecks.filter(check => check.result !== 'MET')));
        assert.deepEqual(report.requirementViolations, []);
        if (scenario.expectComplete !== undefined) assert.equal(Boolean(report.basket), scenario.expectComplete);
        if (report.basket) {
          assert.equal(report.basket.items.length, scenario.expected.length);
          const cents = report.basket.items.flatMap(line => line.products)
            .reduce((sum, product) => sum + Math.round(product.linePriceIls * 100), 0);
          assert.equal(Math.round(report.basket.totalPriceIls * 100), cents);
        }
      }
    } catch (error) {
      report.status = 'failed';
      report.error = redact(error);
      failed++;
    }
    report.totalMilliseconds = elapsed(start);
    console.log(JSON.stringify(report));
  }
  console.log(JSON.stringify({ passed: cases.length - failed, failed, realGeminiCalls: true }));
  if (failed) process.exitCode = 1;
}

if (!process.argv.includes('--allow-live')) {
  console.error('Live Gemini tests require explicit opt-in. Use npm run test:live -- --allow-live.');
  process.exitCode = 2;
} else {
  try {
    await runLiveChecks();
  } catch (error) {
    console.error(redact(error));
    process.exitCode = 1;
  }
}
