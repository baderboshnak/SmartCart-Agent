import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { optimizeBaskets } from '@engine/smartcart-basket-optimizer.mjs';
import type { CatalogRecord, EngineItem } from '@engine/engine-types.mjs';
import {
  buildMatchPrompt, buildReadingPrompt, describeReading, identityEvidenceInName, identityForRelation, MATCH_DECLARATION, MATCH_RELATIONS,
  MATCHER_FINGERPRINT, matchProducts, READING_DECLARATION, readShoppingRequest, runMatchWithCheckpoint, validateMatchBatch,
  type CallModel, type MatchRelation, type MatchResults
} from '@engine/smartcart-matcher.mjs';
import { buildQuantityPriceOptions } from '@engine/smartcart-quantity-price.mjs';
import { MATCH_CACHE_VERSION, matchItemCandidates, matchItemKey } from '@/lib/shopping/matching';
import { caseItem, caseProducts, SEMANTIC_CASES, type Expected } from '../fixtures/semantic-match-cases';

// These tests check the deterministic side of matching: answer validation, consistency, evidence and
// caching. Mocked answers cannot show that Gemini understands a request; scripts/live-semantic-matching.ts does.

const RELATIONS = Object.keys(MATCH_RELATIONS) as MatchRelation[];

function offer(id: string, name: string, quantity: number, unit: string, price: number): CatalogRecord {
  return {
    _id: id, retailer: 'market', chainId: '10', subChainId: '20', storeId: '101', productCode: id, name,
    package: { quantity, unit, isWeighted: false }, pricing: { listedPriceIls: price }
  };
}

function item(product: string, requirements: string[] = []): EngineItem {
  return {
    product, searchTerms: [product], requirements, preferences: [], quantity: { amount: 0, unit: 'unspecified' },
    constraintEvidence: requirements.map(value => ({ type: 'REQUIREMENT' as const, kind: 'OTHER' as const, sourceText: value, value }))
  };
}

/** A Gemini-shaped answer for one candidate; identity follows the relation unless overridden. */
function answer(product: { _id?: string; id?: string; name: string }, relation: MatchRelation, overrides: Record<string, unknown> = {}) {
  return {
    id: product._id ?? product.id, candidate: 'test reading', identityEvidence: product.name, relation,
    identity: identityForRelation(relation), requirementChecks: [], preferencesMet: [], ...overrides
  };
}

const plainMilk = offer('plain', 'חלב תנובה 3% 1 ליטר', 1, 'l', 6.5);
const condensed = offer('condensed', 'חלב מרוכז ממותק 397 גרם', 397, 'g', 4.9);
const smores = offer('smores', 'משקה חלב טעם סמורס 350 מל', 350, 'ml', 5.9);
const soy = offer('soy', 'חלב סויה 1 ליטר', 1, 'l', 5);

function status(raw: unknown, product: CatalogRecord, wanted = item('חלב')) {
  return validateMatchBatch(raw, [product], wanted.preferences, wanted.requirements, { item: wanted })[0]!;
}

function promptCandidates(prompt: string): Array<{ id: string; name: string }> {
  return JSON.parse(prompt.slice(prompt.lastIndexOf('\nProducts: ') + '\nProducts: '.length));
}

/** Price and compare the matched offers of one item; returns the recommended product names. */
function recommended(results: MatchResults): string[] {
  const basket = optimizeBaskets([buildQuantityPriceOptions(results)]).recommendedBasket;
  return basket ? basket.items.flatMap(line => line.products.map(product => product.productName)) : [];
}

describe('semantic identity validation', () => {
  test('only one verdict fits each relation; any other verdict becomes UNCERTAIN, never MATCH', () => {
    for (const relation of RELATIONS) {
      for (const identity of ['MATCH', 'NO_MATCH', 'UNCERTAIN'] as const) {
        const decision = status({ decisions: [answer(plainMilk, relation, { identity })] }, plainMilk);
        const expected = identity === identityForRelation(relation) ? identity : 'UNCERTAIN';
        assert.equal(decision.status, expected, `${relation} + ${identity}`);
        assert.equal(decision.relation, relation);
        assert.equal(decision.identityStatus, identity, 'Gemini\'s own verdict is kept for audits');
      }
    }
  });

  test('the logged failure ("Condensed milk is a form of milk") cannot be accepted', () => {
    // The v2 answer: a MATCH backed only by a related reading. Under v3 Gemini must name the relation.
    const inconsistent = status({ decisions: [answer(condensed, 'DERIVED', { identity: 'MATCH', candidate: 'sweetened condensed milk' })] }, condensed);
    assert.equal(inconsistent.status, 'UNCERTAIN');
    assert.match(inconsistent.reason, /not confirmed: Gemini answered MATCH for made from the requested product/u);
    const consistent = status({ decisions: [answer(condensed, 'DERIVED', { candidate: 'sweetened condensed milk' })] }, condensed);
    assert.equal(consistent.status, 'NO_MATCH');
    assert.equal(consistent.reason, 'sweetened condensed milk (made from the requested product).');
  });

  test('a MATCH needs the identity words from the product name, and a quote alone never makes a match', () => {
    const invented = status({ decisions: [answer(smores, 'SAME_PRODUCT', { identityEvidence: 'חלב טרי' })] }, smores);
    assert.equal(invented.status, 'UNCERTAIN');
    assert.match(invented.reason, /"חלב טרי" are not in the product name/u);
    assert.equal(status({ decisions: [answer(plainMilk, 'SAME_PRODUCT', { identityEvidence: ' ' })] }, plainMilk).status, 'UNCERTAIN');
    assert.equal(status({ decisions: [answer(plainMilk, 'SAME_PRODUCT', { identityEvidence: 'ח' })] }, plainMilk).status, 'UNCERTAIN', 'one letter proves nothing');
    // The grounded keyword "חלב" does not upgrade a flavored drink that Gemini classified as a variant.
    assert.equal(status({ decisions: [answer(smores, 'SPECIAL_VARIANT', { identityEvidence: 'חלב' })] }, smores).status, 'NO_MATCH');
    assert.equal(status({ decisions: [answer(smores, 'SPECIAL_VARIANT', { identityEvidence: 'not on the label' })] }, smores).status, 'NO_MATCH', 'a rejection is never turned into a match');
  });

  test('identity quotes ignore spacing, punctuation, vowel marks and skipped words, but not invented or reordered words', () => {
    const abbreviated = { name: 'מ.חלב טעם סמורס יטבתה1' };
    assert.equal(identityEvidenceInName(abbreviated, 'מ. חלב טעם סמורס'), true);
    assert.equal(identityEvidenceInName({ name: 'חלב 3% 1 ל\'' }, 'חָלָב'), true);
    // Seen live: Gemini left out the size between quoted words, joined words across a number, or repeated a word.
    assert.equal(identityEvidenceInName({ name: 'חלב מועשר 2 ל 3% מהדרין' }, 'חלב מועשר 3%'), true);
    assert.equal(identityEvidenceInName({ name: 'חלב מועשר3%בקבוק1ל יטבתה' }, 'חלב מועשרבקבוק'), true);
    assert.equal(identityEvidenceInName({ name: 'חלב 3% טרה 2 ליטר' }, 'חלב חלב'), true);
    assert.equal(identityEvidenceInName({ name: 'חלב 3% טרה 2 ליטר' }, '3% 2'), false, 'numbers alone show nothing');
    assert.equal(identityEvidenceInName({ name: 'חלב תנובה מלא בטעם של פעם 3.4%' }, 'חlev תנובה'), false, 'a garbled quote is refused');
    assert.equal(identityEvidenceInName(abbreviated, 'משקה חלב'), false, '"משקה" is not on the label');
    assert.equal(identityEvidenceInName({ name: 'חלב טעם סמורס' }, 'סמורס חלב'), false, 'the words must keep their order');
  });

  test('malformed identity answers are asked again for exactly those products', async () => {
    const products = [plainMilk, condensed, smores, soy];
    const requests: string[][] = [];
    const prompts: string[] = [];
    const callModel: CallModel = async ({ prompt }) => {
      const batch = promptCandidates(prompt);
      requests.push(batch.map(row => row.id));
      prompts.push(prompt);
      if (requests.length === 1) {
        return { requestedProduct: 'Plain drinking milk.', decisions: [
          answer(plainMilk, 'SAME_PRODUCT'),
          { ...answer(condensed, 'DERIVED'), relation: undefined },
          answer(smores, 'SPECIAL_VARIANT', { relation: 'SIMILAR' }),
          answer(soy, 'RELATED_DIFFERENT', { candidate: '' })
        ] };
      }
      const relations: Record<string, MatchRelation> = { condensed: 'DERIVED', smores: 'SPECIAL_VARIANT', soy: 'RELATED_DIFFERENT' };
      return { decisions: batch.map(row => answer(row, relations[row.id]!)) };
    };
    const result = await matchProducts({ item: item('חלב'), products, callModel });
    assert.deepEqual(requests, [['plain', 'condensed', 'smores', 'soy'], ['condensed', 'smores', 'soy']]);
    assert.match(prompts[1]!, /condensed: Gemini returned an invalid candidate, identityEvidence, relation/u);
    assert.deepEqual(result.matches.map(row => row.product._id), ['plain']);
    assert.deepEqual(result.rejected.map(row => row.product._id), ['condensed', 'smores', 'soy']);
    assert.deepEqual(result.requestReadings, ['Plain drinking milk.']);
  });
});

describe('semantic decisions through pricing and the basket', () => {
  const products = [plainMilk, condensed, smores, soy];
  const answers: Record<string, MatchRelation> = { plain: 'SAME_PRODUCT', condensed: 'DERIVED', smores: 'SPECIAL_VARIANT', soy: 'RELATED_DIFFERENT' };

  test('"אני רוצה חלב": cheaper related products are never matched, so the basket buys plain milk', async () => {
    const result = await matchProducts({
      item: item('חלב'), products,
      callModel: async ({ prompt }) => ({ decisions: promptCandidates(prompt).map(row => answer(row, answers[row.id]!)) })
    });
    assert.deepEqual(result.matches.map(row => row.product._id), ['plain']);
    assert.deepEqual(recommended(result), ['חלב תנובה 3% 1 ליטר'], 'the most expensive candidate is the only real milk');
  });

  test('an inconsistent MATCH for a cheaper derived or flavored product stays out of the basket', async () => {
    const result = await matchProducts({
      item: item('חלב'), products,
      callModel: async ({ prompt }) => ({ decisions: promptCandidates(prompt).map(row =>
        answer(row, answers[row.id]!, { identity: 'MATCH' })) })
    });
    assert.deepEqual(result.uncertain.map(row => row.product._id), ['condensed', 'smores', 'soy']);
    assert.deepEqual(recommended(result), ['חלב תנובה 3% 1 ליטר']);
  });

  test('a product rejected for a generic request is matched and priced when it is requested explicitly', async () => {
    // The backend has no product rule: the same offer's outcome follows Gemini's relation to each request.
    const ask = (wanted: EngineItem, relation: MatchRelation) => matchProducts({
      item: wanted, products: [condensed], callModel: async () => ({ decisions: [answer(condensed, relation)] })
    });
    assert.deepEqual((await ask(item('חלב'), 'DERIVED')).rejected.map(row => row.product._id), ['condensed']);
    const explicit = await ask(item('חלב מרוכז'), 'SAME_PRODUCT');
    assert.deepEqual(explicit.matches.map(row => row.product._id), ['condensed']);
    assert.deepEqual(recommended(explicit), ['חלב מרוכז ממותק 397 גרם']);
  });

  test('every labelled case: answers consistent with its labels give the labelled outcome (plumbing, not semantics)', async () => {
    const outcome = (results: MatchResults, id: string): Expected =>
      results.matches.some(row => row.product._id === id) ? 'MATCH'
        : results.rejected.some(row => row.product._id === id) ? 'REJECT' : 'UNCERTAIN';
    for (const entry of SEMANTIC_CASES) {
      const wanted = caseItem(entry);
      const products = caseProducts(entry);
      const labels = new Map(products.map((product, index) => [product._id, entry.candidates[index]!]));
      const results = await matchProducts({
        item: wanted, products,
        callModel: async ({ prompt }) => ({ decisions: promptCandidates(prompt).map(row => {
          const label = labels.get(row.id)!;
          // A requirement is claimed only when its words are on the label; deterministic checks find contradictions.
          const requirementChecks = wanted.requirements.map(requirement => row.name.includes(requirement)
            ? { requirement, kind: 'OTHER', result: 'MET', evidenceSource: 'NAME', evidence: requirement }
            : { requirement, kind: 'OTHER', result: 'UNKNOWN', evidenceSource: 'NONE', evidence: '' });
          const relation: MatchRelation = label.expected === 'MATCH' || label.kind.startsWith('constraint') ? 'SAME_PRODUCT'
            : label.expected === 'UNCERTAIN' ? 'UNCLEAR' : 'RELATED_DIFFERENT';
          return answer(row, relation, { requirementChecks });
        }) })
      });
      for (const product of products) {
        const label = labels.get(product._id)!;
        if (label.expected === 'DEBATABLE') continue;
        const actual = outcome(results, product._id);
        const pass = label.expected === 'NOT_MATCH' ? actual !== 'MATCH' : actual === label.expected;
        assert.ok(pass, `${entry.id}: ${label.name} expected ${label.expected}, got ${actual}`);
      }
    }
  });
});

describe('one reading of the request for every batch', () => {
  const milkOffers = Array.from({ length: 60 }, (_, index) => offer(`milk-${index}`, `חלב ${index % 3 === 0 ? '3%' : '1%'} 1 ליטר`, 1, 'l', 6 + index / 100));

  test('the request is read once before any candidate, and every batch gets the same reading', async () => {
    const prompts: string[] = [];
    const readingPrompts: string[] = [];
    const reading = { wanted: 'Plain drinking milk of any fat level or brand.', notWanted: ['condensed milk', 'flavored milk drinks'] };
    const callModel: CallModel = async ({ prompt, declaration }) => {
      if (declaration.name === READING_DECLARATION.name) {
        readingPrompts.push(prompt);
        return reading;
      }
      prompts.push(prompt);
      return { requestedProduct: reading.wanted, decisions: promptCandidates(prompt).map(row => answer(row, 'SAME_PRODUCT')) };
    };
    const model = `reading-test-${Date.now()}`;
    const events: unknown[] = [];
    const outcome = await matchItemCandidates(item('חלב'), milkOffers, { db: null, callModel, model, batchSize: 25, concurrency: 3, onReading: event => events.push(event) });
    assert.equal(readingPrompts.length, 1, 'one reading for three batches');
    assert.doesNotMatch(readingPrompts[0]!, /Products:/u, 'the reading sees no candidates');
    assert.equal(prompts.length, 3);
    for (const prompt of prompts) {
      assert.match(prompt, /made from the request alone before any candidate was seen:\n- Wanted: "Plain drinking milk of any fat level or brand\."\n- Does not count: \["condensed milk","flavored milk drinks"\]/u);
    }
    assert.equal(outcome.modelCalls, 4, 'the reading is counted as a Gemini call');
    assert.deepEqual(outcome.results.requestReadings, [describeReading(reading)]);
    assert.deepEqual(events, [{ reading, reused: false }]);

    // The same request later in this server process reuses the reading.
    readingPrompts.length = 0;
    await matchItemCandidates(item('חלב'), milkOffers.slice(0, 5), { db: null, callModel, model, batchSize: 25 });
    assert.equal(readingPrompts.length, 0);
  });

  test('without a usable reading each batch reads the request itself, as before', async () => {
    const events: Array<{ reading: unknown; error?: unknown }> = [];
    let batches = 0;
    const outcome = await matchItemCandidates(item('חלב'), milkOffers.slice(0, 30), {
      db: null, model: `reading-failure-${Date.now()}`, batchSize: 25, onReading: event => events.push(event),
      callModel: async ({ prompt, declaration }) => {
        if (declaration.name === READING_DECLARATION.name) throw new Error('reading unavailable');
        batches++;
        assert.doesNotMatch(prompt, /Request reading/u);
        return { requestedProduct: 'Plain milk.', decisions: promptCandidates(prompt).map(row => answer(row, 'SAME_PRODUCT')) };
      }
    });
    assert.equal(batches, 2);
    assert.equal(outcome.results.matches.length, 30);
    assert.match(String((events[0]!.error as Error).message), /reading unavailable/u);
    assert.deepEqual(outcome.results.requestReadings, ['Plain milk.']);
  });

  test('a reading answer without a wanted sentence is unusable, and a malformed reading is refused', async () => {
    assert.equal(await readShoppingRequest({ item: item('חלב'), callModel: async () => ({ notWanted: ['x'] }) }), null);
    const cleaned = await readShoppingRequest({ item: item('חלב'), callModel: async () => ({ wanted: ' Milk. ', notWanted: ['a', 'a', 7, ' b '] }) });
    assert.deepEqual(cleaned, { wanted: 'Milk.', notWanted: ['a', 'b'] });
    // Seen live: the reading listed instant coffee both as wanted and as not wanted.
    const contradictory = await readShoppingRequest({ item: item('קפה'), callModel: async () => ({
      wanted: 'Coffee, including ground coffee, Instant Coffee and coffee beans.', notWanted: ['instant coffee', 'coffee syrup']
    }) });
    assert.deepEqual(contradictory?.notWanted, ['coffee syrup']);
    await assert.rejects(matchProducts({ item: item('חלב'), products: [plainMilk], reading: { wanted: 'Milk.' } as never,
      callModel: async () => assert.fail('no call with an invalid reading') }), /reading must be null or/u);
  });
});

describe('matcher instructions', () => {
  const prompt = buildMatchPrompt(item('X'), []);

  test('name no product from the evaluation cases, and the old chocolate-milk rule is gone', () => {
    const instructions = `${prompt}\n${buildReadingPrompt(item('X'))}`.replace(/^Product wanted: .*$/gmu, '');
    const words = [...new Set(SEMANTIC_CASES.flatMap(entry => [entry.product, ...entry.product.split(' ')]))];
    for (const word of words) {
      assert.doesNotMatch(instructions, new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`, 'iu'), `the instructions mention "${word}"`);
    }
    assert.doesNotMatch(prompt, /טובלרון|Toblerone|שוקולד חלב/u);
  });

  test('list every relation of the declaration, before the verdict, and keep the parsed line format', () => {
    const decision = (MATCH_DECLARATION.parameters as { properties: { decisions: { items: { properties: Record<string, { enum?: string[] }> } } } })
      .properties.decisions.items.properties;
    assert.deepEqual(decision.relation!.enum, RELATIONS);
    for (const relation of RELATIONS) assert.match(prompt, new RegExp(`\\n  ${relation}: `, 'u'));
    const order = Object.keys(decision);
    assert.ok(order.indexOf('candidate') < order.indexOf('relation') && order.indexOf('relation') < order.indexOf('identity'),
      'Gemini describes the candidate and its relation before giving a verdict');
    for (const label of ['Product wanted', 'Mandatory requirements', 'Optional preferences']) assert.match(prompt, new RegExp(`^${label}: `, 'mu'));
    assert.match(prompt, /\nProducts: \[\]$/u);
  });
});

describe('saved decisions from older matching rules', () => {
  // The decision v2 saved for "אני רוצה חלב" (logs/smartcart.log, 2026-11-26).
  const v2Decision = {
    id: 'condensed', status: 'MATCH' as const, reason: 'Condensed milk is a form of milk.', identityStatus: 'MATCH' as const,
    requirementChecks: [], preferencesMet: []
  };

  test('the cache key carries the matcher fingerprint, so v2 keys are never looked up', () => {
    assert.match(MATCHER_FINGERPRINT, /^[0-9a-f]{64}$/u);
    assert.ok(MATCH_CACHE_VERSION.startsWith('matcher-v3:'));
    assert.ok(MATCH_CACHE_VERSION.endsWith(MATCHER_FINGERPRINT.slice(0, 16)));
    assert.notEqual(matchItemKey(item('חלב'), 'model'), matchItemKey(item('חלב'), 'model', 'matcher-v2'));
  });

  test('a v2 decision offered for reuse fails validation instead of being trusted', async () => {
    await assert.rejects(matchProducts({
      item: item('חלב'), products: [condensed], initialDecisions: [v2Decision as never],
      callModel: async () => assert.fail('validation must fail before any model call')
    }), /invalid candidate, identityEvidence, relation/u);
  });

  test('a disk checkpoint from the previous matcher is ignored and the product is checked again', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'smartcart-semantic-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const checkpointPath = join(directory, 'match-progress.json');
    await writeFile(checkpointPath, JSON.stringify({ version: 2, fingerprint: 'v2', decisions: [v2Decision] }));
    const statuses: string[] = [];
    let calls = 0;
    const result = await runMatchWithCheckpoint({
      item: item('חלב'), products: [condensed], checkpointPath, onCheckpointStatus: message => statuses.push(message),
      callModel: async () => { calls++; return { decisions: [answer(condensed, 'DERIVED')] }; }
    });
    assert.equal(calls, 1);
    assert.match(statuses[0]!, /Ignoring stale matching checkpoint/u);
    assert.deepEqual(result.rejected.map(row => row.product._id), ['condensed']);
  });
});
