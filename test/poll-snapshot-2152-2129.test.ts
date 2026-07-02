/**
 * test/poll-snapshot-2152-2129.test.ts
 *
 * Regressões para dois bugs em upsertOwnEntryInSnapshot:
 *
 *   #2152 (P1, PROD): snapshot ausente + N>1 score-by-month keys → após voto,
 *     o snapshot de 1 entrada NÃO deve ser gravado (skip-on-missing, modelo
 *     híbrido). O próximo GET (getOrComputeSnapshot) vê todos os N votantes.
 *     Bug original: `entries = []` destruía a visão dos outros N votantes.
 *     Fix original tentou computeSnapshotEntries no voto — mas F3 mostrou que
 *     estourava o budget de 50 subrequests/req para N≥35. Fix final: skip.
 *
 *   #2129 (P2): voto sobre snapshot PRESENTE NÃO deve reduzir o TTL do cache
 *     de 24h para 300s. Bug: upsert sempre gravava com expirationTtl=300,
 *     rebaixando o TTL do snapshot computado (86400). Fix: upsert usa 86400.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  upsertOwnEntryInSnapshot,
  getOrComputeSnapshot,
  type SnapshotEntry,
  type Env,
} from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEnv(kv: ReturnType<typeof makeTrackedKv>): Env {
  return makePollEnv(kv);
}

// ── #2152: snapshot ausente com N>1 votantes — modelo híbrido (skip-on-missing) ──

describe("#2152 — snapshot ausente não deve destruir votantes existentes (modelo híbrido)", () => {
  it("snapshot ausente + N>1 votantes → após voto NÃO existe snapshot de 1 entrada gravado", async () => {
    // Modelo híbrido: snapshot ausente → skip. Não chama computeSnapshotEntries
    // dentro do voto (estouraria subrequest budget para N≥35, F3).
    // Bug original: entries=[] → snapshot de 1 entrada que apagava os outros N.
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 21; i++) {
      const day = String(i).padStart(2, "0"); // F5: padStart(2) para datas ISO válidas
      initial[`score-by-month:2026-06:voter${i}@x.com`] = JSON.stringify({
        nickname: `Voter${i}`,
        correct: i,
        total: 21,
        last_vote_ts: `2026-06-${day}T10:00:00.000Z`,
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

    const snapshotPut = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    // Modelo híbrido: ausente → skip, nenhum snapshot de 1 entrada gravado.
    assert.equal(
      snapshotPut,
      undefined,
      "snapshot ausente → skip-on-missing: nenhum snapshot de 1 entrada deve ser persistido (#2152/#F3)",
    );
  });

  it("snapshot ausente: getOrComputeSnapshot (lazy) vê os N+1 votantes após o voto", async () => {
    // O READ (getOrComputeSnapshot) faz full-compute e vê todos os votantes.
    // Confirma que skip-on-missing não perde dados — dados estão em score-by-month.
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
      initial[`score-by-month:2026-06:voter${i}@x.com`] = JSON.stringify({
        nickname: `Voter${i}`,
        correct: i,
        total: 5,
      });
    }
    const kv = makeTrackedKv(initial);
    const env = makeEnv(kv);

    // Voto escreve o score-by-month key do novo votante (simulado aqui diretamente)
    // e chama upsertOwnEntryInSnapshot (que skipa — snapshot ausente).
    await kv.put("score-by-month:2026-06:pixel@x.com", JSON.stringify({
      nickname: "Pixel",
      correct: 3,
      total: 5,
    }));
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "pixel@x.com",
      nickname: "Pixel",
      correct: 3,
      total: 5,
    });

    // Simula o próximo GET: getOrComputeSnapshot lazy-computa tudo.
    const entries = await getOrComputeSnapshot(env, "2026-06");
    assert.equal(
      entries.length,
      6,
      "getOrComputeSnapshot deve ver os 5 votantes originais + pixel (6 total)",
    );
  });

  it("snapshot ausente + 0 votantes (primeiro voto do mês) → skip-on-missing, nada gravado", async () => {
    // Primeiro voto do mês: KV vazio, snapshot ausente → skip. O READ lazy-computa.
    const kv = makeTrackedKv({});
    const env = makeEnv(kv);
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "alice@x.com",
      nickname: "Alice",
      correct: 1,
      total: 1,
    });
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.equal(put, undefined, "skip-on-missing: nenhum snapshot gravado para primeiro voto");
  });

  it("snapshot existente com N entradas + voto novo → N+1 entradas (upsert normal)", async () => {
    // Snapshot PRESENTE: caminho normal do upsert não é afetado.
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
    // F8: verificar que pelo menos um votante pré-existente tem dados corretos
    const voter1 = payload.entries.find((e: SnapshotEntry) => e.email === "voter1@x.com");
    assert.ok(voter1, "voter1 pré-existente deve ser preservado");
    assert.equal(voter1.correct, 1, "correct de voter1 pré-existente preservado");
    assert.equal(voter1.nickname, "Voter1", "nickname de voter1 pré-existente preservado");
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
    // F8: verificar que bob (pré-existente) foi preservado intacto
    const bob = payload.entries.find((e: SnapshotEntry) => e.email === "bob@x.com");
    assert.ok(bob, "bob pré-existente preservado");
    assert.equal(bob.correct, 1, "correct de bob não alterado");
  });

  it("caminho invalidação (#2152 sub-caso b): após adjustScoreByMonthCorrect deleta snapshot → voto seguinte skipa (lazy rebuild)", async () => {
    // adjustScoreByMonthCorrect chama invalidateSnapshot que deleta a chave.
    // Com modelo híbrido: próximo voto skipa (snapshot ausente). O READ lazy-computa.
    const kv = makeTrackedKv({
      // score-by-month keys existentes (N=3) — snapshot foi deletado por invalidação
      "score-by-month:2026-06:alice@x.com": JSON.stringify({ nickname: "Alice", correct: 3, total: 5 }),
      "score-by-month:2026-06:bob@x.com": JSON.stringify({ nickname: "Bob", correct: 2, total: 5 }),
      "score-by-month:2026-06:carol@x.com": JSON.stringify({ nickname: "Carol", correct: 1, total: 5 }),
      // leaderboard-snapshot:2026-06 AUSENTE (simulando invalidação)
    });
    const env = makeEnv(kv);

    // Novo voto de Dave após invalidação — upsert skipa (snapshot ausente)
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "dave@x.com",
      nickname: "Dave",
      correct: 0,
      total: 1,
    });

    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.equal(put, undefined, "skip-on-missing: nenhum snapshot de 1 gravado após invalidação");

    // Simula dave votando (score-by-month key gravado pelo handleVote real)
    await kv.put("score-by-month:2026-06:dave@x.com", JSON.stringify({ nickname: "Dave", correct: 0, total: 1 }));

    // O próximo READ (getOrComputeSnapshot) reconstrói tudo
    const result = await getOrComputeSnapshot(env, "2026-06");
    assert.equal(result.length, 4, "Alice + Bob + Carol + Dave (lazy rebuild via GET)");
    const emails = result.map((e: SnapshotEntry) => e.email).sort();
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
    // F6: TTL test também verifica contagem de entries para detectar regressão de dados
    const payload = JSON.parse(put!.value);
    assert.equal(payload.entries.length, 2, "alice + bob ambos presentes (não só bob)");
  });

  it("snapshot ausente: skip-on-missing — nenhum put de snapshot (TTL irrelevante)", async () => {
    // Com modelo híbrido, snapshot ausente não gera put algum.
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
    assert.equal(put, undefined, "skip-on-missing: nenhum put de snapshot quando ausente");
  });

  it("read-your-own-write mantido: votante vê próprios dados no snapshot após upsert (snapshot presente)", async () => {
    // Objetivo original do #2113b: ler o snapshot depois do upsert mostra o voto.
    // Com TTL 86400 e snapshot PRESENTE, a entry está no snapshot.
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: [],
        computed_at: "2026-06-11T00:00:00.000Z",
      }),
    });
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

// ── F1: structural corruption (non-array entries) → skip, não persiste 1-entry ──

describe("F1 — snapshot corrompido (não-array entries) não persiste 1-entry por 24h", () => {
  it("entries é null → deleta snapshot e retorna sem gravar (skip-on-corrupted)", async () => {
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: null, // estrutura inválida
        computed_at: "2026-06-10T00:00:00.000Z",
      }),
    });
    const env = makeEnv(kv);
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "alice@x.com",
      nickname: "Alice",
      correct: 1,
      total: 1,
    });
    // Deve deletar o snapshot corrompido mas não gravar novo snapshot de 1 entrada
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.equal(put, undefined, "corrompido (entries=null) → skip, nenhum novo snapshot gravado");
  });

  it("entries é objeto (não-array) → deleta snapshot e retorna sem gravar", async () => {
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: { foo: "bar" }, // objeto, não array
        computed_at: "2026-06-10T00:00:00.000Z",
      }),
    });
    const env = makeEnv(kv);
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "alice@x.com",
      nickname: "Alice",
      correct: 1,
      total: 1,
    });
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.equal(put, undefined, "corrompido (entries=objeto) → skip, nenhum novo snapshot gravado");
  });

  it("JSON inválido → deleta snapshot e retorna sem gravar (F2)", async () => {
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": "not-valid-json{{{",
    });
    const env = makeEnv(kv);
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "alice@x.com",
      nickname: "Alice",
      correct: 1,
      total: 1,
    });
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.equal(put, undefined, "JSON inválido → skip, nenhum novo snapshot gravado (F2)");
  });
});
