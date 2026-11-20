import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

// A fake OpenAI-compatible upstream on a random local port.
function fakeUpstream(handler) {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => handler(JSON.parse(raw || '{}'), res));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/v1` }));
  });
}

function streamSse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  let i = 0;
  const timer = setInterval(() => {
    if (i < chunks.length) {
      res.write(chunks[i++]);
    } else {
      clearInterval(timer);
      res.end();
    }
  }, 5);
}

async function startGateway(env) {
  const gw = createServer(loadConfig({ GATEWAY_KEYS: '', RATE_LIMIT_PER_MIN: '1000', ...env }));
  await new Promise((resolve) => gw.listen(0, '127.0.0.1', resolve));
  return { gw, url: `http://127.0.0.1:${gw.address().port}` };
}

async function stop(...servers) {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise((resolve) => s.close(resolve));
  }
}

test('streams SSE from the next backend when the first returns 503', async () => {
  const first = await fakeUpstream((_body, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"busy"}');
  });
  const second = await fakeUpstream((_body, res) => streamSse(res));
  const g = await startGateway({ OLLAMA_URL: first.url, LOCAL_OPENAI_URL: second.url });

  try {
    const res = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(res.headers.get('x-backend'), 'local-openai');
    const text = await res.text();
    assert.match(text, /"content":"Hel"/);
    assert.match(text, /"content":"lo"/);
    assert.match(text, /\[DONE\]/);
  } finally {
    await stop(g.gw, first.srv, second.srv);
  }
});

test('passes a client error from the upstream through without falling back', async () => {
  const only = await fakeUpstream((_body, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":"bad request"}');
  });
  const g = await startGateway({ OLLAMA_URL: only.url });

  try {
    const res = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 400);
    assert.equal(await res.text(), '{"error":"bad request"}');
  } finally {
    await stop(g.gw, only.srv);
  }
});

test('returns 503 when every backend fails before streaming starts', async () => {
  const down = await fakeUpstream((_body, res) => {
    res.writeHead(500);
    res.end();
  });
  const g = await startGateway({ OLLAMA_URL: down.url });

  try {
    const res = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 503);
  } finally {
    await stop(g.gw, down.srv);
  }
});
