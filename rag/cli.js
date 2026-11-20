// RAG command line.
//   node rag/cli.js index                 index README.md and docs/ into rag/data/index.db
//   node rag/cli.js query "question"      show the top matching chunks
//   node rag/cli.js query "question" --answer   also answer through the gateway, using those chunks
//   node rag/cli.js status                counts per source, embedding model, last indexed time
//   node rag/cli.js backup [dest.db]      consistent copy of the index file
//
// Environment: OLLAMA_URL (default http://localhost:11434), EMBED_MODEL (default nomic-embed-text),
//              GATEWAY_URL (default http://localhost:8080), GATEWAY_KEY, CHAT_MODEL (optional).
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IndexStore } from './store.js';
import { collectFiles, indexFiles, search } from './pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'nomic-embed-text';
const DEFAULT_DB = join(here, 'data', 'index.db');

export function makeOllamaEmbedder(url = OLLAMA, model = EMBED_MODEL) {
  return async (inputs) => {
    const res = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: inputs }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`embedding failed: HTTP ${res.status}`);
    return (await res.json()).embeddings;
  };
}

function defaultDocPaths() {
  const paths = [join(root, 'README.md')];
  const docs = join(root, 'docs');
  if (existsSync(docs)) paths.push(docs);
  return paths;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const key = rest[i].slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(rest[i]);
    }
  }
  return { command, positional, flags };
}

async function answerWithGateway(question, hits) {
  const context = hits.map((h, i) => `[${i + 1}] (${h.source}) ${h.text}`).join('\n\n');
  const res = await fetch(`${process.env.GATEWAY_URL ?? 'http://localhost:8080'}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.GATEWAY_KEY ?? ''}` },
    body: JSON.stringify({
      messages: [
        {
          role: 'system',
          content: 'Answer the question using only the numbered context. If the context does not contain the answer, say so.',
        },
        { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
      ],
      temperature: 0,
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`gateway returned HTTP ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content ?? '';
}

export async function main(argv = process.argv.slice(2)) {
  const { command, positional, flags } = parseArgs(argv);
  const dbPath = flags.db ?? DEFAULT_DB;
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new IndexStore(dbPath);

  try {
    if (command === 'index') {
      const paths = positional.length ? positional.map((p) => resolve(p)) : defaultDocPaths();
      const files = collectFiles(paths, root);
      const stats = await indexFiles({ store, files, model: EMBED_MODEL, embed: makeOllamaEmbedder() });
      console.log(`indexed ${files.length} files with ${EMBED_MODEL}`);
      console.log(JSON.stringify(stats));
      return 0;
    }

    if (command === 'query') {
      const question = positional.join(' ');
      if (!question) throw new Error('usage: query "your question"');
      const hits = await search({
        store,
        model: EMBED_MODEL,
        embed: makeOllamaEmbedder(),
        question,
        k: Number(flags.k ?? 3),
      });
      if (hits.length === 0) {
        console.log('no indexed chunks for this model. Run: node rag/cli.js index');
        return 1;
      }
      for (const h of hits) {
        console.log(`\n[${h.score.toFixed(3)}] ${h.source}#${h.chunk_no}\n${h.text.slice(0, 300)}${h.text.length > 300 ? '...' : ''}`);
      }
      if (flags.answer) {
        console.log(`\n--- answer (via gateway)\n${await answerWithGateway(question, hits)}`);
      }
      return 0;
    }

    if (command === 'status') {
      const s = store.stats();
      console.log(`embedding model: ${s.model ?? '(none)'}   chunks: ${s.total}`);
      for (const row of s.perSource) console.log(`  ${row.source.padEnd(40)} ${String(row.chunks).padStart(4)} chunks   last ${row.last_indexed}`);
      return 0;
    }

    if (command === 'backup') {
      const dest = positional[0] ?? join(here, 'data', `index-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      store.backup(resolve(dest));
      console.log(`backup written to ${resolve(dest)}`);
      return 0;
    }

    console.log('commands: index | query "question" [--answer] [--k N] | status | backup [dest]');
    return command ? 1 : 0;
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
