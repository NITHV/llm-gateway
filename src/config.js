// Reads settings from environment variables. Backends are tried in the order listed here.
export function loadConfig(env = process.env) {
  const backends = [];

  // Local model via Ollama (free, runs on this PC). Set OLLAMA_URL=off to disable.
  if (env.OLLAMA_URL !== 'off') {
    backends.push({
      name: 'ollama',
      baseUrl: env.OLLAMA_URL ?? 'http://localhost:11434/v1',
      model: env.OLLAMA_MODEL ?? 'llama3.2:1b',
      apiKey: null,
    });
  }

  // Optional second backend: any self-hosted open-source server that speaks the OpenAI API
  // (llama.cpp server, vLLM, LM Studio). Enabled only when LOCAL_OPENAI_URL is set.
  if (env.LOCAL_OPENAI_URL) {
    backends.push({
      name: 'local-openai',
      baseUrl: env.LOCAL_OPENAI_URL,
      model: env.LOCAL_OPENAI_MODEL ?? 'default',
      apiKey: env.LOCAL_OPENAI_KEY ?? null,
    });
  }

  return {
    port: Number(env.PORT ?? 8080),
    // Comma-separated keys that clients must send as "Authorization: Bearer <key>".
    gatewayKeys: (env.GATEWAY_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN ?? 30),
    // Cold model loads on a small PC can take over a minute, so the default is generous.
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 120000),
    breakerThreshold: Number(env.BREAKER_THRESHOLD ?? 3),
    breakerCooldownMs: Number(env.BREAKER_COOLDOWN_MS ?? 30000),
    backends,
  };
}
