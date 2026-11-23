/**
 * HTTP-level checks against a production build (`npm run build` first).
 * Starts `next start` on a free port with a disposable, seeded test database.
 * No Gemini calls are made.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { catalogFixture } from '../helpers/fixtures';
import { createTestDatabase, databaseSkipReason, type TestDatabase } from '../helpers/test-db';

const skip = databaseSkipReason || (!existsSync('.next/BUILD_ID') && 'Run `npm run build` before the e2e tests.');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No port'))));
    });
  });
}

function stop(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
}

describe('SmartCart over HTTP', { skip }, () => {
  let testDb: TestDatabase;
  let server: ChildProcess;
  let base = '';
  let output = '';

  before(async () => {
    testDb = await createTestDatabase({ seed: true });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
      env: { ...process.env, MONGODB_DB_NAME: testDb.name },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout?.on('data', chunk => { output += chunk; });
    server.stderr?.on('data', chunk => { output += chunk; });
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return;
      } catch { /* starting */ }
      await delay(500);
    }
    throw new Error(`Next.js did not start:\n${output}`);
  });

  after(async () => {
    if (server) stop(server);
    await testDb?.cleanup();
  });

  const call = (path: string, init: RequestInit & { cookie?: string } = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers }
  });

  test('serves the app shell and health without secrets', async () => {
    const page = await call('/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /SmartCart/u);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-powered-by'), null);

    const health = await (await call('/api/health')).json();
    assert.equal(health.ok, true);
    assert.equal(health.database, 'connected');
    assert.equal(health.products, catalogFixture.length);
    assert.equal(health.stores.length, 2);
    assert.doesNotMatch(JSON.stringify(health), /mongodb\+srv|AIza/u);
  });

  test('sessions, cart reads and edits, conflicts and isolation', async () => {
    const anonymous = await call('/api/sessions');
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, 'NO_SESSION');

    const created = await call('/api/sessions', { method: 'POST' });
    assert.equal(created.status, 201);
    const setCookie = created.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /smartcart_session=.+; Path=\/; HttpOnly; SameSite=Lax/u);
    assert.doesNotMatch(setCookie, /Secure/u, 'plain HTTP must not set Secure');
    const cookie = setCookie.split(';')[0]!;
    const body = await created.json();
    assert.equal(body.cart.status, 'EMPTY');
    assert.deepEqual(body.session.messages, []);

    assert.equal((await call('/api/sessions', { cookie })).status, 200);
    const cart = (await (await call('/api/cart', { cookie })).json()).cart;
    assert.equal(cart.revision, 0);

    const stale = await call('/api/cart', { method: 'PATCH', cookie, body: JSON.stringify({ expectedRevision: 7, operation: { op: 'set_mode', mode: 'cheapest' } }) });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'CART_CONFLICT');

    const edited = await call('/api/cart', { method: 'PATCH', cookie, body: JSON.stringify({ expectedRevision: 0, operation: { op: 'set_mode', mode: 'cheapest' } }) });
    assert.equal(edited.status, 200);
    const editedCart = (await edited.json()).cart;
    assert.equal(editedCart.mode, 'cheapest');
    assert.equal(editedCart.revision, 1);

    const invalid = await call('/api/cart', { method: 'PATCH', cookie, body: JSON.stringify({ expectedRevision: 1, operation: { op: 'drop_everything' } }) });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'VALIDATION_ERROR');

    const other = (await call('/api/sessions', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await (await call('/api/cart', { cookie: other })).json()).cart.mode, 'balanced', 'another session never sees this cart');
    const forged = `${cookie.split('.')[0]}.${other.split('.')[1]}`;
    assert.equal((await call('/api/cart', { cookie: forged })).status, 401);
  });

  test('the agent endpoint validates input, origin and session before calling Gemini', async () => {
    const cookie = (await call('/api/sessions', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0]!;
    const empty = await call('/api/agent', { method: 'POST', cookie, body: JSON.stringify({ message: '   ' }) });
    assert.equal(empty.status, 400);
    const tooLong = await call('/api/agent', { method: 'POST', cookie, body: JSON.stringify({ message: 'x'.repeat(2001) }) });
    assert.equal(tooLong.status, 400);
    const crossSite = await call('/api/agent', { method: 'POST', cookie, headers: { Origin: 'https://evil.example' }, body: JSON.stringify({ message: 'milk' }) });
    assert.equal(crossSite.status, 403);
    const noSession = await call('/api/agent', { method: 'POST', body: JSON.stringify({ message: 'milk' }) });
    assert.equal(noSession.status, 401);
    const malformed = await call('/api/agent', { method: 'POST', cookie, body: '{not json' });
    assert.equal(malformed.status, 400);
    const badVia = await call('/api/agent', { method: 'POST', cookie, body: JSON.stringify({ message: 'milk', via: 'telepathy' }) });
    assert.equal(badVia.status, 400);
  });

  test('voice tokens require a session and a same-site request', async () => {
    assert.equal((await call('/api/voice/token', { method: 'POST' })).status, 401);
    const cookie = (await call('/api/sessions', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0]!;
    const crossSite = await call('/api/voice/token', { method: 'POST', cookie, headers: { Origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);
  });
});
