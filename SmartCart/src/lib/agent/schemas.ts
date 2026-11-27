import { z } from 'zod';
import { QUANTITY_UNITS, SHOPPING_MODES } from '@/lib/shared/types';

const quote = z.string().trim().min(1).max(300);
const itemId = z.string().trim().min(1).max(64);

export const QuantitySchema = z.object({
  amount: z.number().min(0).max(100_000).describe('Total amount, or the lower bound of a range. Use 0 with unit "unspecified" when the customer gave no amount.'),
  unit: z.enum(QUANTITY_UNITS).describe('l, ml, kg, g, units, a container (bottle, can, loaf, bag, roll, capsule), pack for a number of sale packages ("2 packs", "שתי חבילות", "a box"), or unspecified.'),
  maxAmount: z.number().positive().max(100_000).optional().describe('Upper bound in the same unit. Only for an explicit range such as "2-3 liters".')
});

export const ConstraintEvidenceSchema = z.object({
  type: z.enum(['REQUIREMENT', 'PREFERENCE']).describe('REQUIREMENT unless the wording makes it optional ("preferably", "ideally", "if possible", "עדיף").'),
  kind: z.enum(['BRAND', 'OTHER']),
  sourceText: z.string().trim().min(1).max(80).describe('The qualifier copied verbatim from the item sourceText, without cue words like "only" or "preferably".')
});

export const ExtractedItemSchema = z.object({
  sourceText: z.string().trim().min(1).max(300).describe('The complete phrase for this item copied verbatim from requestText, including its amount and every qualifier, e.g. "2 liters of 3% milk, preferably Tnuva".'),
  product: z.string().trim().min(1).max(80).describe('The product identity words copied verbatim from sourceText, without amount, brand or optional attributes, e.g. "milk". Keep flavor, type or processed-form words that say which product it is, e.g. "condensed milk", "חלב בטעם וניל".'),
  coreSearchTerm: z.string().trim().min(1).max(40).describe('The product\'s own Hebrew catalog name without brand or qualifiers: "חלב" for 3% milk, "מוצרלה" for shredded mozzarella, "ספגטי" for spaghetti. Never a broader category or a substitute.'),
  searchTerms: z.array(z.string().trim().min(1).max(40)).max(5).optional().describe('Other Hebrew names or spellings of the same product that improve recall. Never substitutes.'),
  constraintEvidence: z.array(ConstraintEvidenceSchema).max(8).optional().describe('EVERY explicit qualifier of this item: percentages, forms (shredded, sliced), dietary claims, brands, per-container sizes. Empty only for an unqualified item.'),
  quantity: QuantitySchema
});

export const RecipeIngredientSchema = z.object({
  name: z.string().trim().min(1).max(80).describe('A specific grocery or ingredient, such as wheat flour or sparkling water.'),
  coreSearchTerm: z.string().trim().min(1).max(40).describe('The ingredient\'s own Hebrew catalog name, e.g. "קמח", "שמרים", "רוטב עגבניות", "מוצרלה", "פרמזן" for parmesan. Never a category ("גבינה", "פסטה") or a substitute.'),
  searchTerms: z.array(z.string().trim().min(1).max(40)).max(5).optional().describe('Other Hebrew names or spellings of the same ingredient. Never substitutes.'),
  quantity: z.object({
    amount: z.number().min(0).max(100_000),
    unit: z.enum(QUANTITY_UNITS)
  }).describe('Realistic total amount to buy for all servings, in shop units (g, kg, ml, l, units, or pack for a number of whole packages). Kitchen measures such as tbsp, cup or clove are not shop units: use unit "unspecified" with amount 0 for them and for pantry items where one package is enough.'),
  optional: z.boolean().optional().describe('true for garnishes or extras; optional ingredients are listed but not added to the cart.'),
  requirements: z.array(z.string().trim().min(1).max(60)).max(4).optional().describe('Only constraints the customer stated, copied from requestText (e.g. "vegan").'),
  preferences: z.array(z.string().trim().min(1).max(60)).max(4).optional(),
  note: z.string().max(200).optional()
});

export const RecipeSchema = z.object({
  dish: z.string().trim().min(1).max(80).describe('Short title for the meal, occasion or shopping goal.'),
  servings: z.number().int().min(1).max(100).describe('Number of people or servings the plan is for. Set the individual purchase quantities on the groceries.'),
  servingsSource: z.enum(['EXPLICIT', 'ASSUMED']).describe('EXPLICIT only when the customer stated the number of people or servings.'),
  ingredients: z.array(RecipeIngredientSchema).min(1).max(30),
  notes: z.string().max(300).optional().describe('Brief assumption used to estimate how much to buy.')
});

export const ConstraintSchema = z.object({
  value: z.string().trim().min(1).max(60).describe('The constraint as the customer wrote it, e.g. "Tnuva" or "3%".'),
  type: z.enum(['REQUIREMENT', 'PREFERENCE']),
  kind: z.enum(['BRAND', 'OTHER']).optional()
});

const userQuote = quote.describe('Exact words from the customer\'s latest message that ask for this change.');
const requestText = quote.describe('The shopping wording copied verbatim from the customer\'s latest message, covering every item and all its qualifiers.');

// One schema per cart action. Gemini gets each as its own small tool with only the fields
// that action needs: one flat schema with every field optional made it misplace fields.
export const AddItemsArgsSchema = z.object({
  requestText,
  items: z.array(ExtractedItemSchema).min(1).max(20).describe('One entry per product in requestText, in the same order.')
});
/** addItems as validated: Gemini sometimes sends one product's fields without the items list. */
export const AddItemsInputSchema = z.preprocess(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'items' in value) return value;
  const { requestText: text, ...rest } = value as Record<string, unknown>;
  if (!('product' in rest) && !('sourceText' in rest)) return value;
  return { requestText: text ?? rest.sourceText, items: [rest] };
}, AddItemsArgsSchema);
export const AddRecipeArgsSchema = z.object({ requestText, recipe: RecipeSchema });

// Kitchen measures have no shop package, so one package is bought ("2 tbsp oil" = one bottle).
const KITCHEN_MEASURE = /^(?:tsp|teaspoons?|tbsps?|tablespoons?|cups?|cloves?|pinch(?:es)?|dash(?:es)?|sprigs?|bunch(?:es)?|slices?|handfuls?|to taste|כפית|כפיות|כף|כפות|כוס|כוסות|שן|שיני|קורט|צרור|פרוסה|פרוסות|ملعقة|ملاعق|كوب|أكواب|فص|فصوص|رشة|حزمة|شريحة|شرائح)$/iu;
const PIECES = /^(?:piece|pieces|pc|pcs|whole|יחידה|יחידות|قطعة|قطع)$/iu;

/** addRecipe as validated: kitchen measures and piece counts are mapped to shop units. */
export const AddRecipeInputSchema = z.preprocess(value => {
  const recipe = (value as { recipe?: { ingredients?: unknown } } | null)?.recipe;
  if (!recipe || !Array.isArray(recipe.ingredients)) return value;
  const ingredients = recipe.ingredients.map(ingredient => {
    const quantity = (ingredient as { quantity?: { amount?: unknown; unit?: unknown } } | null)?.quantity;
    const unit = typeof quantity?.unit === 'string' ? quantity.unit.trim() : '';
    if (KITCHEN_MEASURE.test(unit)) return { ...(ingredient as object), quantity: { amount: 0, unit: 'unspecified' } };
    if (PIECES.test(unit)) return { ...(ingredient as object), quantity: { amount: quantity?.amount, unit: 'units' } };
    return ingredient;
  });
  return { ...(value as object), recipe: { ...recipe, ingredients } };
}, AddRecipeArgsSchema);
export const RemoveItemsArgsSchema = z.object({ itemIds: z.array(itemId).min(1).max(40).describe('itemId values from the current cart.'), userQuote });
export const SetQuantityArgsSchema = z.object({ itemId, quantity: QuantitySchema, userQuote });
export const ResizeShoppingPlanArgsSchema = z.object({
  planId: itemId.describe('The existing shopping plan ID from the current cart.'),
  servings: z.number().int().min(1).max(100).describe('The new number of people or servings stated by the customer.'),
  userQuote: quote.describe('The shortest exact phrase in the latest message that gives the new headcount, such as "for 10" or "10 people".'),
  quantities: z.array(z.object({ itemId, quantity: QuantitySchema })).min(1).max(40)
    .describe('New total purchase amounts for each current item belonging to this plan, using its existing itemId. Include every current item in the plan once.')
});
export const SetConstraintsArgsSchema = z.object({
  itemId,
  constraints: z.array(ConstraintSchema).max(10).describe('The item\'s complete list of requirements and preferences after the change.'),
  userQuote
});
export const SetSearchTermsArgsSchema = z.object({
  itemId,
  searchTerms: z.array(z.string().trim().min(1).max(60)).min(1).max(6).describe('Hebrew catalog names for the product itself, without brand or qualifiers. Never a broader category or a substitute.')
});
export const SetModeArgsSchema = z.object({ mode: z.enum(SHOPPING_MODES), maxPremiumPct: z.number().min(0).max(100).optional(), userQuote });
export const SetBudgetArgsSchema = z.object({
  budgetIls: z.number().positive().max(100_000).optional().describe('Maximum basket total in shekels. Omit to remove the budget.'),
  budgetExclusive: z.boolean().optional().describe('true for "under" or "less than": the total must stay below the amount.'),
  userQuote
});
export const SelectStoreArgsSchema = z.object({
  storeKey: z.string().trim().max(120).describe('A storeKey from compareStores, or "" for the recommended store.'),
  userQuote
});
export const ClearCartArgsSchema = z.object({ userQuote });

/** Strict per-operation validation, shared by the per-action tools and the batched updateCart. */
export const CartOperationSchema = z.discriminatedUnion('op', [
  AddItemsArgsSchema.extend({ op: z.literal('add_items') }),
  AddRecipeArgsSchema.extend({ op: z.literal('add_recipe') }),
  ResizeShoppingPlanArgsSchema.extend({ op: z.literal('resize_plan') }),
  RemoveItemsArgsSchema.extend({ op: z.literal('remove_items') }),
  SetQuantityArgsSchema.extend({ op: z.literal('set_quantity') }),
  SetConstraintsArgsSchema.extend({ op: z.literal('set_constraints') }),
  SetSearchTermsArgsSchema.extend({ op: z.literal('set_search_terms') }),
  SetModeArgsSchema.extend({ op: z.literal('set_mode') }),
  SetBudgetArgsSchema.extend({ op: z.literal('set_budget') }),
  SelectStoreArgsSchema.extend({ op: z.literal('select_store') }),
  ClearCartArgsSchema.extend({ op: z.literal('clear') })
]);

export type CartOperationInput = z.infer<typeof CartOperationSchema>;

export const UpdateCartArgsSchema = z.object({ operations: z.array(CartOperationSchema).min(1).max(10) });

/** Flat schema for the model: one object with an op discriminator and optional fields. */
const FlatOperationSchema = z.object({
  op: z.enum(['add_items', 'add_recipe', 'remove_items', 'set_quantity', 'set_constraints', 'set_search_terms', 'set_mode', 'set_budget', 'select_store', 'clear'])
    .describe('add_items: requestText+items. add_recipe: requestText+recipe. remove_items: itemIds+userQuote. set_quantity: itemId+quantity+userQuote. set_constraints: itemId+constraints (the complete new list)+userQuote. set_search_terms: itemId+searchTerms. set_mode: mode(+maxPremiumPct)+userQuote. set_budget: budgetIls(+budgetExclusive; omit budgetIls to remove)+userQuote. select_store: storeKey ("" for the recommendation)+userQuote. clear: userQuote.'),
  requestText: quote.optional().describe('For add_items/add_recipe: the shopping wording copied verbatim from the customer\'s latest message, covering every item and all its qualifiers.'),
  items: z.array(ExtractedItemSchema).max(20).optional(),
  recipe: RecipeSchema.optional(),
  itemIds: z.array(itemId).max(40).optional(),
  itemId: itemId.optional(),
  quantity: QuantitySchema.optional(),
  constraints: z.array(ConstraintSchema).max(10).optional().describe('The item\'s complete constraint list after the change.'),
  searchTerms: z.array(z.string().trim().min(1).max(60)).max(6).optional(),
  mode: z.enum(SHOPPING_MODES).optional(),
  maxPremiumPct: z.number().min(0).max(100).optional(),
  budgetIls: z.number().positive().max(100_000).optional(),
  budgetExclusive: z.boolean().optional(),
  storeKey: z.string().max(120).optional(),
  userQuote: userQuote.optional()
});

export const UpdateCartDeclarationSchema = z.object({ operations: z.array(FlatOperationSchema).min(1).max(10) });

export const EmptyArgsSchema = z.object({});

export const SearchProductsArgsSchema = z.object({
  itemIds: z.array(itemId).max(20).optional().describe('Cart items to search with their stored Hebrew search terms (full recall, used by matching).'),
  query: z.array(z.string().trim().min(1).max(60)).max(6).optional().describe('Free Hebrew phrases to explore the catalog, e.g. ["משקה שיבולת שועל"].'),
  storeKeys: z.array(z.string().trim().min(1).max(120)).max(10).optional()
}).refine(args => Boolean(args.itemIds?.length || args.query?.length), 'Provide itemIds or query.');

export const SearchProductsDeclarationSchema = z.object({
  itemIds: z.array(itemId).max(20).optional().describe('Cart items to search with their stored Hebrew search terms (full recall, used by matching).'),
  query: z.array(z.string().trim().min(1).max(60)).max(6).optional().describe('Free Hebrew phrases to explore the catalog, e.g. ["משקה שיבולת שועל"].'),
  storeKeys: z.array(z.string().trim().min(1).max(120)).max(10).optional()
});

export const ItemIdsArgsSchema = z.object({
  itemIds: z.array(itemId).min(1).max(20).describe('Cart item ids from getCurrentCart or updateCart.')
});

export const ExplainArgsSchema = z.object({
  itemId: itemId.optional().describe('Explain one item; omit to explain the whole recommendation.')
});

export const ClarificationArgsSchema = z.object({
  question: z.string().trim().min(5).max(400).describe('One short, specific question.'),
  options: z.array(z.string().trim().min(1).max(80)).max(4).optional().describe('Up to 4 short suggested answers.')
});

const ALLOWED_KEYWORDS = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'description', 'minItems', 'maxItems',
  'minimum', 'maximum', 'minLength', 'maxLength', 'anyOf', 'title'
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== 'object') return node;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && value && typeof value === 'object') {
      output.properties = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, sanitize(schema)]));
    } else if (ALLOWED_KEYWORDS.has(key)) {
      output[key] = sanitize(value);
    }
  }
  return output;
}

/** Convert a Zod schema to the JSON Schema subset that Gemini function declarations accept. */
export function toGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitize(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })) as Record<string, unknown>;
}
