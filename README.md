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

**What this shows:** throughput stays flat while latency grows in step with concurrency. That is what a single backend that handles one request at a time looks like. Little's law explains it: 4 users ÷ 2.48 s ≈ 1.6 req/s, which matches the measured throughput. Adding more users only adds queueing delay.

**Experiment: 2 parallel slots.** I restarted Ollama with `OLLAMA_NUM_PARALLEL=2` and reran the same tests (one run each):

| Virtual users | Throughput (req/s) | Median latency | p95 latency | Errors |
|---|---|---|---|---|
| 1 | 2.03 | 512 ms | 560 ms | 0 |
| 4 | 3.09 | 1,311 ms | 1,495 ms | 0 |

At 4 users, throughput rose about 2x (1.59 → 3.09 req/s) and median latency fell by about half (2,483 → 1,311 ms). Little's law holds again: 4 ÷ 1.31 s ≈ 3.05 req/s. Two slots roughly double capacity, and the rest of the queue still waits. These are single runs on a laptop, so treat the exact numbers as approximate. Next, I'd test whether the extra slots use more memory, since this PC has little RAM to spare.

Reproduce:

```powershell
$env:GATEWAY_KEYS = "local-dev-key"; $env:RATE_LIMIT_PER_MIN = "100000"; npm start
k6 run -e VUS=4 -e DURATION=60s -e GATEWAY_KEY=local-dev-key loadtest/chat.js
```

## Eval gate (GitHub Actions)

`.github/workflows/eval.yml` runs on every push to `main` and every pull request. It:
1. Runs the unit tests.
2. Installs Ollama on the runner and pulls `llama3.2:1b`.
3. Starts the gateway and runs `evals/run.js` against it.
4. Fails the build if the pass rate is below `minPassRate` (80%) in `evals/cases.json`.

The suite has 10 questions with simple, checkable answers. Each question has checks such as "contains any of these words", "at most N words" or "matches this pattern". The runner sets temperature to 0 to keep answers as repeatable as the model allows. Results appear on the Actions run's summary page.

This is a quality gate, the same idea as an SLO gate: a change that makes the model or the gateway worse is caught before it lands. It runs on GitHub's free runners for public repos, so it uses none of your laptop's RAM.

## Container and Kubernetes (status: partial)

- `Dockerfile` builds a 244 MB image that runs as a non-root user. A test run returned `/health` correctly.
- `k8s/gateway.yaml` holds the ConfigMap, Deployment (with probes, resource limits, read-only root filesystem, dropped capabilities) and Service. It renders cleanly with `kubectl kustomize`. I have not validated it against the Kubernetes schema.
- `k8s/kind-gateway.yaml` is the kind cluster config. It sets `failCgroupV1: false`, because Docker Desktop on this PC uses cgroup v1.
- **Not yet running in a cluster.** The first kind cluster attempts failed while the control plane was starting, on a laptop with 0.4 to 1 GB of free RAM. The API server came up, but etcd was slow and the admin permissions were never created, so the node never registered. Retrying after a WSL restart with more free memory is the next step.

## Known limits (on purpose, for a first version)
- Streaming (`stream: true`) is relayed as server-sent events. Failover only happens before the first byte reaches the client, because after that the client already has part of the answer. A backend that fails mid-stream cuts the response short.
- The request timeout also covers the whole streamed answer, so very long generations need a larger `REQUEST_TIMEOUT_MS`.
- The rate limiter and circuit breaker keep state in memory, so they reset on restart and don't work across several gateway instances.
- Half-open allows all concurrent requests through, not just one trial request.
- No response cache yet.

## Next steps
- A response cache keyed on the request body
- Load test with k6 and an SLO dashboard (project 3)
