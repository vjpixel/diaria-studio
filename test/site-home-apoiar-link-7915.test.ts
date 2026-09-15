/**
 * test/site-home-apoiar-link-7915.test.ts (#7915)
 *
 * Trava o link secundário `/apoiar` na nav e no rodapé da home, no mesmo
 * molde de `test/site-home-hub-links-6411.test.ts` — testa o HTML GERADO
 * (`buildIndexHtml`) e o `index.html` COMMITTED (o que de fato vai pro ar
 * em `workers/site/public/`, deploy automático em push), pra um refactor
 * futuro da lista de links não fazer o CTA de apoio desaparecer em silêncio
 * sem nenhum teste acusar.
 *
 * Não testa POSIÇÃO/ordem — só presença, href exato, e que "Assinar"
 * continua sendo o CTA primário (`.nav-cta`), nunca substituído.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndexHtml } from "../scripts/lib/site-home-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = resolve(ROOT, "workers", "site", "public", "index.html");

const FEATURE = {
  slug: "exemplo",
  title: "Título de exemplo",
  description: "Descrição de exemplo",
  url: "https://diar.ia.br/p/exemplo",
  date: "2026-08-28",
  image: null,
};

function assertHasApoiarLink(html: string) {
  assert.match(html, /<a href="\/apoiar">Apoiar<\/a>/, "link /apoiar ausente");
  // A nav-cta (CTA primário) precisa continuar sendo "Assinar" — /apoiar é
  // sempre um link secundário, nunca o botão principal.
  const navCtaMatch = html.match(/<div class="nav-cta">[\s\S]*?<\/div>/);
  assert.ok(navCtaMatch, "bloco .nav-cta não encontrado");
  assert.doesNotMatch(navCtaMatch![0], /\/apoiar/, "/apoiar não pode estar dentro do CTA primário (.nav-cta)");
}

describe("home — link secundário /apoiar (#7915)", () => {
  it("o HTML gerado tem o link /apoiar na nav e no rodapé", () => {
    const html = buildIndexHtml({ feature: FEATURE, archive: [] });
    // 2 ocorrências: 1 na nav, 1 no rodapé.
    const matches = html.match(/<a href="\/apoiar">Apoiar<\/a>/g) ?? [];
    assert.equal(matches.length, 2, `esperava 2 ocorrências do link /apoiar (nav + rodapé), achei ${matches.length}`);
    assertHasApoiarLink(html);
  });

  it("o index.html COMMITTED tem o mesmo link /apoiar", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const matches = html.match(/<a href="\/apoiar">Apoiar<\/a>/g) ?? [];
    assert.equal(matches.length, 2, `esperava 2 ocorrências do link /apoiar (nav + rodapé) no arquivo committed, achei ${matches.length}`);
    assertHasApoiarLink(html);
  });

  it("o CTA primário da nav continua sendo o cadastro gratuito, não /apoiar", () => {
    const html = buildIndexHtml({ feature: FEATURE, archive: [] });
    const navCtaMatch = html.match(/<div class="nav-cta">[\s\S]*?<\/div>/);
    assert.ok(navCtaMatch);
    assert.match(navCtaMatch![0], /Assinar/, "CTA primário deveria continuar sendo 'Assinar'");
  });
});
