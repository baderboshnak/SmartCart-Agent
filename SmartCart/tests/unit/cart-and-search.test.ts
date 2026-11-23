import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { tokenize } from '@engine/smartcart-search.mjs';
import { buildSearchFilter, searchPhrases } from '@/lib/db/products.repository';
import { ExtractedItemSchema, UpdateCartArgsSchema, UpdateCartDeclarationSchema, toGeminiSchema } from '@/lib/agent/schemas';
import { toFunctionDeclarations } from '@/lib/agent/loop';
import { createShoppingTools } from '@/lib/agent/tools';
import { contentHash, offerIdentity, toCatalogRecord, toProductDocument } from '@/lib/catalog/normalize';
import { validateCatalogRecords } from '@/lib/catalog/import';
import type { Cart } from '@/lib/shared/types';
import { applyCartOperations, formatQuantity } from '@/lib/shopping/cart-ops';
import { toEngineItems } from '@/lib/shopping/engine-items';
import { toCartView } from '@/lib/shopping/cart-view';
import { catalogFixture, cartItem } from '../helpers/fixtures';

function emptyCart(): Cart {
  const now = new Date('2026-11-19T10:00:00Z');
  return { _id: 'cart_x', sessionId: 's', revision: 3, itemsVersion: 5, mode: 'balanced', maxPremiumPct: 15, budget: null, items: [], recipePlans: [], selectedStoreKey: null, calculation: null, createdAt: now, updatedAt: now, expiresAt: now };
}

describe('cart operations', () => {
  test('adding, changing and removing items bumps itemsVersion and keeps ids stable', () => {
    const added = applyCartOperations(emptyCart(), [{
      op: 'add_items',
      items: [
        { product: 'milk', searchTerms: ['חלב'], sourceText: 'milk', requirements: [], preferences: [], constraintEvidence: [], quantity: { amount: 2, unit: 'l' }, choiceGroup: 'choice-0' },
        { product: 'oat milk', searchTerms: ['משקה שיבולת שועל'], sourceText: 'oat milk', requirements: [], preferences: [], constraintEvidence: [], quantity: { amount: 2, unit: 'l' }, choiceGroup: 'choice-0' }
      ]
    }]);
    assert.equal(added.cart.itemsVersion, 6);
    assert.equal(added.cart.items.length, 2);
    const group = added.cart.items[0]!.choiceGroup;
    assert.ok(group?.startsWith('grp_'));
    assert.equal(added.cart.items[1]!.choiceGroup, group);
    assert.deepEqual(toEngineItems(added.cart.items).map(item => item.choiceGroup), ['choice-0', 'choice-0']);

    const [first, second] = added.cart.items;
    const changed = applyCartOperations(added.cart, [{ op: 'set_quantity', itemId: first!.id, quantity: { amount: 3, unit: 'l' } }]);
    assert.equal(changed.cart.items[0]!.quantity.amount, 3);
    const removed = applyCartOperations(changed.cart, [{ op: 'remove_items', itemIds: [second!.id] }]);
    assert.equal(removed.cart.items.length, 1);
    assert.equal(removed.cart.items[0]!.choiceGroup, undefined, 'a single remaining alternative is no longer a group');
    assert.throws(() => applyCartOperations(removed.cart, [{ op: 'remove_items', itemIds: ['itm_missing'] }]), /No cart item/u);
  });

  test('selecting a store does not invalidate the calculation; mode changes do', () => {
    const cart = { ...emptyCart(), items: [cartItem({ product: 'milk', searchTerms: ['חלב'], quantity: { amount: 1, unit: 'l' } })] };
    assert.equal(applyCartOperations(cart, [{ op: 'select_store', storeKey: 'a:b:c:d' }]).calculationAffected, false);
    const mode = applyCartOperations(cart, [{ op: 'set_mode', mode: 'cheapest' }]);
    assert.equal(mode.calculationAffected, true);
    assert.equal(mode.cart.mode, 'cheapest');
    assert.throws(() => applyCartOperations(cart, [{ op: 'set_mode', mode: 'balanced', maxPremiumPct: 150 }]), /maxPremiumPct/u);
  });

  test('recipe ingredients become cart items; optional ones stay in the plan only', () => {
    const result = applyCartOperations(emptyCart(), [{
      op: 'add_recipe',
      plan: { dish: 'pizza', servings: 4, servingsSource: 'EXPLICIT', requestText: 'pizza for 4 people' },
      ingredients: [
        { name: 'flour', product: 'flour', searchTerms: ['קמח'], requirements: [], preferences: [], constraintEvidence: [], quantity: { amount: 500, unit: 'g' }, optional: false },
        { name: 'basil', product: 'basil', searchTerms: ['בזיליקום'], requirements: [], preferences: [], constraintEvidence: [], quantity: { amount: 0, unit: 'unspecified' }, optional: true }
      ]
    }]);
    assert.equal(result.cart.items.length, 1);
    assert.equal(result.cart.items[0]!.origin.type, 'RECIPE');
    assert.equal(result.cart.recipePlans[0]!.ingredients.length, 2);
    assert.match(result.changes[0]!, /Optional, not added: basil/u);
  });

  test('the client view never claims a stale calculation is current', () => {
    const cart = { ...emptyCart(), items: [cartItem({ product: 'milk', searchTerms: ['חלב'], quantity: { amount: 1, unit: 'l' } })] };
    const view = toCartView(cart);
    assert.equal(view.status, 'NEEDS_CALCULATION');
    assert.equal(view.basket, null);
    assert.equal(formatQuantity({ amount: 2, maxAmount: 3, unit: 'l' }), '2–3 l');
    assert.equal(formatQuantity({ amount: 0, unit: 'unspecified' }), 'one package');
  });
});

describe('MongoDB search filter', () => {
  test('mirrors the engine: exact tokens under 4 characters, prefixes from 4, phrases ORed', () => {
    const filter = buildSearchFilter(searchPhrases(['חלב', 'מוצרלה מגורדת']));
    assert.deepEqual(filter, { $or: [
      { $and: [{ searchTokens: 'חלב' }] },
      { $and: [{ searchTokens: { $regex: '^מוצרלה' } }, { searchTokens: { $regex: '^מגורדת' } }] }
    ] });
    const scoped = buildSearchFilter(searchPhrases(['ביצים']), ['shufersal:1:2:3']);
    assert.deepEqual(scoped, { $and: [{ $and: [{ searchTokens: { $regex: '^ביצים' } }] }, { storeKey: { $in: ['shufersal:1:2:3'] } }] });
    assert.throws(() => buildSearchFilter([]), /search terms/u);
  });

  test('tokenization splits attached numbers like the engine', () => {
    assert.deepEqual(tokenize('חלב3% תנובה 1 לי'), ['חלב', '3', 'תנובה', '1', 'לי']);
    assert.deepEqual(searchPhrases(['3%', '  ', '500 גרם']), [['3'], ['500', 'גרם']]);
  });
});

describe('catalog normalization', () => {
  test('product documents keep the original record and add search fields', () => {
    const source = catalogFixture[0]!;
    const document = toProductDocument(source, { sourceFile: 'f.json', sourceSha256: 'abc', now: new Date() });
    assert.equal(document._id, offerIdentity(source));
    assert.equal(document.pricing.listedPriceCents, Math.round(source.pricing.listedPriceIls * 100));
    assert.deepEqual(document.searchTokens, [...new Set(tokenize(source.name))]);
    assert.deepEqual(toCatalogRecord(document as unknown as Record<string, unknown>), source);
    assert.equal(document.catalog.contentHash, contentHash(source));
  });

  test('validation rejects bad identities and conflicting duplicates without guessing', () => {
    const good = catalogFixture[0]!;
    const conflicting = { ...good, name: `${good.name} changed` };
    const wrongId = { ...catalogFixture[1]!, _id: 'not-the-identity' };
    const missingPrice = { ...catalogFixture[2]!, pricing: {} };
    const result = validateCatalogRecords([good, good, conflicting, wrongId, missingPrice, catalogFixture[3]]);
    assert.equal(result.duplicateIdenticalRecords, 1);
    assert.deepEqual(result.conflictingDuplicateIds, [good._id]);
    assert.equal(result.records.length, 1);
    assert.equal(result.rejected.length, 3);
  });
});

describe('agent tool declarations', () => {
  test('use only the JSON Schema keywords Gemini accepts', () => {
    const allowed = new Set(['type', 'properties', 'required', 'items', 'enum', 'description', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'anyOf', 'title']);
    // Walk schema objects only; enum and required hold plain values.
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      for (const [key, value] of Object.entries(node)) {
        assert.ok(allowed.has(key), `Unsupported keyword ${key} at ${path}`);
        if (key === 'properties') for (const [name, schema] of Object.entries(value as object)) walk(schema, `${path}.${name}`);
        else if (key === 'items') walk(value, `${path}[]`);
        else if (key === 'anyOf') (value as unknown[]).forEach((schema, index) => walk(schema, `${path}|${index}`));
      }
    };
    const declarations = toFunctionDeclarations(createShoppingTools({} as never));
    assert.deepEqual(declarations.map(declaration => declaration.name), [
      'getCurrentCart', 'updateCart', 'searchProducts', 'matchProducts', 'calculatePurchaseOptions', 'optimizeBasket', 'compareStores', 'explainRecommendation', 'requestClarification'
    ]);
    for (const declaration of declarations) walk(declaration.parametersJsonSchema, declaration.name!);
    assert.ok(JSON.stringify(toGeminiSchema(UpdateCartDeclarationSchema)).includes('add_recipe'));
  });

  test('strict validation rejects malformed operations', () => {
    assert.equal(UpdateCartArgsSchema.safeParse({ operations: [{ op: 'remove_items', itemIds: ['itm_1'] }] }).success, false, 'userQuote is required');
    assert.equal(UpdateCartArgsSchema.safeParse({ operations: [{ op: 'set_mode', mode: 'cheapest', userQuote: 'make it cheaper' }] }).success, true);
    assert.equal(UpdateCartArgsSchema.safeParse({ operations: [{ op: 'drop_database' }] }).success, false);
    assert.equal(ExtractedItemSchema.safeParse({ sourceText: 'milk', product: 'milk', coreSearchTerm: 'חלב', quantity: { amount: 1, unit: 'gallon' } }).success, false);
  });
});
