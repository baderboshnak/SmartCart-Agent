import type { Db } from 'mongodb';
import { getOrCreateCart, mutableFields, saveCart } from '@/lib/db/carts.repository';
import { ValidationError } from '@/lib/shared/errors';
import type { Cart, CartItem } from '@/lib/shared/types';
import { applyCartOperations, formatQuantity, type CartOperation } from '@/lib/shopping/cart-ops';
import { summarizeCalculationForAgent, summarizeCartForAgent } from '@/lib/shopping/cart-view';
import { isCalculationFresh, modeLabel, selectBasket } from '@/lib/shopping/optimizer';
import type { CartPipeline, PipelineProgress } from '@/lib/shopping/pipeline';
import { summarizeItemOptions } from '@/lib/shopping/quantity';
import {
  asksWhichVersion, assertShoppingPlanHeadcount, assertUserQuote, findMention, isHeadcountCorrection, validateConstraintUpdate, validateDirectItems, validateQuantity, validateRecipePlan,
  validateSearchTerms
} from '@/lib/shopping/request-items';
import { exploreProducts } from '@/lib/shopping/search';
import type { TerminalTrace } from '@/lib/server/terminal-trace';
import { storeDisplayName } from '@/lib/catalog/normalize';
import {
  AddItemsArgsSchema, AddItemsInputSchema, AddRecipeArgsSchema, AddRecipeInputSchema, ClarificationArgsSchema, ClearCartArgsSchema, EmptyArgsSchema,
  ExplainArgsSchema, ItemIdsArgsSchema, RemoveItemsArgsSchema, ResizeShoppingPlanArgsSchema, SearchProductsArgsSchema, SearchProductsDeclarationSchema,
  SelectStoreArgsSchema, SetBudgetArgsSchema, SetConstraintsArgsSchema, SetModeArgsSchema, SetQuantityArgsSchema,
  SetSearchTermsArgsSchema, UpdateCartArgsSchema, UpdateCartDeclarationSchema, type CartOperationInput
} from '@/lib/agent/schemas';
import type { AgentTool, ToolExecutionContext, ToolResult } from '@/lib/agent/loop';
import type { z } from 'zod';

export interface ShoppingToolContext {
  db: Db;
  sessionId: string;
  userMessage: { id: string; text: string };
  hasPendingClarification?: boolean;
  pipeline: CartPipeline;
  trace?: TerminalTrace;
  /** Pipeline progress is forwarded to the tool that is currently running. */
  setProgressTarget: (target: ((progress: PipelineProgress) => void) | null) => void;
  onCartSaved: (cart: Cart) => void;
  /** Quotes and request spans already applied in this run. */
  coveredQuotes: string[];
}

const storeName = (storeKey: string) => {
  const [retailer = storeKey, , , storeId = ''] = storeKey.split(':');
  return storeDisplayName(retailer, storeId);
};

function itemsById(cart: Cart, ids: string[]): CartItem[] {
  return ids.map(id => {
    const item = cart.items.find(entry => entry.id === id);
    if (!item) throw new ValidationError(`No cart item has id ${id}. Current ids: ${cart.items.map(entry => `${entry.id} (${entry.product})`).join(', ') || 'none'}.`);
    return item;
  });
}

function mentionsAmount(text: string, amount: number): boolean {
  return new RegExp(`(?<![\\d.,])${String(amount).replace('.', '[.,]')}(?![\\d])`, 'u').test(text);
}

/** Convert one validated tool operation into a cart operation, enforcing grounding rules. */
function toCartOperation(input: CartOperationInput, cart: Cart, context: ShoppingToolContext, covered: string[]): CartOperation {
  const message = context.userMessage.text;
  const others = covered.filter(quote => quote !== ('requestText' in input ? input.requestText : undefined));
  switch (input.op) {
    case 'add_items':
      return { op: 'add_items', items: validateDirectItems({ requestText: input.requestText, items: input.items }, message, others), messageId: context.userMessage.id };
    case 'add_recipe': {
      // A short headcount can also answer a question for a new plan already in progress.
      if (!context.hasPendingClarification && isHeadcountCorrection(message)) {
        const activePlans = cart.recipePlans.filter(plan =>
          cart.items.some(item => item.origin.type === 'RECIPE' && item.origin.recipePlanId === plan.id)
        );
        if (activePlans.length === 1) {
          throw new ValidationError(`This is a headcount correction for the existing plan ${activePlans[0]!.id}. Use resizeShoppingPlan with its current item IDs.`);
        }
        if (activePlans.length > 1) {
          throw new ValidationError('This message only gives a headcount. Determine which existing plan it refers to before using resizeShoppingPlan. Ask for clarification if the plan is unclear.');
        }
      }
      const { plan, ingredients } = validateRecipePlan({ requestText: input.requestText, ...input.recipe }, message, others);
      return { op: 'add_recipe', plan, ingredients };
    }
    case 'resize_plan':
      assertShoppingPlanHeadcount(message, input.userQuote, input.servings);
      return { op: 'resize_plan', planId: input.planId, servings: input.servings,
        quantities: input.quantities.map(entry => ({ itemId: entry.itemId, quantity: validateQuantity(entry.quantity) })) };
    case 'remove_items':
      assertUserQuote(message, input.userQuote, 'Removing items');
      itemsById(cart, input.itemIds);
      return { op: 'remove_items', itemIds: input.itemIds };
    case 'set_quantity':
      assertUserQuote(message, input.userQuote, 'Changing a quantity');
      itemsById(cart, [input.itemId]);
      return { op: 'set_quantity', itemId: input.itemId, quantity: validateQuantity(input.quantity) };
    case 'set_constraints': {
      assertUserQuote(message, input.userQuote, 'Changing requirements or preferences');
      const [item] = itemsById(cart, [input.itemId]);
      return { op: 'set_constraints', itemId: input.itemId, ...validateConstraintUpdate(item!, input.constraints, message) };
    }
    case 'set_search_terms':
      itemsById(cart, [input.itemId]);
      return { op: 'set_search_terms', itemId: input.itemId, searchTerms: validateSearchTerms(input.searchTerms) };
    case 'set_mode':
      assertUserQuote(message, input.userQuote, 'Changing the shopping mode');
      return { op: 'set_mode', mode: input.mode, ...(input.maxPremiumPct === undefined ? {} : { maxPremiumPct: input.maxPremiumPct }) };
    case 'set_budget': {
      assertUserQuote(message, input.userQuote, 'Changing the budget');
      if (input.budgetIls === undefined) return { op: 'set_budget', budget: null };
      if (Math.abs(input.budgetIls * 100 - Math.round(input.budgetIls * 100)) > 1e-7) throw new ValidationError('budgetIls can have at most two decimals.');
      if (!mentionsAmount(message, input.budgetIls)) throw new ValidationError(`The budget ₪${input.budgetIls} is not stated in the customer's message.`);
      return { op: 'set_budget', budget: { amountIls: input.budgetIls, exclusive: input.budgetExclusive ?? false } };
    }
    case 'select_store': {
      assertUserQuote(message, input.userQuote, 'Selecting a store');
      if (!input.storeKey) return { op: 'select_store', storeKey: null };
      const complete = isCalculationFresh(cart) ? cart.calculation!.result.storeComparisons.map(store => store.storeKey) : [];
      if (!complete.includes(input.storeKey)) {
        throw new ValidationError(`Store ${input.storeKey} has no complete verified basket. Complete stores: ${complete.join(', ') || 'none (call optimizeBasket first)'}.`);
      }
      return { op: 'select_store', storeKey: input.storeKey };
    }
    case 'clear':
      assertUserQuote(message, input.userQuote, 'Clearing the cart');
      return { op: 'clear' };
  }
}

async function withProgress<T>(context: ShoppingToolContext, tool: ToolExecutionContext, work: () => Promise<T>): Promise<T> {
  context.setProgressTarget(progress => tool.progress(progress.message, progress.processed, progress.total));
  try {
    return await work();
  } finally {
    context.setProgressTarget(null);
  }
}

function tool<S extends z.ZodType>(definition: Omit<AgentTool, 'execute' | 'argsSchema'> & {
  argsSchema: S;
  execute: (args: z.infer<S>, context: ToolExecutionContext) => Promise<ToolResult>;
}): AgentTool {
  return definition as unknown as AgentTool;
}

/** Calculate, verify and persist the cart. Shared by optimizeBasket and run finalization. */
export async function calculateAndSave(context: ShoppingToolContext): Promise<Cart> {
  const cart = await getOrCreateCart(context.db, context.sessionId);
  if (!cart.items.length) return cart;
  const calculation = await context.pipeline.calculate(cart);
  context.trace?.('cart.calculation.saving', { revision: cart.revision, status: calculation.status, calculationMs: calculation.durationMs });
  const saved = await saveCart(context.db, context.sessionId, cart.revision, { ...mutableFields(cart), calculation });
  context.onCartSaved(saved);
  return saved;
}

/** The cart-changing tools Gemini is given; updateCart is their hidden batched form. */
export const CART_TOOL_NAMES = new Set([
  'addItems', 'addRecipe', 'resizeShoppingPlan', 'removeItems', 'setQuantity', 'setConstraints', 'setSearchTerms',
  'setShoppingMode', 'setBudget', 'selectStore', 'clearCart', 'updateCart'
]);

/**
 * Wording that another cart call in the same Gemini turn covers ("under ₪50" for a setBudget next
 * to an addRecipe), so it does not count as unassigned. Only wording from the message counts.
 */
function siblingQuotes(message: string, siblings: ToolExecutionContext['siblings']): string[] {
  const values = (siblings ?? []).filter(call => CART_TOOL_NAMES.has(call.name)).flatMap(call => {
    const operations = Array.isArray(call.args.operations) ? call.args.operations as Array<Record<string, unknown>> : [];
    return [call.args, ...operations].flatMap(entry => [entry?.requestText, entry?.userQuote]);
  });
  return values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()) && message.includes(value.trim()));
}

export function createShoppingTools(context: ShoppingToolContext): AgentTool[] {
  const loadCart = () => getOrCreateCart(context.db, context.sessionId);

  /** Validate, apply and save cart operations as one revision. Shared by every cart tool. */
  async function applyOperations(inputs: CartOperationInput[], extraQuotes: string[] = []): Promise<ToolResult> {
    const cart = await loadCart();
    const quotes = inputs.flatMap(operation =>
      'requestText' in operation ? [operation.requestText] : 'userQuote' in operation ? [operation.userQuote] : []);
    const covered = [...context.coveredQuotes, ...extraQuotes, ...quotes];
    const operations = inputs.map(operation => toCartOperation(operation, cart, context, covered));
    const { cart: next, changes, calculationAffected, addedItemIds } = applyCartOperations(cart, operations);
    context.trace?.('cart.edit.saving', { operations: operations.map(operation => operation.op).join(','), revision: cart.revision });
    const saved = await saveCart(context.db, context.sessionId, cart.revision, mutableFields(next));
    context.coveredQuotes.push(...quotes);
    context.onCartSaved(saved);
    return {
      data: {
        changes,
        ...(addedItemIds.length ? { addedItemIds } : {}),
        cart: summarizeCartForAgent(saved),
        ...(calculationAffected && saved.items.length ? { next: 'Call optimizeBasket before quoting prices.' } : {})
      },
      summary: changes.join(' ').slice(0, 280)
    };
  }

  /** One small tool per cart action: only the fields that action needs. */
  const cartAction = <S extends z.ZodType>(definition: {
    name: string; op: CartOperationInput['op']; description: string; argsSchema: S; declarationSchema?: z.ZodType; example?: string;
    validationRecovery?: string;
  }) => tool({
    name: definition.name, label: 'Updating your cart', description: definition.description,
    argsSchema: definition.argsSchema, declarationSchema: definition.declarationSchema, example: definition.example,
    validationRecovery: definition.validationRecovery, timeoutMs: 20_000,
    execute: (args, execution) => applyOperations([{ op: definition.op, ...(args as object) } as CartOperationInput],
      siblingQuotes(context.userMessage.text, execution.siblings))
  });

  return [
    tool({
      name: 'getCurrentCart',
      label: 'Looking at your cart',
      description: 'Read the authoritative cart from MongoDB: items with ids, quantities, requirements, preferences, mode and the verified calculation status.',
      argsSchema: EmptyArgsSchema,
      timeoutMs: 15_000,
      async execute() {
        const cart = await loadCart();
        return { data: summarizeCartForAgent(cart), summary: `${cart.items.length} item(s) in the cart` };
      }
    }),

    // The batched form of the cart tools below. Gemini is not offered it (its one flat schema made
    // the model misplace fields), but scripted tests and recorded conversations still call it.
    tool({
      name: 'updateCart',
      label: 'Updating your cart',
      description: 'Apply several cart operations together: add_items, add_recipe, remove_items, set_quantity, set_constraints, set_search_terms, set_mode, set_budget, select_store, clear.',
      argsSchema: UpdateCartArgsSchema,
      declarationSchema: UpdateCartDeclarationSchema,
      hidden: true,
      timeoutMs: 20_000,
      execute: (args, execution) => applyOperations(args.operations, siblingQuotes(context.userMessage.text, execution.siblings))
    }),

    cartAction({
      name: 'addItems', op: 'add_items',
      description: 'Add specific groceries the customer named in the latest message. Preserve stated purchase quantities. Use addRecipe when the customer delegates product selection or asks you to estimate how much to buy.',
      validationRecovery: 'If the customer asked you to choose products or estimate amounts, switch to addRecipe. Record any headcount as servings and estimate the purchase amounts separately.',
      argsSchema: AddItemsInputSchema, declarationSchema: AddItemsArgsSchema,
      example: JSON.stringify({ requestText: '2 liters of 3% milk and bread', items: [
        { sourceText: '2 liters of 3% milk', product: 'milk', coreSearchTerm: 'חלב',
          constraintEvidence: [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: '3%' }], quantity: { amount: 2, unit: 'l' } },
        { sourceText: 'bread', product: 'bread', coreSearchTerm: 'לחם', quantity: { amount: 0, unit: 'unspecified' } }
      ] })
    }),
    cartAction({
      name: 'addRecipe', op: 'add_recipe',
      description: 'Start a new shopping plan for a meal, group, occasion or delegated shopping choice. Keep the headcount in servings, calculate the amounts to buy separately, preserve the customer’s requirements, and explain estimates. Then call optimizeBasket.',
      validationRecovery: 'Fix the error before trying again. Use resizeShoppingPlan for a headcount correction to an existing plan. Ask for clarification when the plan or a required detail is unclear.',
      argsSchema: AddRecipeInputSchema, declarationSchema: AddRecipeArgsSchema
    }),
    cartAction({
      name: 'resizeShoppingPlan', op: 'resize_plan',
      description: 'Adjust the headcount and quantities of an existing shopping plan when the customer corrects its size. Use the plan ID and item IDs already in the cart. Keep the existing products and requirements. Then call optimizeBasket.',
      argsSchema: ResizeShoppingPlanArgsSchema,
      validationRecovery: 'Use the existing plan ID and all of its current item IDs. Quote the customer’s new headcount, or ask for clarification if the plan or count is unclear.'
    }),
    cartAction({
      name: 'removeItems', op: 'remove_items',
      description: 'Remove cart items, by the itemId values in the current cart.', argsSchema: RemoveItemsArgsSchema
    }),
    cartAction({
      name: 'setQuantity', op: 'set_quantity',
      description: 'Change the amount of one cart item ("make it 2 liters").', argsSchema: SetQuantityArgsSchema
    }),
    cartAction({
      name: 'setConstraints', op: 'set_constraints',
      description: 'Replace one item\'s complete list of requirements and preferences ("only Tnuva", "preferably 3%"). Keep its other constraints.',
      argsSchema: SetConstraintsArgsSchema
    }),
    cartAction({
      name: 'setSearchTerms', op: 'set_search_terms',
      description: 'Give one item better Hebrew catalog search terms when it has no candidates or no confirmed matches.',
      argsSchema: SetSearchTermsArgsSchema
    }),
    cartAction({
      name: 'setShoppingMode', op: 'set_mode',
      description: 'Choose how baskets are compared: balanced (default), cheapest ("make it cheaper") or preferences-first.',
      argsSchema: SetModeArgsSchema
    }),
    cartAction({
      name: 'setBudget', op: 'set_budget',
      description: 'Set the maximum basket total in shekels, or omit budgetIls to remove the budget.', argsSchema: SetBudgetArgsSchema
    }),
    cartAction({
      name: 'selectStore', op: 'select_store',
      description: 'Show the complete basket of one store (a storeKey from compareStores), or "" for the recommended store.',
      argsSchema: SelectStoreArgsSchema
    }),
    cartAction({
      name: 'clearCart', op: 'clear', description: 'Empty the cart.', argsSchema: ClearCartArgsSchema
    }),

    tool({
      name: 'searchProducts',
      label: 'Searching the stores',
      description: 'Search the MongoDB catalog. With itemIds, run full-recall retrieval for cart items using their stored Hebrew search terms and report candidate counts per store. With query, explore the catalog with free Hebrew phrases (returns up to 15 products with prices).',
      argsSchema: SearchProductsArgsSchema,
      declarationSchema: SearchProductsDeclarationSchema,
      timeoutMs: 30_000,
      async execute(args, toolContext) {
        const results: Record<string, unknown> = {};
        let summary = '';
        if (args.itemIds?.length) {
          const cart = await loadCart();
          const items = itemsById(cart, args.itemIds);
          const outcomes = await withProgress(context, toolContext, () => Promise.all(items.map(item => context.pipeline.search(item))));
          results.items = items.map((item, index) => {
            const outcome = outcomes[index]!;
            return {
              itemId: item.id,
              product: item.product,
              searchTerms: outcome.terms,
              candidates: outcome.candidates.length,
              ...(outcome.truncated ? { truncatedFrom: outcome.totalMatched, advice: 'Too broad; refine the Hebrew search terms.' } : {}),
              perStore: outcome.perStore,
              examples: outcome.candidates.slice(0, 6).map(record => `${record.name} (₪${record.pricing.listedPriceIls})`)
            };
          });
          summary = items.map((item, index) => `${item.product}: ${outcomes[index]!.totalMatched} possible matches`).join(', ');
        }
        if (args.query?.length) {
          context.trace?.('catalog.query.started', { phrases: args.query.length });
          const queryStarted = Date.now();
          const found = await exploreProducts(context.db, args.query, { storeKeys: args.storeKeys });
          context.trace?.('catalog.query.completed', { totalMatches: found.totalMatched, returned: found.results.length, durationMs: Date.now() - queryStarted });
          results.query = { phrases: args.query, totalMatched: found.totalMatched, results: found.results };
          summary = [summary, `"${args.query.join(', ')}": ${found.totalMatched} products`].filter(Boolean).join('; ');
        }
        return { data: results, summary };
      }
    }),

    tool({
      name: 'matchProducts',
      label: 'Checking each product',
      description: 'Classify the search candidates of cart items as MATCH, NO_MATCH or UNCERTAIN. Gemini checks product identity and each mandatory requirement; backend code verifies the evidence against catalog data. Unverified requirements are never treated as satisfied.',
      argsSchema: ItemIdsArgsSchema,
      timeoutMs: 180_000,
      async execute(args, toolContext) {
        const cart = await loadCart();
        const items = itemsById(cart, args.itemIds);
        const outcomes = await withProgress(context, toolContext, () => Promise.all(items.map(item => context.pipeline.match(item))));
        const data = items.map((item, index) => {
          const { search, match } = outcomes[index]!;
          return {
            itemId: item.id,
            product: item.product,
            requirements: item.requirements,
            candidates: search.candidates.length,
            matched: match.results.matches.length,
            uncertain: match.results.uncertain.length,
            rejected: match.results.rejected.length,
            cachedDecisions: match.cachedDecisions,
            matchedExamples: match.results.matches.slice(0, 5).map(row => `${row.product.name}${row.preferencesMet.length ? ` [prefers: ${row.preferencesMet.join(', ')}]` : ''}`),
            uncertainExamples: match.results.uncertain.slice(0, 3).map(row => `${row.product.name}: ${row.reason}`)
          };
        });
        return { data: { items: data }, summary: data.map(row => `${row.product}: ${row.matched} matched`).join(', ') };
      }
    }),

    tool({
      name: 'calculatePurchaseOptions',
      label: 'Working out package sizes',
      description: 'For matched products, calculate whole package counts, unit conversions, totals and extra quantity per store. Weighted offers are reported only as unverified estimates.',
      argsSchema: ItemIdsArgsSchema,
      timeoutMs: 180_000,
      async execute(args, toolContext) {
        const cart = await loadCart();
        const items = itemsById(cart, args.itemIds);
        const results = await withProgress(context, toolContext, async () => {
          const rows = [];
          for (const item of items) rows.push({ item, ...(await context.pipeline.options(cart, item)) });
          return rows;
        });
        const data = results.map(({ item, options }) => ({
          itemId: item.id, product: item.product, requested: formatQuantity(item.quantity), ...summarizeItemOptions(options)
        }));
        return { data: { items: data }, summary: data.map(row => `${row.product}: ${row.stores.length} store(s)`).join(', ') };
      }
    }),

    tool({
      name: 'optimizeBasket',
      label: 'Finding the best basket',
      description: 'Build complete single-store baskets for the whole cart in cheapest, balanced and preferences-first modes, verify them against MongoDB and save the result. Runs any missing search, matching and pricing stages automatically. The recommendation follows the cart mode.',
      argsSchema: EmptyArgsSchema,
      timeoutMs: 240_000,
      async execute(_args, toolContext) {
        const saved = await withProgress(context, toolContext, () => calculateAndSave(context));
        if (!saved.items.length) return { data: { status: 'EMPTY' }, summary: 'The cart is empty' };
        const summary = summarizeCalculationForAgent(saved);
        const shown = selectBasket(saved).basket;
        return {
          data: summary,
          summary: shown ? `${storeName(shown.storeKey)}: ₪${shown.totalPriceIls} (${modeLabel(saved.mode)})`
            : saved.calculation?.status === 'VERIFICATION_FAILED' ? 'Verification failed' : 'No complete basket in any single store'
        };
      }
    }),

    tool({
      name: 'compareStores',
      label: 'Comparing stores',
      description: 'Compare the verified complete baskets of each store (cheapest and preferences-first totals) and list stores that cannot supply every item, with reasons.',
      argsSchema: EmptyArgsSchema,
      timeoutMs: 15_000,
      async execute() {
        const cart = await loadCart();
        if (!isCalculationFresh(cart)) throw new ValidationError('There are no verified store comparisons for the current cart.');
        const summary = summarizeCalculationForAgent(cart) as Record<string, unknown>;
        return { data: { stores: summary.stores, alternatives: summary.alternatives, note: summary.note }, summary: 'Store comparison ready' };
      }
    }),

    tool({
      name: 'explainRecommendation',
      label: 'Explaining my choice',
      description: 'Explain the verified selection with facts only: why each product qualified (requirement evidence), preferences met or missed, package math, prices, and why this store was chosen under the active mode.',
      argsSchema: ExplainArgsSchema,
      timeoutMs: 15_000,
      async execute(args) {
        const cart = await loadCart();
        if (!isCalculationFresh(cart) || !cart.calculation) throw new ValidationError('There is no verified recommendation for the current cart.');
        const { calculation } = cart;
        const { basket, isRecommended } = selectBasket(cart);
        const result = calculation.result;
        const lines = (basket?.items ?? [])
          .filter(line => !args.itemId || calculation.itemIds[line.itemIndex] === args.itemId)
          .map(line => ({
            item: line.item,
            requested: formatQuantity(line.requestedQuantity),
            purchased: `${line.purchasedQuantity.amount} ${line.purchasedQuantity.unit}`,
            extraBought: line.overbuy && line.overbuy.amount > 0 ? `${line.overbuy.amount} ${line.overbuy.unit}` : null,
            priceIls: line.totalPriceIls,
            preferencesMet: line.preferencesSatisfied,
            preferencesMissed: line.preferencesMissed,
            products: line.products.map(product => ({
              name: product.productName,
              packages: `${product.packageCount} × ${product.package.quantity} ${product.package.unit}`,
              unitPriceIls: product.listedUnitPriceIls,
              requirementEvidence: product.requirementChecks.map(check => `${check.requirement}: ${check.result} (${check.evidenceSource}: ${check.evidence || 'none'})`),
              packageEvidence: product.packageInterpretation.reason
            }))
          }));
        const diagnostics = calculation.itemDiagnostics.filter(entry => !args.itemId || entry.itemId === args.itemId);
        return {
          data: {
            store: basket ? storeName(basket.storeKey) : null,
            totalIls: basket?.totalPriceIls ?? null,
            isRecommended,
            modeRule: calculation.mode === 'balanced'
              ? `Balanced: most preferences among complete baskets up to ₪${result.balancedMaxPriceIls} (cheapest ₪${result.cheapestCompleteBasket?.totalPriceIls} + ${calculation.maxPremiumPct}%), then the lowest price.`
              : calculation.mode === 'cheapest' ? 'Cheapest: the lowest complete single-store total.' : 'Preferences first: the most satisfied preferences, then the lowest price.',
            otherStores: result.storeComparisons.filter(store => store.storeKey !== basket?.storeKey)
              .map(store => ({ store: storeName(store.storeKey), cheapestIls: store.cheapest.totalPriceIls, preferencesFirstIls: store.preferencesFirst.totalPriceIls })),
            incompleteStores: result.excludedStores.map(store => ({ store: storeName(store.storeKey), missing: store.missingItems.map(item => item.product) })),
            lines,
            candidates: diagnostics.map(entry => ({ product: entry.product, candidates: entry.candidates, matched: entry.matched, uncertain: entry.uncertain, rejected: entry.rejected, uncertainExamples: entry.uncertainExamples })),
            verification: calculation.verification.passed ? 'passed' : calculation.verification.failures.slice(0, 3)
          },
          summary: basket ? `Explained ${storeName(basket.storeKey)} at ₪${basket.totalPriceIls}` : 'No basket to explain'
        };
      }
    }),

    tool({
      name: 'requestClarification',
      label: 'Asking you a question',
      description: 'Ask the customer one question and stop. Use it for vague requests ("something tasty") with 3-4 concrete product options, or when a needed detail is missing and no sensible default exists.',
      argsSchema: ClarificationArgsSchema,
      timeoutMs: 5_000,
      async execute(args) {
        // The instructions already forbid "Which type of chicken?" for "I want chicken", but Gemini
        // still asks it now and then. A question about items already in the cart stays allowed.
        if (asksWhichVersion(args.question, context.userMessage.text)) {
          const cart = await loadCart();
          if (!cart.items.some(item => findMention(args.question, item.product))) {
            throw new ValidationError('The customer named a product, so do not ask which type, kind, brand, size or flavor they want. ' +
              'Add it as named with addItems and then call optimizeBasket; matching chooses among the catalog\'s versions. Ask only about a vague request.');
          }
        }
        const options = args.options ?? [];
        return { data: { asked: true }, summary: 'Asked a clarifying question', clarification: { question: args.question, options } };
      }
    })
  ];
}
