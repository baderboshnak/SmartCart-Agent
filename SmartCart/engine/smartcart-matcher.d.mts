import type { CatalogRecord, EngineItem, ItemContext, RequirementCheck } from './engine-types.mjs';

export interface MatchDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const MATCH_DECLARATION: MatchDeclaration;

export interface MatchDecision {
  id: string;
  status: 'MATCH' | 'NO_MATCH' | 'UNCERTAIN';
  reason: string;
  identityStatus: 'MATCH' | 'NO_MATCH' | 'UNCERTAIN';
  requirementChecks: RequirementCheck[];
  preferencesMet: string[];
}

export interface MatchRow {
  product: CatalogRecord;
  reason: string;
  preferencesMet: string[];
  identityStatus: string;
  requirementChecks: RequirementCheck[];
}

export interface MatchResults {
  item: EngineItem;
  context?: ItemContext;
  totalCandidates: number;
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
}

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
  waitForRetry?: (milliseconds: number) => Promise<unknown>;
}): Promise<MatchResults>;

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
