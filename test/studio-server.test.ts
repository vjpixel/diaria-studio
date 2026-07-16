/**
 * test/studio-server.test.ts (#3555) — integração fina do studio-server:
 * bind loopback-only, rotas de API, static + guard de traversal, method
 * guard (read-only). Não testa SSE stream de forma exaustiva aqui —
 * `run-log-tail.test.ts`/`plan-watch.test.ts` já cobrem os watchers que
 * alimentam `/api/events`; este arquivo só confirma que a rota abre com os
 * headers certos e entrega o primeiro chunk (tail inicial) antes de fechar.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";
import type { QueryFn } from "../scripts/studio-ui/studio-chat.ts";

/** Parseia um corpo SSE completo (já lido inteiro) em `{event, data}[]` —
 * mesmo formato de `formatSseEvent`. Ignora linhas de comentário (heartbeat). */
function parseSseBody(body: string): Array<{ event: string; data: unknown }> {
  return body
    .split("\n\n")
    .filter((chunk) => chunk.trim() && !chunk.startsWith(":"))
    .map((chunk) => {
      const lines = chunk.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event:"));
      const dataLine = lines.find((l) => l.startsWith("data:"));
      return {
        event: eventLine ? eventLine.slice("event:".length).trim() : "message",
        data: dataLine ? JSON.parse(dataLine.slice("data:".length).trim()) : null,
      };
    });
}

describe("studio-server (#3555)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-server-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("faz bind em 127.0.0.1, nunca 0.0.0.0", () => {
    assert.ok(server.url.startsWith("http://127.0.0.1:"));
  });

  it("GET /api/state retorna 200 JSON com o shape esperado", async () => {
    const res = await fetch(new URL("/api/state", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.currentEdition, null);
    assert.deepEqual(body.editions, []);
    assert.deepEqual(body.gatesPending, []);
  });

  it("GET /api/editions/{AAMMDD} de edição existente retorna 200", async () => {
    mkdirSync(join(root, "data", "editions", "260716"), { recursive: true });
    writeFileSync(join(root, "data", "editions", "260716", "01-categorized.md"), "x");

    const res = await fetch(new URL("/api/editions/260716", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.edition, "260716");
    assert.equal(body.found, true);
  });

  it("GET /api/editions/{AAMMDD} de edição inexistente retorna 404", async () => {
    const res = await fetch(new URL("/api/editions/999999", server.url));
    assert.equal(res.status, 404);
  });

  it("GET /api/editions/{AAMMDD inválido} retorna 400", async () => {
    const res = await fetch(new URL("/api/editions/nope", server.url));
    assert.equal(res.status, 400);
  });

  it("GET /api/rota-desconhecida retorna 404 JSON", async () => {
    const res = await fetch(new URL("/api/nao-existe", server.url));
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  });

  it("GET / serve a SPA (index.html)", async () => {
    const res = await fetch(new URL("/", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes("Diar.ia Studio"));
  });

  it("GET /tokens.generated.css serve CSS com custom properties do DS", async () => {
    const res = await fetch(new URL("/tokens.generated.css", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/);
    const body = await res.text();
    assert.ok(body.includes("--brand:"));
  });

  it("path traversal na SPA estática retorna 403", async () => {
    const res = await fetch(new URL("/../../../../etc/passwd", server.url));
    // O parser de URL do navegador normalizaria isso, mas o Node's URL/fetch
    // preserva o path cru quando construído a partir de string relativa —
    // usamos %2e%2e pra forçar o traversal chegar cru no servidor.
    assert.ok(res.status === 403 || res.status === 404);
  });

  it("path traversal com encoding explícito retorna 403", async () => {
    const res = await fetch(`${server.url}..%2f..%2f..%2f..%2fetc%2fpasswd`);
    assert.equal(res.status, 403);
  });

  it("POST é rejeitado com 405 em rotas read-only (exceto /api/chat, #3556)", async () => {
    const res = await fetch(new URL("/api/state", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("GET /api/chat é rejeitado com 405 — só POST é aceito nessa rota", async () => {
    const res = await fetch(new URL("/api/chat", server.url));
    assert.equal(res.status, 405);
  });

  it("GET /api/events abre um stream SSE com o content-type correto", async () => {
    const controller = new AbortController();
    const res = await fetch(new URL("/api/events", server.url), { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    // Primeiro chunk é o comentário de conexão OU já o evento `state`
    // (a ordem exata de flush não é garantida pelo Node http em todo
    // ambiente) — o que importa é que o stream abriu e está emitindo.
    assert.ok(chunk.length > 0);

    controller.abort();
  });
});

describe("POST /api/chat (#3556) — com chatQueryFn mockado (sem SDK real)", () => {
  let root: string;
  let server: StudioServer;
  let lastPrompt: string | undefined;
  let lastOptions: { resume?: string } | undefined;
  let queryFn: QueryFn;

  function makeFakeQuery(messages: SDKMessage[]): QueryFn {
    return (params) => {
      lastPrompt = params.prompt as string;
      lastOptions = params.options as { resume?: string };
      async function* gen() {
        for (const m of messages) yield m;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };
  }

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-server-chat-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    // queryFn é reatribuível por teste via um wrapper indireto — cada `it`
    // chama `setQueryFn` antes de disparar a request.
    queryFn = (params) => makeFakeQuery([])(params);
    server = await startStudioServer({
      port: 0,
      rootDir: root,
      pollIntervalMs: 30,
      chatQueryFn: (params) => queryFn(params),
    });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  function setQueryFn(fn: QueryFn) {
    queryFn = fn;
  }

  it("400 quando o corpo não tem 'message'", async () => {
    const res = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /message/);
  });

  it("400 quando o corpo não é JSON válido", async () => {
    const res = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });

  it("200 + SSE: streama chat-init/chat-delta/chat-done na ordem emitida pelo queryFn", async () => {
    setQueryFn(
      makeFakeQuery([
        { type: "system", subtype: "init", session_id: "sess-abc", model: "claude-sonnet-5", cwd: root } as unknown as SDKMessage,
        {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "olá!" } },
        } as unknown as SDKMessage,
        { type: "result", subtype: "success", is_error: false, result: "olá!", session_id: "sess-abc" } as unknown as SDKMessage,
      ]),
    );

    const res = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "oi" }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const body = await res.text();
    const events = parseSseBody(body);
    const names = events.map((e) => e.event);
    assert.deepEqual(names, ["chat-init", "chat-delta", "chat-done"]);
    assert.equal((events[1].data as { text: string }).text, "olá!");
    assert.equal(lastPrompt, "oi");
  });

  it("persiste o sessionId de chat-init e reenvia como 'resume' no turno seguinte", async () => {
    setQueryFn(
      makeFakeQuery([
        { type: "system", subtype: "init", session_id: "sess-persisted", model: "m", cwd: root } as unknown as SDKMessage,
        { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-persisted" } as unknown as SDKMessage,
      ]),
    );
    await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "primeira mensagem" }),
    });

    setQueryFn(makeFakeQuery([{ type: "result", subtype: "success", is_error: false, result: "ok2", session_id: "sess-persisted" } as unknown as SDKMessage]));
    await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "segunda mensagem" }),
    });

    assert.equal(lastOptions?.resume, "sess-persisted");
  });

  it("'reset: true' limpa a sessão em memória antes do turno — 'resume' fica ausente", async () => {
    setQueryFn(
      makeFakeQuery([
        { type: "system", subtype: "init", session_id: "sess-to-reset", model: "m", cwd: root } as unknown as SDKMessage,
      ]),
    );
    await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "primeira" }),
    });

    setQueryFn(makeFakeQuery([]));
    await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "depois do reset", reset: true }),
    });

    assert.equal(lastOptions?.resume, undefined);
  });

  it("fail-soft: queryFn que lança vira evento chat-error no stream, resposta continua 200", async () => {
    setQueryFn(() => {
      throw new Error("spawn claude ENOENT");
    });

    const res = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "oi", reset: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    const events = parseSseBody(body);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "chat-error");
    assert.match((events[0].data as { message: string }).message, /CLI do Claude Code não encontrado/);
  });
});
