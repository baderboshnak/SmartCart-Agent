import type { ItemContext } from './engine-types.mjs';

export function itemFingerprint(item: unknown): string;
export function createItemContext(plan: { items: unknown[]; [key: string]: unknown }, itemIndex: number): ItemContext;
export function assertItemContext(context: unknown, item: unknown): void;
export function exactStoreKey(offer: unknown): string | null;
export function offerId(offer: unknown): string | null;
export function hasConfirmedRequirements(offer: unknown, item: unknown): boolean;
