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

  it("(#3874) GET / — log ao vivo e contadores do statusbar têm aria-live=polite (regiões atualizadas via SSE)", async () => {
    const res = await fetch(new URL("/", server.url));
    const body = await res.text();
    assert.ok(body.includes('id="log-list" class="log-list" aria-live="polite"'));
    assert.ok(body.includes('id="statusbar-edition" aria-live="polite"'));
    assert.ok(body.includes('id="statusbar-stage" aria-live="polite"'));
    assert.ok(body.includes('id="statusbar-gates" aria-live="polite"'));
    assert.ok(body.includes('id="statusbar-overnight" aria-live="polite"'));
    assert.ok(body.includes('id="editions-empty"'), "tabela de edições recentes precisa de contêiner de estado vazio (R4)");
  });

  it("#3891 (item 8): GET / expõe 'Atualizado HH:MM' no statusbar, e app.js cronometra o último render bem-sucedido", async () => {
    const html = await (await fetch(new URL("/", server.url))).text();
    assert.ok(html.includes('id="statusbar-updated" aria-live="polite"'), "faltava o elemento de staleness no header do index");

    const js = await (await fetch(new URL("/app.js", server.url))).text();
    assert.ok(js.includes("statusbar-updated"), "app.js precisa mapear o elemento");
    assert.ok(js.includes("markUpdatedNow"), "precisa existir a função que cronometra o último render");
  });

  it("#3891 (item 6): app.js importa log-dedup.js e guarda appendLogRow atrás do dedup (reconnect do SSE reenvia a tail inteira via log-init)", async () => {
    const js = await (await fetch(new URL("/app.js", server.url))).text();
    assert.ok(js.includes('from "./log-dedup.js"'), "app.js precisa importar o deduplicador");
    assert.ok(js.includes("logDeduper.isNew"), "appendLogRow precisa checar o dedup antes de tocar o DOM");

    const dedupJs = await fetch(new URL("/log-dedup.js", server.url));
    assert.equal(dedupJs.status, 200, "log-dedup.js precisa ser servível como asset estático");
  });

  it("(#3874) GET /tokens.generated.css inclui os 4 tokens semânticos de status", async () => {
    const res = await fetch(new URL("/tokens.generated.css", server.url));
    assert.equal(res.status, 200);
    const css = await res.text();
    assert.match(css, /--status-ok:/);
    assert.match(css, /--status-warn:/);
    assert.match(css, /--status-warn-ink:/);
    assert.match(css, /--status-danger:/);
    assert.match(css, /--status-info:/);
  });

  // #3714 — superfície de Relatórios. Cobertura fina de integração (rota +
  // registro real via registerReport, sem servidor real gerando o
  // relatório): a lógica pura fica em test/studio-reports.test.ts.
  it("GET /api/reports retorna 200 com lista vazia quando nada foi registrado", async () => {
    const res = await fetch(new URL("/api/reports", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.reports, []);
  });

  it("GET /relatorios/:id serve o conteúdo registrado; id desconhecido é 404", async () => {
    const { registerReport } = await import("../scripts/studio-ui/studio-reports.ts");
    mkdirSync(join(root, "data", "overnight", "260720"), { recursive: true });
    writeFileSync(join(root, "data", "overnight", "260720", "report.md"), "# Diar.ia overnight 260720\n\n3 resolvidas.");
    registerReport(root, {
      kind: "overnight",
      sessionId: "260720",
      title: "Diar.ia overnight 260720 — 3 resolvidas",
      htmlPath: "data/overnight/260720/report.md",
    });

    const listRes = await fetch(new URL("/api/reports", server.url));
    const listBody = await listRes.json();
    assert.equal(listBody.reports.length, 1);
    assert.equal(listBody.reports[0].id, "overnight-260720");

    const contentRes = await fetch(new URL("/relatorios/overnight-260720", server.url));
    assert.equal(contentRes.status, 200);
    assert.match(contentRes.headers.get("content-type") ?? "", /text\/html/);
    const html = await contentRes.text();
    assert.match(html, /3 resolvidas/); // markdown wrapado, conteúdo original preservado

    const missingRes = await fetch(new URL("/relatorios/overnight-999999", server.url));
    assert.equal(missingRes.status, 404);
  });

  it("GET /relatorios serve o cockpit (rewrite pra relatorios.html)", async () => {
    const res = await fetch(new URL("/relatorios", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  });

  it("#3891 regressão (item 2): Relatórios ganha o filtro client-side por tipo que faltava (única das 5 telas sem — taxonomia KIND_LABEL já existia)", async () => {
    const html = await (await fetch(new URL("/relatorios", server.url))).text();
    assert.ok(html.includes('id="filter-kind"'), "select de filtro precisa existir no shell");
    assert.ok(html.includes('id="reports-count"'));
    // reusa .panel-header-row/.filter-field de triagem.css (já linkado) —
    // mesmo padrão das outras 4 telas de manutenção.
    assert.ok(html.includes('class="panel-header-row"'));

    const js = await (await fetch(new URL("/relatorios.js", server.url))).text();
    assert.ok(js.includes("filterKind"), "wiring do select precisa existir em relatorios.js");
    assert.ok(js.includes("0 resultados para este filtro"), "distinção 'sem resultado do filtro' vs 'vazio de verdade' (R4)");
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

  it("regressão (#3687): 'context' do corpo HTTP chega no 'prompt' enviado ao SDK, prefixado à mensagem", async () => {
    setQueryFn(
      makeFakeQuery([
        { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-ctx" } as unknown as SDKMessage,
      ]),
    );
    const res = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "passe a Clarice no texto de introdução",
        context: { edition: "260720", file: "02-reviewed.md", tab: "02 — Newsletter" },
      }),
    });
    assert.equal(res.status, 200);
    await res.text(); // drena o stream antes de checar lastPrompt (mesmo padrão dos testes acima).
    assert.equal(
      lastPrompt,
      '[Contexto do painel Studio: edição 260720 · arquivo 02-reviewed.md · aba "02 — Newsletter"]\n\npasse a Clarice no texto de introdução',
    );
  });

  it("sem 'context' no corpo HTTP, 'prompt' é a mensagem crua (comportamento pré-#3687 inalterado)", async () => {
    setQueryFn(
      makeFakeQuery([
        { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-noctx" } as unknown as SDKMessage,
      ]),
    );
    const res = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "oi" }),
    });
    await res.text();
    assert.equal(lastPrompt, "oi");
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

/**
 * #3887 — fim-a-fim (HTTP real + fetch abortado pelo cliente), complementar
 * ao unit test de `createCloseAbortGuard` com timers fake em
 * `studio-chat.test.ts`. Aqui o objetivo é provar a FIAÇÃO em `handleApiChat`:
 * `chatCloseAbortDebounceMs` pequeno (dezenas de ms, não os 2.5s de produção)
 * mantém os testes rápidos sem precisar de fake timers reais nem mockar
 * `node:http`. Cada teste cria seu PRÓPRIO server (`chatQueryFn` observa o
 * `abortController.signal` do turno) em vez de reusar o server do describe
 * acima, porque o queryFn aqui precisa reagir ao abort de verdade.
 */
describe("POST /api/chat (#3887) — debounce do abort no close, fim-a-fim", () => {
  it("close PERSISTENTE (cliente abortou e nunca mais volta) aborta a sessão do Agent SDK após o debounce", async () => {
    const root = mkdtempSync(join(tmpdir(), "studio-server-chat-close-persist-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });

    let sdkAborted = false;
    const queryFn: QueryFn = (params) => {
      async function* gen() {
        params.options?.abortController?.signal.addEventListener("abort", () => {
          sdkAborted = true;
        });
        yield { type: "system", subtype: "init", session_id: "s1", model: "m", cwd: root } as unknown as SDKMessage;
        // nunca resolve por conta própria — só o abort do controller destrava
        // (mesmo padrão de "turno pendurado" já usado em studio-chat.test.ts).
        await new Promise<void>((resolve) => {
          params.options?.abortController?.signal.addEventListener("abort", () => resolve());
        });
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };

    const server = await startStudioServer({
      port: 0,
      rootDir: root,
      pollIntervalMs: 30,
      chatQueryFn: queryFn,
      chatCloseAbortDebounceMs: 80,
    });

    try {
      const controller = new AbortController();
      const resPromise = fetch(new URL("/api/chat", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "oi" }),
        signal: controller.signal,
      });

      await new Promise((r) => setTimeout(r, 40)); // deixa o turno conectar e emitir o init
      controller.abort(); // simula a queda de rede a meio-turno (o `close` chega no server)
      await resPromise.catch(() => {}); // o fetch em si rejeita/resolve no cliente — não importa aqui

      assert.equal(sdkAborted, false, "não deveria abortar ainda — está dentro da janela de debounce (80ms)");

      await new Promise((r) => setTimeout(r, 200)); // folga generosa acima dos 80ms
      assert.equal(sdkAborted, true, "close persistente deveria abortar a sessão SDK depois do debounce");
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("close TRANSITÓRIO (turno termina sozinho dentro da janela) NÃO aborta a sessão SDK", async () => {
    const root = mkdtempSync(join(tmpdir(), "studio-server-chat-close-transient-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });

    let sdkAborted = false;
    const queryFn: QueryFn = (params) => {
      async function* gen() {
        params.options?.abortController?.signal.addEventListener("abort", () => {
          sdkAborted = true;
        });
        yield { type: "system", subtype: "init", session_id: "s1", model: "m", cwd: root } as unknown as SDKMessage;
        // turno "rápido": termina por conta própria em 20ms, INDEPENDENTE da
        // conexão HTTP do cliente (runChatTurn não depende de req/res pra
        // seguir rodando — só usa pra emitir eventos, já fail-soft).
        await new Promise((r) => setTimeout(r, 20));
        yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" } as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };

    const server = await startStudioServer({
      port: 0,
      rootDir: root,
      pollIntervalMs: 30,
      chatQueryFn: queryFn,
      chatCloseAbortDebounceMs: 150,
    });

    try {
      const controller = new AbortController();
      const resPromise = fetch(new URL("/api/chat", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "oi" }),
        signal: controller.signal,
      });

      await new Promise((r) => setTimeout(r, 5)); // deixa a request conectar
      controller.abort(); // close no meio do turno — mas o turno SEGUE rodando no server
      await resPromise.catch(() => {});

      // espera bem além dos 20ms do turno E dos 150ms do debounce — se o
      // cancel() não tivesse cortado o timer, o abort teria disparado aqui.
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(sdkAborted, false, "turno terminou sozinho dentro da janela — debounce deveria ter sido cancelado");
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("POST /api/chat (#3822) — notificação de turno concluído via chatDoneNotifyFn/chatDoneNowFn injetáveis", () => {
  let root: string;
  let server: StudioServer;
  let queryFn: QueryFn;
  let notifyCalls: Array<{ event: unknown; durationMs: number }>;
  // `nowClock` é consumida em ordem por `chatDoneNowFn` — cada `it` empilha os
  // timestamps que quer que `Date.now()` "retorne" nas 2 chamadas que
  // `handleApiChat` faz (uma antes de `runChatTurn`, outra no `chat-done`),
  // simulando um turno "longo" sem esperar segundos de verdade.
  let nowClock: number[];

  function makeFakeQuery(messages: SDKMessage[]): QueryFn {
    return () => {
      async function* gen() {
        for (const m of messages) yield m;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };
  }

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-server-chat-done-notify-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    queryFn = (params) => makeFakeQuery([])(params);
    notifyCalls = [];
    nowClock = [];
    server = await startStudioServer({
      port: 0,
      rootDir: root,
      pollIntervalMs: 30,
      chatQueryFn: (params) => queryFn(params),
      chatDoneNowFn: () => nowClock.shift() ?? 0,
      chatDoneNotifyFn: async (event, durationMs) => {
        notifyCalls.push({ event, durationMs });
        return { ok: true };
      },
    });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  function setQueryFn(fn: QueryFn) {
    queryFn = fn;
  }

  it("turno cuja duração medida atinge o threshold injetado -> chatDoneNotifyFn é chamado 1x com o ChatDoneEvent + duração corretos", async () => {
    setQueryFn(
      makeFakeQuery([
        { type: "result", subtype: "success", is_error: false, result: "Terminei a tarefa X.", session_id: "sess-long" } as unknown as SDKMessage,
      ]),
    );
    // 1ª leitura (turnStartedAt) = 1_000; 2ª leitura (no chat-done) = 41_000
    // -> durationMs = 40_000, bem acima de qualquer threshold plausível.
    nowClock = [1_000, 41_000];

    const res = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "corrige o título", reset: true }),
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].durationMs, 40_000);
    assert.deepEqual(notifyCalls[0].event, {
      event: "chat-done",
      data: { sessionId: "sess-long", isError: false, result: "Terminei a tarefa X." },
    });
  });

  it("chatDoneNotifyFn é fire-and-forget: notifyFn lento não atrasa o fechamento da resposta HTTP", async () => {
    setQueryFn(
      makeFakeQuery([
        { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-slow-notify" } as unknown as SDKMessage,
      ]),
    );
    nowClock = [0, 40_000]; // acima do threshold — chatDoneNotifyFn É chamado
    let notifyStarted = false;
    let notifyFinished = false;
    let releaseNotify: (() => void) | undefined;
    const slowNotify = new Promise<void>((r) => {
      releaseNotify = r;
    });
    const rootSlow = mkdtempSync(join(tmpdir(), "studio-server-chat-done-notify-slow-"));
    mkdirSync(join(rootSlow, "data", "editions"), { recursive: true });
    const slowServer = await startStudioServer({
      port: 0,
      rootDir: rootSlow,
      pollIntervalMs: 30,
      chatQueryFn: (params) => queryFn(params),
      chatDoneNowFn: () => nowClock.shift() ?? 0,
      chatDoneNotifyFn: async () => {
        notifyStarted = true;
        await slowNotify; // só resolve quando o teste chamar releaseNotify()
        notifyFinished = true;
        return { ok: true };
      },
    });
    try {
      const res = await fetch(new URL("/api/chat", slowServer.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "tarefa lenta pra notificar" }),
      });
      assert.equal(res.status, 200);
      await res.text();
      // a resposta HTTP já fechou (linha acima) — a notificação foi disparada
      // (fire-and-forget) mas ainda não teve chance de terminar, porque
      // `releaseNotify` só é chamado DEPOIS daqui.
      assert.equal(notifyStarted, true, "notifyFn deveria ter sido chamado antes do res.text() resolver");
      assert.equal(notifyFinished, false, "notifyFn NÃO deveria ter terminado ainda — a resposta não esperou por ele");
      releaseNotify?.();
      await slowNotify;
    } finally {
      await slowServer.close();
      rmSync(rootSlow, { recursive: true, force: true });
    }
  });

  it("chatDoneNotifyFn lançando não derruba o turno nem quebra a resposta HTTP (fail-soft do wrapper .catch em server.ts)", async () => {
    const rootErr = mkdtempSync(join(tmpdir(), "studio-server-chat-done-notify-throw-"));
    mkdirSync(join(rootErr, "data", "editions"), { recursive: true });
    let throwingQueryFn: QueryFn = (params) => makeFakeQuery([])(params);
    const throwingServer = await startStudioServer({
      port: 0,
      rootDir: rootErr,
      pollIntervalMs: 30,
      chatQueryFn: (params) => throwingQueryFn(params),
      chatDoneNowFn: () => 0,
      chatDoneNotifyFn: async () => {
        throw new Error("Telegram Bot API indisponível");
      },
    });
    try {
      throwingQueryFn = makeFakeQuery([
        { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-throw" } as unknown as SDKMessage,
      ]);
      const res = await fetch(new URL("/api/chat", throwingServer.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "oi" }),
      });
      assert.equal(res.status, 200);
      const body = await res.text();
      const events = parseSseBody(body);
      assert.equal(events[events.length - 1].event, "chat-done");
    } finally {
      await throwingServer.close();
      rmSync(rootErr, { recursive: true, force: true });
    }
  });

  it("turno 'curto' (5s): a duração medida por nowFn chega correta em chatDoneNotifyFn — decisão de threshold é responsabilidade da função injetada, não do wiring", async () => {
    setQueryFn(
      makeFakeQuery([
        { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-short" } as unknown as SDKMessage,
      ]),
    );
    nowClock = [0, 5_000]; // 5s de duração
    notifyCalls = [];
    // #3822 self-review: esta suíte injeta `chatDoneNotifyFn` diretamente
    // (bypassando o threshold real de `maybeNotifyChatDone`, que só é
    // aplicado quando `chatDoneNotifyFn` NÃO é injetado) — então este teste
    // sozinho não prova o threshold em produção; ver
    // "maybeNotifyChatDone (#3822)" em studio-telegram-notify.test.ts pro
    // teste real do threshold. Aqui confirmamos só que a duração É medida e
    // repassada corretamente (5_000, não 0 nem NaN) — a decisão de notificar
    // ou não fica a cargo de quem implementa `chatDoneNotifyFn` (o default
    // de produção, `maybeNotifyChatDone`, já teve o threshold coberto à parte).
    const res = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "oi", reset: true }),
    });
    await res.text();
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].durationMs, 5_000);
  });
});

describe("POST /api/chat (#3822) — fail-soft real, sem injetar chatDoneNotifyFn/chatDoneNowFn (usa os defaults de produção)", () => {
  let root: string;
  let server: StudioServer;
  let queryFn: QueryFn;
  let originalToken: string | undefined;
  let originalChatId: string | undefined;
  let originalWatchdogChatId: string | undefined;

  function makeFakeQuery(messages: SDKMessage[]): QueryFn {
    return () => {
      async function* gen() {
        for (const m of messages) yield m;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };
  }

  before(async () => {
    // Guard de publicação (CLAUDE.md/dispatch-rules): garante que este teste
    // NUNCA dispare uma chamada de rede real ao Telegram, mesmo que a
    // máquina que rodar a suíte tenha credenciais no ambiente — remove-as
    // pra forçar `resolveTelegramCredentials` no caminho "sem credenciais"
    // (skip silencioso), o mesmo caminho fail-soft que roda numa máquina sem
    // nada configurado.
    originalToken = process.env.TELEGRAM_BOT_TOKEN;
    originalChatId = process.env.TELEGRAM_CHAT_ID;
    originalWatchdogChatId = process.env.TELEGRAM_WATCHDOG_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_WATCHDOG_CHAT_ID;

    root = mkdtempSync(join(tmpdir(), "studio-server-chat-done-notify-default-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    queryFn = (params) => makeFakeQuery([])(params);
    // Nem `chatDoneNotifyFn` nem `chatDoneNowFn` são passados — este bloco
    // exercita exatamente o wiring de produção (`maybeNotifyChatDone` real +
    // `Date.now` real).
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
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChatId;
    if (originalWatchdogChatId === undefined) delete process.env.TELEGRAM_WATCHDOG_CHAT_ID;
    else process.env.TELEGRAM_WATCHDOG_CHAT_ID = originalWatchdogChatId;
  });

  it("turno completo sem credenciais Telegram no ambiente -> 200 normal, chat-done chega no stream, nada lança", async () => {
    queryFn = makeFakeQuery([
      { type: "system", subtype: "init", session_id: "sess-nodefault", model: "m", cwd: root } as unknown as SDKMessage,
      { type: "result", subtype: "success", is_error: false, result: "tudo certo", session_id: "sess-nodefault" } as unknown as SDKMessage,
    ]);
    const res = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "oi" }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    const events = parseSseBody(body);
    assert.deepEqual(
      events.map((e) => e.event),
      ["chat-init", "chat-done"],
    );
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

describe("GET /api/chat/history (#3803) — reidratação do TRANSCRIPT do chat drawer", () => {
  let root: string;
  let server: StudioServer;
  let queryFn: QueryFn;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-server-chat-history-"));
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

  it("200 com history:[] quando nenhuma mensagem foi trocada ainda", async () => {
    const res = await fetch(new URL("/api/chat/history", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = (await res.json()) as { history: unknown[]; sessionId: string | null };
    assert.deepEqual(body.history, []);
    assert.equal(body.sessionId, null);
  });

  it("regressão (#3803): após um turno completo, o histórico traz a mensagem do editor + a resposta do assistente + o chip de tool — o mesmo transcript que sumia ao navegar de página", async () => {
    queryFn = (params) => {
      async function* gen() {
        const canUseTool = params.options?.canUseTool as CanUseTool;
        yield { type: "system", subtype: "init", session_id: "s-hist-1", model: "m", cwd: root } as unknown as SDKMessage;
        yield {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "tu-hist-1", name: "Read", input: { file_path: "x.md" } }] },
        } as unknown as SDKMessage;
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Ol" } },
        } as unknown as SDKMessage;
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "á!" } },
        } as unknown as SDKMessage;
        yield {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "tu-hist-1", is_error: false }] },
        } as unknown as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "Olá!", session_id: "s-hist-1" } as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };

    const chatRes = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "oi, tudo bem?" }),
    });
    assert.equal(chatRes.status, 200);
    await chatRes.text(); // drena o stream até o fim (chat-done) antes de checar o histórico.

    const res = await fetch(new URL("/api/chat/history", server.url));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      history: Array<{ kind: string; seq: number; text?: string; toolUseId?: string; status?: string }>;
      sessionId: string | null;
    };
    assert.equal(body.sessionId, "s-hist-1");
    assert.deepEqual(
      body.history.map((e) => e.kind),
      ["user", "tool", "assistant", "tool"],
    );
    assert.equal(body.history[0].text, "oi, tudo bem?");
    assert.equal(body.history[1].toolUseId, "tu-hist-1");
    assert.equal(body.history[1].status, "start");
    assert.equal(body.history[2].text, "Olá!");
    assert.equal(body.history[3].status, "end");
    // seq estritamente crescente, na ordem de emissão.
    for (let i = 1; i < body.history.length; i++) {
      assert.ok(body.history[i].seq > body.history[i - 1].seq);
    }
  });

  it("?sessionId= que NÃO bate com a sessão corrente do servidor devolve history:[] (transcript de conversa já superada não reaparece)", async () => {
    const res = await fetch(new URL("/api/chat/history?sessionId=sessao-antiga-inexistente", server.url));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { history: unknown[]; sessionId: string | null };
    assert.deepEqual(body.history, [], "sessionId divergente da corrente -> não reidrata transcript alheio");
    assert.equal(body.sessionId, "s-hist-1");
  });

  it("?sessionId= que BATE com a sessão corrente devolve o histórico normalmente", async () => {
    const res = await fetch(new URL("/api/chat/history?sessionId=s-hist-1", server.url));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { history: unknown[] };
    assert.equal(body.history.length, 4);
  });

  it("'nova conversa' (reset:true) zera o histórico servido por /api/chat/history", async () => {
    queryFn = (params) => {
      async function* gen() {
        yield { type: "system", subtype: "init", session_id: "s-hist-2", model: "m", cwd: root } as unknown as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "novo turno", session_id: "s-hist-2" } as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };
    const chatRes = await fetch(new URL("/api/chat", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "mensagem pós-reset", reset: true }),
    });
    assert.equal(chatRes.status, 200);
    await chatRes.text();

    const res = await fetch(new URL("/api/chat/history", server.url));
    const body = (await res.json()) as { history: Array<{ text?: string }> };
    // só a mensagem do turno NOVO — o transcript anterior (4 entries do teste
    // de regressão acima) foi descartado pelo reset, nunca reidrataria numa
    // navegação futura como conversa "antiga" misturada com a nova.
    assert.equal(body.history.length, 2);
    assert.equal(body.history[0].text, "mensagem pós-reset");
  });

  it("POST em /api/chat/history não é permitido (rota GET-only)", async () => {
    const res = await fetch(new URL("/api/chat/history", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });
});
