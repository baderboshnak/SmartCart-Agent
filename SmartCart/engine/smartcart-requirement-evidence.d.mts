import type { ConstraintKind } from './engine-types.mjs';

export function isKnownBrand(value: unknown): boolean;
export function corroborateSizeRequirement(
  requirement: string,
  product: unknown,
  item: unknown
): { result: 'MET' | 'CONTRADICTED' | 'UNKNOWN'; evidence: string; evidenceSource: string } | null;
export function manufacturerName(product: unknown): string;
export function corroborateRequirement(
  value: string,
  product: unknown,
  kind?: ConstraintKind
): { result: 'MET' | 'CONTRADICTED' | 'UNKNOWN'; evidence: string; evidenceSource: string; conflict?: boolean };
