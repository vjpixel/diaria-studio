/**
 * test/poll-snapshot-legacy-email-migration-4123.test.ts (#4123)
 *
 * Regressão dedicada pro mecanismo de auto-expurga do snapshot legado —
 * a peça de maior blast radius do fix #4123 (persistir e-mail cru em
 * `leaderboard-snapshot:{slug}`) e, até este teste, a ÚNICA sem cobertura
 * direta (achado do review da PR #4128).
 *
 * `hasLegacyEmailField` (privada, leaderboard-routes.ts) detecta um
 * snapshot cacheado no formato ANTIGO (entries com `email` cru) e trata
 * como INVÁLIDO em 2 pontos:
 *   - `getOrComputeSnapshot` (read path): ignora o cache legado, recomputa
 *     do zero via `computeSnapshotEntries` (fonte da verdade —
 *     `score-by-month:{slug}:*`) e regrava já no formato novo (uid/masked).
 *   - `upsertOwnEntryInSnapshot` (write path, chamado a cada voto): trata
 *     como corrompido — deleta a chave e retorna sem gravar nada em cima
 *     do resíduo legado (mesmo caminho de "skip-on-corrupted" já coberto
 *     pra JSON inválido/estrutura errada em poll-snapshot-2152-2129.test.ts).
 *
 * Os testes abaixo provam as DUAS pontas registradas no PR body:
 *   1. O snapshot recomputado reflete a FONTE DA VERDADE (score-by-month),
 *      não o conteúdo do cache legado (que pode estar desatualizado).
 *   2. O valor RE-PERSISTIDO no KV nunca contém a string "email" — nem por
 *      acidente um campo residual sobrevive ao recompute/re-serialize.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getOrComputeSnapshot,
  upsertOwnEntryInSnapshot,
  type Env,
} from "../workers/poll/src/index.ts";
import { hashEmailForMatch, maskEmail } from "../workers/poll/src/lib.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

function makeEnv(kv: ReturnType<typeof makeTrackedKv>): Env {
  return makePollEnv(kv);
}

describe("getOrComputeSnapshot — snapshot legado (com `email` cru) é tratado como cache inválido (#4123)", () => {
  it("ignora o cache legado e recomputa da fonte da verdade (score-by-month), não do conteúdo legado", async () => {
    const kv = makeTrackedKv({
      // Snapshot LEGADO — formato pré-#4123, com email cru por entry. Dado
      // DIFERENTE do que está em score-by-month, pra provar que o resultado
      // vem do RECOMPUTE (fonte da verdade), não do cache legado servido cru.
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: [{ email: "old-stale@x.com", nickname: "Stale", correct: 9, total: 9 }],
        computed_at: "2026-01-01T00:00:00.000Z",
      }),
      "score-by-month:2026-06:alice@x.com": JSON.stringify({ nickname: "Alice", correct: 3, total: 5 }),
      "score-by-month:2026-06:bob@x.com": JSON.stringify({ nickname: "Bob", correct: 2, total: 5 }),
    });
    const env = makeEnv(kv);

    const entries = await getOrComputeSnapshot(env, "2026-06");

    // Reflete score-by-month (Alice + Bob) — não o snapshot legado (Stale).
    assert.equal(entries.length, 2, "deve recomputar de score-by-month, não usar o snapshot legado de 1 entry");
    const uids = entries.map((e) => e.uid).sort();
    assert.deepEqual(
      uids,
      [hashEmailForMatch("alice@x.com"), hashEmailForMatch("bob@x.com")].sort(),
      "entries devem ser Alice+Bob (fonte da verdade), não a entry 'Stale' do cache legado",
    );
    assert.ok(
      !uids.includes(hashEmailForMatch("old-stale@x.com")),
      "a entry do snapshot legado não deve sobreviver ao recompute",
    );
  });

  it("regrava o snapshot recomputado já no formato novo — o valor persistido nunca contém a string 'email'", async () => {
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: [{ email: "old-stale@x.com", nickname: "Stale", correct: 9, total: 9 }],
        computed_at: "2026-01-01T00:00:00.000Z",
      }),
      "score-by-month:2026-06:alice@x.com": JSON.stringify({ nickname: "Alice", correct: 3, total: 5 }),
    });
    const env = makeEnv(kv);

    await getOrComputeSnapshot(env, "2026-06");

    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put, "recompute deve re-persistir o snapshot (auto-expurga o resíduo legado)");
    // Defense-in-depth: nem por acidente sobra um campo `email` no JSON
    // gravado — checagem na STRING crua, não só na forma tipada do parse.
    assert.doesNotMatch(put!.value, /"email"/, "valor persistido não pode conter a chave 'email' em NENHUMA entry");
    const payload = JSON.parse(put!.value);
    assert.equal(payload.entries[0].uid, hashEmailForMatch("alice@x.com"));
    assert.equal(payload.entries[0].masked, maskEmail("alice@x.com"));
  });

  it("cache legado + score-by-month vazio (sem fonte pra recompor) → não regrava snapshot vazio (#1666 preservado)", async () => {
    // Caso de borda: o snapshot legado é o ÚNICO resíduo (score-by-month já
    // foi limpo/nunca existiu nesse slug). Recompute dá 0 entries — a regra
    // #1666 (não persistir snapshot vazio) continua valendo; o cache legado
    // não deve "vazar" como fallback.
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: [{ email: "old-stale@x.com", nickname: "Stale", correct: 9, total: 9 }],
        computed_at: "2026-01-01T00:00:00.000Z",
      }),
    });
    const env = makeEnv(kv);

    const entries = await getOrComputeSnapshot(env, "2026-06");
    assert.deepEqual(entries, [], "sem score-by-month, recompute não tem de onde repor — nunca cai pro cache legado");
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.equal(put, undefined, "não deve persistir snapshot vazio (#1666)");
  });
});

describe("upsertOwnEntryInSnapshot — snapshot legado é tratado como corrompido (skip + lazy-rebuild) (#4123)", () => {
  it("detecta o cache legado, DELETA a chave e retorna sem gravar em cima do resíduo", async () => {
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: [{ email: "old-stale@x.com", nickname: "Stale", correct: 9, total: 9 }],
        computed_at: "2026-01-01T00:00:00.000Z",
      }),
    });
    const env = makeEnv(kv);

    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "newvoter@x.com",
      nickname: "New",
      correct: 1,
      total: 1,
    });

    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.equal(
      put,
      undefined,
      "nunca deve re-persistir upsert em cima de um snapshot legado — mesmo skip-on-corrupted do JSON inválido",
    );
    // A chave legada deve ter sido de fato DELETADA (não só ignorada) — o
    // próximo GET (getOrComputeSnapshot) precisa cair no recompute lazy,
    // não achar o resíduo legado ainda lá.
    const stillThere = await kv.get("leaderboard-snapshot:2026-06");
    assert.equal(stillThere, null, "snapshot legado deve ser deletado, não deixado intacto");
  });

  it("após o skip, o PRÓXIMO read (getOrComputeSnapshot) reconstrói limpo a partir de score-by-month", async () => {
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: [{ email: "old-stale@x.com", nickname: "Stale", correct: 9, total: 9 }],
        computed_at: "2026-01-01T00:00:00.000Z",
      }),
      "score-by-month:2026-06:alice@x.com": JSON.stringify({ nickname: "Alice", correct: 3, total: 5 }),
    });
    const env = makeEnv(kv);

    // Voto de um novo leitor: upsert vê o cache legado, deleta, skipa.
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "bob@x.com",
      nickname: "Bob",
      correct: 2,
      total: 5,
    });
    // O próprio voto de Bob grava a entry raw em score-by-month (simulado
    // aqui diretamente — quem faz isso de verdade é updateScoreByMonth em
    // vote.ts, fora do escopo deste teste).
    await kv.put("score-by-month:2026-06:bob@x.com", JSON.stringify({ nickname: "Bob", correct: 2, total: 5 }));

    const entries = await getOrComputeSnapshot(env, "2026-06");
    const uids = entries.map((e) => e.uid).sort();
    assert.deepEqual(
      uids,
      [hashEmailForMatch("alice@x.com"), hashEmailForMatch("bob@x.com")].sort(),
      "lazy rebuild deve ver Alice (já existia) + Bob (votou durante a janela do resíduo legado)",
    );
    assert.ok(
      !uids.includes(hashEmailForMatch("old-stale@x.com")),
      "a entry 'Stale' do resíduo legado nunca deve reaparecer",
    );
  });
});
