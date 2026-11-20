// Incremental indexing and search. Pure logic, with the embedder passed in, so tests can use a fake one.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { chunkMarkdown } from './chunk.js';

export const sha = (s) => createHash('sha256').update(s).digest('hex');

// nomic-embed-text expects these prefixes. Using them matches how the model was trained.
const DOC_PREFIX = 'search_document: ';
const QUERY_PREFIX = 'search_query: ';

// Walks paths and returns every .md file as { source, text }. Source is a stable, repo-relative path.
export function collectFiles(paths, root) {
  const files = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) walk(join(p, name));
    } else if (p.endsWith('.md')) {
      files.push({ source: relative(root, p).split(sep).join('/'), text: readFileSync(p, 'utf8') });
    }
  };
  for (const p of paths) walk(p);
  return files;
}

// Brings the index in line with the files. Returns counts so each run is auditable.
//   - unchanged chunks are skipped (no embedding call)
//   - changed or new chunks are embedded
//   - a different embedding model triggers a full rebuild, because vectors from two models don't compare
//   - sources that disappeared, or got shorter, are removed
export async function indexFiles({ store, files, model, embed, batchSize = 16, now = () => new Date().toISOString() }) {
  const stats = { added: 0, updated: 0, skipped: 0, deleted: 0, rebuilt: false };

  const previousModel = store.getMeta('embed_model');
  if (previousModel !== model) {
    if (previousModel !== null) stats.rebuilt = true;
    store.clear();
    store.setMeta('embed_model', model);
  }

  const seen = new Map();
  const pending = [];
  for (const file of files) {
    const chunks = chunkMarkdown(file.text);
    seen.set(file.source, chunks.length);
    chunks.forEach((chunk, i) => {
      const hash = sha(chunk.text);
      const id = sha(`${file.source}#${i}`);
      const existing = store.get(id);
      if (existing && existing.hash === hash && existing.model === model) {
        stats.skipped += 1;
        return;
      }
      pending.push({ id, source: file.source, chunk_no: i, hash, text: chunk.text, isUpdate: Boolean(existing) });
    });
  }

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vectors = await embed(batch.map((p) => `${DOC_PREFIX}${p.text}`));
    if (vectors.length !== batch.length) throw new Error('embedder returned the wrong number of vectors');
    batch.forEach((p, j) => {
      store.upsert({
        id: p.id,
        source: p.source,
        chunk_no: p.chunk_no,
        hash: p.hash,
        text: p.text,
        model,
        embedding: vectors[j],
        indexed_at: now(),
      });
      if (p.isUpdate) stats.updated += 1;
      else stats.added += 1;
    });
  }

  for (const source of store.sources()) {
    if (!seen.has(source)) {
      stats.deleted += store.deleteSource(source);
    } else {
      stats.deleted += store.deleteChunksFrom(source, seen.get(source));
    }
  }

  return stats;
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Embeds the question with the query prefix and returns the top-k chunks by cosine similarity.
export async function search({ store, model, embed, question, k = 3 }) {
  const [queryVector] = await embed([`${QUERY_PREFIX}${question}`]);
  return store
    .allChunks(model)
    .filter((c) => c.vector.length === queryVector.length)
    .map((c) => ({ ...c, score: cosine(queryVector, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ vector, ...rest }) => rest);
}
