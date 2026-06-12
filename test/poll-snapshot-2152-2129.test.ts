/**
 * test/poll-snapshot-2152-2129.test.ts
 *
 * Regressões para dois bugs em upsertOwnEntryInSnapshot:
 *
 *   #2152 (P1, PROD): snapshot ausente + N>1 score-by-month keys → após voto,
 *     snapshot deve conter TODOS os N votantes (não só o votante atual).
 *     Bug: `entries = []` quando `cached` é null destruía a visão dos outros N
 *     votantes. Fix: chamar computeSnapshotEntries quando cached é null.
 *
 *   #2129 (P2): voto sobre snapshot fresco NÃO deve reduzir o TTL do cache
 *     de 24h para 300s. Bug: upsert sempre gravava com expirationTtl=300,
 *     rebaixando o TTL do snapshot computado (86400). Fix: upsert usa 86400.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  upsertOwnEntryInSnapshot,
  type SnapshotEntry,
  type Env,
} from "../workers/poll/src/index.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

/** KV em memória que rastreia puts (incluindo expirationTtl). */
function makeTrackedKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const puts: Array<{ key: string; value: string; opts?: { expirationTtl?: number } }> = [];
  const kv = {
    puts,
    async get(key: string) { return store.get(key) ?? null; },
    async getWithMetadata(key: string) { return { value: store.get(key) ?? null, metadata: null }; },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      puts.push({ key, value, opts });
      store.set(key, value);
    },
    async delete(key: string) { store.delete(key); },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  };
  return kv;
}

function makeEnv(kv: ReturnType<typeof makeTrackedKv>): Env {
  return {
    POLL: kv as unknown as KVNamespace,
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}

// ── #2152: snapshot ausente com N>1 votantes existentes ─────────────────────

describe("#2152 — snapshot ausente não deve destruir votantes existentes", () => {
  it("snapshot ausente + 21 votantes no KV → após voto, snapshot tem 22 entradas", async () => {
    // Simula o cenário real: 21 votos no KV (score-by-month), snapshot expirou (TTL 5min).
    // Bug antigo: entries=[] → snapshot gravado com só o votante atual.
    // Fix: computeSnapshotEntries materializa os 21 antes do upsert.
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 21; i++) {
      initial[`score-by-month:2026-06:voter${i}@x.com`] = JSON.stringify({
        nickname: `Voter${i}`,
        correct: i,
        total: 21,
        last_vote_ts: `2026-06-0${String(i).padStart(1, "0")}T10:00:00.000Z`,
      });
    }
    const kv = makeTrackedKv(initial); // sem snapshot (cached = null)
    const env = makeEnv(kv);

    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "pixel@x.com",
      nickname: "Pixel",
      correct: 5,
      total: 21,
    });

    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put, "snapshot deve ser gravado");
    const payload = JSON.parse(put!.value);
    assert.equal(
      payload.entries.length,
      22,
      "snapshot deve ter os 21 votantes existentes + o novo (não só 1)",
    );
    const pixel = payload.entries.find((e: SnapshotEntry) => e.email === "pixel@x.com");
    assert.ok(pixel, "votante atual deve estar presente no snapshot");
    assert.equal(pixel.correct, 5, "dados do votante atual corretos");
  });

  it("snapshot ausente + 1 votante existente + voto de outro → snapshot tem 2 entradas", async () => {
    const kv = makeTrackedKv({
      "score-by-month:2026-06:alice@x.com": JSON.stringify({
        nickname: "Alice",
        correct: 3,
        total: 5,
      }),
      // sem snapshot
    });
    const env = makeEnv(kv);
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "bob@x.com",
      nickname: "Bob",
      correct: 2,
      total: 5,
    });
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put, "snapshot deve ser gravado");
    const payload = JSON.parse(put!.value);
    assert.equal(payload.entries.length, 2, "Alice + Bob no snapshot");
    const emails = payload.entries.map((e: SnapshotEntry) => e.email).sort();
    assert.deepEqual(emails, ["alice@x.com", "bob@x.com"]);
  });

  it("snapshot ausente + 0 votantes existentes + primeiro voto → snapshot tem 1 entrada", async () => {
    // Caso legítimo de "primeiro voto do mês" — comportamento correto original.
    const kv = makeTrackedKv({}); // KV vazio, sem snapshot nem score-by-month
    const env = makeEnv(kv);
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "alice@x.com",
      nickname: "Alice",
      correct: 1,
      total: 1,
    });
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put, "snapshot deve ser gravado");
    const payload = JSON.parse(put!.value);
    assert.equal(payload.entries.length, 1, "só Alice — primeiro voto real do mês");
    assert.equal(payload.entries[0].email, "alice@x.com");
  });

  it("snapshot existente com N entradas + voto novo → N+1 entradas", async () => {
    // Snapshot presente com 5 votantes → voto de novo votante → 6 entradas.
    const existingEntries = Array.from({ length: 5 }, (_, i) => ({
      email: `voter${i + 1}@x.com`,
      nickname: `Voter${i + 1}`,
      correct: i + 1,
      total: 10,
    }));
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: existingEntries,
        computed_at: "2026-06-10T00:00:00.000Z",
      }),
    });
    const env = makeEnv(kv);
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "new@x.com",
      nickname: "New",
      correct: 3,
      total: 10,
    });
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put, "snapshot deve ser regravado");
    const payload = JSON.parse(put!.value);
    assert.equal(payload.entries.length, 6, "5 existentes + 1 novo = 6");
    assert.ok(
      payload.entries.find((e: SnapshotEntry) => e.email === "new@x.com"),
      "novo votante deve estar presente",
    );
  });

  it("snapshot existente com N entradas + revoto do mesmo email → N entradas (upsert, não append)", async () => {
    // Re-votante: total atualizado, não duplicado.
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: [
          { email: "alice@x.com", nickname: "Alice", correct: 2, total: 3 },
          { email: "bob@x.com", nickname: "Bob", correct: 1, total: 3 },
        ],
        computed_at: "2026-06-10T00:00:00.000Z",
      }),
    });
    const env = makeEnv(kv);
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "alice@x.com",
      nickname: "Alice",
      correct: 3,
      total: 4,
    });
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put);
    const payload = JSON.parse(put!.value);
    assert.equal(payload.entries.length, 2, "revoto não duplica a entry");
    const alice = payload.entries.find((e: SnapshotEntry) => e.email === "alice@x.com");
    assert.equal(alice.total, 4, "total de Alice atualizado");
    assert.equal(alice.correct, 3, "correct de Alice atualizado");
  });

  it("caminho invalidação (#2152 sub-caso b): adjustScoreByMonthCorrect deleta snapshot → voto seguinte restaura todos", async () => {
    // adjustScoreByMonthCorrect chama invalidateSnapshot que deleta a chave.
    // Sem o fix, o próximo voto gravaria snapshot de 1 entrada.
    const kv = makeTrackedKv({
      // score-by-month keys existentes (N=3) — snapshot foi deletado por invalidação
      "score-by-month:2026-06:alice@x.com": JSON.stringify({ nickname: "Alice", correct: 3, total: 5 }),
      "score-by-month:2026-06:bob@x.com": JSON.stringify({ nickname: "Bob", correct: 2, total: 5 }),
      "score-by-month:2026-06:carol@x.com": JSON.stringify({ nickname: "Carol", correct: 1, total: 5 }),
      // leaderboard-snapshot:2026-06 AUSENTE (simulando invalidação)
    });
    const env = makeEnv(kv);

    // Novo voto de Dave após invalidação
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "dave@x.com",
      nickname: "Dave",
      correct: 0,
      total: 1,
    });

    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put, "snapshot recriado após invalidação");
    const payload = JSON.parse(put!.value);
    assert.equal(payload.entries.length, 4, "Alice + Bob + Carol + Dave (não só Dave)");
    const emails = payload.entries.map((e: SnapshotEntry) => e.email).sort();
    assert.deepEqual(emails, ["alice@x.com", "bob@x.com", "carol@x.com", "dave@x.com"]);
  });
});

// ── #2129: TTL do snapshot não deve ser rebaixado pelo upsert ────────────────

describe("#2129 — upsert preserva TTL 24h (não rebaixa para 300s)", () => {
  it("voto sobre snapshot existente: TTL gravado é 86400 (24h)", async () => {
    // Cenário: snapshot foi computado (TTL 86400). Voto chega e faz upsert.
    // Bug antigo: expirationTtl=300 → snapshot expira 5min após o voto,
    // causando recompute repetido no pico de leitura pós-envio.
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: [{ email: "alice@x.com", nickname: "Alice", correct: 2, total: 3 }],
        computed_at: "2026-06-10T00:00:00.000Z",
      }),
    });
    const env = makeEnv(kv);
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "bob@x.com",
      nickname: "Bob",
      correct: 1,
      total: 1,
    });
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put, "snapshot deve ser regravado");
    assert.equal(
      put!.opts?.expirationTtl,
      86400,
      "TTL deve ser 86400s (24h) — não rebaixar o snapshot computado para 300s",
    );
  });

  it("voto sobre snapshot ausente: TTL gravado é 86400 (não 300s)", async () => {
    // Mesmo quando snapshot estava ausente (computeSnapshotEntries chamado),
    // o TTL do resultado deve ser 86400 — idêntico ao getOrComputeSnapshot.
    const kv = makeTrackedKv({
      "score-by-month:2026-06:alice@x.com": JSON.stringify({
        nickname: "Alice", correct: 2, total: 3,
      }),
    });
    const env = makeEnv(kv);
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "bob@x.com",
      nickname: "Bob",
      correct: 1,
      total: 1,
    });
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put, "snapshot deve ser gravado");
    assert.equal(
      put!.opts?.expirationTtl,
      86400,
      "TTL 86400s mesmo partindo de snapshot ausente",
    );
  });

  it("read-your-own-write mantido: votante vê próprios dados no snapshot após upsert", async () => {
    // Objetivo original do #2113b: ler o snapshot depois do upsert mostra o voto.
    // Com TTL 86400, isso continua funcionando — a entry está no snapshot.
    const kv = makeTrackedKv();
    const env = makeEnv(kv);
    const ts = "2026-06-11T10:00:00.000Z";
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "alice@x.com",
      nickname: "Alice",
      correct: 3,
      total: 5,
      last_vote_ts: ts,
    });
    // Ler o snapshot diretamente do KV (simula getOrComputeSnapshot no hit path)
    const raw = await kv.get("leaderboard-snapshot:2026-06");
    assert.ok(raw, "snapshot deve existir");
    const payload = JSON.parse(raw!);
    const alice = payload.entries.find((e: SnapshotEntry) => e.email === "alice@x.com");
    assert.ok(alice, "alice deve estar no snapshot (read-your-own-write)");
    assert.equal(alice.correct, 3);
    assert.equal(alice.total, 5);
    assert.equal(alice.last_vote_ts, ts);
  });
});
