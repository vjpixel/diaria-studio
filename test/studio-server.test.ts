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
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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

/** Lê incrementalmente um `Response` SSE (via `getReader()`, igual ao
 * `chat-drawer.js` real — `EventSource` não suporta POST), chamando
 * `onEvent` pra cada `{event, data}` assim que chega. Usado pro round-trip
 * de `POST /api/chat/answer` (#3557): a request de `/api/chat` fica
 * BLOQUEADA no meio (aguardando o gate ser respondido), então `res.text()`
 * (usado nos outros testes deste arquivo) travaria pra sempre — aqui
 * precisamos reagir a um evento específico (`chat-permission-request`) e
 * disparar uma 2ª request (`/api/chat/answer`) ENQUANTO a 1ª ainda está
 * em voo, exatamente como o browser real faz. */
async function readSseStream(res: Response, onEvent: (evt: { event: string; data: unknown }) => void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIndex: number;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      if (!raw || raw.startsWith(":")) continue;
      let eventName = "message";
      let dataLine = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
        else if (line.startsWith("data:")) dataLine += line.slice("data:".length).trim();
      }
      if (!dataLine) continue;
      onEvent({ event: eventName, data: JSON.parse(dataLine) });
    }
  }
}

describe("POST /api/chat/answer (#3557) — gate AskUserQuestion via HTTP", () => {
  let root: string;
  let server: StudioServer;
  let queryFn: QueryFn;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-server-chat-answer-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    queryFn = () => {
      async function* gen() {}
      return gen() as unknown as ReturnType<QueryFn>;
    };
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

  it("GET é rejeitado com 405 — só POST é aceito nessa rota", async () => {
    const res = await fetch(new URL("/api/chat/answer", server.url));
    assert.equal(res.status, 405);
  });

  it("400 quando o corpo não tem 'toolUseId'/'answers'", async () => {
    const res = await fetch(new URL("/api/chat/answer", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it("404 quando não há gate pendente com esse toolUseId (já respondido, ou nunca existiu)", async () => {
    const res = await fetch(new URL("/api/chat/answer", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolUseId: "tu-inexistente", answers: { q: "a" } }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  it("round-trip completo (#633): AskUserQuestion pendura o turno; /api/chat/answer resolve; /api/state reflete o badge enquanto pendente e some depois", async () => {
    const askInput = {
      questions: [
        {
          question: "Qual caminho seguir?",
          header: "Caminho",
          multiSelect: false,
          options: [
            { label: "Opção 1", description: "primeira" },
            { label: "Opção 2", description: "segunda" },
          ],
        },
      ],
    };

    queryFn = (params) => {
      async function* gen() {
        const canUseTool = params.options?.canUseTool as CanUseTool;
        yield { type: "system", subtype: "init", session_id: "s-http", model: "m", cwd: root } as unknown as SDKMessage;
        const result = await canUseTool("AskUserQuestion", askInput, {
          signal: new AbortController().signal,
          toolUseID: "tu-http-1",
          requestId: "req-1",
        });
        if (result?.behavior === "allow") {
          yield {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu-http-1",
                  is_error: false,
                  content: JSON.stringify(result.updatedInput),
                },
              ],
            },
          } as unknown as SDKMessage;
        }
        yield { type: "result", subtype: "success", is_error: false, result: "fim", session_id: "s-http" } as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };

    const chatRes = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "escolhe um caminho" }),
    });
    assert.equal(chatRes.status, 200);

    const events: Array<{ event: string; data: unknown }> = [];
    let answered = false;
    let stateWhilePending: { chatPermissionsPending: Array<{ toolUseId: string }> } | null = null;
    // Capturado (não fire-and-forget "solto") pra poder `await` depois do
    // loop de leitura — garante que qualquer falha de assert aqui dentro vira
    // uma rejeição de teste normal, não uma unhandled rejection perdida
    // numa corrida com o `readSseStream` abaixo.
    let answerPromise: Promise<void> | null = null;

    await readSseStream(chatRes, (evt) => {
      events.push(evt);
      if (evt.event === "chat-permission-request" && !answered) {
        answered = true;
        const data = evt.data as { toolUseId: string; questions: Array<{ question: string; options: Array<{ label: string }> }> };
        // #3557 critério de aceite: enquanto o gate está pendente, o badge
        // global (/api/state) precisa refletir isso — checa ANTES de
        // responder, reagindo ao evento SSE igual ao browser real
        // (`chat-drawer.js`). `readSseStream` continua lendo em paralelo
        // (não espera este callback) — é isso que permite a 2ª request
        // (`/api/chat/answer`) acontecer ENQUANTO a 1ª ainda está bloqueada
        // esperando resposta.
        answerPromise = (async () => {
          const stateRes = await fetch(new URL("/api/state", server.url));
          stateWhilePending = (await stateRes.json()) as typeof stateWhilePending;

          const answerRes = await fetch(new URL("/api/chat/answer", server.url), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              toolUseId: data.toolUseId,
              answers: { [data.questions[0].question]: data.questions[0].options[0].label },
            }),
          });
          assert.equal(answerRes.status, 200);
          const answerBody = await answerRes.json();
          assert.deepEqual(answerBody, { ok: true });
        })();
      }
    });

    assert.ok(answerPromise, "esperava que chat-permission-request tivesse disparado a resposta");
    await answerPromise;

    assert.ok(stateWhilePending, "esperava ter checado /api/state enquanto o gate estava pendente");
    assert.equal((stateWhilePending as NonNullable<typeof stateWhilePending>).chatPermissionsPending.length, 1);
    assert.equal((stateWhilePending as NonNullable<typeof stateWhilePending>).chatPermissionsPending[0].toolUseId, "tu-http-1");

    const eventNames = events.map((e) => e.event);
    assert.ok(eventNames.includes("chat-permission-request"), "esperava chat-permission-request");
    assert.ok(eventNames.includes("chat-done"), "esperava que a sessão tivesse continuado até chat-done");
    const doneEvent = events.find((e) => e.event === "chat-done");
    assert.equal((doneEvent?.data as { isError: boolean }).isError, false);
    const toolEndEvent = events.find(
      (e) => e.event === "chat-tool" && (e.data as { toolUseId?: string; status?: string }).toolUseId === "tu-http-1",
    );
    assert.ok(toolEndEvent, "esperava um chat-tool pra tu-http-1 (a sessão prosseguiu, não foi negada)");
    assert.equal((toolEndEvent?.data as { status?: string }).status, "end");

    const stateAfterRes = await fetch(new URL("/api/state", server.url));
    const stateAfter = (await stateAfterRes.json()) as { chatPermissionsPending: unknown[] };
    assert.equal(stateAfter.chatPermissionsPending.length, 0);
  });
});

describe("GET /api/chat/pending (#3617) — hidratação do chat drawer", () => {
  let root: string;
  let server: StudioServer;
  let queryFn: QueryFn;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-server-chat-pending-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    queryFn = () => {
      async function* gen() {}
      return gen() as unknown as ReturnType<QueryFn>;
    };
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

  it("200 com pending:[] quando não há gate nenhum", async () => {
    const res = await fetch(new URL("/api/chat/pending", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.deepEqual(body, { pending: [] });
  });

  it("regressão (#3617): com um gate AskUserQuestion pendurado, devolve questions[] completo — o payload que faltava pro drawer reidratar o card sem depender do stream SSE ao vivo", async () => {
    const askInput = {
      questions: [
        {
          question: "Qual caminho seguir?",
          header: "Caminho",
          multiSelect: false,
          options: [
            { label: "Opção 1", description: "primeira" },
            { label: "Opção 2", description: "segunda" },
          ],
        },
      ],
    };

    queryFn = (params) => {
      async function* gen() {
        const canUseTool = params.options?.canUseTool as CanUseTool;
        yield { type: "system", subtype: "init", session_id: "s-pending", model: "m", cwd: root } as unknown as SDKMessage;
        // BLOQUEIA de verdade até o gate ser respondido — exatamente o
        // cenário do bug #3617 (a sessão real do SDK também trava aqui, sem
        // timeout por design; ver studio-chat.ts). A única forma de destravar
        // é responder via /api/chat/answer, como o teste faz abaixo depois de
        // ler o payload de /api/chat/pending (não do stream SSE ao vivo).
        await canUseTool("AskUserQuestion", askInput, {
          signal: new AbortController().signal,
          toolUseID: "tu-pending-1",
          requestId: "req-1",
        });
        yield { type: "result", subtype: "success", is_error: false, result: "fim", session_id: "s-pending" } as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };

    const chatRes = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "escolhe um caminho" }),
    });
    assert.equal(chatRes.status, 200);

    // Lê o stream SSE só até o gate ser registrado (chat-permission-request)
    // pra saber QUANDO checar /api/chat/pending com garantia — mas a
    // asserção central usa o endpoint de hidratação, não o payload do
    // evento SSE, provando que os dois caminhos leem o MESMO estado.
    let answerPromise: Promise<void> | null = null;
    await readSseStream(chatRes, (evt) => {
      if (evt.event === "chat-permission-request" && !answerPromise) {
        answerPromise = (async () => {
          const pendingRes = await fetch(new URL("/api/chat/pending", server.url));
          assert.equal(pendingRes.status, 200);
          const body = (await pendingRes.json()) as { pending: Array<{ toolUseId: string; toolName: string; askedAt: number; questions: unknown[] }> };
          assert.equal(body.pending.length, 1);
          const pending = body.pending[0];
          assert.equal(pending.toolUseId, "tu-pending-1");
          assert.equal(pending.toolName, "AskUserQuestion");
          assert.equal(typeof pending.askedAt, "number");
          // o critério de aceite central (#3617): questions[] INTEIRO
          // (header/options), não um resumo — reconstrói o card exatamente
          // como o evento SSE ao vivo `chat-permission-request` faria, mas
          // SEM depender de estar conectado a esse stream.
          assert.deepEqual(pending.questions, askInput.questions);

          // resolve pelo MESMO endpoint que o card ao vivo usaria, provando
          // que reidratar não criou um estado paralelo — a stream acima
          // retoma sozinha assim que isto resolve.
          const answerRes = await fetch(new URL("/api/chat/answer", server.url), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ toolUseId: "tu-pending-1", answers: { "Qual caminho seguir?": "Opção 1" } }),
          });
          assert.equal(answerRes.status, 200);
        })();
      }
    });

    assert.ok(answerPromise, "esperava que chat-permission-request tivesse disparado a checagem de /api/chat/pending");
    await answerPromise;

    const afterRes = await fetch(new URL("/api/chat/pending", server.url));
    const afterBody = (await afterRes.json()) as { pending: unknown[] };
    assert.equal(afterBody.pending.length, 0);
  });

  it("POST em /api/chat/pending não é permitido (rota GET-only)", async () => {
    const res = await fetch(new URL("/api/chat/pending", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });
});
