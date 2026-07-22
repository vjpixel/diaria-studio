/**
 * test/chat-drawer-badge-wiring.test.ts (#3888) — cobertura de "contrato
 * estático servido" do badge global (mesmo precedente de
 * `test/chat-drawer-mobile.test.ts`/#3851 e "GET /chat-drawer.js expõe
 * prefillMessage..." em `test/studio-review-server.test.ts`): este projeto
 * não tem harness de DOM (sem jsdom/happy-dom, ver
 * `test/studio-edicao-page.test.ts`), então a cobertura possível pro WIRING
 * real (chat-drawer.js de fato lendo `state.gatesPending`/`currentEdition` e
 * chamando `computeGlobalBadgeCount`/`resolveBadgeClickAction`) é buscar o
 * asset servido via HTTP (mesmo static-serve.ts de produção) e afirmar
 * estrutura via regex no corpo — a decisão em si (soma/ação de clique) já
 * está coberta isoladamente, sem DOM, em `test/chat-badge.test.ts`.
 *
 * Regressão do #3888: antes deste fix, o badge só lia
 * `state.chatPermissionsPending` — o SSE `state` nunca era usado pra somar
 * `gatesPending`, então um gate 4/6 pendente sem card de chat aberto ficava
 * sem NENHUM sinal em 6 das 8 páginas do Studio (todas injetam
 * `chat-drawer.js` — ver `apoios.html`/`edicao.html`/`index.html`/
 * `integracoes.html`/`relatorios.html`/`revisao.html`/`rodada.html`/
 * `triagem.html`).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

describe("badge global soma gates de pipeline + perguntas do chat (#3888)", () => {
  let root: string;
  let server: StudioServer;
  let drawerBody: string;
  let badgeBody: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "chat-drawer-badge-wiring-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });

    const drawerRes = await fetch(new URL("/chat-drawer.js", server.url));
    assert.equal(drawerRes.status, 200);
    assert.match(drawerRes.headers.get("content-type") ?? "", /javascript/);
    drawerBody = await drawerRes.text();

    const badgeRes = await fetch(new URL("/chat-badge.js", server.url));
    assert.equal(badgeRes.status, 200);
    assert.match(badgeRes.headers.get("content-type") ?? "", /javascript/);
    badgeBody = await badgeRes.text();
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /chat-badge.js expõe computeGlobalBadgeCount e resolveBadgeClickAction", () => {
    assert.match(badgeBody, /export function computeGlobalBadgeCount\(/);
    assert.match(badgeBody, /export function resolveBadgeClickAction\(/);
  });

  it("chat-drawer.js importa as duas funções de chat-badge.js", () => {
    assert.match(
      drawerBody,
      /import\s*\{\s*computeGlobalBadgeCount,\s*resolveBadgeClickAction\s*\}\s*from\s*"\.\/chat-badge\.js";/,
    );
  });

  it("regression #3888: o handler do SSE 'state' lê state.gatesPending (não só chatPermissionsPending)", () => {
    assert.match(drawerBody, /latestGatesPending\s*=\s*Array\.isArray\(state\.gatesPending\)\s*\?\s*state\.gatesPending\s*:\s*\[\]/);
    assert.match(
      drawerBody,
      /latestChatPermissionsPending\s*=\s*Array\.isArray\(state\.chatPermissionsPending\)\s*\?\s*state\.chatPermissionsPending\s*:\s*\[\]/,
    );
    assert.match(drawerBody, /latestCurrentEdition\s*=\s*typeof state\.currentEdition === "string" \? state\.currentEdition : null/);
  });

  it("regression #3888: o badge é setado a partir de computeGlobalBadgeCount(gatesPending, chatPermissionsPending), não só chatPermissionsPending.length isolado", () => {
    assert.match(
      drawerBody,
      /setPendingBadge\(computeGlobalBadgeCount\(latestGatesPending,\s*latestChatPermissionsPending\)\)/,
    );
  });

  it("o clique no toggle decide a ação via resolveBadgeClickAction com os 3 campos do state mais recente", () => {
    assert.match(
      drawerBody,
      /const decision = resolveBadgeClickAction\(latestGatesPending,\s*latestChatPermissionsPending,\s*latestCurrentEdition\);/,
    );
    assert.match(drawerBody, /if\s*\(decision\.action === "scroll"\)\s*\{\s*scrollToPendingCard\(\);/);
    assert.match(drawerBody, /else if\s*\(decision\.action === "navigate"\)\s*\{\s*location\.href = decision\.href;/);
  });

  it("todas as 8 páginas do Studio injetam chat-drawer.js (cobertura do badge global)", async () => {
    const pages = [
      "/apoios.html",
      "/edicao.html",
      "/index.html",
      "/integracoes.html",
      "/relatorios.html",
      "/revisao.html",
      "/rodada.html",
      "/triagem.html",
    ];
    for (const page of pages) {
      const res = await fetch(new URL(page, server.url));
      assert.equal(res.status, 200, `${page} deveria servir 200`);
      const body = await res.text();
      assert.match(body, /<script src="\/chat-drawer\.js" type="module"><\/script>/, `${page} deveria injetar chat-drawer.js`);
    }
  });
});
