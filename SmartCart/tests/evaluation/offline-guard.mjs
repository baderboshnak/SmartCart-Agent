import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

const installed = Symbol.for('smartcart.evaluation.offline-guard');
const counters = Symbol.for('smartcart.evaluation.offline-guard.counters');
const blockedByProtocol = (globalThis[counters] ??= Object.create(null));
const normalizedHost = value => String(value ?? 'localhost').toLowerCase().replace(/^\[|\]$|\.$/gu, '');

function loopback(host) {
  const name = normalizedHost(host);
  return name === 'localhost' || name === '::1' || (net.isIP(name) === 4 && name.startsWith('127.'));
}

function blocked(protocol) {
  blockedByProtocol[protocol] = (blockedByProtocol[protocol] ?? 0) + 1;
  return Object.assign(new Error(`Offline evaluation blocked an external ${protocol} operation.`), { code: 'SMARTCART_OFFLINE_NETWORK' });
}

/** Connections rejected in this process before any external request was sent. */
export function offlineNetworkStats() {
  return { blockedAttempts: Object.values(blockedByProtocol).reduce((sum, count) => sum + count, 0), blockedByProtocol: { ...blockedByProtocol } };
}

function wrap(target, method, authorize) {
  const original = target?.[method];
  if (typeof original !== 'function') return;
  target[method] = function (...args) {
    authorize(args);
    return Reflect.apply(original, this, args);
  };
}

function tcpEndpoint(args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const [first, second] = values;
  if (first && typeof first === 'object') {
    return { host: first.host ?? first.hostname ?? first.servername, port: first.port, path: first.path };
  }
  if (typeof first === 'number' || /^\d+$/u.test(String(first))) {
    return { host: typeof second === 'string' ? second : undefined, port: first };
  }
  return { path: first };
}

function install() {
  // Children used by the engine and HTTP tests inherit the preload as well.
  const preload = `--import=${import.meta.url}`;
  const inherited = [preload, ...process.execArgv.filter(value =>
    value === '--preserve-symlinks' || value === '--preserve-symlinks-main')];
  const current = process.env.NODE_OPTIONS ?? '';
  const existingFlags = new Set(current.split(/\s+/u));
  process.env.NODE_OPTIONS = [current, ...inherited.filter(value => !existingFlags.has(value))].filter(Boolean).join(' ');
  process.env.SMARTCART_EVAL_OFFLINE = '1';
  // The empty value stays set even when a legacy script later loads its .env file.
  process.env.GEMINI_API_KEY = '';
  process.env.GOOGLE_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';

  const mongo = new Set((process.env.SMARTCART_EVAL_MONGO_HOSTS ?? '').split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => /^[a-z\d][a-z\d.-]*:2701[789]$/u.test(entry)));
  const mongoDns = new Set([...mongo].map(entry => entry.split(':')[0]));
  const allowTcp = args => {
    const { host, port, path } = tcpEndpoint(args);
    if (path || (!loopback(host) && !mongo.has(`${normalizedHost(host)}:${port}`))) throw blocked('TCP');
  };
  wrap(net.Socket.prototype, 'connect', allowTcp);
  wrap(tls, 'connect', allowTcp);

  const allowHttp = args => {
    const [first, second] = args;
    const uri = typeof first === 'string' || first instanceof URL ? new URL(first) : undefined;
    const options = uri ? second : first;
    const host = options?.hostname ?? options?.host ?? uri?.hostname;
    if (!loopback(host) || String(options?.method).toUpperCase() === 'CONNECT') throw blocked('HTTP');
  };
  for (const client of [http, https]) {
    wrap(client, 'request', allowHttp);
    wrap(client, 'get', allowHttp);
  }
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const uri = input instanceof Request ? new URL(input.url) : new URL(input);
    if (!loopback(uri.hostname)) throw blocked('fetch');
    return fetch(input, init);
  };

  const allowDns = ([name]) => {
    if (!loopback(name) && !mongoDns.has(normalizedHost(name))) throw blocked('DNS');
  };
  for (const resolver of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const method of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname',
      'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse']) {
      wrap(resolver, method, allowDns);
    }
  }
  wrap(dgram.Socket.prototype, 'connect', ([, host]) => {
    if (typeof host === 'string' && !loopback(host)) throw blocked('UDP');
  });
  for (const method of ['send', 'sendto']) {
    wrap(dgram.Socket.prototype, method, ([, , lengthOrHost, port, host]) => {
      const destination = typeof lengthOrHost === 'number' && typeof port === 'number' ? host : lengthOrHost;
      if (typeof destination === 'string' && !loopback(destination)) throw blocked('UDP');
    });
  }
  syncBuiltinESMExports();
}

if (!globalThis[installed]) {
  install();
  globalThis[installed] = true;
}
