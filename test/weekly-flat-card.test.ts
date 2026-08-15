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
import { COLORS } from "../scripts/lib/shared/design-tokens.ts";

/** Extrai o 1º `font-size="N"` de um SVG cujo fill é a cor de título (ink) — helper de teste. */
function firstTitleFontSize(svg: string): number {
  const re = new RegExp(`font-size="(\\d+)"[^>]*fill="${COLORS.ink}">`);
  const m = svg.match(re);
  if (!m) throw new Error(`nenhum font-size de título encontrado no SVG: ${svg.slice(0, 300)}`);
  return Number(m[1]);
}

describe("buildFlatCardSvg (pure)", () => {
  it("#5330 (2ª rodada, review do editor 260815): fundo é a paleta CLARA canônica da marca (paper/ink/brand), não o overlay escuro dos cards de notícia", () => {
    const svg = buildFlatCardSvg({ kicker: "resumo semanal", title: "Título qualquer", footer: "diar.ia.br" });
    assert.match(svg, new RegExp(`fill="${COLORS.paper}"`), "fundo deveria ser COLORS.paper (claro)");
    assert.match(svg, new RegExp(`fill="${COLORS.ink}"`), "título/rodapé deveriam ser COLORS.ink (escuro sobre claro)");
    assert.doesNotMatch(svg, /fill="#FFFFFF"/, "não deveria ter texto branco (herança do overlay escuro antigo)");
    assert.doesNotMatch(svg, /linearGradient/, "não deveria ter gradiente escuro (herança do overlay antigo)");
  });

  it("#5330 (2ª rodada): título GRANDE, preenche o espaço disponível — nunca o tamanho pequeno do overlay de notícia (clamp 44-88)", () => {
    // Título curto o suficiente pra caber em poucas linhas mesmo bem grande —
    // o auto-size deveria escolher um tamanho bem acima do clamp do overlay
    // de notícia (que nunca passa de 88), porque agora o objetivo é "ocupar
    // o card todo, assim não sente falta de não ter imagem" (pedido do editor).
    const svg = buildFlatCardSvg({ kicker: "resumo semanal", title: "Os destaques da semana", footer: "diar.ia.br" });
    const size = firstTitleFontSize(svg);
    assert.ok(size > 88, `esperava título bem maior que o clamp do overlay de notícia (88), veio ${size}`);
  });

  it("título mais longo resulta em tamanho MENOR (auto-size decrescente pra continuar cabendo)", () => {
    const shortSvg = buildFlatCardSvg({ kicker: "x", title: "Título curto", footer: "y" });
    const longSvg = buildFlatCardSvg({
      kicker: "x",
      title: "A edição completa chega no seu e-mail. Assine no link da bio.",
      footer: "y",
    });
    assert.ok(firstTitleFontSize(longSvg) < firstTitleFontSize(shortSvg));
  });

  it("nunca abaixo do tamanho mínimo mesmo com título extremamente longo", () => {
    const veryLong = "Palavra ".repeat(60).trim();
    const svg = buildFlatCardSvg({ kicker: "x", title: veryLong, footer: "y" });
    assert.ok(firstTitleFontSize(svg) >= 46);
  });

  it("inclui kicker (uppercase), título (possivelmente quebrado em linhas) e rodapé no SVG gerado", () => {
    const svg = buildFlatCardSvg({ kicker: "resumo semanal", title: "As notícias da semana", footer: "diar.ia.br" });
    assert.match(svg, /RESUMO SEMANAL/);
    assert.match(svg, /As notícias/);
    assert.match(svg, /da semana/);
    assert.match(svg, /diar<tspan/); // wordmark colorido, ver testes dedicados de footerMarkup
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

  it("#5330 (achado ao vivo): rodapé terminando em 'diar.ia.br' usa o wordmark com pontos+br em COLORS.brand (teal) — igual aos cards de notícia", () => {
    const svg = buildFlatCardSvg({ kicker: "x", title: "y", footer: "diar.ia.br" });
    assert.match(svg, new RegExp(`diar<tspan fill="${COLORS.brand}">\\.</tspan>ia<tspan fill="${COLORS.brand}">\\.</tspan><tspan fill="${COLORS.brand}">br</tspan>`));
  });

  it("rodapé com prefixo antes do wordmark ('10–14 ago · diar.ia.br') preserva o prefixo em texto plano + wordmark colorido", () => {
    const svg = buildFlatCardSvg({ kicker: "x", title: "y", footer: "10–14 ago · diar.ia.br" });
    assert.match(svg, /10–14 ago · diar<tspan/);
  });

  it("rodapé que NÃO termina em 'diar.ia.br' (ex: 'Link na bio') sai em texto plano, sem tspan", () => {
    const svg = buildFlatCardSvg({ kicker: "x", title: "y", footer: "Link na bio" });
    const footerLine = svg.split("\n").find((l) => l.includes("Link na bio"));
    assert.ok(footerLine);
    assert.doesNotMatch(footerLine ?? "", /tspan/);
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
      // #5386: kvKey precisa casar com a allowlist `img-` do Worker (nunca
      // mais `weekly/{key}/{slot}-4x5.jpg` — ver `poll-img-key-allowlist-weekly-5386.test.ts`).
      assert.equal(url, "https://cdn.example.com/img-unknown-weekly-260815-highlights-cover-4x5.jpg");
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
