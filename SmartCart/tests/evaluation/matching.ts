import assert from 'node:assert/strict';
import type { CatalogRecord, EngineItem } from '@engine/engine-types.mjs';
import { identityForRelation, matchProducts, READING_DECLARATION, validateMatchBatch, type MatchRelation } from '@engine/smartcart-matcher.mjs';
import { buildQuantityPriceOptions } from '@engine/smartcart-quantity-price.mjs';
import { optimizeBaskets } from '@engine/smartcart-basket-optimizer.mjs';
import { createItemContext } from '@engine/smartcart-pipeline-context.mjs';
import { matchItemCandidates } from '@/lib/shopping/matching';
import { SEMANTIC_CASES, caseItem, caseProducts } from '../fixtures/semantic-match-cases';
import { parseMatcherPrompt } from '../helpers/fake-models';
import { evaluateCase, type EvaluationSection } from './types';

const milk = SEMANTIC_CASES.find(row => row.id === 'milk')!;
const plain = caseProducts(milk)[0]!;
const flavored = caseProducts(milk)[6]!;

function decision(product: Pick<CatalogRecord, '_id' | 'name'>, relation: MatchRelation = 'SAME_PRODUCT', fields: Record<string, unknown> = {}) {
  return { id: product._id, candidate: product.name, identityEvidence: product.name, relation,
    identity: identityForRelation(relation), requirementChecks: [], preferencesMet: [], ...fields };
}

function wanted(requirements: string[] = []): EngineItem {
  return { ...caseItem(milk), requirements, constraintEvidence: requirements.map(value => ({
    type: 'REQUIREMENT', kind: 'OTHER', sourceText: value, value
  })) };
}

export async function runMatching(): Promise<EvaluationSection> {
  const cases = [];
  for (const entry of SEMANTIC_CASES) {
    cases.push(await evaluateCase({
      id: 'MATCH-' + entry.id, title: entry.product, request: entry.product, component: 'matcher plumbing', category: 'product identity',
      expected: entry.candidates.map(label => ({ name: label.name, decision: label.expected }))
    }, async () => {
      const item = caseItem(entry);
      const products = caseProducts(entry);
      const labels = new Map(products.map((product, index) => [product._id, entry.candidates[index]!]));
      const result = await matchProducts({
        item, products,
        callModel: async ({ prompt }) => ({ decisions: parseMatcherPrompt(prompt).candidates.map(row => {
          const label = labels.get(row.id)!;
          const relation = label.expected === 'MATCH' || label.kind.startsWith('constraint') ? 'SAME_PRODUCT'
            : label.expected === 'UNCERTAIN' ? 'UNCLEAR' : 'RELATED_DIFFERENT';
          const requirementChecks = item.requirements.map(requirement => row.name.includes(requirement)
            ? { requirement, kind: 'OTHER', result: 'MET', evidenceSource: 'NAME', evidence: requirement }
            : { requirement, kind: 'OTHER', result: 'UNKNOWN', evidenceSource: 'NONE', evidence: '' });
          return decision({ _id: row.id, name: row.name }, relation, { requirementChecks });
        }) })
      });
      const matches = new Set(result.matches.map(row => row.product._id));
      const rejects = new Set(result.rejected.map(row => row.product._id));
      const actual = products.map(product => {
        const expected = labels.get(product._id)!.expected;
        const observed = matches.has(product._id) ? 'MATCH' : rejects.has(product._id) ? 'REJECT' : 'UNCERTAIN';
        const agrees = expected === 'DEBATABLE' ? null : expected === 'NOT_MATCH' ? observed !== 'MATCH' : expected === observed;
        return { name: product.name, expected, observed, agrees };
      });
      const discrepancies = actual.filter(row => row.agrees === false);
      return { status: discrepancies.length ? 'fail' : 'pass', actual,
        metrics: { incorrectlyAccepted: discrepancies.filter(row => row.observed === 'MATCH').length,
          incorrectlyRejected: discrepancies.filter(row => row.expected === 'MATCH').length,
          debatable: actual.filter(row => row.agrees === null).length } };
    }));
  }
  cases.push(await evaluateCase({
    id: 'MATCH-READING-SHARED', title: 'Every batch sees one request reading', request: 'I want milk.',
    component: 'matchItemCandidates', expected: 'One intent call and identical interpretation on all three batches'
  }, async () => {
    let reads = 0;
    const prompts: string[] = [];
    await matchItemCandidates({ ...wanted(), product: 'milk for shared-reading audit' }, caseProducts(milk).slice(0, 3), {
      db: null, concurrency: 3, batchSize: 1, model: 'audit-reading',
      callModel: async ({ declaration, prompt }) => {
        if (declaration.name === READING_DECLARATION.name) {
          reads++;
          return { wanted: 'plain drinking milk shared evidence', notWanted: ['condensed milk'] };
        }
        prompts.push(prompt);
        return { decisions: parseMatcherPrompt(prompt).candidates.map(row => decision({ _id: row.id, name: row.name }, 'RELATED_DIFFERENT')) };
      }
    });
    assert.equal(reads, 1);
    assert.equal(prompts.length, 3);
    assert.ok(prompts.every(prompt => prompt.includes('plain drinking milk shared evidence')));
    return { actual: { reads, batches: prompts.length, shared: true } };
  }));
  return {
    name: 'Product matching and intent reading', mode: 'MOCK', cases,
    notes: ['The supplied semantic relations are labelled fixtures. These scores measure passage through the real matcher, never independent Gemini semantic accuracy.']
  };
}

export async function runValidation(): Promise<EvaluationSection> {
  type Probe = { title: string; raw: unknown; requirements?: string[]; product?: CatalogRecord; expected: string };
  const invented = (requirement: string, evidence: string) => ({
    requirement, kind: 'OTHER', result: 'MET', evidenceSource: 'NAME', evidence
  });
  const probes: Probe[] = [
    { title: 'valid same product', raw: { decisions: [decision(plain)] }, expected: 'MATCH' },
    { title: 'invalid product ID', raw: { decisions: [decision(plain, 'SAME_PRODUCT', { id: 'invented' })] }, expected: 'rejected-response' },
    { title: 'duplicate decisions', raw: { decisions: [decision(plain), decision(plain)] }, expected: 'rejected-response' },
    { title: 'missing decision', raw: { decisions: [] }, expected: 'rejected-response' },
    { title: 'invalid JSON', raw: '{"decisions":[', expected: 'rejected-response' },
    { title: 'invalid decision type', raw: { decisions: [false] }, expected: 'rejected-response' },
    { title: 'illegal verdict', raw: { decisions: [decision(plain, 'SAME_PRODUCT', { identity: 'GUESS' })] }, expected: 'rejected-response' },
    { title: 'invented identity evidence', raw: { decisions: [decision(plain, 'SAME_PRODUCT', { identityEvidence: 'organic whole-wheat tortilla' })] }, expected: 'UNCERTAIN' },
    { title: 'missing identity evidence', raw: { decisions: [decision(plain, 'SAME_PRODUCT', { identityEvidence: '' })] }, expected: 'UNCERTAIN' },
    { title: 'derived relationship plus MATCH', raw: { decisions: [decision(plain, 'DERIVED', { identity: 'MATCH' })] }, expected: 'UNCERTAIN' },
    { title: 'accessory relationship plus MATCH', raw: { decisions: [decision(plain, 'ACCESSORY', { identity: 'MATCH' })] }, expected: 'UNCERTAIN' },
    { title: 'uncertain product', raw: { decisions: [decision(plain, 'UNCLEAR')] }, expected: 'UNCERTAIN' },
    { title: 'incorrect fat percentage', raw: { decisions: [decision(plain, 'SAME_PRODUCT', { requirementChecks: [invented('1%', '1%')] })] },
      requirements: ['1%'], expected: 'NO_MATCH' },
    { title: 'invented certification', raw: { decisions: [decision(plain, 'SAME_PRODUCT', { requirementChecks: [invented('halal', 'halal')] })] },
      requirements: ['halal'], expected: 'UNCERTAIN' },
    { title: 'incorrect package size', raw: { decisions: [decision(plain, 'SAME_PRODUCT', { requirementChecks: [invented('500 ml', '500 ml')] })] },
      requirements: ['500 ml'], expected: 'NO_MATCH' },
    { title: 'missing requirement check', raw: { decisions: [decision(plain)] }, requirements: ['3%'], expected: 'rejected-response' },
    { title: 'coherent semantic error with genuine title', raw: { decisions: [decision(flavored)] }, product: flavored, expected: 'NO_MATCH' }
  ];
  const cases = [];
  for (const [index, probe] of probes.entries()) {
    const request = wanted(probe.requirements);
    cases.push(await evaluateCase({
      id: 'VALID-' + (index + 1), title: probe.title, request: request.product, expected: probe.expected,
      component: 'validateMatchBatch', category: 'backend validation'
    }, () => {
      let actual: string;
      let message = '';
      try {
        actual = validateMatchBatch(probe.raw, [probe.product ?? plain], [], request.requirements, { item: request })[0]!.status;
      } catch (error) {
        actual = 'rejected-response';
        message = String(error);
      }
      return { status: actual === probe.expected ? 'pass' : 'fail', actual,
        logs: [message || 'The relationship, verdict and evidence can agree even when the product identity is wrong.'].filter(Boolean) };
    }));
  }
  cases.push(await evaluateCase({
    id: 'VALID-partial-retry', title: 'Retry only the unresolved candidate', request: 'I want milk.',
    expected: 'The second batch contains only the missing offer, and UNCERTAIN remains out of pricing.', component: 'matchProducts and optimizer'
  }, async () => {
    const item = wanted();
    const plan = { userRequest: 'I want milk.', items: [item] };
    const products = [plain, flavored];
    const batches: string[][] = [];
    const result = await matchProducts({ item, products, context: createItemContext(plan, 0), waitForRetry: async () => {},
      callModel: async ({ prompt }) => {
        batches.push(parseMatcherPrompt(prompt).candidates.map(row => row.id));
        return { decisions: batches.length === 1 ? [decision(plain)] : [decision(flavored, 'UNCLEAR')] };
      }
    });
    assert.deepEqual(batches, [[plain._id, flavored._id], [flavored._id]]);
    const optimized = optimizeBaskets([buildQuantityPriceOptions(result)], { request: plan });
    assert.ok(optimized.recommendedBasket);
    assert.deepEqual(optimized.recommendedBasket.items.flatMap(row => row.products.map(offer => offer.productId)), [plain._id]);
    return { actual: { batches, excluded: result.uncertain.map(row => row.product._id) } };
  }));
  return { name: 'Backend response validation', mode: 'DETERMINISTIC', cases };
}
