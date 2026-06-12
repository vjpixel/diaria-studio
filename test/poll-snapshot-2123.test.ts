/**
 * test/poll-snapshot-2123.test.ts (#2123)
 *
 * Regressões pros 4 fixes do #2123:
 *   1. last_vote_ts em SnapshotEntry: computeSnapshotEntries + upsertOwnEntryInSnapshot
 *      propagam o campo → rankEntries usa tiebreaker real via snapshot.
 *   2. TTL 24h pós-upsert: upsertOwnEntryInSnapshot grava com 86400s (24h — igual ao
 *      compute path). TTL 300s foi o bug; veja #2129.
 *   3. Redirect do leaderboard YYMM-MM → anual é 302 (não 301 cacheável permanentemente).
 *   4. backfill-score-by-month.ts: editionToMonthSlug local aceita ciclo YYMM-MM.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeSnapshotEntries,
  upsertOwnEntryInSnapshot,
  scoreByMonthEntriesToLeaderboard,
  type SnapshotEntry,
  type Env,
} from "../workers/poll/src/index.ts";
import { editionToMonthSlug } from "../workers/poll/src/lib.ts";
import { rankEntries } from "../workers/poll/src/leaderboard.ts";
import worker from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

function makeEnv(kv: ReturnType<typeof makeTrackedKv>): Env {
  return {
    POLL: kv as unknown as KVNamespace,
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}

// ── Fix 1a: computeSnapshotEntries propaga last_vote_ts ──────────────────────

describe("computeSnapshotEntries propaga last_vote_ts (#2123 fix 1a)", () => {
  it("inclui last_vote_ts quando presente na entry KV", async () => {
    const ts = "2026-06-10T12:00:00.000Z";
    const kv = makeTrackedKv({
      "score-by-month:2026-06:alice@x.com": JSON.stringify({
        nickname: "Alice",
        correct: 5,
        total: 5,
        last_vote_ts: ts,
      }),
    });
    const env = makeEnv(kv);
    const entries = await computeSnapshotEntries(env, "2026-06");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].last_vote_ts, ts, "last_vote_ts deve ser propagado");
  });

  it("omite last_vote_ts quando ausente na entry KV (back-compat entries pré-#1383)", async () => {
    const kv = makeTrackedKv({
      "score-by-month:2026-06:bob@x.com": JSON.stringify({
        nickname: "Bob",
        correct: 3,
        total: 5,
        // sem last_vote_ts
      }),
    });
    const env = makeEnv(kv);
    const entries = await computeSnapshotEntries(env, "2026-06");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].last_vote_ts, undefined, "ausência back-compat → undefined");
  });

  it("dense-rank usa last_vote_ts do snapshot — voto mais recente vence empate", async () => {
    // Alice e Bob empatados em (correct=5, total=5), Alice votou mais recentemente.
    const kv = makeTrackedKv({
      "score-by-month:2026-06:alice@x.com": JSON.stringify({
        nickname: "Alice",
        correct: 5,
        total: 5,
        last_vote_ts: "2026-06-10T12:00:00.000Z",
      }),
      "score-by-month:2026-06:bob@x.com": JSON.stringify({
        nickname: "Bob",
        correct: 5,
        total: 5,
        last_vote_ts: "2026-06-09T08:00:00.000Z", // mais antigo
      }),
    });
    const env = makeEnv(kv);
    const entries = await computeSnapshotEntries(env, "2026-06");
    const leaderboard = scoreByMonthEntriesToLeaderboard(entries);
    const ranked = rankEntries(leaderboard);
    // Ambos rank 1 (dense), mas Alice deve aparecer primeiro
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].nickname, "Alice", "Alice votou mais recentemente → rank 1 na frente");
    assert.equal(ranked[1].nickname, "Bob");
    assert.equal(ranked[0].rank, 1);
    assert.equal(ranked[1].rank, 1); // empate dense, Bob também é rank 1
  });

  it("sem last_vote_ts (pré-#1383) cai em displayKey ASC — back-compat preservado", async () => {
    const kv = makeTrackedKv({
      "score-by-month:2026-06:zoe@x.com": JSON.stringify({ nickname: "Zoe", correct: 3, total: 3 }),
      "score-by-month:2026-06:alice@x.com": JSON.stringify({ nickname: "Alice", correct: 3, total: 3 }),
    });
    const env = makeEnv(kv);
    const entries = await computeSnapshotEntries(env, "2026-06");
    const ranked = rankEntries(scoreByMonthEntriesToLeaderboard(entries));
    assert.equal(ranked[0].nickname, "Alice", "sem timestamp → displayKey ASC: Alice < Zoe");
  });
});

// ── Fix 1b: upsertOwnEntryInSnapshot propaga last_vote_ts ───────────────────

describe("upsertOwnEntryInSnapshot propaga last_vote_ts (#2123 fix 1b)", () => {
  it("inclui last_vote_ts na entry upserted quando snapshot presente", async () => {
    // Modelo híbrido: snapshot deve estar PRESENTE para que o upsert grave.
    const ts = "2026-06-10T15:30:00.000Z";
    const kv = makeTrackedKv({
      // snapshot presente (mas sem entradas de alice ainda)
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: [],
        computed_at: "2026-06-10T00:00:00.000Z",
      }),
    });
    const env = makeEnv(kv);
    const own: SnapshotEntry = {
      email: "alice@x.com",
      nickname: "Alice",
      correct: 3,
      total: 3,
      last_vote_ts: ts,
    };
    await upsertOwnEntryInSnapshot(env, "2026-06", own);
    // Verificar que o snapshot gravado tem o last_vote_ts
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put, "snapshot deve ser gravado");
    const payload = JSON.parse(put!.value);
    const entry = payload.entries.find((e: SnapshotEntry) => e.email === "alice@x.com");
    assert.ok(entry, "entry alice deve existir");
    assert.equal(entry.last_vote_ts, ts, "last_vote_ts deve ser persistido no snapshot");
  });

  it("upsert em snapshot existente preserva last_vote_ts da entry atualizada", async () => {
    const existingSnapshot = JSON.stringify({
      entries: [
        { email: "bob@x.com", nickname: "Bob", correct: 2, total: 3, last_vote_ts: "2026-06-09T00:00:00.000Z" },
      ],
      computed_at: "2026-06-09T00:00:00.000Z",
    });
    const kv = makeTrackedKv({ "leaderboard-snapshot:2026-06": existingSnapshot });
    const env = makeEnv(kv);
    const newTs = "2026-06-10T16:00:00.000Z";
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "bob@x.com",
      nickname: "Bob",
      correct: 3,
      total: 4,
      last_vote_ts: newTs,
    });
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put);
    const payload = JSON.parse(put!.value);
    const bob = payload.entries.find((e: SnapshotEntry) => e.email === "bob@x.com");
    assert.equal(bob.correct, 3, "correct atualizado");
    assert.equal(bob.last_vote_ts, newTs, "last_vote_ts atualizado");
  });

  it("last_vote_ts ausente no own: entry no snapshot não carrega o campo", async () => {
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: [],
        computed_at: "2026-06-10T00:00:00.000Z",
      }),
    });
    const env = makeEnv(kv);
    // SnapshotEntry sem last_vote_ts (back-compat — campo é opcional)
    const own: SnapshotEntry = {
      email: "carol@x.com",
      nickname: "Carol",
      correct: 1,
      total: 1,
    };
    await upsertOwnEntryInSnapshot(env, "2026-06", own);
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put);
    const payload = JSON.parse(put!.value);
    const carol = payload.entries.find((e: SnapshotEntry) => e.email === "carol@x.com");
    // last_vote_ts deve ser undefined (não presente no JSON) — não "undefined" como string
    assert.equal(carol.last_vote_ts, undefined, "sem last_vote_ts no own → campo ausente");
  });
});

// ── Fix 2 (atualizado #2129): TTL 24h pós-upsert — mesmo safety net do compute path ──

describe("upsertOwnEntryInSnapshot — TTL 24h pós-upsert (#2129 fix)", () => {
  it("grava snapshot com expirationTtl = 86400 (24h) — mesmo do compute path", async () => {
    // #2129: TTL 300s estava rebaixando o TTL de 24h do compute path.
    // Snapshot expirava 5min após o último voto → recompute repetido no pico.
    // Fix: upsert usa 86400s (same safety net). Read-your-own-write é garantido
    // pela escrita da entry no snapshot, não pelo TTL curto.
    const kv = makeTrackedKv({
      // snapshot existente com dados de outro votante
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: [{ email: "bob@x.com", nickname: "Bob", correct: 1, total: 1 }],
        computed_at: "2026-06-10T00:00:00.000Z",
      }),
    });
    const env = makeEnv(kv);
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "alice@x.com",
      nickname: "Alice",
      correct: 2,
      total: 2,
    });
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put, "snapshot deve ser gravado");
    assert.equal(
      put!.opts?.expirationTtl,
      86400,
      "TTL do upsert deve ser 86400s (24h) — igual ao compute path, não rebaixar o cache",
    );
    // F6: TTL test also asserts entry count — if entries were silently dropped,
    // the TTL check would pass but data would be lost.
    const payload = JSON.parse(put!.value);
    assert.equal(payload.entries.length, 2, "bob + alice ambos presentes no snapshot");
  });

  it("snapshot ausente: skip-on-missing — não grava snapshot de 1 entrada (#2152/#F3)", async () => {
    // Modelo híbrido: snapshot ausente → skip (não chama computeSnapshotEntries
    // dentro do voto para não estourar budget de subrequests).
    // O próximo GET lazy-computa via getOrComputeSnapshot.
    const kv = makeTrackedKv({
      "score-by-month:2026-06:carol@x.com": JSON.stringify({
        nickname: "Carol", correct: 3, total: 5,
      }),
    });
    const env = makeEnv(kv);
    await upsertOwnEntryInSnapshot(env, "2026-06", {
      email: "alice@x.com",
      nickname: "Alice",
      correct: 2,
      total: 2,
    });
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    // Modelo híbrido: ausente → skip, nenhum put de snapshot-de-1.
    assert.equal(put, undefined, "snapshot ausente → skip-on-missing: nenhum snapshot gravado");
  });
});

// ── Fix 3: Redirect 302 (não 301) ───────────────────────────────────────────

describe("redirect /leaderboard/{YYYY-MM} → anual usa 302, não 301 (#2123 fix 3)", () => {
  const makeWorkerEnv = (): Env & { POLL: ReturnType<typeof makeTrackedKv> } => ({
    POLL: makeTrackedKv() as unknown as ReturnType<typeof makeTrackedKv> & KVNamespace,
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  });

  it("brand=clarice: /leaderboard/2026-05 retorna 302 (não 301)", async () => {
    const env = makeWorkerEnv();
    const req = new Request("https://poll.test/leaderboard/2026-05?brand=clarice");
    const res = await worker.fetch(req, env as unknown as Env);
    assert.equal(
      res.status,
      302,
      "redirect mensal→anual deve ser 302 (temporário) — 301 é cacheável permanentemente e bloquearia mudança futura de leaderboardPeriod",
    );
  });

  it("brand=clarice: redirect preserva query params (brand=clarice) na URL de destino", async () => {
    const env = makeWorkerEnv();
    const req = new Request("https://poll.test/leaderboard/2026-05?brand=clarice");
    const res = await worker.fetch(req, env as unknown as Env);
    const location = res.headers.get("Location") ?? "";
    assert.match(location, /\/leaderboard\/2026/, "deve redirecionar para /leaderboard/{ano}");
    assert.match(location, /brand=clarice/, "query param brand= deve ser preservado no redirect");
  });

  it("brand=diaria (period=month): /leaderboard/2026-05 NÃO redireciona (renderiza)", async () => {
    const env = makeWorkerEnv();
    const req = new Request("https://poll.test/leaderboard/2026-05");
    const res = await worker.fetch(req, env as unknown as Env);
    // brand=diaria com leaderboardPeriod=month não entra no redirect
    assert.notEqual(res.status, 302, "brand=diaria não deve redirecionar");
    assert.notEqual(res.status, 301, "brand=diaria não deve redirecionar com 301 também");
  });

  it("status code não é 301 (regressão: 301 é cacheável permanentemente)", async () => {
    const env = makeWorkerEnv();
    const req = new Request("https://poll.test/leaderboard/2026-06?brand=clarice");
    const res = await worker.fetch(req, env as unknown as Env);
    assert.notEqual(
      res.status,
      301,
      "status 301 NÃO deve ser usado aqui — browsers o cacheariam para sempre sem forma de autocorreção",
    );
  });
});

// ── #2130: filtro null no merge de upsertOwnEntryInSnapshot ─────────────────

describe("#2130 — upsertOwnEntryInSnapshot filtra null além de undefined", () => {
  it("null em last_vote_ts não sobrescreve valor existente (timestamp fantasma)", async () => {
    // Cenário: snapshot existente com last_vote_ts válido. Um caller passa
    // last_vote_ts: null (JSON.parse pode retornar null em campos opcionais).
    // Antes do fix, null passava o filtro `v !== undefined` e sobrescrevia o ts.
    const existingTs = "2026-06-10T10:00:00.000Z";
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: [
          { email: "alice@x.com", nickname: "Alice", correct: 3, total: 5, last_vote_ts: existingTs },
        ],
        computed_at: "2026-06-10T00:00:00.000Z",
      }),
    });
    const env = makeEnv(kv);

    // Simula caller com last_vote_ts: null (campo nullable via JSON parse)
    const own = {
      email: "alice@x.com",
      nickname: "Alice",
      correct: 4,
      total: 6,
      last_vote_ts: null as unknown as string, // null injetado via JSON
    };
    await upsertOwnEntryInSnapshot(env, "2026-06", own as SnapshotEntry);

    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put, "snapshot deve ser regravado");
    const payload = JSON.parse(put!.value);
    const alice = payload.entries.find((e: SnapshotEntry) => e.email === "alice@x.com");
    assert.ok(alice, "alice deve estar no snapshot");
    assert.equal(alice.correct, 4, "correct atualizado");
    assert.equal(
      alice.last_vote_ts,
      existingTs,
      "last_vote_ts existente NÃO deve ser sobrescrito por null — filtro #2130",
    );
  });

  it("null em nickname não sobrescreve nickname existente", async () => {
    const kv = makeTrackedKv({
      "leaderboard-snapshot:2026-06": JSON.stringify({
        entries: [
          { email: "bob@x.com", nickname: "Bob", correct: 2, total: 4 },
        ],
        computed_at: "2026-06-10T00:00:00.000Z",
      }),
    });
    const env = makeEnv(kv);
    const own = {
      email: "bob@x.com",
      nickname: null as unknown as string, // null injetado
      correct: 3,
      total: 5,
    };
    await upsertOwnEntryInSnapshot(env, "2026-06", own as SnapshotEntry);
    const put = kv.puts.find((p) => p.key === "leaderboard-snapshot:2026-06");
    assert.ok(put);
    const payload = JSON.parse(put!.value);
    const bob = payload.entries.find((e: SnapshotEntry) => e.email === "bob@x.com");
    assert.equal(bob.correct, 3, "correct atualizado");
    assert.equal(bob.nickname, "Bob", "nickname existente não deve ser sobrescrito por null — filtro #2130");
  });
});

// ── #2130: Cache-Control: no-store no redirect 302 do leaderboard ────────────

describe("#2130 — redirect 302 do leaderboard emite Cache-Control: no-store", () => {
  const makeWorkerEnv = (): Env & { POLL: ReturnType<typeof makeTrackedKv> } => ({
    POLL: makeTrackedKv() as unknown as ReturnType<typeof makeTrackedKv> & KVNamespace,
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  });

  it("brand=clarice: 302 emite Cache-Control: no-store (proxies/link-preview não cacheiam)", async () => {
    const env = makeWorkerEnv();
    const req = new Request("https://poll.test/leaderboard/2026-05?brand=clarice");
    const res = await worker.fetch(req, env as unknown as Env);
    assert.equal(res.status, 302, "deve ser 302");
    const cc = res.headers.get("Cache-Control");
    assert.ok(
      cc?.includes("no-store"),
      `Cache-Control deve incluir no-store para evitar cache de proxy/link-preview: got "${cc}"`,
    );
  });

  it("brand=diaria (sem redirect): não impõe Cache-Control: no-store via redirect path", async () => {
    // brand=diaria renderiza normalmente — não deve ser afetado pelo redirect path
    const env = makeWorkerEnv();
    const req = new Request("https://poll.test/leaderboard/2026-05");
    const res = await worker.fetch(req, env as unknown as Env);
    // Apenas verifica que não é um redirect — o Cache-Control da página normal é gerenciado separadamente
    assert.notEqual(res.status, 302, "brand=diaria não deve redirecionar");
  });
});

// ── Fix 4: backfill editionToMonthSlug aceita ciclo YYMM-MM ─────────────────

describe("backfill editionToMonthSlug local aceita ciclo YYMM-MM (#2123 fix 4)", async () => {
  // #2123 (review): testa a função CANÔNICA importada — o backfill agora importa
  // de workers/poll/src/lib.ts, então cobrir a canônica cobre o backfill por construção.

  it("ciclo YYMM-MM (2605-06) → bucket 2026-05 (mês do CONTEÚDO)", () => {
    assert.equal(editionToMonthSlug("2605-06"), "2026-05");
  });

  it("ciclo YYMM-MM com mês inválido → null (não processa silenciosamente)", () => {
    assert.equal(editionToMonthSlug("2600-01"), null, "mês do conteúdo 0 → null");
    assert.equal(editionToMonthSlug("2613-02"), null, "mês do conteúdo 13 → null");
  });

  it("legado AAMMDD preservado (back-compat)", () => {
    assert.equal(editionToMonthSlug("260531"), "2026-05");
    assert.equal(editionToMonthSlug("260101"), "2026-01");
  });

  it("legado e ciclo produzem o MESMO bucket (fragmentação zero)", () => {
    assert.equal(
      editionToMonthSlug("260531"),
      editionToMonthSlug("2605-06"),
      "voto legado (260531) e ciclo novo (2605-06) devem cair no mesmo bucket",
    );
  });

  it("formato inválido → null (sem processamento silencioso)", () => {
    assert.equal(editionToMonthSlug("naoehdata"), null);
    assert.equal(editionToMonthSlug("12345"), null);
    assert.equal(editionToMonthSlug(""), null);
  });

  it("ciclo YYMM-MM outro exemplo: 2604-05 → 2026-04", () => {
    assert.equal(editionToMonthSlug("2604-05"), "2026-04");
  });
});
