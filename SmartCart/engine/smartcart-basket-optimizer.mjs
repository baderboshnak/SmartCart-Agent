/**
 * SmartCart Step 5 – Complete Basket Optimizer (Node.js ESM; no API/dependencies)
 *
 * Usage:
 *   node smartcart-basket-optimizer.mjs shopping-options.json
 *   node smartcart-basket-optimizer.mjs --mode balanced --max-premium-pct 15 shopping-options-0.json shopping-options-1.json
 *   node smartcart-basket-optimizer.mjs --mode preferences-first --output basket-results.json shopping-options-0.json shopping-options-1.json
 *
 * Input: one Step-4 shopping-options.json file PER requested shopping item.
 * - No cross-store mixing, even between branches of the same chain.
 * - Only fixed-size packages are eligible for automatic recommendations.
 * - Weighted offers are reported as unverified estimates only.
 * - Preferences are SOFT, mandatory matching is handled by Step 3.
 * - Mixed fixed-package SKUs are supported within ONE requested item and store.
 * - Prices are catalog snapshots, not live availability or checkout offers.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAmount, normalizeRequestedQuantity } from './smartcart-package.mjs';
import { assertItemContext, createItemContext, exactStoreKey, hasConfirmedRequirements } from './smartcart-pipeline-context.mjs';

const DEFAULT_PREMIUM_PERCENT = 15;
const MAX_STATES_PER_ITEM_STORE = 30000;
const MAX_PREFERENCES_PER_ITEM = 15;
const round = (n, digits = 3) => Number(n.toFixed(digits));
const toCents = value => Math.round(value * 100);
const money = cents => round(cents / 100, 2);

// Thousandths of the normalized base unit prevent binary float comparison errors.
function quantityTicks(quantity, unit) {
  const normalized = normalizeAmount(quantity, unit);
  return normalized && { ...normalized, ticks: Math.round(normalized.amountBase * 1000) };
}

function requestedTicks(quantity) {
  const normalized = normalizeRequestedQuantity(quantity);
  if (!normalized) return null;
  return {
    ...normalized,
    ticks: Math.round(normalized.amountBase * 1000),
    maxTicks: normalized.maxAmountBase === null ? null : Math.round(normalized.maxAmountBase * 1000)
  };
}

function norm(s) { return String(s ?? '').normalize('NFKC').toLocaleLowerCase().trim(); }
function satisfiedByMask(preferences, mask) { return preferences.filter((_, i) => mask & (1 << i)); }

function preferenceMask(option, preferences) {
  const have = new Set((Array.isArray(option.preferencesMet) ? option.preferencesMet : []).map(norm));
  return preferences.reduce((mask, pref, i) => mask | (have.has(norm(pref)) ? (1 << i) : 0), 0);
}

function compareStates(a, b) {
  return a.costCents - b.costCents || a.totalTicks - b.totalTicks || a.packages - b.packages ||
    a.key.localeCompare(b.key);
}

class MinHeap {
  constructor() { this.values = []; }
  push(node) {
    const a = this.values; a.push(node); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (compareStates(a[p], node) <= 0) break; a[i] = a[p]; i = p; }
    a[i] = node;
  }
  pop() {
    const a = this.values; if (!a.length) return null;
    const top = a[0], last = a.pop();
    if (!a.length) return top;
    let i = 0;
    while (true) {
      let child = i * 2 + 1; if (child >= a.length) break;
      if (child + 1 < a.length && compareStates(a[child + 1], a[child]) < 0) child++;
      if (compareStates(last, a[child]) <= 0) break;
      a[i] = a[child]; i = child;
    }
    a[i] = last; return top;
  }
  get length() { return this.values.length; }
}

function makePackagedProducts(file, store, target, preferences) {
  const unique = new Map();
  for (const o of store.options ?? []) {
    if (!o || o.type !== 'PACKAGED' || (o.status !== 'CALCULATED_FIXED_PACKAGES' &&
        !(o.status === 'MIXED_PACKAGES_ONLY' && target?.maxTicks != null))) continue;
    if (o.package?.isWeighted === true) continue;
    if ((file.context || file.item.requirements?.length) && !hasConfirmedRequirements(o, file.item)) continue;
    if (typeof o.productId !== 'string' || !o.productId.trim()) continue;
    if (!Number.isFinite(o.listedPriceIls) || o.listedPriceIls <= 0) continue;
    const p = quantityTicks(o.package?.quantity, o.package?.unit);
    if (!p || (target && p.family !== target.family)) continue;
    if (target?.maxTicks != null && p.ticks > target.maxTicks) continue;
    const product = {
      ...o, ticks: p.ticks, baseUnit: p.base,
      costCents: toCents(o.listedPriceIls), mask: preferenceMask(o, preferences)
    };
    if (!Number.isSafeInteger(product.costCents) || product.costCents <= 0) continue;
    // Same package size and same preferences: a more expensive SKU cannot improve the basket.
    const key = `${product.ticks}|${product.mask}`;
    const previous = unique.get(key);
    if (!previous || product.costCents < previous.costCents ||
        (product.costCents === previous.costCents && product.productId < previous.productId)) {
      unique.set(key, product);
    }
  }
  return [...unique.values()].sort((a,b) => a.costCents-b.costCents || a.productId.localeCompare(b.productId));
}

function optionFromPurchases(products, counts, totalTicks, costCents, mask, requested, preferences) {
  const lines = counts.map((count, index) => ({ p:products[index], count })).filter(r => r.count);
  const packages = lines.map(({p,count}) => ({
    productId: p.productId, productName:p.productName, productCode:p.productCode,
    packageCount:count,
    package: p.package,
    originalPackage: p.originalPackage,
    packageInterpretation: p.packageInterpretation,
    identityStatus: p.identityStatus,
    requirementChecks: p.requirementChecks,
    priceUpdatedAt: p.priceUpdatedAt,
    snapshotDate: p.snapshotDate,
    linePriceIls: money(p.costCents*count),
    listedUnitPriceIls:money(p.costCents),
    preferencesMet: p.preferencesMet ?? []
  }));
  const satisfied = satisfiedByMask(preferences, mask);
  return {
    costCents,
    totalPriceIls: money(costCents),
    preferencesSatisfiedCount: satisfied.length,
    preferencesSatisfied: satisfied,
    preferencesMissed: preferences.filter(x => !satisfied.includes(x)),
    packageCount: lines.reduce((n,r) => n+r.count,0),
    purchasedQuantity: requested ? {amount:round(totalTicks/1000,3),unit:requested.base} : {amount:1,unit:'unspecified purchase'},
    overbuy: requested ? {
      amount: round(Math.max(0, totalTicks - (requested.maxTicks ?? requested.ticks)) / 1000, 3),
      unit: requested.base
    } : null,
    products:packages
  };
}

/** Find the cheapest mixed-SKU fixed-package plan for each possible satisfied-preference count. */
function optimizeItemStore(file, store) {
  const item = file.item;
  const preferences = Array.isArray(item.preferences) ? [...new Set(item.preferences.filter(x => typeof x==='string' && x.trim()))] : [];
  if (preferences.length > MAX_PREFERENCES_PER_ITEM) {
    throw new Error(`Item ${item.product} has >${MAX_PREFERENCES_PER_ITEM} preferences; cannot optimize safely.`);
  }
  const q = item.quantity ?? {};
  const unspecified = q.amount === 0 && q.maxAmount === undefined && ['unspecified',''].includes(norm(q.unit));
  const target = unspecified ? null : requestedTicks(q);
  if (!unspecified && !target) throw new Error(`Unsupported requested quantity for ${item.product}: ${JSON.stringify(q)}`);
  const products = makePackagedProducts(file,store,target,preferences);
  if (!products.length) return { variants:[],reason:'No qualifying fixed-price packages in this store' };
  const bestByScore = new Map();

  function offer(a) {
    const old = bestByScore.get(a.preferencesSatisfiedCount);
    if (!old || a.costCents < old.costCents ||
        (a.costCents === old.costCents && a.purchasedQuantity.amount < old.purchasedQuantity.amount) ||
        (a.costCents === old.costCents && a.purchasedQuantity.amount === old.purchasedQuantity.amount &&
          a.packageCount < old.packageCount)) {
      bestByScore.set(a.preferencesSatisfiedCount, a);
    }
  }
  if (!target) {
    for (let i=0;i<products.length;i++) {
      const counts = products.map((_,j) => i===j?1:0);
      offer(optionFromPurchases(products,counts,products[i].ticks,products[i].costCents,products[i].mask,null,preferences));
    }
    return {variants:[...bestByScore.values()].sort((a,b)=>a.costCents-b.costCents),reason:null};
  }

  // Unbounded shortest path on (quantity capped to target, satisfied-preferences mask).
  // Cap to target because purchasing more than requested never improves an option.
  const initialMask = (1 << preferences.length) - 1;
  const first = { key:`0|${initialMask}`,sum:0,mask:initialMask,totalTicks:0,
    costCents:0,packages:0,counts:new Array(products.length).fill(0) };
  const heap = new MinHeap(); heap.push(first);
  const best = new Map([[first.key, first]]);
  let overflowed = false;
  while (heap.length) {
    const current = heap.pop();
    if (best.get(current.key) !== current) continue;
    if (current.sum >= target.ticks) {
      offer(optionFromPurchases(products,current.counts,current.totalTicks,current.costCents,current.mask,target,preferences));
      continue;
    }
    for (let i=0;i<products.length;i++) {
      const p = products[i];
      const totalTicks = current.totalTicks + p.ticks;
      if (target.maxTicks !== null && totalTicks > target.maxTicks) continue;
      const costCents = current.costCents + p.costCents;
      if (!Number.isSafeInteger(totalTicks) || !Number.isSafeInteger(costCents)) {
        overflowed = true;
        continue;
      }
      const sum = Math.min(target.ticks, totalTicks);
      const mask = current.mask & p.mask;
      const key = `${sum}|${mask}`;
      const next = {
        key,sum,mask,totalTicks,
        costCents,packages:current.packages+1,
        counts:null
      };
      const old = best.get(key);
      if (old && compareStates(old,next) <= 0) continue;
      next.counts = current.counts.slice(); next.counts[i]++;
      best.set(key,next); heap.push(next);
      if (best.size > MAX_STATES_PER_ITEM_STORE) {
        throw new Error(`Too many package combinations for ${item.product} in ${store.storeKey}. ` +
          'Reduce quantities or add a more efficient package optimizer; no unsafe approximation saved.');
      }
    }
  }
  return {
    variants: [...bestByScore.values()].sort((a, b) => a.costCents - b.costCents),
    reason: bestByScore.size ? null : overflowed
      ? 'No fixed-package combination can be priced within safe integer limits'
      : 'No fixed-package combination meets the requested quantity range'
  };
}

function groupItems(itemFiles) {
  const groups = new Map();
  for (const [itemIndex, file] of itemFiles.entries()) {
    const choice = file.item.choiceGroup;
    const key = choice === undefined ? itemIndex : choice;
    const group = groups.get(key) ?? [];
    if (choice !== undefined &&
        (choice !== `choice-${group[0]?.itemIndex ?? itemIndex}` ||
          (group.length && group.at(-1).itemIndex !== itemIndex - 1))) {
      throw new Error(`Invalid or nonconsecutive shopping choice group at item ${itemIndex}.`);
    }
    group.push({ file, itemIndex });
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    if (typeof key === 'string' && group.length < 2) {
      throw new Error(`Shopping choice group ${key} requires at least two alternatives.`);
    }
  }
  return [...groups.values()];
}

function combineStore(store, itemOffers) {
  // DP across items: keep the cheapest basket for each total number of soft preferences met.
  let totals = new Map([[0,{score:0,costCents:0,lines:[],packageCount:0,preferencesPossible:0}]]);
  for (const variants of itemOffers) {
    const newTotals = new Map();
    for (const current of totals.values()) for (const option of variants) {
      const score = current.score + option.preferencesSatisfiedCount;
      const costCents = current.costCents + option.costCents;
      if (!Number.isSafeInteger(costCents)) continue;
      const plan = {
        score,
        costCents,
        packageCount:current.packageCount+option.packageCount,
        preferencesPossible: current.preferencesPossible + option.preferencesSatisfied.length + option.preferencesMissed.length,
        lines:[...current.lines, option]
      };
      const old = newTotals.get(score);
      if (!old || plan.costCents<old.costCents ||
          (plan.costCents===old.costCents && plan.packageCount<old.packageCount)) newTotals.set(score,plan);
    }
    totals = newTotals;
  }
  return [...totals.values()].map(b => ({
    storeKey:store.storeKey,retailer:store.retailer,chainId:store.chainId,
    subChainId:store.subChainId,storeId:store.storeId,
    totalPriceIls:money(b.costCents),costCents:b.costCents,
    preferencesSatisfied:b.score,
    preferencesPossible:b.preferencesPossible,
    packageCount:b.packageCount,items:b.lines,
    status:'CALCULATED_FIXED_PACKAGES_NOT_LIVE_AVAILABILITY'
  }));
}

function storeGroupOffers(group, available) {
  const variants = [];
  const failures = [];
  for (const { file, itemIndex } of group) {
    const { item } = file;
    const store = available[itemIndex];
    const offer = store ? optimizeItemStore(file, store)
      : { variants: [], reason: 'No matching products from this store' };
    for (const option of offer.variants) {
      variants.push({
        itemIndex,
        item: item.product,
        ...(item.choiceGroup !== undefined ? { choiceGroup: item.choiceGroup } : {}),
        requestedQuantity: item.quantity,
        ...option
      });
    }
    if (!offer.variants.length) {
      failures.push({
        itemIndex,
        product: item.product,
        ...(item.choiceGroup !== undefined ? { choiceGroup: item.choiceGroup } : {}),
        reason: offer.reason
      });
    }
  }
  return { variants, failures };
}

function byCheapest(a,b) {
  return a.costCents-b.costCents || b.preferencesSatisfied-a.preferencesSatisfied ||
    a.packageCount-b.packageCount || a.storeKey.localeCompare(b.storeKey);
}
function byPreferences(a,b) {
  return b.preferencesSatisfied-a.preferencesSatisfied || a.costCents-b.costCents ||
    a.packageCount-b.packageCount || a.storeKey.localeCompare(b.storeKey);
}
function summaryBasket(basket) {
  if (!basket) return null;
  const {costCents,...rest} = basket;
  return rest;
}

function orderedItemFiles(files, request) {
  if (!files.some(file => file.context !== undefined)) {
    if (request) throw new Error('Regenerate shopping-options files to verify them against the shopping request.');
    return files;
  }
  const { requestFingerprint, itemCount, budgetIls, budgetExclusive } = files[0].context ?? {};
  const byIndex = new Map();
  for (const file of files) {
    assertItemContext(file.context, file.item);
    const context = file.context;
    const index = context.itemIndex;
    if (requestFingerprint !== context.requestFingerprint || itemCount !== context.itemCount) {
      throw new Error('Shopping-options files belong to different shopping requests.');
    }
    if (budgetIls !== context.budgetIls || budgetExclusive !== context.budgetExclusive) {
      throw new Error('Shopping-options files disagree on the shopping budget.');
    }
    if (request) {
      const expected = createItemContext(request, index);
      if (expected.requestFingerprint !== requestFingerprint || expected.itemCount !== itemCount) {
        throw new Error('Shopping-options files belong to a different shopping request.');
      }
      if (expected.itemFingerprint !== context.itemFingerprint) {
        throw new Error(`Shopping-options file does not match the request item at index ${index}.`);
      }
      if (expected.budgetIls !== context.budgetIls || expected.budgetExclusive !== context.budgetExclusive) {
        throw new Error('Shopping-options budget does not match the shopping request.');
      }
    }
    if (byIndex.has(index)) throw new Error(`Duplicate shopping-options file for item ${index}.`);
    byIndex.set(index, file);
    const storeKeys = new Set();
    for (const store of file.stores) {
      const key = exactStoreKey(store);
      if (!key || key !== store.storeKey || storeKeys.has(key) || !Array.isArray(store.options) ||
          store.options.some(option => exactStoreKey(option) !== key || option.storeKey !== key)) {
        throw new Error(`Invalid or inconsistent store identity in shopping-options for item ${index}.`);
      }
      storeKeys.add(key);
    }
  }
  if (byIndex.size !== itemCount) {
    throw new Error(`Expected options for all ${itemCount} shopping items. Received ${byIndex.size}.`);
  }
  return [...byIndex.values()].sort((a, b) => a.context.itemIndex - b.context.itemIndex);
}

/**
 * Accept Step-4 outputs as an ordered array (one file per requested item).
 * Default balanced: among complete baskets costing at most 15% above the
 * absolute cheapest complete fixed-package basket, maximize fulfilled preferences,
 * then minimize total price. Customer can choose cheapest/preferences-first modes.
 */
export function optimizeBaskets(itemFiles, {mode='balanced',maxPremiumPct=DEFAULT_PREMIUM_PERCENT,request}={}) {
  if (!Array.isArray(itemFiles) || !itemFiles.length ||
      itemFiles.some(f => !f || !f.item || !Array.isArray(f.stores))) {
    throw new Error('Provide at least one valid Step-4 shopping-options.json file, one per item.');
  }
  if (!['balanced','cheapest','preferences-first'].includes(mode)) throw new Error('Mode must be balanced, cheapest or preferences-first.');
  if (!Number.isFinite(maxPremiumPct) || maxPremiumPct < 0 || maxPremiumPct > 100) {
    throw new Error('maxPremiumPct must be a number between 0 and 100.');
  }
  itemFiles = orderedItemFiles(itemFiles, request);
  const groups = groupItems(itemFiles);
  const { budgetIls, budgetExclusive } = itemFiles[0].context ?? {};
  const budgetCents = budgetIls === undefined ? null : toCents(budgetIls) - Number(budgetExclusive === true);
  const storeKeys = [...new Set(itemFiles.flatMap(f => f.stores.map(s => s.storeKey)))].sort();
  const completeVariants = [], excludedStores = [], storeSummaries = [];
  let cheapestOverBudgetCents = null;
  for (const storeKey of storeKeys) {
    const available = itemFiles.map(f=>(f.stores??[]).find(s => s.storeKey===storeKey));
    const firstStore = available.find(Boolean);
    const groupOffers = groups.map(group => storeGroupOffers(group, available));
    const missingItems = groupOffers.flatMap(group => group.variants.length ? [] : group.failures);
    if (missingItems.length) {
      excludedStores.push({storeKey,retailer:firstStore.retailer,missingItems});
      continue;
    }
    const allVariants = combineStore(firstStore, groupOffers.map(group => group.variants));
    if (!allVariants.length) {
      excludedStores.push({
        storeKey, retailer: firstStore.retailer, missingItems: [],
        reason: 'The complete basket price exceeds safe integer limits.'
      });
      continue;
    }
    const variants = budgetCents === null ? allVariants : allVariants.filter(basket => basket.costCents <= budgetCents);
    if (!variants.length) {
      const lowestCost = allVariants.reduce((least, basket) => Math.min(least, basket.costCents), Infinity);
      cheapestOverBudgetCents = Math.min(cheapestOverBudgetCents ?? Infinity, lowestCost);
      excludedStores.push({
        storeKey, retailer: firstStore.retailer, missingItems: [],
        reason: 'The cheapest confirmed complete basket exceeds the shopping budget.',
        lowestCompletePriceIls: money(lowestCost)
      });
      continue;
    }
    completeVariants.push(...variants);
    storeSummaries.push({storeKey,retailer:variants[0].retailer,storeId:variants[0].storeId,
      cheapest:summaryBasket([...variants].sort(byCheapest)[0]),
      preferencesFirst:summaryBasket([...variants].sort(byPreferences)[0])});
  }
  const cheapest = [...completeVariants].sort(byCheapest)[0]??null;
  const maxCostCents = cheapest
    ? Math.min(budgetCents ?? Number.MAX_SAFE_INTEGER,
      Math.floor(cheapest.costCents * (1 + maxPremiumPct / 100) + 1e-7)) : null;
  const withinBudget = completeVariants.filter(x => x.costCents <= maxCostCents);
  const balanced = [...withinBudget].sort(byPreferences)[0]??null;
  const preferencesFirst = [...completeVariants].sort(byPreferences)[0]??null;
  const chosen = {balanced,cheapest,'preferences-first':preferencesFirst}[mode];
  const weightedEstimatesExcluded = itemFiles.flatMap((f,i) => f.stores.flatMap(s => s.options
    .filter(o => o.type === 'WEIGHTED')
    .map(o => ({itemIndex:i,product:f.item.product,storeKey:s.storeKey,
      productName:o.productName,estimatedPriceIls:o.totalPriceIls,
      status:'ESTIMATE_REQUIRES_QUANTITY_CONFIRMATION'}))));
  return {
    settings:{mode,maxPremiumPct,balancedUsesGlobalBasketPremium:true,
      pricingField:'pricing.listedPriceIls',weightedAutomaticallyPurchasable:false,
      ...(budgetIls === undefined ? {} : { budgetIls, budgetExclusive: budgetExclusive === true }),
      note:'All complete baskets are restricted to one exact store. Prices are catalog snapshots, not live availability, promotions, delivery fees or checkout.'},
    requestedItems:itemFiles.map((f,i)=>({itemIndex:i,product:f.item.product,
      requirements:f.item.requirements??[],preferences:f.item.preferences??[],quantity:f.item.quantity,
      ...(f.item.choiceGroup !== undefined ? { choiceGroup: f.item.choiceGroup } : {}),
      sourceText:f.item.sourceText,constraintEvidence:f.item.constraintEvidence})),
    storesCompared:storeKeys.length,completeStores:storeSummaries.length,
    noCompleteBasket:!cheapest,
    cheapestCompleteBasket:summaryBasket(cheapest),
    balancedBasket:summaryBasket(balanced),
    preferencesFirstBasket:summaryBasket(preferencesFirst),
    recommendedBasket:summaryBasket(chosen),
    balancedMaxPriceIls:maxCostCents===null?null:money(maxCostCents),
    storeComparisons:storeSummaries,
    excludedStores,
    weightedEstimatesExcluded,
    ...(cheapestOverBudgetCents === null ? {} : { cheapestOverBudgetIls: money(cheapestOverBudgetCents) }),
    warning: cheapest ? null : cheapestOverBudgetCents !== null
      ? 'No confirmed complete basket fits the shopping budget.'
      : 'No exact store provides confirmed fixed-package options for every requested item; SmartCart must not silently combine stores or use uncertain products.'
  };
}

function usage() {
  return `Usage:\n  node smartcart-basket-optimizer.mjs [--mode balanced|cheapest|preferences-first] [--max-premium-pct 15] [--request shopping-request.json] [--output basket-results.json] shopping-options-0.json [shopping-options-1.json ...]\n\nDefault mode: balanced; default max basket price premium: 15%.`;
}
async function main() {
  const args=process.argv.slice(2), inputs=[];
  let mode='balanced',maxPremiumPct=DEFAULT_PREMIUM_PERCENT,output='basket-results.json',requestPath;
  for (let i=0;i<args.length;i++) {
    const arg=args[i];
    if (arg==='--mode') mode=args[++i];
    else if (arg==='--max-premium-pct') maxPremiumPct=Number(args[++i]);
    else if (arg==='--output') output=args[++i];
    else if (arg==='--request') {
      requestPath = args[++i];
      if (!requestPath || requestPath.startsWith('--')) throw new Error(usage());
    }
    else if (arg==='--help'||arg==='-h') {console.log(usage());return;}
    else if (arg.startsWith('--')) throw new Error('Unknown option: '+arg+'\n'+usage());
    else inputs.push(arg);
  }
  if (!inputs.length || !output || !mode) throw new Error(usage());
  const files=[];
  for (const path of inputs) files.push(JSON.parse(await readFile(resolve(/*turbopackIgnore: true*/ path),'utf8')));
  if (files.some(file => !file?.context)) {
    throw new Error('Shopping-options files lack request context. Regenerate them through search, match and quantity.');
  }
  const request = requestPath ? JSON.parse(await readFile(resolve(/*turbopackIgnore: true*/ requestPath), 'utf8')) : undefined;
  const result=optimizeBaskets(files,{mode,maxPremiumPct,request});
  await writeFile(resolve(/*turbopackIgnore: true*/ output),JSON.stringify(result,null,2)+'\n','utf8');
  console.log(`Saved ${resolve(/*turbopackIgnore: true*/ output)} | ${result.completeStores} complete store(s) of ${result.storesCompared} checked.`);
  if (result.recommendedBasket) {
    const b=result.recommendedBasket;
    console.log(`Recommended (${mode}): ${b.retailer} / ${b.storeId} — ₪${b.totalPriceIls} | preferences ${b.preferencesSatisfied}/${b.preferencesPossible}`);
    console.log(`Cheapest complete fixed-package basket: ₪${result.cheapestCompleteBasket.totalPriceIls}.`);
    for (const item of b.items) console.log(`  ${item.item}: ${item.products.map(p=>`${p.packageCount}× ${p.productName}`).join(' + ')} — ₪${item.totalPriceIls}`);
  } else console.log('No complete fixed-package basket available. See excludedStores in JSON.');
  if (result.weightedEstimatesExcluded.length) console.log(`Note: ${result.weightedEstimatesExcluded.length} weighted offers excluded (unverified).`);
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
}
