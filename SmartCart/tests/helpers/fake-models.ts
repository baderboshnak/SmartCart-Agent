import type { Content } from '@google/genai';
import { READING_DECLARATION, type CallModel } from '@engine/smartcart-matcher.mjs';
import type { AgentModel, AgentModelRequest, ModelTurn } from '@/lib/agent/gemini';

/** Product codes that the controlled matcher accepts per requested product (as in the legacy pipeline tests). */
export const MATCHING_CODES: Record<string, Set<string>> = {
  milk: new Set(['7290000042015', '7290000042435', '7290004131074']),
  eggs: new Set(['7290001201572', '742259241895']),
  bread: new Set(['7290000002026', '379623']),
  mozzarella: new Set(['7290014692817', '7290110324025', '7290014762909', '1794142'])
};

interface PromptCandidate { id: string; name: string; manufacturer: string | null }

export function parseMatcherPrompt(prompt: string) {
  const line = (label: string) => JSON.parse(new RegExp(`^${label}: (.*)$`, 'mu').exec(prompt)?.[1] ?? 'null');
  return {
    product: line('Product wanted') as string,
    requirements: line('Mandatory requirements') as string[],
    preferences: line('Optional preferences') as string[],
    candidates: JSON.parse(prompt.slice(prompt.lastIndexOf('\nProducts: ') + '\nProducts: '.length)) as PromptCandidate[]
  };
}

/**
 * Deterministic stand-in for the Gemini matcher. It claims evidence the way a model
 * would; the engine's deterministic checks still decide the final status.
 */
export function createFakeMatcher(options: { codes?: Record<string, Set<string>>; identity?: (product: string, candidate: PromptCandidate) => boolean } = {}) {
  const codes = options.codes ?? MATCHING_CODES;
  const stats = { calls: 0, candidates: 0, readings: 0 };
  const callModel: CallModel = async ({ prompt, declaration }) => {
    if (declaration.name === READING_DECLARATION.name) {
      // The once-per-item reading of the request, before any candidate is checked.
      stats.readings++;
      const product = JSON.parse(/^Product wanted: (.*)$/mu.exec(prompt)?.[1] ?? '""') as string;
      return { wanted: `${product} (controlled reading)`, notWanted: [] };
    }
    stats.calls++;
    const { product, requirements, preferences, candidates } = parseMatcherPrompt(prompt);
    stats.candidates += candidates.length;
    return {
      decisions: candidates.map(candidate => {
        const code = candidate.id.split(':').at(-1)!;
        const matches = options.identity ? options.identity(product, candidate) : codes[product]?.has(code) === true;
        const tnuva = /תנובה/u.test(candidate.manufacturer ?? '') || /תנובה/u.test(candidate.name);
        const requirementChecks = requirements.map(requirement => {
          let evidence: string | undefined;
          let kind: 'BRAND' | 'OTHER' = 'OTHER';
          let evidenceSource: 'NAME' | 'MANUFACTURER' = 'NAME';
          if (matches && requirement.includes('%')) evidence = candidate.name.match(/\d+%/u)?.[0];
          if (matches && /shredded/iu.test(requirement)) evidence = candidate.name.match(/מגורדת|פתיתי/u)?.[0];
          if (matches && /tnuva|תנובה/iu.test(requirement)) {
            kind = 'BRAND';
            evidence = candidate.manufacturer ?? candidate.name.match(/תנובה/u)?.[0];
            evidenceSource = candidate.manufacturer ? 'MANUFACTURER' : 'NAME';
          }
          return { requirement, kind, result: evidence ? 'MET' : 'UNKNOWN', evidenceSource: evidence ? evidenceSource : 'NONE', evidence: evidence ?? '' };
        });
        return {
          id: candidate.id,
          candidate: 'Controlled test decision',
          identityEvidence: candidate.name,
          relation: matches ? 'SAME_PRODUCT' : 'RELATED_DIFFERENT',
          identity: matches ? 'MATCH' : 'NO_MATCH',
          requirementChecks,
          preferencesMet: matches && tnuva ? preferences.filter(preference => /tnuva/iu.test(preference)) : []
        };
      })
    };
  };
  return { callModel, stats };
}

export function functionCallTurn(calls: Array<{ name: string; args: Record<string, unknown> }>): ModelTurn {
  return {
    text: '',
    functionCalls: calls.map(call => ({ name: call.name, args: call.args })),
    content: { role: 'model', parts: calls.map(call => ({ functionCall: { name: call.name, args: call.args } })) },
    usage: { promptTokens: 100, outputTokens: 20, thoughtTokens: 0, totalTokens: 120 }
  };
}

export function textTurn(text: string): ModelTurn {
  return {
    text,
    functionCalls: [],
    content: { role: 'model', parts: [{ text }] },
    usage: { promptTokens: 100, outputTokens: 30, thoughtTokens: 0, totalTokens: 130 }
  };
}

export type ScriptStep = ModelTurn | ((request: AgentModelRequest) => ModelTurn | Promise<ModelTurn>);

/** A fake agent model that plays a fixed script and records every request. */
export function scriptedModel(steps: ScriptStep[], name = 'fake-agent-model'): AgentModel & { requests: AgentModelRequest[] } {
  const requests: AgentModelRequest[] = [];
  let index = 0;
  return {
    name,
    requests,
    async generate(request) {
      requests.push(request);
      const step = steps[index++];
      if (!step) return textTurn('Done.');
      return typeof step === 'function' ? step(request) : step;
    }
  };
}

/** Function responses from the latest user turn, by tool name. */
export function lastToolResponses(request: AgentModelRequest): Array<{ name: string; response: Record<string, unknown> }> {
  const last = [...request.contents].reverse().find((content: Content) => content.role === 'user');
  return (last?.parts ?? []).filter(part => part.functionResponse).map(part => ({
    name: part.functionResponse!.name ?? '',
    response: (part.functionResponse!.response ?? {}) as Record<string, unknown>
  }));
}

/** The authoritative cart snapshot embedded in the system instruction. */
export function cartFromInstruction(request: AgentModelRequest): { items: Array<{ itemId: string; product: string; requirements: string[]; preferences: string[] }>; revision: number } {
  const match = /# Current cart \(authoritative, from MongoDB\)\n(.*)/u.exec(request.systemInstruction);
  return JSON.parse(match?.[1] ?? '{"items":[],"revision":0}');
}
