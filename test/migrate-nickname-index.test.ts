import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildNicknameIndex,
  migrateNicknameIndex,
  type KvClient,
  type ScoreEntry,
} from "../scripts/migrate-nickname-index.ts";

/** KV mockado em memória — get/put/list, sem rede (#3117: nunca bater no KV real neste teste). */
function mockKv(seed: Record<string, string> = {}): { kv: KvClient; store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed));
  const kv: KvClient = {
    async list(prefix: string): Promise<string[]> {
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
  };
  return { kv, store };
}

describe("buildNicknameIndex (#3117)", () => {
  it("agrega score:* entries com nickname num índice normalizado→email", () => {
    const entries: ScoreEntry[] = [
      { email: "ana@x.com", nickname: "Ana Cândida" },
      { email: "bob@x.com", nickname: "Bob" },
    ];
    const { index, conflicts } = buildNicknameIndex(entries);
    assert.equal(index.get("ana candida"), "ana@x.com");
    assert.equal(index.get("bob"), "bob@x.com");
    assert.equal(conflicts.length, 0);
  });

  it("ignora entries sem nickname (null)", () => {
    const entries: ScoreEntry[] = [
      { email: "novo@x.com", nickname: null },
      { email: "ana@x.com", nickname: "Ana" },
    ];
    const { index } = buildNicknameIndex(entries);
    assert.equal(index.size, 1);
    assert.equal(index.get("ana"), "ana@x.com");
  });

  it("dois emails já com o mesmo apelido normalizado (pré-existente) → conflito reportado, first-come-wins", () => {
    const entries: ScoreEntry[] = [
      { email: "primeiro@x.com", nickname: "Bruna Quevedo" },
      { email: "segundo@x.com", nickname: "bruna  quevedo" }, // normaliza pro mesmo
    ];
    const { index, conflicts } = buildNicknameIndex(entries);
    assert.equal(index.get("bruna quevedo"), "primeiro@x.com");
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].winner, "primeiro@x.com");
    assert.equal(conflicts[0].loser, "segundo@x.com");
  });

  it("mesmo email repetido (idempotência) não gera conflito consigo mesmo", () => {
    const entries: ScoreEntry[] = [
      { email: "ana@x.com", nickname: "Ana" },
      { email: "ana@x.com", nickname: "Ana" },
    ];
    const { index, conflicts } = buildNicknameIndex(entries);
    assert.equal(index.get("ana"), "ana@x.com");
    assert.equal(conflicts.length, 0);
  });
});

describe("migrateNicknameIndex (#3117, KV mockado)", () => {
  it("popula nickname:{normalizado} → email a partir de score:* existentes", async () => {
    const { kv, store } = mockKv({
      "score:ana@x.com": JSON.stringify({ total: 3, nickname: "Ana Cândida" }),
      "score:bob@x.com": JSON.stringify({ total: 1, nickname: "Bob" }),
      "score:semnick@x.com": JSON.stringify({ total: 1, nickname: null }),
    });
    const result = await migrateNicknameIndex(kv);
    assert.equal(result.scanned, 3);
    assert.equal(result.written, 2);
    assert.equal(result.conflicts.length, 0);
    assert.equal(store.get("nickname:ana candida"), "ana@x.com");
    assert.equal(store.get("nickname:bob"), "bob@x.com");
    assert.equal(store.has("nickname:semnick@x.com"), false);
  });

  it("--dry-run não escreve nada no KV", async () => {
    const { kv, store } = mockKv({
      "score:ana@x.com": JSON.stringify({ total: 3, nickname: "Ana" }),
    });
    const result = await migrateNicknameIndex(kv, { dryRun: true });
    assert.equal(result.written, 1); // reporta o que faria
    assert.equal(store.has("nickname:ana"), false); // mas não persiste
  });

  it("respeita brandPrefix (clarice) — não mistura com diaria", async () => {
    const { kv, store } = mockKv({
      "score:ana@x.com": JSON.stringify({ total: 3, nickname: "Ana" }),
      "clarice:score:carla@x.com": JSON.stringify({ total: 2, nickname: "Carla" }),
    });
    const diariaResult = await migrateNicknameIndex(kv, { brandPrefix: "" });
    const clariceResult = await migrateNicknameIndex(kv, { brandPrefix: "clarice:" });
    assert.equal(diariaResult.written, 1);
    assert.equal(clariceResult.written, 1);
    assert.equal(store.get("nickname:ana"), "ana@x.com");
    assert.equal(store.get("clarice:nickname:carla"), "carla@x.com");
    // diaria migration não vazou pro namespace clarice, e vice-versa.
    assert.equal(store.has("clarice:nickname:ana"), false);
    assert.equal(store.has("nickname:carla"), false);
  });

  it("ignora score:* com JSON corrompido em vez de abortar a migração inteira", async () => {
    const { kv, store } = mockKv({
      "score:bom@x.com": JSON.stringify({ total: 1, nickname: "Bom" }),
      "score:corrompido@x.com": "{ not json",
    });
    const result = await migrateNicknameIndex(kv);
    assert.equal(result.scanned, 2);
    assert.equal(result.written, 1);
    assert.equal(store.get("nickname:bom"), "bom@x.com");
  });

  it("idempotente: rodar 2x produz o mesmo índice", async () => {
    const { kv, store } = mockKv({
      "score:ana@x.com": JSON.stringify({ total: 3, nickname: "Ana" }),
    });
    await migrateNicknameIndex(kv);
    await migrateNicknameIndex(kv);
    assert.equal(store.get("nickname:ana"), "ana@x.com");
  });
});
