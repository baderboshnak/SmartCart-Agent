import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { getOrCreateCart, mutableFields, saveCart } from '@/lib/db/carts.repository';
import { createSession } from '@/lib/db/sessions.repository';
import { ConflictError, ValidationError } from '@/lib/shared/errors';
import { applyUiCartEdit } from '@/lib/shopping/cart-service';
import { toCartView } from '@/lib/shopping/cart-view';
import { referenceItems, STORES } from '../helpers/fixtures';
import { createFakeMatcher } from '../helpers/fake-models';
import { createTestDatabase, databaseSkipReason, type TestDatabase } from '../helpers/test-db';

describe('cart edits from the UI', { skip: databaseSkipReason }, () => {
  let testDb: TestDatabase;
  const matcher = createFakeMatcher();
  const deps = () => ({ matcher: { callModel: matcher.callModel, model: 'fake-matcher' } });
  before(async () => { testDb = await createTestDatabase({ seed: true }); });
  after(async () => { await testDb?.cleanup(); });

  test('edits are saved, recalculated and verified on the server with optimistic concurrency', async () => {
    const { session } = await createSession(testDb.db);
    const empty = await getOrCreateCart(testDb.db, session._id);
    await saveCart(testDb.db, session._id, empty.revision, { ...mutableFields(empty), items: referenceItems(), itemsVersion: 1 });

    const priced = await applyUiCartEdit(testDb.db, session._id, { expectedRevision: 1, operation: { op: 'recalculate' } }, deps());
    assert.equal(priced.recalculationError, null);
    assert.equal(toCartView(priced.cart).status, 'COMPLETE');
    assert.equal(toCartView(priced.cart).basket?.totalPriceIls, 67.26);
    const callsAfterFirstPricing = matcher.stats.calls;

    // Quantity changes reprice without new model calls.
    const doubled = await applyUiCartEdit(testDb.db, session._id, {
      expectedRevision: priced.cart.revision, operation: { op: 'set_quantity', itemId: 'itm_milk', quantity: { amount: 4, unit: 'l' } }
    }, deps());
    assert.equal(matcher.stats.calls, callsAfterFirstPricing);
    const milkLine = toCartView(doubled.cart).basket!.lines.find(line => line.itemId === 'itm_milk')!;
    assert.equal(milkLine.purchasedLabel, '4000 ml');

    // A stale revision is rejected instead of overwriting newer changes.
    await assert.rejects(applyUiCartEdit(testDb.db, session._id, { expectedRevision: priced.cart.revision, operation: { op: 'remove_item', itemId: 'itm_eggs' } }, deps()), ConflictError);

    // Turning the Tnuva preference into a requirement re-evaluates candidates.
    const strict = await applyUiCartEdit(testDb.db, session._id, {
      expectedRevision: doubled.cart.revision, operation: { op: 'toggle_constraint', itemId: 'itm_milk', value: 'Tnuva' }
    }, deps());
    assert.ok(matcher.stats.calls > callsAfterFirstPricing);
    const milk = strict.cart.items.find(item => item.id === 'itm_milk')!;
    assert.deepEqual(milk.requirements, ['3%', 'Tnuva']);
    assert.equal(milk.constraintEvidence.find(entry => entry.value === 'Tnuva')?.kind, 'BRAND');

    // Only complete stores can be selected.
    await assert.rejects(applyUiCartEdit(testDb.db, session._id, { expectedRevision: strict.cart.revision, operation: { op: 'select_store', storeKey: 'other:1:2:3' } }, deps()), ValidationError);
    const complete = toCartView(strict.cart).stores.filter(store => store.complete).map(store => store.storeKey);
    if (complete.includes(STORES.shufersal)) {
      const selected = await applyUiCartEdit(testDb.db, session._id, { expectedRevision: strict.cart.revision, operation: { op: 'select_store', storeKey: STORES.shufersal } }, deps());
      assert.equal(toCartView(selected.cart).basket?.storeKey, STORES.shufersal);
    }

    const latest = await getOrCreateCart(testDb.db, session._id);
    const removed = await applyUiCartEdit(testDb.db, session._id, { expectedRevision: latest.revision, operation: { op: 'remove_item', itemId: 'itm_eggs' } }, deps());
    assert.equal(removed.cart.items.length, 3);
    assert.equal(toCartView(removed.cart).basket?.lines.length, 3);

    const cleared = await applyUiCartEdit(testDb.db, session._id, { expectedRevision: removed.cart.revision, operation: { op: 'clear' } }, deps());
    assert.equal(toCartView(cleared.cart).status, 'EMPTY');
  });

  test('without a matcher model, edits still save and the missing recalculation is reported', async () => {
    const { session } = await createSession(testDb.db);
    const empty = await getOrCreateCart(testDb.db, session._id);
    const item = { ...referenceItems()[0]!, preferences: ['Yotvata'], constraintEvidence: [{ type: 'PREFERENCE' as const, kind: 'BRAND' as const, sourceText: 'Yotvata', value: 'Yotvata' }], requirements: [] };
    await saveCart(testDb.db, session._id, empty.revision, { ...mutableFields(empty), items: [item], itemsVersion: 1 });
    const result = await applyUiCartEdit(testDb.db, session._id, { expectedRevision: 1, operation: { op: 'set_mode', mode: 'cheapest' } }, { matcher: { callModel: null, model: 'unconfigured' } });
    assert.equal(result.cart.mode, 'cheapest');
    assert.match(String(result.recalculationError), /GEMINI_API_KEY/u);
    assert.equal(toCartView(result.cart).status, 'NEEDS_CALCULATION');
  });
});
