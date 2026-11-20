// Scoring for the eval suite. Pure functions, so they're easy to unit test.

export function checkOutput(text, check) {
  const t = String(text ?? '');
  const lower = t.toLowerCase();
  switch (check.type) {
    case 'contains_any':
      return check.values.some((v) => lower.includes(v.toLowerCase()));
    case 'not_contains':
      return !check.values.some((v) => lower.includes(v.toLowerCase()));
    case 'max_words':
      return t.trim().split(/\s+/).filter(Boolean).length <= check.max;
    case 'regex':
      return new RegExp(check.pattern, 'i').test(t);
    default:
      throw new Error(`unknown check type: ${check.type}`);
  }
}

// A case passes only when every one of its checks passes.
export function scoreCase(testCase, output) {
  const failed = testCase.checks.filter((c) => !checkOutput(output, c)).map((c) => c.type);
  return { id: testCase.id, passed: failed.length === 0, failed };
}

export function passRate(results) {
  if (results.length === 0) return 0;
  return results.filter((r) => r.passed).length / results.length;
}
