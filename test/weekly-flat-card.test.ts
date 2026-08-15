/**
 * weekly-flat-card.test.ts (#5330)
 *
 * Cobre os slides SEM foto (capa + CTA) do carrossel semanal do Instagram:
 *   - buildFlatCardSvg: pure, título/kicker/rodapé aparecem no SVG.
 *   - resolveOrGenerateFlatCardUrl: cache hit nunca chama o generator; cache
 *     miss chama 1x, grava, e uma 2ª chamada (mesma key+slot) vira cache hit.
 *
 * `generator` é sempre um fake injetado — nunca o `defaultFlatCardGenerator`
 * real (checa fonte de marca + sharp + upload pro KV Cloudflare, mesma
 * classe de restrição de `defaultSectionCardGenerator`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildFlatCardSvg, resolveOrGenerateFlatCardUrl, type FlatCardGenerator } from "../scripts/lib/weekly-flat-card.ts";
import { buildOverlaySvg } from "../scripts/gen-social-card-4x5.ts";

/** Extrai o 1º `font-size="N"` de um SVG (a linha de título) — helper de teste. */
function firstTitleFontSize(svg: string): number {
  const m = svg.match(/font-size="(\d+)"[^>]*fill="#FFFFFF">/);
  if (!m) throw new Error(`nenhum font-size de título encontrado no SVG: ${svg.slice(0, 200)}`);
  return Number(m[1]);
}

describe("buildFlatCardSvg (pure)", () => {
  it("#5330 fleet review (regressão): título do card sem foto usa a MESMA fórmula de tamanho de buildOverlaySvg — nunca desproporcional ao card de notícia", () => {
    // Mesmo texto, mesmo `available` (W-PAD*2 é idêntico nos dois builders) —
    // o font-size resultante tem que bater, senão os 2 tipos de slide do
    // mesmo carrossel voltam a ficar visualmente desproporcionais (achado
    // ao vivo que motivou este PR).
    const title = "Os principais destaques da semana";
    const flatSvg = buildFlatCardSvg({ kicker: "resumo semanal", title, footer: "diar.ia.br" });
    const overlaySvg = buildOverlaySvg(title, "");
    assert.equal(firstTitleFontSize(flatSvg), firstTitleFontSize(overlaySvg));
  });

  it("inclui kicker (uppercase), título e rodapé no SVG gerado", () => {
    const svg = buildFlatCardSvg({ kicker: "resumo semanal", title: "As notícias da semana", footer: "diar.ia.br" });
    assert.match(svg, /RESUMO SEMANAL/);
    assert.match(svg, /As notícias da semana/);
    assert.match(svg, /diar\.ia\.br/);
    assert.match(svg, /<svg /);
  });

  it("título longo quebra em mais de 1 linha (múltiplos <text> de título)", () => {
    const svg = buildFlatCardSvg({
      kicker: "grátis, toda manhã",
      title: "A edição completa chega no seu e-mail. Assine no link da bio.",
      footer: "diar.ia.br",
    });
    const textTags = svg.match(/<text /g) ?? [];
    // kicker (1) + rodapé (1) + pelo menos 2 linhas de título = 4+.
    assert.ok(textTags.length >= 4, `esperava várias linhas de título, veio ${textTags.length} <text> tags`);
  });

  it("escapa caracteres especiais (&, <, >) no texto — nunca quebra o SVG", () => {
    const svg = buildFlatCardSvg({ kicker: "a & b", title: "Título <perigoso> & \"aspas\"", footer: "x" });
    assert.doesNotMatch(svg, /<perigoso>/);
    assert.match(svg, /&amp;/);
    assert.match(svg, /&lt;perigoso&gt;/);
  });
});

describe("resolveOrGenerateFlatCardUrl (cache + geração sob demanda)", () => {
  it("cache MISS: chama o generator 1x, grava a URL em 06-flat-cards.json, retorna a URL", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-flatcard-"));
    try {
      let calls = 0;
      const generator: FlatCardGenerator = async ({ kvKey }) => {
        calls++;
        return { url: `https://cdn.example.com/${kvKey}` };
      };
      const url = await resolveOrGenerateFlatCardUrl(
        dataRoot,
        "260815-highlights",
        "cover",
        { kicker: "Resumo semanal", title: "Os principais destaques da semana", footer: "diar.ia.br" },
        generator,
      );
      assert.equal(calls, 1);
      assert.equal(url, "https://cdn.example.com/weekly/260815-highlights/cover-4x5.jpg");
      const cachePath = join(dataRoot, "weekly", "260815-highlights", "_internal", "06-flat-cards.json");
      assert.ok(existsSync(cachePath));
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      assert.equal(cached.cover.url, url);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("cache HIT (2ª chamada, mesma key+slot): NUNCA chama o generator de novo", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-flatcard-"));
    try {
      let calls = 0;
      const generator: FlatCardGenerator = async ({ kvKey }) => {
        calls++;
        return { url: `https://cdn.example.com/${kvKey}` };
      };
      const text = { kicker: "Grátis, toda manhã", title: "Assine no link da bio", footer: "diar.ia.br" };
      const url1 = await resolveOrGenerateFlatCardUrl(dataRoot, "260815-clicked", "cta", text, generator);
      const url2 = await resolveOrGenerateFlatCardUrl(dataRoot, "260815-clicked", "cta", text, generator);
      assert.equal(calls, 1, "2ª chamada deveria ser cache hit — generator só roda 1x");
      assert.equal(url1, url2);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("cover e cta do MESMO carrossel nunca colidem (chaves de cache distintas)", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-flatcard-"));
    try {
      const generator: FlatCardGenerator = async ({ kvKey }) => ({ url: `https://cdn.example.com/${kvKey}` });
      const coverUrl = await resolveOrGenerateFlatCardUrl(
        dataRoot,
        "260815-highlights",
        "cover",
        { kicker: "a", title: "b", footer: "c" },
        generator,
      );
      const ctaUrl = await resolveOrGenerateFlatCardUrl(dataRoot, "260815-highlights", "cta", { kicker: "d", title: "e", footer: "f" }, generator);
      assert.notEqual(coverUrl, ctaUrl);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("highlights e clicked do MESMO sábado nunca colidem (key inclui o modo)", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-flatcard-"));
    try {
      const generator: FlatCardGenerator = async ({ kvKey }) => ({ url: `https://cdn.example.com/${kvKey}` });
      const urlHighlights = await resolveOrGenerateFlatCardUrl(
        dataRoot,
        "260815-highlights",
        "cover",
        { kicker: "a", title: "b", footer: "c" },
        generator,
      );
      const urlClicked = await resolveOrGenerateFlatCardUrl(dataRoot, "260815-clicked", "cover", { kicker: "a", title: "b", footer: "c" }, generator);
      assert.notEqual(urlHighlights, urlClicked);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
