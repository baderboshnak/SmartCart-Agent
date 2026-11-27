// Side-effect-free validation of an extracted shopping plan against the exact
// request wording. Shared by the CLI extractor and the web agent's cart tools.
import { normalizeRequestedQuantity } from './smartcart-package.mjs';
import { isCatalogSearchTerm } from './smartcart-search.mjs';
import {
  assertProductPhrase, assertRequestedQuantity, REQUEST_UNITS, validateRequestEvidence
} from './smartcart-request-coverage.mjs';

export function validateSourceInventory(raw, userRequest) {
  if (!raw || !Array.isArray(raw.items) || !raw.items.length) {
    throw new Error('LLM response is missing a nonempty items array.');
  }
  const spans = validateRequestEvidence(userRequest, raw.items);
  return raw.items.map((item, i) => {
    const { amount, unit, maxAmount } = item.quantity ?? {};
    const validQuantity = unit === 'unspecified' ? amount === 0 && maxAmount === undefined
      : normalizeRequestedQuantity(item.quantity);
    if (!REQUEST_UNITS.includes(unit) || !validQuantity) {
      throw new Error(`items[${i}].quantity is invalid.`);
    }
    assertRequestedQuantity(item, i);
    const { requirements, preferences, constraints, choiceGroup } = spans[i];
    return {
      sourceText: item.sourceText,
      requirements,
      preferences,
      constraintEvidence: constraints.map(x => x.evidence),
      quantity: { amount, unit, ...(maxAmount === undefined ? {} : { maxAmount }) },
      ...(choiceGroup === undefined ? {} : { choiceGroup })
    };
  });
}

export function validateShoppingPlan(raw, userRequest) {
  const inventory = validateSourceInventory(raw, userRequest);
  const items = raw.items.map((item, i) => {
    assertProductPhrase(item, i);
    const coreSearchTerm = typeof item.coreSearchTerm === 'string'
      ? item.coreSearchTerm.trim() : '';
    if (!coreSearchTerm || !/[֐-׿]/u.test(coreSearchTerm) || !isCatalogSearchTerm(coreSearchTerm)) {
      throw new Error(`items[${i}].coreSearchTerm must be a nonempty Hebrew product phrase.`);
    }
    if (!Array.isArray(item.searchTerms) || !item.searchTerms.every(term => typeof term === 'string')) {
      throw new Error(`items[${i}].searchTerms must be a string array.`);
    }
    // An extra phrase with Arabic letters can never match a Hebrew catalog name, so it is dropped.
    const searchTerms = [...new Set([coreSearchTerm, ...item.searchTerms.map(term => term.trim()).filter(Boolean).filter(isCatalogSearchTerm)])];
    return { product: item.product.trim(), searchTerms, ...inventory[i] };
  });
  return { userRequest, items };
}
