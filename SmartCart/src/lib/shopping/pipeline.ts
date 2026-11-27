import type { Db } from 'mongodb';
import type { CallModel, MatchRow } from '@engine/smartcart-matcher.mjs';
import type { QuantityPriceOptions } from '@engine/smartcart-quantity-price.mjs';
import type { EngineItem, ItemContext } from '@engine/engine-types.mjs';
import { itemFingerprint } from '@engine/smartcart-pipeline-context.mjs';
import { findProductsByIds } from '@/lib/db/products.repository';
import { sha256, storeDisplayName } from '@/lib/catalog/normalize';
import { formatDuration, type TerminalTrace } from '@/lib/server/terminal-trace';
import { ConfigurationError, ValidationError } from '@/lib/shared/errors';
import type { Cart, CartCalculation, CartItem, ItemDiagnostics } from '@/lib/shared/types';
import { buildEnginePlan, engineItemCore } from '@/lib/shopping/engine-items';
import { createLimiter, type Limiter } from '@/lib/shopping/limiter';
import { matchItemCandidates, type MatchOutcome } from '@/lib/shopping/matching';
import { optimizeCart } from '@/lib/shopping/optimizer';
import { buildItemOptions, summarizeItemOptions } from '@/lib/shopping/quantity';
import { searchItemCandidates, type SearchOutcome } from '@/lib/shopping/search';
import { productIdsIn, verifyBasketResult } from '@/lib/shopping/validation';

export interface PipelineProgress {
  stage: 'search' | 'match' | 'price' | 'optimize' | 'verify';
  message: string;
  itemId?: string;
  processed?: number;
  total?: number;
}

/** Most matcher model calls running at once for one cart (one agent run or cart edit). */
export const DEFAULT_MAX_CONCURRENT_MODEL_CALLS = 12;

export interface PipelineDeps {
  db: Db;
  /**
   * Product matcher. Without a model, only cached decisions can be used. The server's
   * matcher (getMatcher) also applies the server-wide limit inside this cart's own limit.
   */
  matcher: { callModel: CallModel | null; model: string };
  signal?: AbortSignal;
  onProgress?: (progress: PipelineProgress) => void;
  trace?: TerminalTrace;
  /** Most matcher model calls running at once for this cart, across all its items (default 12). */
  maxConcurrentModelCalls?: number;
}

/**
 * Deterministic shopping pipeline for one cart: MongoDB search -> matching ->
 * quantity and price -> single-store optimization -> independent verification.
 * Stage results are memoized for the lifetime of one agent run or UI request.
 */
export class CartPipeline {
  private readonly searches = new Map<string, Promise<SearchOutcome>>();
  private readonly matches = new Map<string, Promise<MatchOutcome>>();
  private readonly limit: Limiter;
  modelCalls = 0;

  constructor(private readonly deps: PipelineDeps) {
    this.limit = createLimiter(deps.maxConcurrentModelCalls ?? DEFAULT_MAX_CONCURRENT_MODEL_CALLS);
  }

  private progress(progress: PipelineProgress) {
    this.deps.onProgress?.(progress);
  }

  search(item: CartItem): Promise<SearchOutcome> {
    const { db, trace } = this.deps;
    const key = JSON.stringify(item.searchTerms);
    let pending = this.searches.get(key);
    if (!pending) {
      trace?.('pipeline.search.started', { itemId: item.id });
      this.progress({ stage: 'search', itemId: item.id, message: `Looking for ${item.product} in the stores` });
      pending = searchItemCandidates(db, engineItemCore(item));
      pending.then(outcome => {
        trace?.('pipeline.search.completed', {
          itemId: item.id, candidates: outcome.candidates.length, totalMatches: outcome.totalMatched,
          truncated: outcome.truncated, durationMs: outcome.durationMs
        });
        if (trace && trace.mode !== 'off') {
          trace.detail(`Search for "${item.product}": ${outcome.candidates.length} candidates in ${formatDuration(outcome.durationMs)}`, {
            searchTerms: item.searchTerms,
            stores: outcome.perStore,
            candidates: outcome.candidates.map(({ _id, name }) => ({ id: _id, name }))
          });
        }
      }, error => {
        this.searches.delete(key);
        trace?.('pipeline.search.failed', { itemId: item.id }, 'warn');
        trace?.detail(`search for "${item.product}" failed`, error, 'warn');
      });
      this.searches.set(key, pending);
    } else {
      trace?.('pipeline.search.reused', { itemId: item.id });
    }
    return pending;
  }

  async match(item: CartItem): Promise<{ search: SearchOutcome; match: MatchOutcome }> {
    const { db, signal, trace } = this.deps;
    const search = await this.search(item);
    const core = engineItemCore(item);
    const key = `${itemFingerprint(core)}:${sha256(search.candidates.map(candidate => candidate._id).join(','))}`;
    let pending = this.matches.get(key);
    if (!pending) {
      const { callModel, model } = this.deps.matcher;
      const limited: CallModel = callModel
        ? args => this.limit.run(() => callModel(args), signal)
        : async () => { throw new ConfigurationError('Product matching needs GEMINI_API_KEY on the server.'); };
      trace?.('pipeline.match.started', { itemId: item.id, candidates: search.candidates.length });
      this.progress({ stage: 'match', itemId: item.id, processed: 0, total: search.candidates.length, message: `Checking ${search.candidates.length} possible products for ${item.product}` });
      pending = matchItemCandidates(core, search.candidates, {
        db,
        callModel: limited,
        model,
        signal,
        onProgress: ({ processed, total }) => {
          if (processed > 0) trace?.('pipeline.match.progress', { itemId: item.id, processed, total });
          this.progress({ stage: 'match', itemId: item.id, processed, total, message: `Checked ${processed} of ${total} products for ${item.product}` });
        },
        onRetry: retry => {
          trace?.('pipeline.match.retry', { itemId: item.id, attempt: retry.attempt, missing: retry.missing }, 'warn');
          trace?.detail(`product check for "${item.product}": attempt ${retry.attempt} failed, asking Gemini again`, retry, 'warn');
        },
        onReading: ({ reading, reused, error }) => {
          trace?.('pipeline.match.reading', { itemId: item.id, read: Boolean(reading), reused }, reading ? 'info' : 'warn');
          if (reading) trace?.detail(`Gemini read "${item.product}" as${reused ? ' (earlier reading)' : ''}`, reading);
          else trace?.detail(`could not read "${item.product}" first; each batch reads it alone`, error ?? 'no reading in the answer', 'warn');
        }
      });
      pending.then(outcome => {
        this.modelCalls += outcome.modelCalls;
        trace?.('pipeline.match.completed', {
          itemId: item.id, matched: outcome.results.matches.length, rejected: outcome.results.rejected.length,
          uncertain: outcome.results.uncertain.length, cacheHits: outcome.cachedDecisions,
          sharedWithOtherRequest: outcome.sharedDecisions, modelCalls: outcome.modelCalls, durationMs: outcome.durationMs
        });
        if (trace && trace.mode !== 'off') {
          const { matches, uncertain, rejected } = outcome.results;
          const verdict = ({ product, reason, requirementChecks, preferencesMet }: MatchRow) => ({
            product: product.name, id: product._id, reason,
            ...(requirementChecks.length ? { requirementChecks } : {}),
            ...(preferencesMet.length ? { preferencesMet } : {})
          });
          trace.detail(`Product checks for "${item.product}": ${matches.length} matched, ${uncertain.length} unsure, ${rejected.length} rejected`, {
            ...(outcome.results.requestReadings?.length ? { geminiReadTheRequestAs: outcome.results.requestReadings } : {}),
            savedDecisionsReused: outcome.cachedDecisions,
            ...(outcome.sharedDecisions ? { decisionsSharedWithAnotherCustomer: outcome.sharedDecisions } : {}),
            geminiCalls: outcome.modelCalls,
            matched: matches.map(verdict), uncertain: uncertain.map(verdict), rejected: rejected.map(verdict)
          });
        }
      }, error => {
        this.matches.delete(key);
        trace?.('pipeline.match.failed', { itemId: item.id }, 'warn');
        trace?.detail(`product check for "${item.product}" failed`, error, 'warn');
      });
      this.matches.set(key, pending);
    } else {
      trace?.('pipeline.match.reused', { itemId: item.id });
    }
    return { search, match: await pending };
  }

  /** Purchase options for one item in the context of the whole cart. */
  async options(cart: Cart, item: CartItem): Promise<{ options: QuantityPriceOptions; search: SearchOutcome; match: MatchOutcome }> {
    const index = cart.items.findIndex(entry => entry.id === item.id);
    if (index === -1) throw new ValidationError(`Item ${item.id} is not in the cart.`);
    const { plan, contexts } = buildEnginePlan(cart);
    const { search, match } = await this.match(item);
    return { options: this.price(item.id, match, plan.items[index]!, contexts[index]!), search, match };
  }

  private price(itemId: string, match: MatchOutcome, item: EngineItem, context: ItemContext): QuantityPriceOptions {
    const { trace } = this.deps;
    trace?.('pipeline.price.started', { itemId });
    const started = Date.now();
    const options = buildItemOptions(match.results, item, context);
    trace?.('pipeline.price.completed', { itemId, options: options.optionCount, skipped: options.skipped.length, durationMs: Date.now() - started });
    if (trace && trace.mode !== 'off') {
      trace.detail(`Package and price options for "${item.product}"`, summarizeItemOptions(options));
    }
    return options;
  }

  async calculate(cart: Cart): Promise<CartCalculation> {
    const { db, signal, trace } = this.deps;
    const started = Date.now();
    if (!cart.items.length) throw new ValidationError('The cart has no items to calculate.');
    const { plan, contexts } = buildEnginePlan(cart);
    const outcomes = await Promise.all(cart.items.map(item => this.match(item)));
    signal?.throwIfAborted();

    const files: QuantityPriceOptions[] = [];
    const diagnostics: ItemDiagnostics[] = [];
    const snapshotDates = new Set<string>();
    let minDate: string | null = null;
    let maxDate: string | null = null;
    cart.items.forEach((item, index) => {
      const { search, match } = outcomes[index]!;
      this.progress({ stage: 'price', itemId: item.id, message: `Working out packages and prices for ${item.product}` });
      const options = this.price(item.id, match, plan.items[index]!, contexts[index]!);
      files.push(options);
      diagnostics.push({
        itemId: item.id,
        product: item.product,
        candidates: search.candidates.length,
        totalMatched: search.totalMatched,
        truncated: search.truncated,
        matched: match.results.matches.length,
        uncertain: match.results.uncertain.length,
        rejected: match.results.rejected.length,
        pricedOptions: options.optionCount,
        skippedOptions: options.skipped.length,
        cachedDecisions: match.cachedDecisions,
        modelCalls: match.modelCalls,
        uncertainExamples: match.results.uncertain.slice(0, 3).map(row => `${row.product.name}: ${row.reason}`)
      });
      for (const candidate of search.candidates) {
        if (candidate.snapshotDate) snapshotDates.add(candidate.snapshotDate);
        const date = candidate.priceUpdatedAt;
        if (date && (!minDate || date < minDate)) minDate = date;
        if (date && (!maxDate || date > maxDate)) maxDate = date;
      }
    });

    trace?.('pipeline.optimize.started', { items: cart.items.length, mode: cart.mode });
    this.progress({ stage: 'optimize', message: 'Comparing complete baskets in each store' });
    const optimizeStarted = Date.now();
    const result = optimizeCart(files, plan, cart.mode, cart.maxPremiumPct);
    trace?.('pipeline.optimize.completed', {
      completeStores: result.storeComparisons.length, excludedStores: result.excludedStores.length, durationMs: Date.now() - optimizeStarted
    });
    const recommended = result.recommendedBasket;
    trace?.detail('basket comparison', {
      recommended: recommended ? `${storeDisplayName(recommended.retailer, recommended.storeId)}: ₪${recommended.totalPriceIls}` : 'none',
      ...(result.storeComparisons.length ? {
        'stores with everything': result.storeComparisons.map(store => `${storeDisplayName(store.retailer, store.storeId)}: from ₪${store.cheapest.totalPriceIls}`)
      } : {}),
      ...(result.excludedStores.length ? {
        'stores missing items': result.excludedStores.map(store =>
          `${storeDisplayName(store.retailer, store.storeKey.split(':')[3] ?? '')}: ${store.missingItems.map(missing => missing.product).join(', ') || store.reason || 'incomplete'}`)
      } : {})
    });
    trace?.('pipeline.verify.started');
    this.progress({ stage: 'verify', message: 'Double-checking every price against the catalog' });
    const verifyStarted = Date.now();
    const products = await findProductsByIds(db, productIdsIn(result));
    const verification = verifyBasketResult({
      result, items: plan.items, products, mode: cart.mode, maxPremiumPct: cart.maxPremiumPct, budget: cart.budget
    });
    const status = !verification.passed ? 'VERIFICATION_FAILED' : result.recommendedBasket ? 'COMPLETE' : 'NO_COMPLETE_BASKET';
    trace?.('pipeline.verify.completed', {
      status, checkedBaskets: verification.checkedBaskets, checkedLines: verification.checkedLines,
      failures: verification.failures.length, durationMs: Date.now() - verifyStarted
    }, verification.passed ? 'info' : 'warn');
    if (!verification.passed) trace?.detail('the basket double-check found problems', verification.failures, 'warn');
    return {
      status,
      itemsVersion: cart.itemsVersion,
      requestFingerprint: contexts[0]!.requestFingerprint,
      mode: cart.mode,
      maxPremiumPct: cart.maxPremiumPct,
      itemIds: cart.items.map(item => item.id),
      result,
      verification,
      itemDiagnostics: diagnostics,
      catalog: { snapshotDates: [...snapshotDates].sort(), priceUpdatedAtRange: { min: minDate, max: maxDate } },
      calculatedAt: new Date(),
      durationMs: Date.now() - started
    };
  }
}
