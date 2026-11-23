import type { Db } from 'mongodb';
import type { CallModel } from '@engine/smartcart-matcher.mjs';
import type { QuantityPriceOptions } from '@engine/smartcart-quantity-price.mjs';
import { itemFingerprint } from '@engine/smartcart-pipeline-context.mjs';
import { findProductsByIds } from '@/lib/db/products.repository';
import { sha256 } from '@/lib/catalog/normalize';
import { ConfigurationError, ValidationError } from '@/lib/shared/errors';
import type { Cart, CartCalculation, CartItem, ItemDiagnostics } from '@/lib/shared/types';
import { buildEnginePlan, engineItemCore } from '@/lib/shopping/engine-items';
import { createLimiter, type Limiter } from '@/lib/shopping/limiter';
import { matchItemCandidates, type MatchOutcome } from '@/lib/shopping/matching';
import { optimizeCart } from '@/lib/shopping/optimizer';
import { buildItemOptions } from '@/lib/shopping/quantity';
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
    const key = JSON.stringify(item.searchTerms);
    let pending = this.searches.get(key);
    if (!pending) {
      this.progress({ stage: 'search', itemId: item.id, message: `Looking for ${item.product} in the stores` });
      pending = searchItemCandidates(this.deps.db, engineItemCore(item));
      pending.catch(() => this.searches.delete(key));
      this.searches.set(key, pending);
    }
    return pending;
  }

  async match(item: CartItem): Promise<{ search: SearchOutcome; match: MatchOutcome }> {
    const search = await this.search(item);
    const core = engineItemCore(item);
    const key = `${itemFingerprint(core)}:${sha256(search.candidates.map(candidate => candidate._id).join(','))}`;
    let pending = this.matches.get(key);
    if (!pending) {
      const { callModel, model } = this.deps.matcher;
      const limited: CallModel = callModel
        ? args => this.limit.run(() => callModel(args), this.deps.signal)
        : async () => { throw new ConfigurationError('Product matching needs GEMINI_API_KEY on the server.'); };
      this.progress({ stage: 'match', itemId: item.id, processed: 0, total: search.candidates.length, message: `Checking ${search.candidates.length} possible products for ${item.product}` });
      pending = matchItemCandidates(core, search.candidates, {
        db: this.deps.db,
        callModel: limited,
        model,
        signal: this.deps.signal,
        onProgress: ({ processed, total }) => this.progress({
          stage: 'match', itemId: item.id, processed, total, message: `Checked ${processed} of ${total} products for ${item.product}`
        })
      });
      pending.then(outcome => { this.modelCalls += outcome.modelCalls; }, () => this.matches.delete(key));
      this.matches.set(key, pending);
    }
    return { search, match: await pending };
  }

  /** Purchase options for one item in the context of the whole cart. */
  async options(cart: Cart, item: CartItem): Promise<{ options: QuantityPriceOptions; search: SearchOutcome; match: MatchOutcome }> {
    const index = cart.items.findIndex(entry => entry.id === item.id);
    if (index === -1) throw new ValidationError(`Item ${item.id} is not in the cart.`);
    const { plan, contexts } = buildEnginePlan(cart);
    const { search, match } = await this.match(item);
    return { options: buildItemOptions(match.results, plan.items[index]!, contexts[index]!), search, match };
  }

  async calculate(cart: Cart): Promise<CartCalculation> {
    const started = Date.now();
    if (!cart.items.length) throw new ValidationError('The cart has no items to calculate.');
    const { plan, contexts } = buildEnginePlan(cart);
    const outcomes = await Promise.all(cart.items.map(item => this.match(item)));
    this.deps.signal?.throwIfAborted();

    const files: QuantityPriceOptions[] = [];
    const diagnostics: ItemDiagnostics[] = [];
    const snapshotDates = new Set<string>();
    let minDate: string | null = null;
    let maxDate: string | null = null;
    cart.items.forEach((item, index) => {
      const { search, match } = outcomes[index]!;
      this.progress({ stage: 'price', itemId: item.id, message: `Working out packages and prices for ${item.product}` });
      const options = buildItemOptions(match.results, plan.items[index]!, contexts[index]!);
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

    this.progress({ stage: 'optimize', message: 'Comparing complete baskets in each store' });
    const result = optimizeCart(files, plan, cart.mode, cart.maxPremiumPct);
    this.progress({ stage: 'verify', message: 'Double-checking every price against the catalog' });
    const products = await findProductsByIds(this.deps.db, productIdsIn(result));
    const verification = verifyBasketResult({
      result, items: plan.items, products, mode: cart.mode, maxPremiumPct: cart.maxPremiumPct, budget: cart.budget
    });
    return {
      status: !verification.passed ? 'VERIFICATION_FAILED' : result.recommendedBasket ? 'COMPLETE' : 'NO_COMPLETE_BASKET',
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
