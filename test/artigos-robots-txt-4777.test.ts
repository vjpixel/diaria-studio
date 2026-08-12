/**
 * test/artigos-robots-txt-4777.test.ts (#4777, sitemap #5126)
 *
 * Regressão (#633) — `especial.diar.ia.br` (Worker `artigos`, static-assets-
 * only, sem script — ver `workers/artigos/wrangler.toml`) servia o
 * robots.txt DEFAULT gerenciado pela Cloudflare, contrariando a decisão do
 * editor de 03/ago (CLAUDE.md, "Crawlers de IA ficam liberados nas nossas
 * superfícies"). `public/robots.txt` é servido direto pelo binding `ASSETS`
 * (sem `fetch` handler pra invocar) — mesma disciplina de cobertura de
 * `test/curadoria-sitemap-robots.test.ts` (cursos/livros): confere o
 * CONTEÚDO do arquivo committed contra um render fresco.
 *
 * **#5126 (12/ago/2026): este Worker GANHOU um `/sitemap.xml` próprio**
 * (`public/sitemap.xml`, estático — sem índice/build script, ver
 * `README.md`). Antes disso o robots.txt era gerado SEM `sitemapUrl` (era o
 * único host de curadoria assim); agora `renderCuradoriaRobotsTxt` recebe a
 * URL do sitemap deste host, igual aos demais. Cobertura do próprio
 * sitemap/índice/JSON-LD: `test/artigos-sitemap-5126.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderCuradoriaRobotsTxt, CURADORIA_BLOCKED_BOTS } from "../scripts/lib/shared/robots-txt.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROBOTS_PATH = resolve(ROOT, "workers", "artigos", "public", "robots.txt");

const ARTIGOS_SITEMAP_URL = "https://especial.diar.ia.br/sitemap.xml";

describe("workers/artigos/public/robots.txt (#4777, #5126)", () => {
  it("existe e bate byte-a-byte com um render fresco de renderCuradoriaRobotsTxt(sitemapUrl)", () => {
    assert.ok(existsSync(ROBOTS_PATH), `${ROBOTS_PATH} ausente`);
    const committed = readFileSync(ROBOTS_PATH, "utf8");
    const fresh = renderCuradoriaRobotsTxt(ARTIGOS_SITEMAP_URL);
    assert.equal(committed, fresh, "robots.txt divergiu de renderCuradoriaRobotsTxt() — regenerar o arquivo");
  });

  it("declara Allow: / geral e Sitemap: própria (#5126 — antes deste PR, sem sitemap.xml próprio)", () => {
    const body = readFileSync(ROBOTS_PATH, "utf8");
    assert.match(body, /User-agent: \*/);
    assert.match(body, /Allow: \//);
    assert.match(body, new RegExp(`Sitemap: ${ARTIGOS_SITEMAP_URL.replace(/\./g, "\\.")}`));
  });

  it("só bloqueia os bots da allowlist de bloqueio (#4777, mesma decisão do #4546) — os 7 crawlers de IA liberados não aparecem", () => {
    const body = readFileSync(ROBOTS_PATH, "utf8");
    for (const bot of CURADORIA_BLOCKED_BOTS) {
      assert.match(body, new RegExp(`User-agent: ${bot}\\nDisallow: /`));
    }
    for (const bot of [
      "GPTBot",
      "ClaudeBot",
      "CCBot",
      "Google-Extended",
      "Bytespider",
      "meta-externalagent",
      "Applebot-Extended",
    ]) {
      assert.doesNotMatch(body, new RegExp(`User-agent: ${bot}\\b`));
    }
  });
});

describe("renderCuradoriaRobotsTxt sem argumentos (#4777)", () => {
  it("omite a linha Sitemap: quando sitemapUrl não é informado", () => {
    const out = renderCuradoriaRobotsTxt();
    assert.doesNotMatch(out, /Sitemap:/);
  });

  it("extraDisallowPaths bloqueia paths adicionais pra User-agent: * além do Allow: / geral", () => {
    const out = renderCuradoriaRobotsTxt(undefined, { extraDisallowPaths: ["/vote"] });
    assert.match(out, /Allow: \/\nDisallow: \/vote/);
  });

  it("extraDisallowPaths + sitemapUrl coexistem sem interferir um no outro", () => {
    const out = renderCuradoriaRobotsTxt("https://eia.diar.ia.br/sitemap.xml", { extraDisallowPaths: ["/vote"] });
    assert.match(out, /Allow: \/\nDisallow: \/vote/);
    assert.match(out, /Sitemap: https:\/\/eia\.diar\.ia\.br\/sitemap\.xml/);
  });
});
