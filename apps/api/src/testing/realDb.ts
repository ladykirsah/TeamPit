import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

/**
 * Tests only: a real SQLite built from every migration in apply order, foreign keys on as in D1,
 * and the slice of D1 the Worker uses (prepare → bind → all/first/run, plus an atomic batch).
 * Several older test files carry their own copy of these two; new tests use this one.
 */

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/migrations",
);

export function migratedDb(): DatabaseSync {
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(migrationsDir)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  }
  raw.exec("PRAGMA foreign_keys = ON");
  return raw;
}

export function asD1(raw: DatabaseSync): D1Database {
  const make = (sql: string) => {
    let binds: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        binds = args;
        return stmt;
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        return { results: raw.prepare(sql).all(...(binds as never[])) as T[] };
      },
      async first<T = unknown>(): Promise<T | null> {
        return (raw.prepare(sql).get(...(binds as never[])) as T | undefined) ?? null;
      },
      async run() {
        return raw.prepare(sql).run(...(binds as never[]));
      },
      __exec() {
        return raw.prepare(sql).run(...(binds as never[]));
      },
    };
    return stmt;
  };
  return {
    prepare: (sql: string) => make(sql),
    async batch(stmts: { __exec: () => unknown }[]) {
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.__exec());
        raw.exec("COMMIT");
        return out;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}

/** Tests only: the slice of an R2 bucket the Worker uses, kept in memory. */
export function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const bucket = {
    async put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, {
        bytes: new Uint8Array(value),
        contentType: opts?.httpMetadata?.contentType ?? "application/octet-stream",
      });
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        body: o.bytes,
        httpMetadata: { contentType: o.contentType },
        arrayBuffer: async () => o.bytes.buffer,
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  return { objects, bucket: bucket as unknown as R2Bucket };
}
