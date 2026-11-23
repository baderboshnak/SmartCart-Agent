import type { ConstraintEvidence, EngineQuantity } from '@engine/engine-types.mjs';
import type { BasketMode, BasketResult } from '@engine/smartcart-basket-optimizer.mjs';

export type { CatalogRecord, ConstraintEvidence, EngineItem, RequirementCheck } from '@engine/engine-types.mjs';

export type ShoppingMode = BasketMode;
export const SHOPPING_MODES = ['balanced', 'cheapest', 'preferences-first'] as const satisfies readonly ShoppingMode[];
export const DEFAULT_MAX_PREMIUM_PCT = 15;

export const QUANTITY_UNITS = ['l', 'ml', 'kg', 'g', 'units', 'unspecified', 'bottle', 'can', 'loaf', 'bag', 'roll', 'capsule'] as const;
export type QuantityUnit = (typeof QUANTITY_UNITS)[number];
export type Quantity = EngineQuantity;

export type ItemOrigin =
  | { type: 'DIRECT'; messageId?: string }
  | { type: 'RECIPE'; recipePlanId: string; dish: string };

/** A requested shopping line stored in the cart. MongoDB is the source of truth. */
export interface CartItem {
  id: string;
  product: string;
  searchTerms: string[];
  requirements: string[];
  preferences: string[];
  constraintEvidence: ConstraintEvidence[];
  quantity: Quantity;
  sourceText?: string;
  /** Items sharing a group are alternatives; the basket buys exactly one of them. */
  choiceGroup?: string;
  origin: ItemOrigin;
  addedAt: Date;
}

export interface RecipeIngredient {
  name: string;
  quantity: Quantity;
  optional: boolean;
  note?: string;
  itemId?: string;
}

export interface RecipePlan {
  id: string;
  dish: string;
  servings: number;
  servingsSource: 'EXPLICIT' | 'ASSUMED';
  requestText: string;
  ingredients: RecipeIngredient[];
  notes?: string;
  createdAt: Date;
}

export interface Budget {
  amountIls: number;
  exclusive: boolean;
}

export type CalculationStatus = 'COMPLETE' | 'NO_COMPLETE_BASKET' | 'VERIFICATION_FAILED';

export interface VerificationReport {
  passed: boolean;
  checkedBaskets: number;
  checkedLines: number;
  failures: string[];
  checkedAt: Date;
}

export interface ItemDiagnostics {
  itemId: string;
  product: string;
  candidates: number;
  totalMatched: number;
  truncated: boolean;
  matched: number;
  uncertain: number;
  rejected: number;
  pricedOptions: number;
  skippedOptions: number;
  cachedDecisions: number;
  modelCalls: number;
  uncertainExamples: string[];
}

export interface CartCalculation {
  status: CalculationStatus;
  /** cart.itemsVersion at calculation time; a different value means the result is stale. */
  itemsVersion: number;
  requestFingerprint: string;
  mode: ShoppingMode;
  maxPremiumPct: number;
  /** Cart item ids in the engine's item order (itemIndex -> item id). */
  itemIds: string[];
  result: BasketResult;
  verification: VerificationReport;
  itemDiagnostics: ItemDiagnostics[];
  catalog: { snapshotDates: string[]; priceUpdatedAtRange: { min: string | null; max: string | null } };
  calculatedAt: Date;
  durationMs: number;
}

export interface Cart {
  _id: string;
  sessionId: string;
  revision: number;
  itemsVersion: number;
  mode: ShoppingMode;
  maxPremiumPct: number;
  budget: Budget | null;
  items: CartItem[];
  recipePlans: RecipePlan[];
  selectedStoreKey: string | null;
  calculation: CartCalculation | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  kind: 'text' | 'clarification' | 'error';
  options?: string[];
  /** Set when the customer spoke the message. */
  via?: 'voice';
  runId?: string;
  createdAt: Date;
}

export interface ShoppingSession {
  _id: string;
  tokenHash: string;
  messages: ChatMessage[];
  intent: string | null;
  pendingClarification: { question: string; options: string[] } | null;
  activeRun: { runId: string; expiresAt: Date } | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface StoreDocument {
  _id: string;
  retailer: string;
  chainId: string;
  subChainId: string;
  storeId: string;
  displayName: string;
  displayNameSource: 'DERIVED_FROM_RETAILER_AND_STORE_ID';
  productCount: number;
  weightedProductCount: number;
  snapshotDates: string[];
  priceUpdatedAtRange: { min: string | null; max: string | null };
  importedAt: Date;
  updatedAt: Date;
}

export interface AgentToolSummary {
  name: string;
  status: 'ok' | 'error';
  durationMs: number;
  summary: string;
}

export interface AgentRunDocument {
  _id: string;
  sessionId: string;
  status: 'running' | 'completed' | 'clarification' | 'failed' | 'cancelled';
  model: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  modelTurns: number;
  toolCalls: AgentToolSummary[];
  matcherModelCalls: number;
  tokenUsage: { promptTokens: number; outputTokens: number; thoughtTokens: number; totalTokens: number };
  error: string | null;
  expiresAt: Date;
}
