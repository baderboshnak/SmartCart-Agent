import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCatalog, searchCatalog } from '@engine/smartcart-search.mjs';
import type { CatalogRecord } from '@engine/engine-types.mjs';
import { sha256 } from '@/lib/catalog/normalize';
import type { CartItem } from '@/lib/shared/types';

const fixtureUrl = new URL('../fixtures/catalog-sample.json', import.meta.url);
const fixtureBuffer = readFileSync(fileURLToPath(fixtureUrl));

/** Every catalog offer matching the fixture terms, extracted from the real snapshot. */
export const catalogFixture: CatalogRecord[] = JSON.parse(fixtureBuffer.toString('utf8'));
export const catalogFixtureSha256 = sha256(fixtureBuffer);

export const STORES = {
  shufersal: 'shufersal:7290027600007:002:413',
  ramiLevy: 'rami_levy:7290058140886:001:039'
} as const;

const engineCatalog = buildCatalog(catalogFixture);

/** In-memory search with the original engine (same semantics as the MongoDB search). */
export function fixtureSearch(terms: string[]): CatalogRecord[] {
  return searchCatalog(engineCatalog, { searchTerms: terms }).results;
}

export function record(id: string): CatalogRecord {
  const found = catalogFixture.find(entry => entry._id === id);
  if (!found) throw new Error(`Fixture has no offer ${id}`);
  return found;
}

let counter = 0;
export function cartItem(fields: Partial<CartItem> & Pick<CartItem, 'product' | 'searchTerms' | 'quantity'>): CartItem {
  const requirements = fields.requirements ?? [];
  const preferences = fields.preferences ?? [];
  return {
    id: fields.id ?? `itm_test_${++counter}`,
    requirements,
    preferences,
    constraintEvidence: fields.constraintEvidence ?? [
      ...requirements.map(value => ({ type: 'REQUIREMENT' as const, kind: /tnuva/iu.test(value) ? 'BRAND' as const : 'OTHER' as const, sourceText: value, value })),
      ...preferences.map(value => ({ type: 'PREFERENCE' as const, kind: /tnuva/iu.test(value) ? 'BRAND' as const : 'OTHER' as const, sourceText: value, value }))
    ],
    origin: { type: 'DIRECT' },
    addedAt: new Date('2026-11-19T10:00:00Z'),
    ...fields
  };
}

/** The four items of the reference request, as validated cart lines. */
export function referenceItems(): CartItem[] {
  return [
    cartItem({ id: 'itm_milk', product: 'milk', searchTerms: ['חלב'], quantity: { amount: 2, unit: 'l' }, requirements: ['3%'], preferences: ['Tnuva'], sourceText: '2 liters of 3% milk, preferably Tnuva' }),
    cartItem({ id: 'itm_eggs', product: 'eggs', searchTerms: ['ביצים'], quantity: { amount: 12, unit: 'units' }, sourceText: '12 eggs' }),
    cartItem({ id: 'itm_bread', product: 'bread', searchTerms: ['לחם'], quantity: { amount: 500, unit: 'g' }, sourceText: '500 grams of bread' }),
    cartItem({ id: 'itm_mozzarella', product: 'mozzarella', searchTerms: ['מוצרלה'], quantity: { amount: 500, unit: 'g' }, requirements: ['shredded'], sourceText: '500 grams of shredded mozzarella' })
  ];
}
