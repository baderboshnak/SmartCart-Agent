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

export function decision(id, { identity = 'MATCH', checks = [], preferences = [] } = {}) {
  return { id, identity, requirementChecks: checks, reason: 'Local fixture', preferencesMet: preferences };
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
