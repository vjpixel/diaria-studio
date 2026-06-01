/**
 * test/leaderboard-snapshot-empty.test.ts (#1666)
 *
 * getOrComputeSnapshot NÃO deve gravar um snapshot vazio. Bug: o reorder do
 * #1643 passou getOrComputeSnapshot pra ANTES do gate "ainda não começou", então
 * um GET /leaderboard/{mês-futuro} (rota não-autenticada; parseMonthSlug aceita
 * anos 2000-2099) computava + GRAVAVA um snapshot vazio por slug → write
 * amplification. Fix: early-return sem put quando entries === [].
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getOrComputeSnapshot } from "../workers/poll/src/index.ts";

/** Mock mínimo do KVNamespace que computeSnapshotEntries + getOrComputeSnapshot usam. */
function mockKv(scoreEntries: Record<string, string>) {
  const puts: Array<{ key: string; value: string }> = [];
  return {
    puts,
    async get(key: string): Promise<string | null> {
      if (key.startsWith("leaderboard-snapshot:")) return null; // sem cache → recompute
      return scoreEntries[key] ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      puts.push({ key, value });
    },
    async list({ prefix }: { prefix: string }) {
      const keys = Object.keys(scoreEntries)
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    async delete(): Promise<void> {},
  };
}

describe("getOrComputeSnapshot — não persiste snapshot vazio (#1666)", () => {
  it("mês sem votos → entries [] e NENHUM put (sem write amplification)", async () => {
    const kv = mockKv({}); // zero score-by-month entries
    const env = { POLL: kv } as unknown as Parameters<typeof getOrComputeSnapshot>[0];
    const entries = await getOrComputeSnapshot(env, "2099-12");
    assert.deepEqual(entries, []);
    assert.equal(kv.puts.length, 0, `não deveria gravar snapshot vazio; puts: ${JSON.stringify(kv.puts)}`);
  });

  it("mês com votos → grava o snapshot (comportamento normal preservado)", async () => {
    const kv = mockKv({
      "score-by-month:2026-06:a@x.com": JSON.stringify({ nickname: "A", correct: 3, total: 3 }),
    });
    const env = { POLL: kv } as unknown as Parameters<typeof getOrComputeSnapshot>[0];
    const entries = await getOrComputeSnapshot(env, "2026-06");
    assert.equal(entries.length, 1);
    assert.equal(kv.puts.length, 1, "deveria cachear o snapshot quando há votos");
    assert.equal(kv.puts[0].key, "leaderboard-snapshot:2026-06");
  });
});
