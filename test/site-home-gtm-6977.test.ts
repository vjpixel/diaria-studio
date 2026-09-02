/**
 * test/site-home-gtm-6977.test.ts (#6977)
 *
 * Antes desta correção, `workers/site/public/index.html` (a home, servida
 * pelo Worker `diaria-site`) era o ÚNICO dos 3 hosts que podem receber
 * tráfego pago (home, `livros.diar.ia.br`, `cursos.diar.ia.br`) sem
 * container GTM/GA4 — `livros`/`cursos` (via `build-livros-page.ts`/
 * `build-cursos-page.ts`) já chamam `renderAnalyticsHead()` de
 * `scripts/lib/shared/seo-meta.ts`; `scripts/lib/site-home-page.ts` nunca
 * importava esse módulo. Efeito: o teste de atribuição de 3 canais pagos
 * (#6150) ficava cego exatamente no braço da home — sem sessão, origem ou
 * evento de cadastro medidos ali.
 *
 * Cobre:
 *   - `buildIndexHtml()` (miolo puro) emite o mesmo snippet GTM que
 *     `renderAnalyticsHead()` produz, com o MESMO container id que
 *     `livros`/`cursos` usam (`GTM_CONTAINER_ID`) — nunca uma propriedade
 *     nova, senão os 3 braços do teste caem em datasets que não somam.
 *   - o snippet aparece no `<head>`, antes de `<style>` (mesma posição que
 *     `build-livros-page.ts`/`build-cursos-page.ts` usam).
 *   - o arquivo COMMITTED (`workers/site/public/index.html`) reflete a
 *     mudança — regressão que aconteceria se alguém editar
 *     `site-home-page.ts` sem rerodar `gen-home-page.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndexHtml } from "../scripts/lib/site-home-page.ts";
import { renderAnalyticsHead, GTM_CONTAINER_ID } from "../scripts/lib/shared/seo-meta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(ROOT, "workers", "site", "public");

describe("buildIndexHtml() — GTM/GA4 (#6977)", () => {
  const html = buildIndexHtml({ feature: null, archive: [] });

  it("emite o snippet GTM com o MESMO container id de livros/cursos", () => {
    assert.match(html, /googletagmanager\.com\/gtm\.js/);
    assert.ok(
      html.includes(GTM_CONTAINER_ID),
      `esperava o container ${GTM_CONTAINER_ID} — home não pode virar uma propriedade GA4 separada de livros/cursos`,
    );
  });

  it("o snippet é byte-a-byte o mesmo que renderAnalyticsHead() produz — nenhuma cópia divergente", () => {
    assert.ok(html.includes(renderAnalyticsHead()));
  });

  it("o snippet aparece no <head>, antes de <style> (mesma posição de livros/cursos)", () => {
    const headEnd = html.indexOf("</head>");
    const gtmPos = html.indexOf("googletagmanager.com");
    const stylePos = html.indexOf("<style>");
    assert.ok(gtmPos > -1 && gtmPos < headEnd, "GTM precisa estar dentro do <head>");
    assert.ok(gtmPos < stylePos, "GTM precisa vir antes do <style> (mesma convenção de build-livros-page.ts)");
  });
});

describe("workers/site/public/index.html — committed (#6977)", () => {
  const indexPath = resolve(PUBLIC_DIR, "index.html");

  it("index.html existe", () => {
    assert.ok(existsSync(indexPath));
  });

  it("arquivo committed contém o snippet GTM (regressão: editar site-home-page.ts sem rerodar gen-home-page.ts)", () => {
    const html = readFileSync(indexPath, "utf8");
    assert.match(html, /googletagmanager\.com\/gtm\.js/);
    assert.ok(html.includes(GTM_CONTAINER_ID));
  });
});
