import type { CatalogRecord, EngineItem, ItemContext, RequirementCheck } from './engine-types.mjs';

export interface MatchDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const MATCH_DECLARATION: MatchDeclaration;

/** How a candidate relates to the product the customer asked for. */
export type MatchRelation =
  | 'SAME_PRODUCT' | 'SPECIAL_VARIANT' | 'FLAVORED_WITH' | 'CONTAINS_IT'
  | 'DERIVED' | 'RELATED_DIFFERENT' | 'ACCESSORY' | 'UNCLEAR';

/** Plain-language description of each relation. */
export const MATCH_RELATIONS: Readonly<Record<MatchRelation, string>>;

/** Bumped when the deterministic validation of matcher answers changes. */
export const MATCHER_VERSION: string;

/** Hash of the matcher version, function declaration and prompt rules. */
export const MATCHER_FINGERPRINT: string;

/** The only identity that is consistent with a relation. */
export function identityForRelation(relation: MatchRelation): 'MATCH' | 'NO_MATCH' | 'UNCERTAIN';

/** True when the identity quote appears in the candidate's name (spacing and punctuation ignored). */
export function identityEvidenceInName(product: Pick<CatalogRecord, 'name'>, evidence: string): boolean;

/** Gemini's reading of a request, made once before any candidate is seen and shared by every batch. */
export interface RequestReading {
  wanted: string;
  notWanted: string[];
}

export const READING_DECLARATION: MatchDeclaration;

/** The prompt for one reading of a request (no candidates). */
export function buildReadingPrompt(item: EngineItem): string;

/** One Gemini call per request; null when the answer has no usable reading. */
export function readShoppingRequest(options: { item: EngineItem; callModel?: CallModel }): Promise<RequestReading | null>;

/** One line for logs and explanations. */
export function describeReading(reading: RequestReading): string;

/** The prompt for one batch of candidates. */
export function buildMatchPrompt(item: EngineItem, batch: CatalogRecord[], retryFeedback?: string, reading?: RequestReading | null): string;

export interface MatchDecision {
  id: string;
  status: 'MATCH' | 'NO_MATCH' | 'UNCERTAIN';
  reason: string;
  /** Gemini's own verdict; status also reflects relation consistency, evidence and requirements. */
  identityStatus: 'MATCH' | 'NO_MATCH' | 'UNCERTAIN';
  relation: MatchRelation;
  /** What Gemini says the candidate is. */
  candidate: string;
  /** Words from the candidate's name that Gemini quoted for its identity. */
  identityEvidence: string;
  requirementChecks: RequirementCheck[];
  preferencesMet: string[];
}

export interface MatchRow {
  product: CatalogRecord;
  reason: string;
  preferencesMet: string[];
  identityStatus: string;
  relation?: MatchRelation;
  requirementChecks: RequirementCheck[];
}

export interface MatchResults {
  item: EngineItem;
  context?: ItemContext;
  totalCandidates: number;
  /** Gemini's one-sentence reading of the request, from the batches it checked. */
  requestReadings?: string[];
  matches: MatchRow[];
  rejected: MatchRow[];
  uncertain: MatchRow[];
}

export interface MatchProgress {
  processed: number;
  total: number;
  retry?: number;
  missing?: number;
  error?: string;
  resumed?: boolean;
  retryDelayMs?: number;
  /** The wait the provider asked for (Google RetryInfo), when it said. */
  providerDelayMs?: number;
}

/** How long the provider asked callers to wait before retrying, in milliseconds, or null. */
export function providerRetryDelayMs(error: unknown): number | null;

export type CallModel = (args: { prompt: string; declaration: MatchDeclaration }) => Promise<unknown>;

export function matchProducts(options: {
  item: EngineItem;
  products: CatalogRecord[];
  context?: ItemContext;
  batchSize?: number;
  maxAttempts?: number;
  callModel?: CallModel;
  onProgress?: (progress: MatchProgress) => void;
  initialDecisions?: MatchDecision[];
  onBatchComplete?: (state: { processed: number; total: number; decisions: MatchDecision[] }) => Promise<void>;
  onCheckpoint?: (state: { processed: number; total: number; decisions: MatchDecision[] }) => Promise<void>;
  waitForRetry?: (milliseconds: number, providerDelayMs?: number) => Promise<unknown>;
  /** The shared request reading; null lets each batch read the request itself. */
  reading?: RequestReading | null;
}): Promise<MatchResults>;

/** matchProducts with a resumable JSON checkpoint file (the manual CLI's step 3). */
export function runMatchWithCheckpoint(
  options: Parameters<typeof matchProducts>[0] & { checkpointPath?: string; onCheckpointStatus?: (message: string) => void }
): Promise<MatchResults>;

export function validateMatchBatch(
  raw: unknown,
  batch: CatalogRecord[],
  allowedPreferences?: string[],
  requirements?: string[],
  options?: { allowPartial?: boolean; item?: EngineItem }
): MatchDecision[];

export function collectValidMatchDecisions(
  raw: unknown,
  batch: CatalogRecord[],
  preferences?: string[],
  requirements?: string[],
  item?: EngineItem
): { decisions: MatchDecision[]; errors: Map<string, string> };
