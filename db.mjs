/* =============================================================================
   test/lib/db.mjs — read (and optionally write) the LOCAL D1 database directly.

   Why not `wrangler d1 execute`?
     It briefly disturbs a running `wrangler dev`, so any HTTP or WebSocket call
     made immediately afterwards fails with a connection reset. That made tests
     order-dependent and produced failures that looked like game bugs.

   Node 22 ships `node:sqlite`, so the test can open the same file Miniflare
   writes to. Reads are safe alongside the running server (SQLite is in WAL
   mode). Writes take the write lock, so a busy timeout is set and callers
   should treat a write failure as a real result rather than retrying forever.
   ============================================================================= */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/** Miniflare stores local D1 databases here, one file per database. */
export function findDbFile(root) {
  const dir = path.join(root, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
  if (!fs.existsSync(dir)) {
    throw new Error('No local D1 database found. Run `npm run db:migrate` first.');
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sqlite'));
  if (!files.length) throw new Error('No .sqlite file in ' + dir + '. Run `npm run db:migrate` first.');
  /* Newest wins, so a rebuilt state directory does not pick up a stale file. */
  files.sort((a, b) =>
    fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]);
}

export function openDb(root, { readOnly = true } = {}) {
  const file = findDbFile(root);
  const db = new DatabaseSync(file, { readOnly });
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch (e) { /* read-only is fine */ }
  return {
    file,
    /** Rows as plain objects. */
    all(sql, ...params) {
      const stmt = db.prepare(sql);
      return params.length ? stmt.all(...params) : stmt.all();
    },
    /** First row, or {} when there is none. */
    one(sql, ...params) {
      const rows = this.all(sql, ...params);
      return rows[0] || {};
    },
    /** Single scalar value, or null. */
    scalar(sql, ...params) {
      const row = this.one(sql, ...params);
      const keys = Object.keys(row);
      return keys.length ? row[keys[0]] : null;
    },
    run(sql, ...params) {
      const stmt = db.prepare(sql);
      return params.length ? stmt.run(...params) : stmt.run();
    },
    close() { try { db.close(); } catch (e) { /* already closed */ } }
  };
}

/** Convenience: a short-lived read handle. */
export function withDb(root, fn) {
  const db = openDb(root);
  try { return fn(db); } finally { db.close(); }
}
