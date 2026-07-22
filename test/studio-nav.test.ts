/**
 * test/studio-nav.test.ts (#3849) — menu de navegação unificado do Studio.
 *
 * Duas frentes:
 *   1. Lógica PURA de `scripts/studio-ui/public/nav-core.js` (`NAV_ITEMS`,
 *      `resolveActiveNavId`, `resolveRevisaoHref`, `buildNavHtml`) — mesmo
 *      padrão de `test/revisao-guards.test.ts`: nenhuma das funções toca
 *      `document`/`fetch`, testável direto com fixtures puras (#633).
 *      Inclui um cross-check contra o SOURCE de `scripts/studio-ui/server.ts`
 *      (fonte da verdade das rotas reais, #3849) — pega drift em ambas as
 *      direções: rota real sem entrada no menu, ou entrada no menu apontando
 *      pra rota que não existe. `/integracoes` (#3848) foi adicionado nesta
 *      rodada — a rota real existe agora em `server.ts`, então o item entra
 *      em `NAV_ITEMS` como qualquer outro destino.
 *   2. Contrato HTTP: cada página real servida por `server.ts` inclui o
 *      mount point (`#app-nav`), o script `nav.js`, e o marcador
 *      `window.STUDIO_PAGE` com o valor correto — a montagem real no DOM
 *      (fetch de `/api/state`, injeção de HTML) roda no browser sem harness
 *      de DOM neste projeto, mesmo precedente de
 *      `test/studio-edicao-page.test.ts`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";
import {
  NAV_ITEMS,
  DASHBOARD_LINKS,
  resolveActiveNavId,
  resolveRevisaoHref,
  buildNavHtml,
} from "../scripts/studio-ui/public/nav-core.js";

const __dir = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dir, "..");
const SERVER_TS = readFileSync(resolve(REPO_ROOT, "scripts", "studio-ui", "server.ts"), "utf-8");

// ─── lógica pura (nav-core.js) ──────────────────────────────────────────

describe("NAV_ITEMS / DASHBOARD_LINKS (#3849) — shape e drift-guard contra server.ts", () => {
  it("cobre os 7 destinos de página (home/rodada/triagem/revisao/apoios/relatorios/integracoes)", () => {
    const ids = NAV_ITEMS.map((i) => i.id);
    assert.deepEqual(ids, ["home", "rodada", "triagem", "revisao", "apoios", "relatorios", "integracoes"]);
  });

  it("todo item (exceto revisao, que resolve em runtime) tem href estático não-vazio", () => {
    for (const item of NAV_ITEMS) {
      if (item.id === "revisao") {
        assert.equal(item.href, null);
        continue;
      }
      assert.ok(typeof item.href === "string" && item.href.startsWith("/"), `${item.id} precisa de href estático`);
    }
  });

  it("cada href estático de NAV_ITEMS corresponde a uma rota REAL em server.ts (#3849 escopo — fonte da verdade)", () => {
    // rodada/triagem/apoios/relatorios são comparados por igualdade exata de
    // urlPath no router (`urlPath === "/rodada"` etc.) — bare "/" (home) é o
    // catch-all de static-serve.ts (index.html), não precisa de match textual
    // aqui além de existir o próprio arquivo (coberto pelo teste HTTP abaixo).
    const staticRoutes = NAV_ITEMS.filter((i) => i.href && i.href !== "/");
    for (const item of staticRoutes) {
      assert.match(
        SERVER_TS,
        new RegExp(`urlPath === "${item.href}"`),
        `NAV_ITEMS.${item.id} aponta pra "${item.href}", que não aparece como rota reconhecida em server.ts`,
      );
    }
  });

  it("o item 'revisao' é backed pela rota dinâmica /revisao/:aammdd real de server.ts", () => {
    // Match textual direto contra o regex-fonte usado no router (evita
    // reconstruir um regex-que-casa-um-regex frágil): server.ts declara
    // literalmente `/^\/revisao\/[^/]+\/?$/` pra essa rota.
    assert.ok(
      SERVER_TS.includes("\\/revisao\\/[^/]+"),
      "server.ts não tem mais a rota dinâmica /revisao/:aammdd esperada",
    );
  });

  it("DASHBOARD_LINKS aponta pras 2 rotas /painel/* reais de server.ts", () => {
    for (const d of DASHBOARD_LINKS) {
      assert.match(SERVER_TS, new RegExp(d.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("(#3848): /integracoes agora É um destino de menu — rota real existe em server.ts", () => {
    const item = NAV_ITEMS.find((i) => i.id === "integracoes");
    assert.ok(item, "NAV_ITEMS precisa ter o item 'integracoes'");
    assert.equal(item.href, "/integracoes");
    assert.match(SERVER_TS, /urlPath === "\/integracoes"/, "server.ts precisa reconhecer a rota /integracoes");
  });

  it("todo item de NAV_ITEMS tem pelo menos 1 pageId associado (senão nunca fica ativo)", () => {
    for (const item of NAV_ITEMS) {
      assert.ok(Array.isArray(item.pageIds) && item.pageIds.length > 0, `${item.id} sem pageIds`);
    }
  });
});

describe("resolveActiveNavId (#3849)", () => {
  it("mapeia cada página conhecida pro item correto", () => {
    assert.equal(resolveActiveNavId("index"), "home");
    assert.equal(resolveActiveNavId("edicao"), "home"); // cockpit é parte do fluxo Home
    assert.equal(resolveActiveNavId("rodada"), "rodada");
    assert.equal(resolveActiveNavId("triagem"), "triagem");
    assert.equal(resolveActiveNavId("revisao"), "revisao");
    assert.equal(resolveActiveNavId("apoios"), "apoios");
    assert.equal(resolveActiveNavId("relatorios"), "relatorios");
    assert.equal(resolveActiveNavId("integracoes"), "integracoes");
  });

  it("retorna null pra pageId desconhecido/ausente (fail-closed — nenhum item marcado ativo por engano)", () => {
    assert.equal(resolveActiveNavId("nao-existe"), null);
    assert.equal(resolveActiveNavId(null), null);
    assert.equal(resolveActiveNavId(undefined), null);
  });
});

describe("resolveRevisaoHref (#3849)", () => {
  it("com edição corrente -> /revisao/{edicao}", () => {
    assert.equal(resolveRevisaoHref("260722"), "/revisao/260722");
  });

  it("sem edição corrente -> null (nunca aponta pra /revisao bare, que não é rota válida)", () => {
    assert.equal(resolveRevisaoHref(null), null);
    assert.equal(resolveRevisaoHref(undefined), null);
    assert.equal(resolveRevisaoHref(""), null);
  });
});

describe("buildNavHtml (#3849)", () => {
  it("renderiza os 7 itens de página + o grupo de Dashboards", () => {
    const html = buildNavHtml("rodada", "/revisao/260722");
    assert.match(html, /id="app-nav-list"/);
    assert.match(html, /href="\/">Home<\/a>/);
    assert.match(html, /href="\/rodada"/);
    assert.match(html, /href="\/triagem"/);
    assert.match(html, /href="\/revisao\/260722"/);
    assert.match(html, /href="\/apoios"/);
    assert.match(html, /href="\/relatorios"/);
    assert.match(html, /href="\/integracoes"/);
    assert.match(html, /app-nav-group-label">Dashboards</);
    assert.match(html, /href="\/painel\/diaria"[^>]*target="_blank"/);
    assert.match(html, /href="\/painel\/clarice"[^>]*target="_blank"/);
  });

  it("marca o item ativo com a classe 'active' e aria-current", () => {
    const html = buildNavHtml("triagem", null);
    assert.match(html, /class="app-nav-item active" href="\/triagem" aria-current="page">Triagem/);
    // os outros itens não recebem active nem aria-current
    assert.doesNotMatch(html, /class="app-nav-item active" href="\/rodada"/);
  });

  it("nenhum item ativo quando activeId é null (ex: página não mapeada)", () => {
    const html = buildNavHtml(null, null);
    assert.doesNotMatch(html, /active/);
    assert.doesNotMatch(html, /aria-current/);
  });

  it("Revisão sem href vira <span> desabilitado, não um <a> (nunca aponta pra rota inexistente)", () => {
    const html = buildNavHtml("revisao", null);
    assert.match(html, /<span class="app-nav-item app-nav-disabled"[^>]*>Revisão<\/span>/);
    assert.doesNotMatch(html, /<a[^>]*>Revisão<\/a>/);
  });

  it("Revisão com href vira <a> normal, marcado ativo quando activeId === 'revisao'", () => {
    const html = buildNavHtml("revisao", "/revisao/260722");
    assert.match(html, /<a class="app-nav-item active" href="\/revisao\/260722" aria-current="page">Revisão<\/a>/);
  });

  it("escapa labels/hrefs (defesa básica contra XSS, mesmo padrão de escapeHtml em outras páginas)", () => {
    // não há input de usuário real hoje (NAV_ITEMS/DASHBOARD_LINKS são
    // estáticos), mas a função em si precisa escapar corretamente — cobre
    // corretude da própria escapeHtml interna via caracteres especiais no
    // href resolvido de Revisão (currentEdition vem de /api/state, uma API
    // própria, mas defesa em profundidade é barata aqui).
    const html = buildNavHtml("revisao", '/revisao/260722"><script>');
    assert.doesNotMatch(html, /<script>/);
  });
});

// ─── contrato HTTP: cada página real inclui o nav ────────────────────────

describe("GET de cada página real inclui #app-nav + nav.js + STUDIO_PAGE correto (#3849)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-nav-page-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const cases: Array<{ path: string; page: string }> = [
    { path: "/", page: "index" },
    { path: "/rodada", page: "rodada" },
    { path: "/triagem", page: "triagem" },
    { path: "/apoios", page: "apoios" },
    { path: "/relatorios", page: "relatorios" },
    { path: "/integracoes", page: "integracoes" },
    { path: "/edicao/260722", page: "edicao" },
    { path: "/revisao/260722", page: "revisao" },
  ];

  for (const { path, page } of cases) {
    it(`GET ${path} inclui #app-nav, /nav.js e window.STUDIO_PAGE = "${page}"`, async () => {
      const res = await fetch(new URL(path, server.url));
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes('id="app-nav"'), `${path}: falta o mount point #app-nav`);
      assert.ok(body.includes('src="/nav.js"'), `${path}: falta o script nav.js`);
      assert.ok(
        body.includes(`window.STUDIO_PAGE = "${page}";`),
        `${path}: STUDIO_PAGE não bate com "${page}"`,
      );
    });
  }

  it("nenhuma rota de página real fica de fora da cobertura acima (mesma lista que NAV_ITEMS + edicao)", () => {
    const coveredPages = new Set(cases.map((c) => c.page));
    for (const item of NAV_ITEMS) {
      for (const pageId of item.pageIds) {
        assert.ok(coveredPages.has(pageId), `pageId "${pageId}" de NAV_ITEMS não tem uma página real testada acima`);
      }
    }
  });

  it("GET /nav.js e /nav-core.js são servidos com content-type JS", async () => {
    const nav = await fetch(new URL("/nav.js", server.url));
    assert.equal(nav.status, 200);
    assert.match(nav.headers.get("content-type") ?? "", /javascript/);
    const core = await fetch(new URL("/nav-core.js", server.url));
    assert.equal(core.status, 200);
    assert.match(core.headers.get("content-type") ?? "", /javascript/);
  });

  it("GET /nav.css é servido com content-type CSS", async () => {
    const res = await fetch(new URL("/nav.css", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/);
  });
});
