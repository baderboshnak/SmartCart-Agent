import { createHash } from 'node:crypto';

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}

export function itemFingerprint(item) {
  return fingerprint(item);
}

function budgetFields(value) {
  const { budgetIls, budgetExclusive } = value;
  if (budgetIls === undefined && budgetExclusive === undefined) return {};
  const cents = Math.round(budgetIls * 100);
  if (!Number.isFinite(budgetIls) || budgetIls < 0 || !Number.isSafeInteger(cents) ||
      Math.abs(budgetIls * 100 - cents) > 1e-7 ||
      (budgetExclusive !== undefined && typeof budgetExclusive !== 'boolean')) {
    throw new Error('Invalid shopping budget. Use a nonnegative ILS amount with at most two decimal places.');
  }
  return { budgetIls, ...(budgetExclusive === undefined ? {} : { budgetExclusive }) };
}

export function createItemContext(plan, itemIndex) {
  if (!Array.isArray(plan?.items) || !Number.isInteger(itemIndex) ||
      itemIndex < 0 || !plan.items[itemIndex]) {
    throw new Error('Invalid itemIndex in shopping-request.json.');
  }
  return {
    requestFingerprint: fingerprint(plan),
    itemFingerprint: itemFingerprint(plan.items[itemIndex]),
    itemIndex,
    itemCount: plan.items.length,
    ...budgetFields(plan)
  };
}

export function assertItemContext(context, item) {
  const { requestFingerprint, itemIndex, itemCount } = context ?? {};
  if (typeof requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
      !Number.isInteger(itemCount) || itemCount < 1 ||
      !Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= itemCount ||
      !item || context.itemFingerprint !== itemFingerprint(item)) {
    throw new Error('Pipeline context does not identify this shopping item and request.');
  }
  budgetFields(context);
}

function validIdentifier(value) {
  return Number.isSafeInteger(value) || (typeof value === 'string' && value.trim() &&
    !value.includes(':') && value.trim().toLowerCase() !== 'unknown');
}

export function exactStoreKey(offer) {
  const parts = [offer?.retailer, offer?.chainId, offer?.subChainId, offer?.storeId];
  if (!parts.every(validIdentifier)) return null;
  return parts.map(part => String(part).trim()).join(':');
}

export function offerId(offer) {
  for (const id of [offer?._id, offer?.id]) {
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  const storeKey = exactStoreKey(offer);
  return storeKey && validIdentifier(offer.productCode)
    ? `${storeKey}:${String(offer.productCode).trim()}` : null;
}

export function hasConfirmedRequirements(offer, item) {
  const checks = offer?.requirementChecks;
  const requirements = item?.requirements;
  return offer?.identityStatus === 'MATCH' &&
    Array.isArray(requirements) && Array.isArray(checks) &&
    checks.length === requirements.length &&
    requirements.every(requirement => checks.filter(check =>
      check?.requirement === requirement && check.result === 'MET').length === 1);
}
