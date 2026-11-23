import { z } from 'zod';
import { QUANTITY_UNITS, SHOPPING_MODES } from '@/lib/shared/types';

const quote = z.string().trim().min(1).max(300);
const itemId = z.string().trim().min(1).max(64);

export const QuantitySchema = z.object({
  amount: z.number().min(0).max(100_000).describe('Total amount, or the lower bound of a range. Use 0 with unit "unspecified" when the customer gave no amount.'),
  unit: z.enum(QUANTITY_UNITS).describe('l, ml, kg, g, units, a container (bottle, can, loaf, bag, roll, capsule), or unspecified.'),
  maxAmount: z.number().positive().max(100_000).optional().describe('Upper bound in the same unit. Only for an explicit range such as "2-3 liters".')
});

export const ConstraintEvidenceSchema = z.object({
  type: z.enum(['REQUIREMENT', 'PREFERENCE']).describe('REQUIREMENT unless the wording makes it optional ("preferably", "ideally", "if possible", "עדיף").'),
  kind: z.enum(['BRAND', 'OTHER']),
  sourceText: z.string().trim().min(1).max(80).describe('The qualifier copied verbatim from the item sourceText, without cue words like "only" or "preferably".')
});

export const ExtractedItemSchema = z.object({
  sourceText: z.string().trim().min(1).max(300).describe('The complete phrase for this item copied verbatim from requestText, including its amount and every qualifier, e.g. "2 liters of 3% milk, preferably Tnuva".'),
  product: z.string().trim().min(1).max(80).describe('The product identity words copied verbatim from sourceText, without amount, brand or optional attributes, e.g. "milk".'),
  coreSearchTerm: z.string().trim().min(1).max(40).describe('A broad Hebrew catalog phrase for the base product: "חלב" for 3% milk, "מוצרלה" for shredded mozzarella, "לחם" for bread. Never include brands or qualifiers.'),
  searchTerms: z.array(z.string().trim().min(1).max(40)).max(5).optional().describe('Extra Hebrew name variations that improve recall.'),
  constraintEvidence: z.array(ConstraintEvidenceSchema).max(8).optional().describe('EVERY explicit qualifier of this item: percentages, forms (shredded, sliced), dietary claims, brands, per-container sizes. Empty only for an unqualified item.'),
  quantity: QuantitySchema
});

export const RecipeIngredientSchema = z.object({
  name: z.string().trim().min(1).max(80).describe('Generic ingredient name in English, e.g. "wheat flour".'),
  coreSearchTerm: z.string().trim().min(1).max(40).describe('Broad Hebrew catalog phrase, e.g. "קמח", "שמרים", "רוטב עגבניות", "מוצרלה".'),
  searchTerms: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
  quantity: z.object({
    amount: z.number().min(0).max(100_000),
    unit: z.enum(QUANTITY_UNITS)
  }).describe('Realistic total amount to buy for all servings. Use unit "unspecified" with amount 0 for pantry items where one package is enough.'),
  optional: z.boolean().optional().describe('true for garnishes or extras; optional ingredients are listed but not added to the cart.'),
  requirements: z.array(z.string().trim().min(1).max(60)).max(4).optional().describe('Only constraints the customer stated, copied from requestText (e.g. "vegan").'),
  preferences: z.array(z.string().trim().min(1).max(60)).max(4).optional(),
  note: z.string().max(200).optional()
});

export const RecipeSchema = z.object({
  dish: z.string().trim().min(1).max(80),
  servings: z.number().int().min(1).max(100),
  servingsSource: z.enum(['EXPLICIT', 'ASSUMED']).describe('EXPLICIT only when the customer stated the number of people or servings.'),
  ingredients: z.array(RecipeIngredientSchema).min(1).max(30),
  notes: z.string().max(300).optional()
});

export const ConstraintSchema = z.object({
  value: z.string().trim().min(1).max(60).describe('The constraint as the customer wrote it, e.g. "Tnuva" or "3%".'),
  type: z.enum(['REQUIREMENT', 'PREFERENCE']),
  kind: z.enum(['BRAND', 'OTHER']).optional()
});

const userQuote = quote.describe('Exact words from the customer\'s latest message that ask for this change.');

/** Strict per-operation validation of updateCart. */
export const CartOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_items'), requestText: quote, items: z.array(ExtractedItemSchema).min(1).max(20) }),
  z.object({ op: z.literal('add_recipe'), requestText: quote, recipe: RecipeSchema }),
  z.object({ op: z.literal('remove_items'), itemIds: z.array(itemId).min(1).max(40), userQuote }),
  z.object({ op: z.literal('set_quantity'), itemId, quantity: QuantitySchema, userQuote }),
  z.object({ op: z.literal('set_constraints'), itemId, constraints: z.array(ConstraintSchema).max(10), userQuote }),
  z.object({ op: z.literal('set_search_terms'), itemId, searchTerms: z.array(z.string().trim().min(1).max(60)).min(1).max(6) }),
  z.object({ op: z.literal('set_mode'), mode: z.enum(SHOPPING_MODES), maxPremiumPct: z.number().min(0).max(100).optional(), userQuote }),
  z.object({ op: z.literal('set_budget'), budgetIls: z.number().positive().max(100_000).optional(), budgetExclusive: z.boolean().optional(), userQuote }),
  z.object({ op: z.literal('select_store'), storeKey: z.string().trim().max(120), userQuote }),
  z.object({ op: z.literal('clear'), userQuote })
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
