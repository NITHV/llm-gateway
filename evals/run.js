// Runs the eval suite against the gateway and fails (exit 1) if the pass rate is below the threshold.
// Set GATEWAY_URL and GATEWAY_KEY. Writes a summary to the GitHub Actions job page when run in CI.
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { scoreCase, passRate } from './score.js';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const KEY = process.env.GATEWAY_KEY ?? '';

async function ask(prompt) {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    // temperature 0 makes the answers as repeatable as the model allows.
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 80,
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`gateway returned HTTP ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

export async function runSuite(suite, askFn = ask) {
  const results = [];
  for (const testCase of suite.cases) {
    try {
      const output = await askFn(testCase.prompt);
      results.push({ ...scoreCase(testCase, output), output });
    } catch (err) {
      results.push({ id: testCase.id, passed: false, failed: [`error: ${err.message}`], output: '' });
    }
  }
  return results;
}

async function main() {
  const suite = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
  const results = await runSuite(suite);
  const rate = passRate(results);
  const passed = rate >= suite.minPassRate;

  console.log('case                      result   output');
  for (const r of results) {
    const shown = r.output.replace(/\s+/g, ' ').slice(0, 60);
    console.log(`${r.id.padEnd(26)}${(r.passed ? 'PASS' : 'FAIL').padEnd(9)}${shown}`);
  }
  console.log(`\npass rate ${(rate * 100).toFixed(0)}% (threshold ${(suite.minPassRate * 100).toFixed(0)}%)`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => `| ${r.id} | ${r.passed ? 'pass' : 'fail'} | ${r.failed.join(', ')} |`).join('\n');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Eval results\n\nPass rate **${(rate * 100).toFixed(0)}%** (threshold ${(suite.minPassRate * 100).toFixed(0)}%)\n\n| case | result | failed checks |\n|---|---|---|\n${rows}\n`,
    );
  }

  if (!passed) {
    console.error('eval gate FAILED');
    process.exit(1);
  }
  console.log('eval gate passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
