/**
 * test/chat-drawer-shared-events.test.ts (#3891, itens 4 e 7 — residuais da
 * auditoria #3866 excluídos de propósito do PR #3899, que fechou os outros 8
 * itens da mesma issue por overlap de arquivo com #3887/#3888, ambos já
 * mergeados).
 *
 * Item 4 — "SSE duplicado por aba": toda página do Studio abria 2 conexões a
 * `/api/events` (a da própria tela + uma segunda de `chat-drawer.js`, injetado
 * em TODAS as 8 páginas, só pro contador do badge global) — dobrando
 * fs.watch/polling no server por aba aberta. Fix: `resolveSharedEventSource`
 * (shared-event-source.js) + `window.__studioEvents` publicado por
 * app.js/edicao.js/rodada.js e reusado por chat-drawer.js.
 *
 * Item 7 — "drawer colapsado não sinaliza atividade em curso": o dot só
 * refletia ok/down/idle (`setToggleStatus`), nunca "a sessão está trabalhando
 * agora" — com o painel colapsado, texto/tool chegando não tinha nenhum sinal
 * visível fora do badge (que só cobre gate/pergunta pendente). Fix: pulso CSS
 * discreto (`.chat-toggle-dot.active`) ligado/desligado por
 * `setToggleActive()` no início/fim de `sendMessage`.
 *
 * Mesmo precedente de `chat-drawer-network-drop.test.ts`/`chat-drawer-badge-wiring.test.ts`
 * (#3887/#3888): este projeto não tem harness de DOM (sem jsdom/happy-dom),
 * então a cobertura do WIRING real é "contrato estático servido" — buscar o
 * asset via HTTP (mesmo static-serve.ts de produção) e afirmar estrutura via
 * regex. A lógica pura de decisão (`resolveSharedEventSource`) é testada
 * isoladamente, sem servidor nenhum.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";
import { resolveSharedEventSource } from "../scripts/studio-ui/public/shared-event-source.js";

describe("resolveSharedEventSource (#3891 item 4) — decisão pura reusa-ou-abre", () => {
  it("existing truthy → retorna ele mesmo, NUNCA chama factory", () => {
    let factoryCalls = 0;
    const existing = { fake: "event-source" };
    const result = resolveSharedEventSource(existing, () => {
      factoryCalls += 1;
      return { fake: "new" };
    });
    assert.equal(result, existing);
    assert.equal(factoryCalls, 0);
  });

  it("existing ausente (undefined) → chama factory exatamente 1x e retorna o resultado dela", () => {
    let factoryCalls = 0;
    const created = { fake: "created" };
    const result = resolveSharedEventSource(undefined, () => {
      factoryCalls += 1;
      return created;
    });
    assert.equal(result, created);
    assert.equal(factoryCalls, 1);
  });

  it("existing null → mesmo comportamento de undefined (nullish, não só strict-undefined)", () => {
    const created = { fake: "created" };
    const result = resolveSharedEventSource(null, () => created);
    assert.equal(result, created);
  });
});

describe("chat-drawer.js/app.js/edicao.js/rodada.js: SSE compartilhado via window.__studioEvents (#3891 item 4)", () => {
  let root: string;
  let server: StudioServer;
  let drawerBody: string;
  let appBody: string;
  let edicaoBody: string;
  let rodadaBody: string;
  let sharedEventsBody: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "chat-drawer-shared-events-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });

    const fetchText = async (path: string) => {
      const res = await fetch(new URL(path, server.url));
      assert.equal(res.status, 200, `${path} deveria servir 200`);
      return res.text();
    };
    drawerBody = await fetchText("/chat-drawer.js");
    appBody = await fetchText("/app.js");
    edicaoBody = await fetchText("/edicao.js");
    rodadaBody = await fetchText("/rodada.js");
    sharedEventsBody = await fetchText("/shared-event-source.js");
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /shared-event-source.js expõe resolveSharedEventSource", () => {
    assert.match(sharedEventsBody, /export function resolveSharedEventSource\(existing, factory\)/);
  });

  it("chat-drawer.js importa resolveSharedEventSource de shared-event-source.js", () => {
    assert.match(
      drawerBody,
      /import\s*\{\s*resolveSharedEventSource\s*\}\s*from\s*"\.\/shared-event-source\.js";/,
    );
  });

  it("regression #3891 item 4: chat-drawer.js reusa window.__studioEvents em vez de abrir uma 2ª conexão incondicional", () => {
    assert.match(
      drawerBody,
      /const statusEvents = resolveSharedEventSource\(window\.__studioEvents,\s*\(\)\s*=>\s*new EventSource\("\/api\/events"\)\);/,
    );
    assert.match(drawerBody, /window\.__studioEvents = statusEvents;/);
    // não deveria sobrar a construção INCONDICIONAL antiga (regressão exata
    // do bug: `new EventSource(...)` direto, sem passar por resolveSharedEventSource).
    assert.doesNotMatch(drawerBody, /const statusEvents = new EventSource\("\/api\/events"\);/);
  });

  it("app.js publica a conexão própria em window.__studioEvents logo após criá-la", () => {
    assert.match(
      appBody,
      /eventSource = new EventSource\("\/api\/events"\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*window\.__studioEvents = eventSource;/,
    );
  });

  it("edicao.js publica a conexão própria em window.__studioEvents logo após criá-la", () => {
    assert.match(
      edicaoBody,
      /eventSource = new EventSource\("\/api\/events"\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*window\.__studioEvents = eventSource;/,
    );
  });

  it("rodada.js publica a conexão própria em window.__studioEvents logo após criá-la", () => {
    assert.match(
      rodadaBody,
      /const events = new EventSource\("\/api\/events"\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*window\.__studioEvents = events;/,
    );
  });
});

describe("chat-drawer.js: pulso de atividade no dot durante turno ativo (#3891 item 7)", () => {
  let root: string;
  let server: StudioServer;
  let drawerBody: string;
  let cssBody: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "chat-drawer-activity-pulse-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });

    const drawerRes = await fetch(new URL("/chat-drawer.js", server.url));
    assert.equal(drawerRes.status, 200);
    drawerBody = await drawerRes.text();

    const cssRes = await fetch(new URL("/chat-drawer.css", server.url));
    assert.equal(cssRes.status, 200);
    cssBody = await cssRes.text();
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  function extractSendMessageBody(): string {
    const start = drawerBody.indexOf("async function sendMessage(text) {");
    assert.ok(start > -1, "sendMessage deveria existir em chat-drawer.js");
    const end = drawerBody.indexOf("// #3556 self-review", start);
    assert.ok(end > start, "marcador de fim do recorte não encontrado");
    return drawerBody.slice(start, end);
  }

  it("setToggleActive existe e alterna a classe 'active' no dot", () => {
    assert.match(
      drawerBody,
      /function setToggleActive\(active\)\s*\{\s*el\.toggleDot\.classList\.toggle\("active", active\);\s*\}/,
    );
  });

  it("regression #3891 item 7: sendMessage liga o pulso (setToggleActive(true)) ao iniciar o turno", () => {
    const body = extractSendMessageBody();
    const sendIndex = body.indexOf("setToggleStatus(\"ok\");");
    const activeIndex = body.indexOf("setToggleActive(true);");
    assert.ok(sendIndex > -1, "setToggleStatus(\"ok\") deveria existir no início de sendMessage");
    assert.ok(activeIndex > sendIndex, "setToggleActive(true) deveria vir logo após ligar o status");
  });

  it("regression #3891 item 7: o finally desliga o pulso (setToggleActive(false)) incondicionalmente — nunca fica pulsando pra sempre", () => {
    const body = extractSendMessageBody();
    const finallyMatch = body.match(/\}\s*finally\s*\{([\s\S]*?)\n\}/);
    assert.ok(finallyMatch, "deveria existir um bloco finally em sendMessage");
    const finallyBody = finallyMatch![1];
    assert.match(finallyBody, /sending\s*=\s*false;/);
    assert.match(finallyBody, /setToggleActive\(false\);/);
  });

  it("chat-drawer.css define .chat-toggle-dot.active com animação de pulso", () => {
    assert.match(cssBody, /\.chat-toggle-dot\.active\s*\{\s*animation:\s*chat-toggle-pulse/);
    assert.match(cssBody, /@keyframes chat-toggle-pulse\s*\{/);
  });
});
