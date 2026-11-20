// k6 load test for the gateway's /v1/chat/completions endpoint.
// Ramps concurrency 1 -> 2 -> 4 virtual users so you can see where latency starts to queue.
//
// Run (gateway already running on :8080 with the same key):
//   k6 run -e GATEWAY_URL=http://localhost:8080 -e GATEWAY_KEY=local-dev-key loadtest/chat.js

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.GATEWAY_URL || 'http://localhost:8080';
const KEY = __ENV.GATEWAY_KEY || 'local-dev-key';

const ttfbOk = new Trend('chat_duration_ok', true);
const failures = new Counter('chat_failures');

// One fixed concurrency level per run, so each result is clean.
//   -e VUS=1 -e DURATION=60s
const VUS = Number(__ENV.VUS || 1);
const DURATION = __ENV.DURATION || '60s';

export const options = {
  scenarios: {
    fixed: { executor: 'constant-vus', vus: VUS, duration: DURATION },
  },
  // Measured, not gated: this test reports where the limits are rather than passing or failing.
};

const PROMPTS = [
  'Explain what a circuit breaker is in one sentence.',
  'Name three metrics for monitoring an API.',
  'What does p99 latency mean? Answer briefly.',
  'Give one reason to use a load balancer.',
];

export default function () {
  const prompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
  const res = http.post(
    `${BASE}/v1/chat/completions`,
    JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 48, // keeps each request short and comparable
    }),
    {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      timeout: '120s',
      tags: { endpoint: 'chat' },
    },
  );

  const ok = check(res, { 'status is 200': (r) => r.status === 200 });
  if (ok) {
    ttfbOk.add(res.timings.duration);
  } else {
    failures.add(1, { status: String(res.status) });
  }
}
