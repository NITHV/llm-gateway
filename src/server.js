import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { CircuitBreaker } from './breaker.js';
import { RateLimiter } from './ratelimit.js';
import { Metrics } from './metrics.js';
import { routeChat, routeStream, AllBackendsFailed } from './router.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_BODY_BYTES = 1_000_000;

export function createServer(cfg = loadConfig()) {
  const metrics = new Metrics();
  const limiter = new RateLimiter({ limit: cfg.rateLimitPerMin });
  const keys = new Set(cfg.gatewayKeys);
  const backends = cfg.backends.map((b) => ({
    ...b,
    breaker: new CircuitBreaker({ threshold: cfg.breakerThreshold, cooldownMs: cfg.breakerCooldownMs }),
  }));

  const sendJson = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  };

  // Relays the upstream server-sent events to the client as they arrive.
  async function handleStream(res, body) {
    const abort = new AbortController();
    // If the client disconnects, stop the upstream generation too.
    res.on('close', () => abort.abort());

    let out;
    try {
      out = await routeStream(body, backends, { timeoutMs: cfg.requestTimeoutMs, metrics, signal: abort.signal });
    } catch (err) {
      if (err instanceof AllBackendsFailed) {
        console.error('all backends failed (stream):', err.errors);
        return sendJson(res, 503, { error: 'all backends unavailable' });
      }
      throw err;
    }

    // Upstream returned a client error (4xx): pass it through as a normal JSON response.
    if (out.stream === null) {
      res.writeHead(out.status, { 'content-type': 'application/json', 'x-backend': out.backend });
      return res.end(out.body);
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-backend': out.backend,
    });
    try {
      await pipeline(Readable.fromWeb(out.stream), res);
    } catch {
      // The client left or the upstream was cut off partway through. Nothing more to send.
    } finally {
      out.done();
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        status: 'ok',
        backends: backends.map((b) => ({ name: b.name, circuit: b.breaker.state })),
      });
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      let text = metrics.render();
      for (const b of backends) {
        text += `gateway_circuit_open{backend="${b.name}"} ${b.breaker.state === 'open' ? 1 : 0}\n`;
      }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      return res.end(text);
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (keys.size > 0 && !keys.has(token)) {
        return sendJson(res, 401, { error: 'invalid or missing API key' });
      }

      // Rate limit per key when keys are configured, otherwise per client IP.
      const clientId = keys.size > 0 ? token : (req.socket.remoteAddress ?? 'anonymous');
      if (!limiter.hit(clientId)) {
        metrics.inc('gateway_rate_limited_total');
        return sendJson(res, 429, { error: 'rate limit exceeded' }, { 'retry-after': '60' });
      }

      let body;
      try {
        body = JSON.parse(await readBody(req, MAX_BODY_BYTES));
      } catch (err) {
        if (err.message === 'body too large') return sendJson(res, 413, { error: 'body too large' });
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      if (!Array.isArray(body.messages)) {
        return sendJson(res, 400, { error: 'messages must be an array' });
      }
      if (body.stream === true) {
        return handleStream(res, body);
      }

      try {
        const out = await routeChat(body, backends, { timeoutMs: cfg.requestTimeoutMs, metrics });
        res.writeHead(out.status, { 'content-type': 'application/json', 'x-backend': out.backend });
        return res.end(out.body);
      } catch (err) {
        if (err instanceof AllBackendsFailed) {
          // Detailed errors go to the server log, not to the client.
          console.error('all backends failed:', err.errors);
          return sendJson(res, 503, { error: 'all backends unavailable' });
        }
        throw err;
      }
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('unhandled error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Start the server only when this file is run directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  if (cfg.backends.length === 0) {
    console.error('No backends configured. Set OLLAMA_URL or LOCAL_OPENAI_URL.');
    process.exit(1);
  }
  if (cfg.gatewayKeys.length === 0) {
    console.warn('GATEWAY_KEYS is empty: anyone who can reach this port can use the gateway.');
  }
  createServer(cfg).listen(cfg.port, () => {
    console.log(`llm-gateway on http://localhost:${cfg.port} with backends: ${cfg.backends.map((b) => b.name).join(', ')}`);
  });
}
