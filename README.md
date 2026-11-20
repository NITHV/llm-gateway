# llm-gateway

A small OpenAI-compatible gateway in front of several LLM backends. It is written in plain Node.js with no dependencies. It uses open-source models only, running on this PC through Ollama (for example Llama 3.2 1B). An optional second backend can be any self-hosted open-source server with an OpenAI-compatible API, such as llama.cpp or vLLM. No paid or closed-model APIs are used.

It does four things:
- **Fallback:** if the first backend returns 5xx, 429, times out or is unreachable, the request goes to the next one.
- **Circuit breaker:** a backend that keeps failing is skipped for a cooldown period, so requests don't wait on it.
- **Rate limiting:** a fixed per-minute limit for each client key.
- **Metrics:** Prometheus-format counters, latency and circuit state at `/metrics`.

## Run it

Requires Node 20 or newer, and Ollama for the local backend.

```powershell
cd D:\Metamorphosis\llm-gateway
ollama pull llama3.2:1b
$env:GATEWAY_KEYS = "local-dev-key"
npm start
```

Test with curl (Git Bash or PowerShell with `curl.exe`):

```powershell
curl.exe http://localhost:8080/v1/chat/completions -H "Authorization: Bearer local-dev-key" -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"Say hi in five words"}]}'
```

Other endpoints: `GET /health` (backend and circuit state) and `GET /metrics`.

## Tests

```powershell
npm test
```

## Design notes (SRE view)
- **Fail fast on a sick backend:** the circuit breaker stops a slow or down backend from adding its timeout to every request.
- **Retry only where it helps:** 5xx, 429 and timeouts move to the next backend. A 4xx is the client's fault, so it is returned unchanged.
- **Bounded resources:** request bodies are capped at 1 MB, and every upstream call has a timeout.
- **Errors stay internal:** the client sees a generic 503, and the full backend errors go to the server log.

## Known limits (on purpose, for a first version)
- No streaming responses yet. Requests with `stream: true` are rejected.
- The rate limiter and circuit breaker keep state in memory, so they reset on restart and don't work across several gateway instances.
- Half-open allows all concurrent requests through, not just one trial request.
- No response cache yet.

## Next steps
- Streaming (SSE pass-through)
- A response cache keyed on the request body
- Load test with k6 and an SLO dashboard (project 3)
