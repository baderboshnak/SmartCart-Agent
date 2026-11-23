/**
 * Opt-in voice smoke test with REAL Gemini calls (this spends Gemini credits).
 *   npx tsx scripts/live-voice-smoke.ts "I want two liters of three percent milk and twelve eggs" --allow-live --cleanup
 *
 * Runs the voice path without a microphone: a locked token from the server, a Gemini
 * Live session (the request is sent as text instead of speech), the shopping_agent tool
 * backed by the real agent and MongoDB, and the spoken answer with its transcript.
 */
import { GoogleGenAI, type LiveServerMessage, type Session } from '@google/genai';
import { runShoppingAgent } from '@/lib/agent/agent';
import { getCart } from '@/lib/db/carts.repository';
import { collections } from '@/lib/db/mongodb';
import { createSession } from '@/lib/db/sessions.repository';
import { serverModelHealth } from '@/lib/agent/model-pool';
import { getAgentModel, getMatcher } from '@/lib/server/services';
import { toCartView } from '@/lib/shopping/cart-view';
import { VOICE_TOOL_NAME } from '@/lib/voice/constants';
import { normalizeSpokenRequest } from '@/lib/voice/normalize-speech';
import { createVoiceToken } from '@/lib/voice/token';
import { openScriptDatabase, parseArgs, runScript, stringFlag } from './lib/cli';

runScript(async () => {
  const { flags, positional } = parseArgs();
  if (!flags.has('allow-live')) {
    console.error('This script calls the real Gemini API and spends credits. Re-run with --allow-live to confirm.');
    return 2;
  }
  const spoken = positional.join(' ').trim() || 'I want two liters of three percent milk, preferably Tnuva, and twelve eggs';
  const { client, db, dbName } = await openScriptDatabase(stringFlag(flags, 'db'));
  const { session: shoppingSession } = await createSession(db);
  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
  try {
    console.log(`Database "${dbName}". Customer says: "${spoken}"`);
    const voice = await createVoiceToken();
    console.log(`[${elapsed()}] locked token created for ${voice.model}`);
    const ai = new GoogleGenAI({ apiKey: voice.token, httpOptions: { apiVersion: 'v1alpha' } });
    const report = { toolRequest: '', normalized: '', agentAnswer: '', spoken: '', audioSeconds: 0, done: false };
    await new Promise<void>((resolve, reject) => {
      let live: Session | null = null;
      const timer = setTimeout(() => reject(new Error('Voice test timed out after 180 s.')), 180_000);
      const finish = () => { clearTimeout(timer); report.done = true; try { live?.close(); } catch { /* closed */ } resolve(); };
      ai.live.connect({
        model: voice.model,
        config: voice.config,
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            for (const part of message.serverContent?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) report.audioSeconds += Buffer.from(part.inlineData.data, 'base64').length / 2 / 24_000;
            }
            if (message.serverContent?.outputTranscription?.text) report.spoken += message.serverContent.outputTranscription.text;
            for (const call of message.toolCall?.functionCalls ?? []) {
              report.toolRequest = String((call.args as { request?: string })?.request ?? '');
              report.normalized = normalizeSpokenRequest(report.toolRequest);
              console.log(`[${elapsed()}] Live called ${call.name}: "${report.toolRequest}" -> agent receives "${report.normalized}"`);
              void runShoppingAgent({
                db, sessionId: shoppingSession._id, message: report.normalized, via: 'voice',
                model: getAgentModel(), matcher: getMatcher(), signal: new AbortController().signal,
                emit: event => { if (event.type === 'tool.completed') console.log(`  [${elapsed()}] agent ${event.tool}: ${event.summary}`); }
              }).then(result => {
                report.agentAnswer = result.message.content;
                console.log(`[${elapsed()}] agent answered (${result.status}); sending it back to Live`);
                live?.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name ?? VOICE_TOOL_NAME, response: { answer: result.message.content } }] });
              }, reject);
            }
            if (message.serverContent?.turnComplete && report.agentAnswer && report.spoken) finish();
          },
          onerror: event => reject(new Error(`Live error: ${String((event as { message?: string })?.message ?? event)}`)),
          onclose: event => { if (!report.done) reject(new Error(`Live closed: ${event?.reason ?? ''}`)); }
        }
      }).then(session => {
        live = session;
        console.log(`[${elapsed()}] connected; sending the customer's words`);
        session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: spoken }] }], turnComplete: true });
      }, reject);
    });
    const cart = await getCart(db, shoppingSession._id);
    const view = cart ? toCartView(cart) : null;
    console.log(`\n[${elapsed()}] DONE`);
    console.log(`Agent's verified text answer:\n${report.agentAnswer}\n`);
    console.log(`Spoken answer (${report.audioSeconds.toFixed(1)} s of audio), transcript:\n${report.spoken.trim()}\n`);
    console.log(JSON.stringify({ cartStatus: view?.status, store: view?.basket?.storeName, totalIls: view?.basket?.totalPriceIls, items: view?.items.map(item => `${item.product} ${item.quantityLabel} required[${item.requirements}] preferred[${item.preferences}]`) }, null, 2));
    console.log('Answers per model:', JSON.stringify(serverModelHealth().usage()));
    return view?.status === 'COMPLETE' ? 0 : 1;
  } finally {
    if (flags.has('cleanup')) {
      await Promise.all([
        collections.sessions(db).deleteOne({ _id: shoppingSession._id }),
        collections.carts(db).deleteOne({ sessionId: shoppingSession._id }),
        collections.agentRuns(db).deleteMany({ sessionId: shoppingSession._id })
      ]);
    }
    await client.close();
  }
});
