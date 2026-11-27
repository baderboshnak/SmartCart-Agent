import type { GenerateContentResponse } from '@google/genai';

export const APPROVED_CAP_MICROS = 600_000;
export const FLASH_LITE = 'gemini-3.5-flash-lite';
export const LIVE_VOICE = 'gemini-3.8-live';
export type PaidPhase = 'batch' | 'deep' | 'voice';

export interface Charge {
  id: string;
  phase: PaidPhase;
  reservedMicros: number;
  actualMicros?: number;
  inputTokens?: number;
  outputTokens?: number;
}

function validMoney(micros: number): boolean {
  return Number.isSafeInteger(micros) && micros >= 0;
}

export function textMicros(input: number, output: number, batch = false): number {
  return Math.ceil((input * 0.30 + output * 2.50) * (batch ? 0.5 : 1));
}

export function textUsage(response: GenerateContentResponse) {
  const usage = response.usageMetadata;
  const input = usage?.promptTokenCount;
  const total = usage?.totalTokenCount;
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 ||
    typeof total !== 'number' || !Number.isSafeInteger(total) || total < input) return undefined;
  const separateOutput = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
  return { inputTokens: input, outputTokens: Math.max(total - input, separateOutput) };
}

export class ApprovedBudget {
  constructor(private readonly charges: Charge[], private readonly persist: () => void) {
    if (charges.some(row => !validMoney(row.reservedMicros) || (row.actualMicros !== undefined && !validMoney(row.actualMicros))) ||
      new Set(charges.map(row => row.id)).size !== charges.length) throw new Error('Invalid saved budget ledger.');
  }

  tracked(phase?: PaidPhase): number {
    return this.charges.filter(row => !phase || row.phase === phase)
      .reduce((sum, row) => sum + (row.actualMicros ?? row.reservedMicros), 0);
  }

  available(): number {
    return Math.max(0, APPROVED_CAP_MICROS - this.tracked());
  }

  reserve(id: string, phase: PaidPhase, amount: number): boolean {
    return this.reserveMany([{ id, phase, reservedMicros: amount }]);
  }

  reserveMany(charges: Charge[]): boolean {
    const ids = new Set(this.charges.map(row => row.id));
    if (charges.some(row => {
      if (!validMoney(row.reservedMicros) || !row.reservedMicros || ids.has(row.id)) return true;
      ids.add(row.id);
      return false;
    }) || charges.reduce((sum, row) => sum + row.reservedMicros, 0) > this.available() ||
      this.charges.some(row => row.actualMicros !== undefined && row.actualMicros > row.reservedMicros)) return false;
    this.charges.push(...charges);
    this.persist();
    return true;
  }

  settle(id: string, micros: number, usage?: { inputTokens: number; outputTokens: number }): void {
    const record = this.charges.find(row => row.id === id);
    if (!record || !validMoney(micros)) throw new Error('Invalid budget settlement.');
    if (record.actualMicros !== undefined && record.actualMicros !== micros) throw new Error('Conflicting budget settlement.');
    Object.assign(record, usage, { actualMicros: micros });
    this.persist();
    if (micros > record.reservedMicros) throw new Error('Provider usage exceeded its reservation. Further generation is disabled.');
  }

  summary() {
    const actualMicros = this.charges.reduce((sum, row) => sum + (row.actualMicros ?? 0), 0);
    return {
      approvedUsd: APPROVED_CAP_MICROS / 1_000_000,
      observedUsd: actualMicros / 1_000_000,
      unconfirmedReservedUsd: (this.tracked() - actualMicros) / 1_000_000,
      availableUsd: this.available() / 1_000_000,
      phases: Object.fromEntries((['batch', 'deep', 'voice'] as const).map(phase => {
        const entries = this.charges.filter(item => item.phase === phase);
        return [phase, {
          entries: entries.length, observedUsd: entries.reduce((sum, row) => sum + (row.actualMicros ?? 0), 0) / 1_000_000,
          reservedUnconfirmed: entries.filter(row => row.actualMicros === undefined).length,
          inputTokens: entries.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
          outputTokens: entries.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0)
        }];
      }))
    };
  }
}
