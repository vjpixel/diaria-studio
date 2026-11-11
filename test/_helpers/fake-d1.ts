/**
 * test/_helpers/fake-d1.ts (#12842) — `D1Client` falso sobre SQLite em memória
 * (`node:sqlite`). Roda o MESMO SQL que vai à Cloudflare, com os parâmetros em
 * string como a REST exige — o teste exercita o upsert condicional de verdade,
 * não uma reimplementação dele.
 *
 * `failing()` simula o D1 fora do ar (toda chamada lança). `interleave` permite
 * intercalar chamadas de dois "processos" sobre o mesmo banco.
 */
import { DatabaseSync } from "node:sqlite";
import { D1_LOCKS_SCHEMA_SQL, type D1Client } from "../../scripts/lib/d1-locks.ts";

export interface FakeD1 extends D1Client {
  db: DatabaseSync;
  calls: Array<{ sql: string; params: string[] }>;
}

export function createFakeD1(): FakeD1 {
  const db = new DatabaseSync(":memory:");
  db.exec(D1_LOCKS_SCHEMA_SQL);
  const calls: FakeD1["calls"] = [];
  return {
    db,
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const stmt = db.prepare(sql);
      const results = stmt.all(...params) as Record<string, unknown>[];
      return { results, servedByPrimary: true };
    },
  };
}

export function failingD1(message = "fetch failed (simulado)"): D1Client & { calls: number } {
  const c = {
    calls: 0,
    async query(): Promise<never> {
      c.calls++;
      throw new Error(message);
    },
  };
  return c;
}
