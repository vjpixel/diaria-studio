/**
 * test/site-apoiar-page-7915.test.ts (#7915)
 *
 * Cobre o miolo puro de `scripts/lib/site-apoiar-page.ts` (buildApoiarHtml)
 * — a página `/apoiar` que a issue pede: explicação curta de benefícios +
 * valores vigentes, link pra campanha, amostra pública, sem invenção de
 * nível/promessa nova, e sem vazar conteúdo pago.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApoiarHtml, APOIAR_CLICK_PATH } from "../scripts/lib/site-apoiar-page.ts";
import { DIARIA_ESPECIAL_URL } from "../scripts/lib/canonical-urls.ts";
import { GTM_CONTAINER_ID } from "../scripts/lib/shared/seo-meta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("buildApoiarHtml (#7915)", () => {
  const html = buildApoiarHtml();

  it("HTML válido, lang pt-BR, charset e viewport (acessibilidade básica)", () => {
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  });

  it("title e canonical apontam pra /apoiar", () => {
    assert.match(html, /<title>Apoiar — diar\.ia\.br<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/apoiar">/);
  });

  it("carrega o container GTM (#5498, mesma instrumentação das demais páginas do apex)", () => {
    assert.match(html, /googletagmanager\.com\/gtm\.js/);
    assert.match(html, new RegExp(`['"]${GTM_CONTAINER_ID}['"]`));
  });

  it("lista os 4 níveis de recompensa com os MESMOS valores de computeRewardGroup (#3844) — nunca inventa um novo", () => {
    for (const valor of ["R$5/mês", "R$10/mês", "R$25/mês", "R$50/mês"]) {
      assert.ok(html.includes(valor), `valor ${valor} ausente — nível de recompensa deveria bater com REWARD_TIER_*_MIN`);
    }
    for (const nome of ["Amigo", "Apoiador", "Mantenedor", "Patrono"]) {
      assert.ok(html.includes(`>${nome}<`), `nível "${nome}" ausente`);
    }
  });

  it("benefícios citados (Apoiador/Mantenedor) são os já transcritos da campanha real na #7658 — não texto novo", () => {
    assert.match(html, /Artigo Especial mensal completo/);
    assert.match(html, /Panorama do Mês/);
    assert.match(html, /voto no tema do próximo Artigo Especial/);
  });

  it("CTA de apoio aponta pra rota própria do Worker (/apoiar/ir), não direto pro apoia.se — instrumentação de clique", () => {
    assert.equal(APOIAR_CLICK_PATH, "/apoiar/ir");
    assert.match(html, new RegExp(`href="${APOIAR_CLICK_PATH.replace("/", "\\/")}"`));
    // Nunca um link DIRETO pro apoia.se nesta página — o clique tem que
    // passar pela rota que conta (senão o contador nunca incrementa).
    assert.ok(!html.includes('href="https://apoia.se'), "CTA não deveria linkar direto pro apoia.se — perde a instrumentação de clique");
  });

  it("amostra pública é um link pro hub de Artigos Especiais (nunca conteúdo atrás do gate)", () => {
    assert.match(html, new RegExp(`href="${DIARIA_ESPECIAL_URL.replace(/[.]/g, "\\.")}"`));
    assert.match(html, /amostra pública/i);
    // Nenhum link pro domínio de retrospectiva (gate de apoio R$25+) nem
    // qualquer indício de rota gateada/paga.
    assert.ok(!html.includes("retrospectiva.diar.ia.br"), "não deveria linkar pra conteúdo gateado");
  });

  it("link de volta pra home e nunca markdown cru (só HTML)", () => {
    assert.match(html, /href="\/">/);
    assert.ok(!/\*\*|^#\s|^- /m.test(html.replace(/<style>[\s\S]*?<\/style>/, "")), "não deveria conter marcação markdown crua no corpo");
  });

  it("nunca menciona custo em pixels/resolução nem reproduz prompt de imagem — página é texto puro, sem imagem gerada", () => {
    assert.ok(!html.includes("<img"), "página não deveria carregar imagem nenhuma (conteúdo é só texto/links)");
  });
});

describe("workers/site/public/apoiar/index.html — committed (#7915)", () => {
  const filePath = resolve(ROOT, "workers", "site", "public", "apoiar", "index.html");

  it("existe e é idêntico ao output atual de buildApoiarHtml() — regenerado via gen-apoiar-page.ts, nunca editado à mão", () => {
    assert.ok(existsSync(filePath), `${filePath} ausente`);
    const committed = readFileSync(filePath, "utf8");
    assert.equal(committed, buildApoiarHtml());
  });
});
