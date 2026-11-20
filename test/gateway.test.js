import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../src/breaker.js';
import { RateLimiter } from '../src/ratelimit.js';
import { Metrics } from '../src/metrics.js';
import { routeChat, AllBackendsFailed } from '../src/router.js';

test('breaker opens after threshold, then allows a trial after cooldown', () => {
  let now = 0;
  const b = new CircuitBreaker({ threshold: 2, cooldownMs: 1000, now: () => now });
  b.onFailure();
  assert.equal(b.state, 'closed');
  b.onFailure();
  assert.equal(b.state, 'open');
  assert.equal(b.allow(), false);
  now = 1000;
  assert.equal(b.state, 'half-open');
  assert.equal(b.allow(), true);
  b.onFailure(); // failed trial re-opens immediately
  assert.equal(b.state, 'open');
  now = 2000;
  b.onSuccess();
  assert.equal(b.state, 'closed');
});

test('rate limiter enforces the limit per window per key', () => {
  let now = 0;
  const r = new RateLimiter({ limit: 2, windowMs: 60000, now: () => now });
  assert.equal(r.hit('a'), true);
  assert.equal(r.hit('a'), true);
  assert.equal(r.hit('a'), false);
  assert.equal(r.hit('b'), true);
  now = 60000;
  assert.equal(r.hit('a'), true);
});

function backend(name, breaker = new CircuitBreaker()) {
  return { name, baseUrl: `http://${name}`, model: 'm', apiKey: null, breaker };
}

const json = (status, obj) => new Response(JSON.stringify(obj), { status });

test('falls back to the next backend on 503', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return url.startsWith('http://a') ? json(503, { error: 'busy' }) : json(200, { ok: true });
  };
  const out = await routeChat({ messages: [] }, [backend('a'), backend('b')], {
    metrics: new Metrics(),
    fetchImpl,
  });
  assert.equal(out.backend, 'b');
  assert.equal(out.status, 200);
  assert.deepEqual(calls, ['http://a/chat/completions', 'http://b/chat/completions']);
});

test('does not fall back on a 4xx from the client', async () => {
  const fetchImpl = async () => json(400, { error: 'bad request' });
  const out = await routeChat({ messages: [] }, [backend('a'), backend('b')], {
    metrics: new Metrics(),
    fetchImpl,
  });
  assert.equal(out.backend, 'a');
  assert.equal(out.status, 400);
});

test('skips a backend whose circuit is open', async () => {
  const open = new CircuitBreaker({ threshold: 1 });
  open.onFailure();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return json(200, {});
  };
  const out = await routeChat({ messages: [] }, [backend('a', open), backend('b')], {
    metrics: new Metrics(),
    fetchImpl,
  });
  assert.equal(out.backend, 'b');
  assert.deepEqual(calls, ['http://b/chat/completions']);
});

test('throws AllBackendsFailed when every backend fails', async () => {
  const fetchImpl = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  await assert.rejects(
    routeChat({ messages: [] }, [backend('a'), backend('b')], { metrics: new Metrics(), fetchImpl }),
    (err) => err instanceof AllBackendsFailed && err.errors.length === 2,
  );
});
