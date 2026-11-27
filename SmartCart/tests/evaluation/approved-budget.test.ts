import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVED_CAP_MICROS, ApprovedBudget, textMicros, textUsage, type Charge } from './approved-budget';

test('one campaign budget covers batch, interactive, and voice reservations', () => {
  const charges: Charge[] = [];
  let writes = 0;
  const budget = new ApprovedBudget(charges, () => { writes++; });
  assert.ok(budget.reserveMany([
    { id: 'batch-one', phase: 'batch', reservedMicros: 190_000 },
    { id: 'batch-two', phase: 'batch', reservedMicros: 190_000 }
  ]));
  assert.ok(budget.reserve('text-one', 'deep', 160_000));
  assert.equal(budget.reserve('voice-one', 'voice', 61_000), false);
  const loaded = new ApprovedBudget(structuredClone(charges), () => { writes++; });
  assert.equal(loaded.reserve('batch-one', 'batch', 1), false);
  loaded.settle('batch-one', 50_000);
  assert.ok(loaded.reserve('voice-one', 'voice', 61_000));
  assert.equal(loaded.available(), APPROVED_CAP_MICROS - 50_000 - 190_000 - 160_000 - 61_000);
  assert.equal(writes, 4);
});

test('unconfirmed work retains its reservation and an overage stops further generation', () => {
  const charges: Charge[] = [];
  const budget = new ApprovedBudget(charges, () => {});
  assert.ok(budget.reserve('submitted', 'batch', 240_000));
  assert.ok(budget.reserve('voice-one', 'voice', 7_000));
  assert.throws(() => budget.settle('voice-one', 7_001), /exceeded its reservation/u);
  assert.equal(budget.reserve('next', 'deep', 1), false);
  assert.equal(budget.summary().unconfirmedReservedUsd, 0.24);
});

test('uses the larger of reported output and the difference in total usage', () => {
  const usage = textUsage({ usageMetadata: {
    promptTokenCount: 4_000, totalTokenCount: 4_400, candidatesTokenCount: 300, thoughtsTokenCount: 50
  } } as Parameters<typeof textUsage>[0]);
  assert.deepEqual(usage, { inputTokens: 4_000, outputTokens: 400 });
  assert.equal(textMicros(4_000, 400), 2_200);
  assert.equal(textMicros(4_000, 400, true), 1_100);
});
