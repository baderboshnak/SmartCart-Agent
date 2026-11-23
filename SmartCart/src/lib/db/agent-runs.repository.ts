import type { Db } from 'mongodb';
import { collections } from '@/lib/db/mongodb';
import type { AgentRunDocument } from '@/lib/shared/types';

export const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function createAgentRun(db: Db, run: Omit<AgentRunDocument, 'expiresAt'>): Promise<void> {
  await collections.agentRuns(db).insertOne({ ...run, expiresAt: new Date(run.startedAt.getTime() + RUN_RETENTION_MS) });
}

export async function finishAgentRun(
  db: Db,
  runId: string,
  patch: Pick<AgentRunDocument, 'status' | 'finishedAt' | 'durationMs' | 'modelTurns' | 'toolCalls' | 'matcherModelCalls' | 'tokenUsage' | 'error'>
): Promise<void> {
  await collections.agentRuns(db).updateOne({ _id: runId }, { $set: patch });
}

export async function countRecentRuns(db: Db, sessionId: string, windowMs: number): Promise<number> {
  return collections.agentRuns(db).countDocuments({ sessionId, startedAt: { $gt: new Date(Date.now() - windowMs) } });
}

export async function getAgentRun(db: Db, runId: string): Promise<AgentRunDocument | null> {
  return collections.agentRuns(db).findOne({ _id: runId });
}
