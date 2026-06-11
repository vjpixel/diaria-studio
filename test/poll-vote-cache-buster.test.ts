/**
 * test/poll-vote-cache-buster.test.ts (#2113)
 *
 * Regressing coverage para os dois fixes do #2113:
 *
 * (a) Cache-buster no link "Ver leaderboard" da página de resultado do voto:
 *   - Quando `cacheBusterTs` fornecido, URL do link tem `?v=` ou `&v=` no final.
 *   - Quando `cacheBusterTs` ausente/null, link mantém comportamento original.
 *   - Para clarice (URL já contém `?brand=clarice`): usa `&v=`.
 *   - Para diaria (URL sem query param): usa `?v=`.
 *   - Cache-buster NÃO aparece nos outros links da página.
 *
 * (b) Upsert da própria entry no snapshot:
 *   - `upsertOwnEntryInSnapshot`: cria snapshot se não existir.
 *   - `upsertOwnEntryInSnapshot`: faz upsert de entry existente (substitui valores).
 *   - `upsertOwnEntryInSnapshot`: adiciona entry nova a snapshot existente.
 *   - `upsertOwnEntryInSnapshot`: deleta e retorna se snapshot estiver corrompido.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { votePageHtml, upsertOwnEntryInSnapshot, type Env, type SnapshotEntry } from "../workers/poll/src/index.ts";

// ── (a) Cache-buster no link "Ver leaderboard" ──────────────────────────────

describe("votePageHtml — cache-buster no link leaderboard (#2113a)", () => {
  it("sem cacheBusterTs → link sem ?v= (back-compat)", () => {
    const html = votePageHtml("Acertou!", true, null, null, "2026-05");
    assert.match(html, /href="\/leaderboard\/2026-05"/);
    assert.doesNotMatch(html, /href="\/leaderboard\/2026-05[?&]v=/);
  });

  it("cacheBusterTs null → link sem ?v= (back-compat)", () => {
    const html = votePageHtml("Acertou!", true, null, null, "2026-05", "diaria", null);
    assert.match(html, /href="\/leaderboard\/2026-05"/);
    assert.doesNotMatch(html, /\?v=/);
    assert.doesNotMatch(html, /&v=/);
  });

  it("diaria + cacheBusterTs → link com ?v= (sem query param existente)", () => {
    const ts = "2026-06-11T15:12:51.000Z";
    const html = votePageHtml("Acertou!", true, null, null, "2026-05", "diaria", ts);
    assert.match(html, /href="\/leaderboard\/2026-05\?v=2026-06-11T15:12:51\.000Z"/);
  });

  it("clarice + cacheBusterTs → link com &v= (URL já tem ?brand=clarice)", () => {
    const ts = "2026-06-11T15:12:51.000Z";
    // Para clarice, leaderboardHref converte slug mensal → ano: 2026-05 → 2026
    const html = votePageHtml("Acertou!", true, null, null, "2026-05", "clarice", ts);
    assert.match(html, /href="\/leaderboard\/2026\?brand=clarice&v=2026-06-11T15:12:51\.000Z"/);
  });

  it("cache-buster só aparece no link do leaderboard, não em outros links", () => {
    const ts = "2026-06-11T15:00:00.000Z";
    const html = votePageHtml("Acertou!", true, null, null, "2026-05", "diaria", ts);
    // O link de voltar para o site NÃO deve ter o cache-buster.
    // Regex sem `.` greedy pra não cruzar a aspas de fechamento do href.
    assert.doesNotMatch(html, /href="https:\/\/diar\.ia\.br[^"]*v=/);
    // Mas o link do leaderboard DEVE ter
    assert.match(html, /\/leaderboard\/2026-05\?v=/);
  });

  it("sem slug mas com cacheBusterTs → /leaderboard?v=... (cache-buster mesmo sem slug)", () => {
    // O cache-buster se aplica sempre que fornecido — slug null/undefined não o bloqueia.
    // Caso: leitor votou numa edição sem monthSlug (edge case), mas ainda assim
    // queremos quebrar o cache do leaderboard raiz.
    const ts = "2026-06-11T15:00:00Z";
    const html = votePageHtml("Acertou!", true, null, null, null, "diaria", ts);
    assert.match(html, /href="\/leaderboard\?v=2026-06-11T15:00:00Z"/);
  });
});

// ── (b) Upsert da própria entry no snapshot ─────────────────────────────────

function makeKv(store: Record<string, string> = {}): KVNamespace {
  const data = { ...store };
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => { data[key] = value; },
    delete: async (key: string) => { delete data[key]; },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
    // Expose underlying data for assertions
    _data: data,
  } as unknown as KVNamespace & { _data: Record<string, string> };
}

function makeEnv(kv: KVNamespace): Env {
  return { POLL: kv, POLL_SECRET: "test", ADMIN_SECRET: "test", ALLOWED_ORIGINS: "*" };
}

describe("upsertOwnEntryInSnapshot (#2113b)", () => {
  it("cria snapshot novo quando não existia (primeiro voto do mês)", async () => {
    const kv = makeKv() as unknown as KVNamespace & { _data: Record<string, string> };
    const env = makeEnv(kv);
    const own: SnapshotEntry = { email: "a@x.com", nickname: "Ana", correct: 1, total: 1 };
    await upsertOwnEntryInSnapshot(env, "2026-05", own);
    const snapKey = "leaderboard-snapshot:2026-05";
    const raw = (kv as unknown as { _data: Record<string, string> })._data[snapKey];
    assert.ok(raw, "snapshot deve ser gravado");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].email, "a@x.com");
    assert.equal(parsed.entries[0].correct, 1);
  });

  it("faz upsert de entry existente (substitui valores)", async () => {
    const existing = JSON.stringify({
      entries: [{ email: "a@x.com", nickname: null, correct: 0, total: 1 }],
      computed_at: "2026-06-01T00:00:00Z",
    });
    const kv = makeKv({ "leaderboard-snapshot:2026-05": existing }) as unknown as KVNamespace & { _data: Record<string, string> };
    const env = makeEnv(kv);
    const own: SnapshotEntry = { email: "a@x.com", nickname: "Ana", correct: 1, total: 2 };
    await upsertOwnEntryInSnapshot(env, "2026-05", own);
    const raw = (kv as unknown as { _data: Record<string, string> })._data["leaderboard-snapshot:2026-05"];
    const parsed = JSON.parse(raw);
    assert.equal(parsed.entries.length, 1, "não deve duplicar a entry");
    assert.equal(parsed.entries[0].correct, 1, "correct deve ser atualizado");
    assert.equal(parsed.entries[0].total, 2, "total deve ser atualizado");
    assert.equal(parsed.entries[0].nickname, "Ana", "nickname deve ser atualizado");
  });

  it("adiciona entry nova a snapshot com outras entries", async () => {
    const existing = JSON.stringify({
      entries: [{ email: "b@x.com", nickname: "Bob", correct: 3, total: 5 }],
      computed_at: "2026-06-01T00:00:00Z",
    });
    const kv = makeKv({ "leaderboard-snapshot:2026-05": existing }) as unknown as KVNamespace & { _data: Record<string, string> };
    const env = makeEnv(kv);
    const own: SnapshotEntry = { email: "a@x.com", nickname: null, correct: 1, total: 1 };
    await upsertOwnEntryInSnapshot(env, "2026-05", own);
    const raw = (kv as unknown as { _data: Record<string, string> })._data["leaderboard-snapshot:2026-05"];
    const parsed = JSON.parse(raw);
    assert.equal(parsed.entries.length, 2, "deve ter 2 entries");
    const emailsInSnapshot = parsed.entries.map((e: SnapshotEntry) => e.email);
    assert.ok(emailsInSnapshot.includes("b@x.com"));
    assert.ok(emailsInSnapshot.includes("a@x.com"));
  });

  it("email de entrada em case misto é normalizado pra lowercase na saída", async () => {
    const kv = makeKv() as unknown as KVNamespace & { _data: Record<string, string> };
    const env = makeEnv(kv);
    const own: SnapshotEntry = { email: "A@X.COM", nickname: null, correct: 1, total: 1 };
    await upsertOwnEntryInSnapshot(env, "2026-05", own);
    const raw = (kv as unknown as { _data: Record<string, string> })._data["leaderboard-snapshot:2026-05"];
    const parsed = JSON.parse(raw);
    assert.equal(parsed.entries[0].email, "a@x.com");
  });

  it("snapshot corrompido → deleta e retorna sem gravar entry", async () => {
    const kv = makeKv({ "leaderboard-snapshot:2026-05": "{ corrupted json [" }) as unknown as KVNamespace & { _data: Record<string, string> };
    const env = makeEnv(kv);
    const own: SnapshotEntry = { email: "a@x.com", nickname: null, correct: 1, total: 1 };
    await upsertOwnEntryInSnapshot(env, "2026-05", own);
    // Snap deve ter sido deletado (não regravado com dados parciais)
    assert.equal(
      (kv as unknown as { _data: Record<string, string> })._data["leaderboard-snapshot:2026-05"],
      undefined,
      "snapshot corrompido deve ser removido",
    );
  });

  it("upsert é case-insensitive: email em lowercase no snapshot encontra entrada uppercase", async () => {
    const existing = JSON.stringify({
      entries: [{ email: "a@x.com", nickname: null, correct: 0, total: 1 }],
      computed_at: "2026-06-01T00:00:00Z",
    });
    const kv = makeKv({ "leaderboard-snapshot:2026-05": existing }) as unknown as KVNamespace & { _data: Record<string, string> };
    const env = makeEnv(kv);
    // Mesmo email em uppercase → deve fazer upsert, não append
    const own: SnapshotEntry = { email: "A@X.COM", nickname: "Ana", correct: 1, total: 2 };
    await upsertOwnEntryInSnapshot(env, "2026-05", own);
    const raw = (kv as unknown as { _data: Record<string, string> })._data["leaderboard-snapshot:2026-05"];
    const parsed = JSON.parse(raw);
    assert.equal(parsed.entries.length, 1, "não deve duplicar mesmo com casing diferente");
    assert.equal(parsed.entries[0].total, 2);
  });
});
