import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkMarkdown } from '../rag/chunk.js';
import { IndexStore } from '../rag/store.js';
import { collectFiles, indexFiles, search, cosine } from '../rag/pipeline.js';

// Deterministic stand-in for the embedding model: a hashed bag-of-words vector.
const DIM = 64;
function hashWord(w) {
  let h = 0;
  for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
function fakeEmbedder(calls = []) {
  return async (inputs) => {
    calls.push(inputs.length);
    return inputs.map((t) => {
      const v = new Array(DIM).fill(0);
      for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) v[hashWord(w) % DIM] += 1;
      return v;
    });
  };
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'rag-test-'));
  const docs = join(dir, 'docs');
  mkdirSync(docs);
  return { dir, docs, dbPath: join(dir, 'index.db') };
}

test('chunker keeps headings and respects the size limit', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} about caching and retries.`).join('\n\n');
  const md = `# Intro\n\nHello world.\n\n## Details\n\n${long}`;
  const chunks = chunkMarkdown(md, { maxChars: 300, overlap: 40 });
  assert.ok(chunks.length > 2, 'long section is split');
  for (const c of chunks) {
    assert.ok(c.text.length <= 300 + 'Details\n\n'.length, `chunk too long: ${c.text.length}`);
  }
  assert.equal(chunks[0].heading, 'Intro');
  assert.ok(chunks.some((c) => c.heading === 'Details'));
});

test('first run adds everything, second run skips everything without embedding', async () => {
  const w = workspace();
  writeFileSync(join(w.docs, 'a.md'), '# A\n\nKubernetes pods are scheduled onto nodes.');
  writeFileSync(join(w.docs, 'b.md'), '# B\n\nPasta needs salted boiling water.');
  const store = new IndexStore(w.dbPath);
  const files = collectFiles([w.docs], w.dir);
  const calls1 = [];
  const first = await indexFiles({ store, files, model: 'm1', embed: fakeEmbedder(calls1) });
  assert.equal(first.added, 2);
  assert.equal(first.skipped, 0);

  const calls2 = [];
  const second = await indexFiles({ store, files, model: 'm1', embed: fakeEmbedder(calls2) });
  assert.equal(second.added + second.updated, 0);
  assert.equal(second.skipped, 2);
  assert.equal(calls2.length, 0, 'no embedding calls for unchanged content');
  store.close();
  rmSync(w.dir, { recursive: true, force: true });
});

test('changed, removed and shrunk files are handled', async () => {
  const w = workspace();
  writeFileSync(join(w.docs, 'a.md'), '# A\n\nOne.\n\nTwo.');
  writeFileSync(join(w.docs, 'b.md'), '# B\n\nGone soon.');
  const store = new IndexStore(w.dbPath);
  const embed = fakeEmbedder();
  await indexFiles({ store, files: collectFiles([w.docs], w.dir), model: 'm1', embed });

  // a.md changes text; b.md is removed.
  writeFileSync(join(w.docs, 'a.md'), '# A\n\nOne changed.');
  rmSync(join(w.docs, 'b.md'));
  const stats = await indexFiles({ store, files: collectFiles([w.docs], w.dir), model: 'm1', embed });
  assert.equal(stats.updated, 1, 'changed chunk re-embedded');
  assert.ok(stats.deleted >= 1, 'removed file and tail chunks deleted');
  assert.deepEqual(store.sources(), ['docs/a.md']);
  store.close();
  rmSync(w.dir, { recursive: true, force: true });
});

test('changing the embedding model rebuilds the whole index', async () => {
  const w = workspace();
  writeFileSync(join(w.docs, 'a.md'), '# A\n\nSome text here.');
  const store = new IndexStore(w.dbPath);
  const files = collectFiles([w.docs], w.dir);
  await indexFiles({ store, files, model: 'm1', embed: fakeEmbedder() });

  const calls = [];
  const stats = await indexFiles({ store, files, model: 'm2', embed: fakeEmbedder(calls) });
  assert.equal(stats.rebuilt, true);
  assert.ok(calls.length > 0, 'everything re-embedded with the new model');
  assert.equal(store.stats().model, 'm2');
  store.close();
  rmSync(w.dir, { recursive: true, force: true });
});

test('search ranks the relevant chunk first', async () => {
  const w = workspace();
  writeFileSync(join(w.docs, 'k8s.md'), '# Scheduling\n\nKubernetes pods are scheduled onto worker nodes.');
  writeFileSync(join(w.docs, 'food.md'), '# Cooking\n\nPasta needs salted boiling water and olive oil.');
  const store = new IndexStore(w.dbPath);
  const embed = fakeEmbedder();
  await indexFiles({ store, files: collectFiles([w.docs], w.dir), model: 'm1', embed });
  const hits = await search({ store, model: 'm1', embed, question: 'how are kubernetes pods scheduled?', k: 2 });
  assert.equal(hits[0].source, 'docs/k8s.md');
  assert.ok(hits[0].score > hits[1].score);
  store.close();
  rmSync(w.dir, { recursive: true, force: true });
});

test('backup produces a readable copy of the index', async () => {
  const w = workspace();
  writeFileSync(join(w.docs, 'a.md'), '# A\n\nBackup me.');
  const store = new IndexStore(w.dbPath);
  await indexFiles({ store, files: collectFiles([w.docs], w.dir), model: 'm1', embed: fakeEmbedder() });
  const dest = join(w.dir, 'copy.db');
  store.backup(dest);
  store.close();
  const copy = new IndexStore(dest);
  assert.equal(copy.stats().total, 1);
  copy.close();
  assert.ok(existsSync(dest));
  rmSync(w.dir, { recursive: true, force: true });
});

test('cosine similarity basics', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
});
