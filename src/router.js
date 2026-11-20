// Sends a chat request to the first healthy backend and falls back to the next one on failure.
// Failures that count: network errors, timeouts, HTTP 5xx and 429.
// A 4xx (for example a malformed request) is returned to the client as-is, because retrying elsewhere won't help.

export class AllBackendsFailed extends Error {
  constructor(errors) {
    super('all backends failed');
    this.errors = errors;
  }
}

export async function routeChat(body, backends, { timeoutMs = 20000, metrics, fetchImpl = fetch } = {}) {
  const errors = [];

  for (const backend of backends) {
    if (!backend.breaker.allow()) {
      metrics.inc('gateway_backend_skipped_total', { backend: backend.name });
      errors.push(`${backend.name}: circuit open`);
      continue;
    }

    const start = Date.now();
    try {
      const res = await fetchImpl(`${backend.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(backend.apiKey ? { authorization: `Bearer ${backend.apiKey}` } : {}),
        },
        body: JSON.stringify({ ...body, model: backend.model, stream: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();

      if (res.status >= 500 || res.status === 429) {
        throw new Error(`HTTP ${res.status}`);
      }

      backend.breaker.onSuccess();
      metrics.inc('gateway_requests_total', { backend: backend.name, status: res.status });
      return { backend: backend.name, status: res.status, body: text };
    } catch (err) {
      backend.breaker.onFailure();
      metrics.inc('gateway_backend_errors_total', { backend: backend.name });
      errors.push(`${backend.name}: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
    } finally {
      metrics.observe('gateway_backend_latency', { backend: backend.name }, (Date.now() - start) / 1000);
    }
  }

  throw new AllBackendsFailed(errors);
}

// Streaming variant. Failover is only possible until the first byte is sent to the client,
// because after that the client has already received part of the answer.
// Returns { backend, status, stream, done }:
//   - stream is a web ReadableStream of the upstream SSE body (success), or null (upstream 4xx).
//   - body is the upstream error text when stream is null.
//   - done() must be called when the response has finished, to clear the timeout.
// `signal` aborts the upstream request, for example when the client disconnects.
export async function routeStream(body, backends, { timeoutMs = 120000, metrics, fetchImpl = fetch, signal } = {}) {
  const errors = [];

  for (const backend of backends) {
    if (!backend.breaker.allow()) {
      metrics.inc('gateway_backend_skipped_total', { backend: backend.name });
      errors.push(`${backend.name}: circuit open`);
      continue;
    }

    const start = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onClientGone = () => ctrl.abort();
    signal?.addEventListener('abort', onClientGone, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onClientGone);
    };

    try {
      const res = await fetchImpl(`${backend.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(backend.apiKey ? { authorization: `Bearer ${backend.apiKey}` } : {}),
        },
        body: JSON.stringify({ ...body, model: backend.model, stream: true }),
        signal: ctrl.signal,
      });

      if (res.status >= 500 || res.status === 429) {
        throw new Error(`HTTP ${res.status}`);
      }

      backend.breaker.onSuccess();
      metrics.inc('gateway_requests_total', { backend: backend.name, status: res.status, stream: 'true' });

      if (res.status >= 400) {
        const text = await res.text();
        done();
        return { backend: backend.name, status: res.status, stream: null, body: text, done: () => {} };
      }
      return { backend: backend.name, status: res.status, stream: res.body, body: null, done };
    } catch (err) {
      done();
      if (signal?.aborted) {
        // The client left. That is not the backend's fault, so don't count it against the breaker.
        throw new AllBackendsFailed(['client disconnected']);
      }
      backend.breaker.onFailure();
      metrics.inc('gateway_backend_errors_total', { backend: backend.name });
      errors.push(`${backend.name}: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
    } finally {
      metrics.observe('gateway_backend_latency', { backend: backend.name }, (Date.now() - start) / 1000);
    }
  }

  throw new AllBackendsFailed(errors);
}
