/**
 * Opt-in smoke test with REAL Gemini calls (this spends Gemini credits).
 *   npm run test:live:agent -- --allow-live ["I want 2 liters of 3% milk and 12 eggs"] [--cleanup]
 *
 * Runs the full agent against the configured MongoDB catalog in a new session and
 * prints the streamed events, the answer and the verified cart.
 */
import { runShoppingAgent } from '@/lib/agent/agent';
import type { AgentEvent } from '@/lib/agent/events';
import { getCart } from '@/lib/db/carts.repository';
import { collections } from '@/lib/db/mongodb';
import { createSession } from '@/lib/db/sessions.repository';
import { serverModelHealth } from '@/lib/agent/model-pool';
import { getAgentModel, getMatcher } from '@/lib/server/services';
import { toCartView } from '@/lib/shopping/cart-view';
import { openScriptDatabase, parseArgs, runScript, stringFlag } from './lib/cli';

runScript(async () => {
  const { flags, positional } = parseArgs();
  if (!flags.has('allow-live')) {
    console.error('This script calls the real Gemini API and spends credits. Re-run with --allow-live to confirm.');
    return 2;
  }
  const message = positional.join(' ').trim() || 'I want 2 liters of 3% milk, preferably Tnuva, and 12 eggs';
  const { client, db, dbName } = await openScriptDatabase(stringFlag(flags, 'db'));
  const { session } = await createSession(db);
  try {
    console.log(`Database "${dbName}", session ${session._id}\nCustomer: ${message}\n`);
    const started = Date.now();
    const result = await runShoppingAgent({
      db, sessionId: session._id, message, model: getAgentModel(), matcher: getMatcher(), signal: new AbortController().signal,
      emit: (event: AgentEvent) => {
        if (event.type === 'tool.started') console.log(`→ ${event.tool}`);
        if (event.type === 'tool.completed') console.log(`  ${event.status === 'ok' ? '✓' : '✗'} ${event.tool} (${event.durationMs} ms): ${event.summary}`);
        if (event.type === 'agent.failed') console.log(`✗ ${event.error.code}: ${event.error.message}`);
      }
    });
    const cart = await getCart(db, session._id);
    const run = await collections.agentRuns(db).findOne({ _id: result.runId });
    console.log(`\nSmartCart (${result.status}, ${Date.now() - started} ms):\n${result.message.content}\n`);
    console.log(JSON.stringify({
      cartStatus: cart ? toCartView(cart).status : null,
      basket: cart ? toCartView(cart).basket : null,
      modelTurns: run?.modelTurns, matcherModelCalls: run?.matcherModelCalls, tokenUsage: run?.tokenUsage,
      answersPerModel: serverModelHealth().usage()
    }, null, 2));
    return result.status === 'failed' ? 1 : 0;
  } finally {
    if (flags.has('cleanup')) {
      await Promise.all([
        collections.sessions(db).deleteOne({ _id: session._id }),
        collections.carts(db).deleteOne({ sessionId: session._id }),
        collections.agentRuns(db).deleteMany({ sessionId: session._id })
      ]);
    }
    await client.close();
  }
});
