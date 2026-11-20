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

## Load test results

Run with k6 (v2.4.0). Each run used a fixed number of virtual users for 60 seconds. Every request asks for at most 48 output tokens. The model was `llama3.2:1b` (Q8_0) in Ollama, on an Intel i5-10300H with a GTX 1650 Ti (4 GB) and 7.8 GB RAM. The rate limit was raised for the test. Raw summaries are in `loadtest/results/`.

| Virtual users | Requests | Throughput (req/s) | Median latency | p95 latency | Errors |
|---|---|---|---|---|---|
| 1 | 113 | 1.87 | 557 ms | 649 ms | 0 |
| 2 | 105 | 1.73 | 1,150 ms | 1,329 ms | 0 |
| 4 | 98 | 1.59 | 2,483 ms | 2,808 ms | 0 |

**What this shows:** throughput stays flat while latency grows in step with concurrency. That is what a single backend that handles one request at a time looks like. Little's law explains it: 4 users ÷ 2.48 s ≈ 1.6 req/s, which matches the measured throughput. Adding more users only adds queueing delay. To raise throughput, add capacity: more model instances, parallel slots in Ollama (`OLLAMA_NUM_PARALLEL`), or a second backend. I have not yet tested the parallel-slots setting. That is the next experiment.

Reproduce:

```powershell
$env:GATEWAY_KEYS = "local-dev-key"; $env:RATE_LIMIT_PER_MIN = "100000"; npm start
k6 run -e VUS=4 -e DURATION=60s -e GATEWAY_KEY=local-dev-key loadtest/chat.js
```

## Known limits (on purpose, for a first version)
- No streaming responses yet. Requests with `stream: true` are rejected.
- The rate limiter and circuit breaker keep state in memory, so they reset on restart and don't work across several gateway instances.
- Half-open allows all concurrent requests through, not just one trial request.
- No response cache yet.

## Next steps
- Streaming (SSE pass-through)
- A response cache keyed on the request body
- Load test with k6 and an SLO dashboard (project 3)
