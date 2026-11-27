export function catalogOffer(id, name, {
  store = '101', retailer = 'market', chain = '10', subChain = '20', code = id,
  size = 1, unit = 'units', price = 10, weighted = false, manufacturer
} = {}) {
  return {
    _id: id,
    name,
    productCode: code,
    retailer,
    chainId: chain,
    subChainId: subChain,
    storeId: store,
    manufacturer: manufacturer ? { name: manufacturer } : undefined,
    package: { quantity: size, unit, isWeighted: weighted },
    pricing: { listedPriceIls: price }
  };
}

export function shoppingItem(product, amount = 0, unit = 'unspecified', {
  terms = [product], requirements = [], preferences = [], maxAmount
} = {}) {
  return {
    product,
    searchTerms: terms,
    requirements,
    preferences,
    quantity: { amount, unit, ...(maxAmount === undefined ? {} : { maxAmount }) }
  };
}

export function claim(requirement, evidence = requirement, {
  kind = 'OTHER', result = 'MET', source = 'NAME'
} = {}) {
  return { requirement, kind, result, evidenceSource: source, evidence };
}

const RELATION_FOR = { MATCH: 'SAME_PRODUCT', NO_MATCH: 'RELATED_DIFFERENT', UNCERTAIN: 'UNCLEAR' };

/**
 * A Gemini-shaped matcher decision. Pass the product (or { id, name }) so the identity
 * quote comes from its name; a bare ID needs `evidence` for a confirmed MATCH.
 */
export function decision(target, {
  identity = 'MATCH', checks = [], preferences = [], relation = RELATION_FOR[identity],
  evidence, candidate = 'Local fixture'
} = {}) {
  const product = typeof target === 'string' ? { id: target } : target;
  return {
    id: product.id ?? product._id, candidate, identityEvidence: evidence ?? product.name ?? '',
    relation, identity, requirementChecks: checks, preferencesMet: preferences
  };
}

export function submittedCandidates(prompt) {
  return JSON.parse(prompt.slice(prompt.lastIndexOf('\nProducts: ') + '\nProducts: '.length));
}

export function confirmedOffer(product, { requirements = [], preferences = [] } = {}) {
  return {
    product,
    identityStatus: 'MATCH',
    requirementChecks: requirements.map(requirement => claim(requirement)),
    preferencesMet: preferences
  };
}
