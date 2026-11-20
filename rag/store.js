// SQLite-backed vector store using Node's built-in node:sqlite (no npm dependencies).
// One file holds the chunks, their embeddings and metadata, so backup is a single file copy.
import { DatabaseSync } from 'node:sqlite';

export class IndexStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        chunk_no INTEGER NOT NULL,
        hash TEXT NOT NULL,
        text TEXT NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source);
    `);
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  get(id) {
    return this.db.prepare('SELECT id, hash, model FROM chunks WHERE id = ?').get(id) ?? null;
  }

  upsert(row) {
    const blob = Buffer.from(new Float32Array(row.embedding).buffer);
    this.db
      .prepare(`INSERT INTO chunks (id, source, chunk_no, hash, text, model, dims, embedding, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  hash = excluded.hash, text = excluded.text, model = excluded.model,
                  dims = excluded.dims, embedding = excluded.embedding, indexed_at = excluded.indexed_at`)
      .run(row.id, row.source, row.chunk_no, row.hash, row.text, row.model, row.embedding.length, blob, row.indexed_at);
  }

  // Remove every chunk for a source file. Returns the number of rows removed.
  deleteSource(source) {
    return this.db.prepare('DELETE FROM chunks WHERE source = ?').run(source).changes;
  }

  // Remove chunks past the new end of a file (the file got shorter).
  deleteChunksFrom(source, chunkCount) {
    return this.db.prepare('DELETE FROM chunks WHERE source = ? AND chunk_no >= ?').run(source, chunkCount).changes;
  }

  sources() {
    return this.db.prepare('SELECT DISTINCT source FROM chunks').all().map((r) => r.source);
  }

  clear() {
    this.db.exec('DELETE FROM chunks');
  }

  // Every chunk embedded with the given model, with the vector as a Float32Array.
  allChunks(model) {
    return this.db
      .prepare('SELECT id, source, chunk_no, text, dims, embedding FROM chunks WHERE model = ?')
      .all(model)
      .map((r) => ({
        id: r.id,
        source: r.source,
        chunk_no: r.chunk_no,
        text: r.text,
        vector: toFloat32(r.embedding),
      }));
  }

  stats() {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
    const perSource = this.db
      .prepare('SELECT source, COUNT(*) AS chunks, MAX(indexed_at) AS last_indexed FROM chunks GROUP BY source ORDER BY source')
      .all();
    return { model: this.getMeta('embed_model'), total, perSource };
  }

  // Consistent copy of the whole database, safe to run while the index is in use.
  backup(destPath) {
    this.db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  }

  close() {
    this.db.close();
  }
}

function toFloat32(blob) {
  const bytes = Uint8Array.from(blob);
  return new Float32Array(bytes.buffer);
}
