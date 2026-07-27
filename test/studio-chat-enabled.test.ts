/**
 * test/studio-chat-enabled.test.ts (#4078)
 *
 * Cobre o estado legível-por-máquina do toggle "chat ativo/desativado" do
 * Studio (`scripts/lib/studio-chat-enabled.ts`) — o requisito central da
 * issue: uma sessão de automação (overnight/develop) precisa conseguir
 * checar esse estado ANTES de reiniciar/religar o Studio, sem depender do
 * server rodando (leitura direta do arquivo via `readChatEnabledState`/
 * `isChatEnabled`).
 *
 *   1. Lógica PURA — fixture de diretório temporário (mesmo padrão de
 *      test/studio-boxes.test.ts): default fail-soft, round-trip
 *      write/read, `updatedAt` avança, corpo corrompido/shape errado não
 *      lança.
 *   2. Contrato HTTP via `startStudioServer` — `GET/PUT /api/chat/enabled` e
 *      o guard de `POST /api/chat` recusando com 409 quando desativado.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";
import type { QueryFn } from "../scripts/studio-ui/studio-chat.ts";
import {
  readChatEnabledState,
  isChatEnabled,
  setChatEnabled,
} from "../scripts/lib/studio-chat-enabled.ts";

/** Mesma técnica de test/studio-server.test.ts: `chatQueryFn` mockado com um
 * generator síncrono e rápido — nunca invoca o SDK real (spawn de processo),
 * que deixaria o server "em voo" e travaria `rmSync` de limpeza no Windows
 * (EPERM — achado ao escrever este teste). */
function makeFakeQuery(messages: SDKMessage[]): QueryFn {
  return () => {
    async function* gen() {
      for (const m of messages) yield m;
    }
    return gen() as unknown as ReturnType<QueryFn>;
  };
}

const FAKE_RESULT_MESSAGES: SDKMessage[] = [
  { type: "system", subtype: "init", session_id: "s1", model: "m", cwd: "/repo" } as unknown as SDKMessage,
  { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" } as unknown as SDKMessage,
];

// ─── lógica pura ──────────────────────────────────────────────────────────

describe("readChatEnabledState / isChatEnabled / setChatEnabled (#4078, pure)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-chat-enabled-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("sem data/studio-chat-enabled.json -> default {enabled:true, updatedAt:null}", () => {
    const state = readChatEnabledState(root);
    assert.deepEqual(state, { enabled: true, updatedAt: null });
    assert.equal(isChatEnabled(root), true);
  });

  it("setChatEnabled(false) persiste e readChatEnabledState reflete", () => {
    const written = setChatEnabled(root, false, { now: () => new Date("2026-07-27T10:00:00.000Z") });
    assert.equal(written.enabled, false);
    assert.equal(written.updatedAt, "2026-07-27T10:00:00.000Z");

    const read = readChatEnabledState(root);
    assert.deepEqual(read, { enabled: false, updatedAt: "2026-07-27T10:00:00.000Z" });
    assert.equal(isChatEnabled(root), false);
  });

  it("setChatEnabled(true) reativa e atualiza updatedAt", () => {
    const written = setChatEnabled(root, true, { now: () => new Date("2026-07-27T11:30:00.000Z") });
    assert.equal(written.enabled, true);
    assert.equal(written.updatedAt, "2026-07-27T11:30:00.000Z");
    assert.equal(isChatEnabled(root), true);
  });

  it("nunca sobrescreve/reaproveita nenhum outro arquivo sob data/ — path é dedicado", () => {
    const other = resolve(root, "data", "outro-estado-qualquer.json");
    mkdirSync(resolve(root, "data"), { recursive: true });
    writeFileSync(other, JSON.stringify({ hello: "world" }), "utf8");
    setChatEnabled(root, false);
    // o arquivo dedicado existe e o outro não foi tocado
    assert.equal(JSON.parse(readFileSync(other, "utf8")).hello, "world");
    assert.equal(readChatEnabledState(root).enabled, false);
  });

  it("JSON corrompido -> default fail-soft {enabled:true, updatedAt:null}, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-chat-enabled-corrupt-"));
    mkdirSync(resolve(dir, "data"), { recursive: true });
    writeFileSync(resolve(dir, "data", "studio-chat-enabled.json"), "{ isso não é json", "utf8");
    assert.deepEqual(readChatEnabledState(dir), { enabled: true, updatedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });

  it("shape com 'enabled' de tipo errado -> default fail-soft, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-chat-enabled-badtype-"));
    mkdirSync(resolve(dir, "data"), { recursive: true });
    writeFileSync(resolve(dir, "data", "studio-chat-enabled.json"), JSON.stringify({ enabled: "sim" }), "utf8");
    assert.deepEqual(readChatEnabledState(dir), { enabled: true, updatedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });

  it("'updatedAt' de tipo errado no arquivo -> normaliza pra null, 'enabled' ainda respeitado", () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-chat-enabled-badupdated-"));
    mkdirSync(resolve(dir, "data"), { recursive: true });
    writeFileSync(
      resolve(dir, "data", "studio-chat-enabled.json"),
      JSON.stringify({ enabled: false, updatedAt: 12345 }),
      "utf8",
    );
    assert.deepEqual(readChatEnabledState(dir), { enabled: false, updatedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── contrato HTTP ──────────────────────────────────────────────────────────

describe("GET/PUT /api/chat/enabled + guard de POST /api/chat (#4078, HTTP)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-chat-enabled-http-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({
      port: 0,
      rootDir: root,
      pollIntervalMs: 30,
      chatQueryFn: makeFakeQuery(FAKE_RESULT_MESSAGES),
    });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /api/chat/enabled sem estado gravado -> default {enabled:true, updatedAt:null}", async () => {
    const res = await fetch(new URL("/api/chat/enabled", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { enabled: true, updatedAt: null });
  });

  it("PUT /api/chat/enabled {enabled:false} persiste e GET reflete", async () => {
    const put = await fetch(new URL("/api/chat/enabled", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json();
    assert.equal(putBody.enabled, false);
    assert.ok(putBody.updatedAt);

    const get = await fetch(new URL("/api/chat/enabled", server.url));
    const getBody = await get.json();
    assert.equal(getBody.enabled, false);
  });

  it("POST /api/chat recusa com 409 quando o chat está desativado", async () => {
    // estado deixado por 'false' no teste anterior
    const res = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "oi" }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /desativado/);
  });

  it("PUT /api/chat/enabled {enabled:true} reativa e POST /api/chat deixa de recusar por este guard", async () => {
    const put = await fetch(new URL("/api/chat/enabled", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).enabled, true);

    const res = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "oi de novo" }),
    });
    assert.equal(res.status, 200); // 200 + SSE — o guard de #4078 deixou passar (chatQueryFn mockado responde rápido)
    await res.text(); // drena a stream inteira antes do teste seguinte / cleanup
  });

  it("PUT /api/chat/enabled com corpo malformado -> 400, não muda o estado", async () => {
    const before = await (await fetch(new URL("/api/chat/enabled", server.url))).json();
    const put = await fetch(new URL("/api/chat/enabled", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "não é boolean" }),
    });
    assert.equal(put.status, 400);
    const after = await (await fetch(new URL("/api/chat/enabled", server.url))).json();
    assert.deepEqual(after, before);
  });

  it("PUT /api/chat/enabled com corpo não-JSON -> 400", async () => {
    const put = await fetch(new URL("/api/chat/enabled", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "não é json",
    });
    assert.equal(put.status, 400);
  });

  it("GET /api/chat/enabled não aceita POST (405)", async () => {
    const res = await fetch(new URL("/api/chat/enabled", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });
});
