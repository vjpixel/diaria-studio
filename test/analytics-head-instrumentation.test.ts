/**
 * test/analytics-head-instrumentation.test.ts (#5498)
 *
 * Trava o invariante que a issue #5498 endereça: TODO host servido por
 * Worker deste repo (arquivo, livros, cursos, especial, eia) emite o
 * container GTM (`GTM-TC8C65ZN`) no `<head>`. Sem este teste, uma página
 * nova nasceria sem a tag em silêncio — exatamente o modo de falha que
 * produziu a issue original (nenhum dos 6 hosts tinha qualquer tag de
 * medição instalada).
 *
 * Cobre os 16 call sites de `renderSeoMeta()` + os 3 outliers que não
 * passam por ela (`render-app.ts`, `render-privacy.ts`, `gate-page.ts`) +
 * os assets committed gerados a partir desses renderers
 * (hubs .generated.ts sob workers/arquivo/src/hubs/,
 * index.html por entidade sob workers/artigos/public/entidades/,
 * workers/{livros,cursos}/public/index.html,
 * `workers/cursos/src/courses-full.generated.ts`) — drift nesses assets já
 * é coberto por `test/hub-page-drift.test.ts`/`test/entity-page-drift*`/
 * `test/cursos-full-drift.test.ts`/etc.; aqui garantimos que o conteúdo
 * COMMITTED carrega a tag, não só o renderer fonte.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderAnalyticsHead, GTM_CONTAINER_ID } from "../scripts/lib/shared/seo-meta.ts";
import { renderAppPage } from "../workers/arquivo/src/render-app.ts";
import { renderPrivacyPage } from "../workers/arquivo/src/render-privacy.ts";
import { buildArchiveHtml } from "../workers/arquivo/src/render-archive.ts";
import { renderGatePage } from "../workers/cursos/src/gate-page.ts";
import { renderConfirmadoPage } from "../workers/poll/src/confirmado.ts";
import { renderJogarPageHtml, renderJogarSequencePageHtml, renderJogarArchiveHtml, renderJogarQuizPageHtml } from "../workers/poll/src/jogar.ts";
import { renderSharePageHtml, renderQuizSharePageHtml } from "../workers/poll/src/share.ts";
import { renderArchiveListHtml, renderArchiveVoteHtml, handleLeaderboard } from "../workers/poll/src/leaderboard-routes.ts";
import { renderLivrosPage, loadBooks } from "../scripts/build-livros-page.ts";
import { renderCursosPage, loadCourses } from "../scripts/build-cursos-page.ts";
import { renderHubIndexPage } from "../scripts/lib/shared/hub-index-page.ts";
import { renderHubPage } from "../scripts/lib/shared/hub-page.ts";
import { HUB_LOADERS } from "../scripts/build-hub-page.ts";
import { renderEntityPage } from "../scripts/lib/shared/entity-page.ts";
import { ENTITY_LOADERS } from "../scripts/build-entity-page.ts";
import type { Env } from "../workers/poll/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// O snippet oficial do GTM concatena o container ID em runtime
// (`'...gtm.js?id='+i+dl`, `i` = último argumento da IIFE) — o ID não
// aparece literalmente colado à URL no texto-fonte. O invariante real é:
// "carrega o script googletagmanager.com/gtm.js" E "declara o container ID
// certo" em algum lugar do mesmo bloco — checados como 2 padrões
// independentes, não 1 concatenado.
const GTM_SCRIPT_RE = /googletagmanager\.com\/gtm\.js/;
const GTM_ID_RE = new RegExp(`['"]${GTM_CONTAINER_ID}['"]`);

/** Asserção comum — a tag GTM está presente E dentro do `<head>...</head>`. */
function assertGtmInHead(html: string, label: string) {
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  assert.ok(headMatch, `${label}: sem <head>...</head> pra inspecionar`);
  const head = headMatch![1];
  assert.match(head, GTM_SCRIPT_RE, `${label}: script do GTM ausente do <head>`);
  assert.match(head, GTM_ID_RE, `${label}: container ID (${GTM_CONTAINER_ID}) ausente do <head>`);
}

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const data: Record<string, string> = { ...seed };
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => { data[key] = value; },
    delete: async (key: string) => { delete data[key]; },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Object.keys(data).filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
}

function makeEnv(): Env {
  return {
    POLL: makeKv(),
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  } as Env;
}

describe("renderAnalyticsHead (#5498)", () => {
  it("emite o container GTM canônico", () => {
    const html = renderAnalyticsHead();
    assert.match(html, /<script>/);
    assert.match(html, GTM_SCRIPT_RE);
    assert.match(html, GTM_ID_RE);
  });

  it("GTM_CONTAINER_ID é o container confirmado ao vivo na home", () => {
    assert.equal(GTM_CONTAINER_ID, "GTM-TC8C65ZN");
  });
});

describe("sweep de renderers — todo <head> emite o container GTM (#5498)", () => {
  it("workers/arquivo/src/render-app.ts — renderAppPage", () => {
    assertGtmInHead(renderAppPage(), "renderAppPage");
  });

  it("workers/arquivo/src/render-privacy.ts — renderPrivacyPage", () => {
    assertGtmInHead(renderPrivacyPage(), "renderPrivacyPage");
  });

  it("workers/arquivo/src/render-archive.ts — buildArchiveHtml", () => {
    assertGtmInHead(buildArchiveHtml([]), "buildArchiveHtml");
  });

  it("workers/cursos/src/gate-page.ts — renderGatePage", () => {
    assertGtmInHead(renderGatePage(), "renderGatePage");
  });

  it("workers/poll/src/confirmado.ts — renderConfirmadoPage", () => {
    assertGtmInHead(renderConfirmadoPage(), "renderConfirmadoPage");
  });

  it("workers/poll/src/jogar.ts — renderJogarPageHtml", () => {
    assertGtmInHead(renderJogarPageHtml({ edition: "260101", revealed: false }), "renderJogarPageHtml");
  });

  it("workers/poll/src/jogar.ts — renderJogarSequencePageHtml", () => {
    assertGtmInHead(renderJogarSequencePageHtml(["260101"]), "renderJogarSequencePageHtml");
  });

  it("workers/poll/src/jogar.ts — renderJogarArchiveHtml", () => {
    assertGtmInHead(renderJogarArchiveHtml(["260101"], "2026"), "renderJogarArchiveHtml");
  });

  it("workers/poll/src/jogar.ts — renderJogarQuizPageHtml", () => {
    assertGtmInHead(renderJogarQuizPageHtml(["260101"]), "renderJogarQuizPageHtml");
  });

  it("workers/poll/src/share.ts — renderSharePageHtml", async () => {
    const html = renderSharePageHtml({ token: "tok", payload: { edition: "260101", correct: true }, utmMedium: "link" });
    assertGtmInHead(html, "renderSharePageHtml");
  });

  it("workers/poll/src/share.ts — renderQuizSharePageHtml", () => {
    const html = renderQuizSharePageHtml({ token: "tok", payload: { score: 3, total: 5 }, utmMedium: "link" });
    assertGtmInHead(html, "renderQuizSharePageHtml");
  });

  it("workers/poll/src/leaderboard-routes.ts — renderArchiveListHtml", async () => {
    const res = renderArchiveListHtml(["260101"], "2026");
    assertGtmInHead(await res.text(), "renderArchiveListHtml");
  });

  it("workers/poll/src/leaderboard-routes.ts — renderArchiveVoteHtml", async () => {
    const res = renderArchiveVoteHtml("260101", "2026");
    assertGtmInHead(await res.text(), "renderArchiveVoteHtml");
  });

  it("workers/poll/src/leaderboard-routes.ts — handleLeaderboard (renderLeaderboardHtml interno)", async () => {
    const res = await handleLeaderboard(makeEnv(), "diaria");
    assertGtmInHead(await res.text(), "handleLeaderboard");
  });

  it("scripts/build-livros-page.ts — renderLivrosPage", () => {
    assertGtmInHead(renderLivrosPage(loadBooks()), "renderLivrosPage");
  });

  it("scripts/build-cursos-page.ts — renderCursosPage (teaser)", () => {
    assertGtmInHead(renderCursosPage(loadCourses(), "teaser"), "renderCursosPage(teaser)");
  });

  it("scripts/build-cursos-page.ts — renderCursosPage (full)", () => {
    assertGtmInHead(renderCursosPage(loadCourses(), "full"), "renderCursosPage(full)");
  });

  it("scripts/lib/shared/hub-index-page.ts — renderHubIndexPage", () => {
    assertGtmInHead(renderHubIndexPage([]), "renderHubIndexPage");
  });

  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`scripts/lib/shared/hub-page.ts — renderHubPage(${slug})`, () => {
      assertGtmInHead(renderHubPage(HUB_LOADERS[slug]()), `renderHubPage(${slug})`);
    });
  }

  for (const slug of Object.keys(ENTITY_LOADERS)) {
    it(`scripts/lib/shared/entity-page.ts — renderEntityPage(${slug})`, () => {
      assertGtmInHead(renderEntityPage(ENTITY_LOADERS[slug]()), `renderEntityPage(${slug})`);
    });
  }
});

describe("sweep de assets committed — nenhum HTML servido em produção diverge (#5498)", () => {
  const staticFiles = [
    "workers/artigos/public/index.html",
    "workers/livros/public/index.html",
    "workers/cursos/public/index.html",
  ];

  for (const rel of staticFiles) {
    it(`${rel} contém o container GTM`, () => {
      const html = readFileSync(resolve(ROOT, rel), "utf8");
      assertGtmInHead(html, rel);
    });
  }

  it("workers/cursos/src/courses-full.generated.ts contém o container GTM", () => {
    const src = readFileSync(resolve(ROOT, "workers/cursos/src/courses-full.generated.ts"), "utf8");
    assert.match(src, GTM_SCRIPT_RE);
    assert.match(src, GTM_ID_RE);
  });

  const hubsDir = resolve(ROOT, "workers/arquivo/src/hubs");
  for (const file of readdirSync(hubsDir).filter((f) => f.endsWith(".generated.ts"))) {
    it(`workers/arquivo/src/hubs/${file} contém o container GTM`, () => {
      const src = readFileSync(resolve(hubsDir, file), "utf8");
      assert.match(src, GTM_SCRIPT_RE);
      assert.match(src, GTM_ID_RE);
    });
  }

  const entidadesDir = resolve(ROOT, "workers/artigos/public/entidades");
  for (const slug of readdirSync(entidadesDir)) {
    it(`workers/artigos/public/entidades/${slug}/index.html contém o container GTM`, () => {
      const html = readFileSync(resolve(entidadesDir, slug, "index.html"), "utf8");
      assertGtmInHead(html, `entidades/${slug}`);
    });
  }
});
