import type { PackageInterpretation, SellablePackage } from './engine-types.mjs';

export interface NormalizedAmount {
  family: 'mass' | 'volume' | 'count';
  base: 'g' | 'ml' | 'units';
  amountBase: number;
}

export const CONTAINER_UNITS: readonly string[];
export function parseUnit(value: unknown): { family: string; factor: number; base: string; aliases: string[] } | null;
export function containerType(value: unknown): string | undefined;
export function normalizeAmount(amount: unknown, unit: unknown): NormalizedAmount | null;
export function normalizeRequestedQuantity(quantity: unknown): (NormalizedAmount & { maxAmountBase: number | null }) | null;
export function interpretPackage(product: unknown, item: unknown, requested: unknown): {
  originalPackage: Record<string, unknown> | null;
  packageInterpretation: PackageInterpretation;
  packageAmount: NormalizedAmount | null;
  package: SellablePackage | null;
};
