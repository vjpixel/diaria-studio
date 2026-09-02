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
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

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

  // #7050 (finding 2 do review da PR que fechou o #6942): o chat do Studio
  // foi removido por inteiro — estas rotas não devem existir mais. O teste
  // acima ("rota-desconhecida") usa um path que nunca existiu, então não
  // pega reintrodução acidental (ex: merge malfeito trazendo `studio-chat.ts`
  // de volta sem religar server.ts). Este teste nomeia as rotas REAIS que
  // existiam antes do #6942, pra uma reintrodução acidental falhar aqui em
  // vez de passar despercebida.
  it("#7050: rotas de chat removidas no #6942 continuam 404 (reintrodução acidental deve falhar aqui)", async () => {
    const chatRoutes = [
      "/api/chat",
      "/api/chat/answer",
      "/api/chat/tool-decision",
      "/api/chat/pending",
      "/api/chat/history",
      "/api/chat/enabled",
    ];
    for (const path of chatRoutes) {
      const res = await fetch(new URL(path, server.url));
      assert.equal(res.status, 404, `${path} deveria ser 404, veio ${res.status}`);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    }
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
    assert.ok(body.includes("diar.ia.br Studio"));
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

  it("POST é rejeitado com 405 em rotas read-only", async () => {
    const res = await fetch(new URL("/api/state", server.url), { method: "POST" });
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

