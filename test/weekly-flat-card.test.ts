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
import { buildFlatCardSvg, measureFlatCardBody, resolveOrGenerateFlatCardUrl, type FlatCardGenerator } from "../scripts/lib/weekly-flat-card.ts";
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

  it("#6086: FlatCardText com handle renderiza handle na MESMA linha do rodapé (tspan, sem <text> extra)", () => {
    const svg = buildFlatCardSvg({ kicker: "x", title: "y", footer: "diar.ia.br", handle: "@diar.ia.br" });
    assert.match(svg, /· @diar\.ia\.br/);
  });

  it("#6086: FlatCardText com microCta renderiza um <text> à direita (text-anchor=end), ancorado na linha do rodapé", () => {
    const svg = buildFlatCardSvg({ kicker: "x", title: "y", footer: "diar.ia.br", microCta: "Segue pra mais" });
    assert.match(svg, /<text x="1008" y="1288" text-anchor="end"[^>]*>Segue pra mais<\/text>/);
  });

  it("#6086: sem handle/microCta (capa/CTA do carrossel SEMANAL, layout fill) — nada extra é renderizado, default intocado", () => {
    const svg = buildFlatCardSvg({ kicker: "resumo semanal", title: "Título qualquer", footer: "diar.ia.br" });
    assert.doesNotMatch(svg, /text-anchor="end"/);
    assert.doesNotMatch(svg, /tspan[^>]*> · /);
  });

  it("#6136 item 1: compactHandle=true + handle -> rodapé é SÓ o handle ('@' em brand), nunca wordmark + handle", () => {
    const svg = buildFlatCardSvg({ kicker: "x", title: "y", footer: "diar.ia.br", handle: "@diar.ia.br", compactHandle: true });
    assert.match(svg, new RegExp(`<tspan fill="${COLORS.brand}">@</tspan>diar\\.ia\\.br`));
    assert.doesNotMatch(svg, /diar<tspan/, "wordmark completo não deveria aparecer no modo compacto");
    assert.doesNotMatch(svg, / · @diar\.ia\.br/, "sem o separador ' · ' do modo antigo — não é mais wordmark+handle");
  });

  it("#6136 item 1: compactHandle=true SEM handle -> cai pro rodapé normal (footer), nunca lança", () => {
    const svg = buildFlatCardSvg({ kicker: "x", title: "y", footer: "diar.ia.br", compactHandle: true });
    assert.match(svg, /diar<tspan/, "sem handle, o modo compacto não tem o que compactar — footer normal");
  });

  it("#6136 item 1: handle setado mas compactHandle ausente/false -> comportamento pré-#6136 preservado (wordmark + handle)", () => {
    const svg = buildFlatCardSvg({ kicker: "x", title: "y", footer: "diar.ia.br", handle: "@diar.ia.br" });
    assert.match(svg, / · @diar\.ia\.br/);
    assert.match(svg, /diar<tspan/);
  });
});

/**
 * (#6136 item 2) `title` pode carregar UMA quebra de parágrafo (`\n\n`) —
 * respiro visual de 1 linha entre os 2 blocos, dentro do MESMO card. Título
 * sem `\n\n` (todo chamador pré-#6136, inclusive todo uso do carrossel
 * SEMANAL) precisa continuar byte-a-byte igual.
 */
describe("quebra de parágrafo em title (#6136 item 2)", () => {
  const FIXED = { mode: "fixed" as const, size: 62 };

  it("título com \\n\\n quebra em 2 grupos de linha, com 1 linha de respiro entre eles", () => {
    const { lines } = measureFlatCardBody("Primeiro bloco curto.\n\nSegundo bloco curto.", FIXED);
    // 1 linha (bloco 1) + 1 respiro (vazia) + 1 linha (bloco 2) = 3
    assert.equal(lines.length, 3);
    assert.equal(lines[1], "", "linha do meio é o respiro — vazia");
    assert.equal(lines[0], "Primeiro bloco curto.");
    assert.equal(lines[2], "Segundo bloco curto.");
  });

  it("título SEM \\n\\n não muda — nenhuma linha de respiro inserida (default do semanal intocado)", () => {
    const { lines } = measureFlatCardBody("Um título qualquer sem quebra.", FIXED);
    assert.ok(!lines.includes(""), "sem \\n\\n no input, nunca deveria aparecer linha vazia");
  });

  it("blockHeight cresce em 1 lineGap por causa do respiro (consome altura, #6078)", () => {
    const semQuebra = measureFlatCardBody("Bloco A.", FIXED);
    const comQuebra = measureFlatCardBody("Bloco A.\n\nBloco B.", FIXED);
    const lineGap = Math.round(62 * 1.18);
    assert.equal(comQuebra.blockHeight, semQuebra.blockHeight + lineGap + Math.round(62 * 1.18));
  });

  it("o respiro não renderiza nenhum <text> visível com conteúdo (linha vazia no SVG)", () => {
    const svg = buildFlatCardSvg({ kicker: "x", title: "Bloco A.\n\nBloco B.", footer: "y" }, FIXED);
    assert.match(svg, /Bloco A\./);
    assert.match(svg, /Bloco B\./);
  });
});

describe("#6086 item c: negrito seletivo (`**...**` no title)", () => {
  it("trecho marcado vira <tspan font-weight=\"700\">; resto fica peso 400 sem tspan", () => {
    // fixed 62px: o trecho cabe numa linha — a asserção exata do tspan
    // exige o trecho inteiro numa linha
    const FIXED = { mode: "fixed" as const, size: 62 };
    const svg = buildFlatCardSvg({ kicker: "x", title: "A **frase em destaque** B", footer: "y" }, FIXED);
    assert.match(svg, />A <tspan font-weight="700">frase em destaque<\/tspan> B</);
    assert.doesNotMatch(svg, /\*\*/); // delimitadores nunca vazam pro SVG
  });

  it("título SEM marcação renderiza exatamente como antes — nenhum tspan de peso no corpo (default do semanal inalterado)", () => {
    const svg = buildFlatCardSvg({
      kicker: "resumo semanal",
      title: "A edição completa chega no seu e-mail. Assine no link da bio.",
      footer: "diar.ia.br",
    });
    assert.doesNotMatch(svg, /<tspan font-weight="700">/);
  });

  it("QUEBRA DE LINHA conta só o texto VISÍVEL — delimitadores `**` não entram na largura (o caso que quebra)", () => {
    // Em fixed 62px, maxCharsPerLine = floor(936 / (62 * 0.52)) = 29.
    const DAILY = { mode: "fixed" as const, size: 62 };
    const plainWord = "palavra"; // 7 chars
    const boldContent = `${plainWord} `.repeat(3).trim(); // 21 chars visíveis
    const title = `**${boldContent}**`; // 25 chars CRUS — contagem ingênua estouraria 29 com mais uma palavra
    // Visível = 21 chars + " " + 6 = cabe numa linha só se os delimitadores forem ignorados.
    // Um título equivalente SEM marcação de mesmo comprimento cru (29) também caberia;
    // o ponto é: a versão marcada NÃO pode quebrar em 2 linhas só porque tem `**`.
    const { lines } = measureFlatCardBody(title, DAILY);
    assert.equal(lines.length, 1, `esperava 1 linha (texto visível cabe), veio ${lines.length}: ${JSON.stringify(lines)}`);
    assert.equal(lines[0], boldContent);
  });

  it("wrap com marcação produz o MESMO texto visível que o equivalente sem marcação", () => {
    const DAILY = { mode: "fixed" as const, size: 62 };
    const visible = "Um parágrafo razoavelmente longo o bastante para quebrar em várias linhas no card de sessenta e dois pixels.";
    // marca a partir do começo de uma palavra (marcação no meio de palavra é
    // input malformado — a marcação delimita frases/trechos inteiros)
    const marked = `**${visible.slice(0, 13)}**${visible.slice(13)}`;
    const b = measureFlatCardBody(marked, DAILY).lines.join(" ");
    assert.equal(b.replace(/\s+/g, " ").trim(), visible);
  });

  it("trecho bold pesa MAIS na largura — bold demais quebra mais cedo que o mesmo texto regular", () => {
    const DAILY = { mode: "fixed" as const, size: 62 };
    const text = "palavra ".repeat(12).trim();
    const plainLines = measureFlatCardBody(text, DAILY).lines.length;
    const boldLines = measureFlatCardBody(`**${text}**`, DAILY).lines.length;
    assert.ok(boldLines >= plainLines, `bold deveria quebrar em >= linhas que regular (${boldLines} vs ${plainLines})`);
  });

  it("layout fill (default, semanal) continua funcionando com marcação — e sem marcação não muda nada", () => {
    // fixed 62px pra ter o trecho inteiro numa linha e asserção exata.
    const FIXED = { mode: "fixed" as const, size: 62 };
    const svg = buildFlatCardSvg({ kicker: "x", title: "Capa **com destaque** da semana", footer: "diar.ia.br" }, FIXED);
    assert.match(svg, /Capa <tspan font-weight="700">com destaque<\/tspan> da semana/);
    assert.doesNotMatch(svg, /\*\*/);
  });

  it("#6740-render-fix: **bold** colado direto em pontuação (sem espaço) não ganha espaço fantasma nem órfã em linha própria", () => {
    // Achado ao vivo (carrossel diário 260830): "**trecho**:"/"**trecho**." —
    // bold fechando direto sobre pontuação, sem espaço no texto original.
    // Antes do fix, o `:`/`.` virava uma "palavra" própria que o wrap juntava
    // de volta com um espaço extra ("trecho :"), ou até isolava em linha nova.
    const FIXED = { mode: "fixed" as const, size: 62 };
    const svgColon = buildFlatCardSvg({ kicker: "x", title: "**Isto é bold**: e o resto", footer: "y" }, FIXED);
    assert.match(svgColon, /<tspan font-weight="700">Isto é bold<\/tspan>: e o resto/);
    assert.doesNotMatch(svgColon, /bold<\/tspan> :/);

    const svgPeriod = buildFlatCardSvg({ kicker: "x", title: "Frase com **destaque no fim**.", footer: "y" }, FIXED);
    assert.match(svgPeriod, /<tspan font-weight="700">destaque no fim<\/tspan>\./);
    assert.doesNotMatch(svgPeriod, /fim<\/tspan> \./);

    // Mesmo padrão preservado no texto VISÍVEL (measureFlatCardBody) — a
    // pontuação nunca abre linha própria nem ganha espaço antes de si.
    const { lines } = measureFlatCardBody("Frase com **destaque no fim**.", FIXED);
    assert.ok(lines[lines.length - 1].endsWith("fim."), `última linha deveria terminar em "fim.", veio: ${JSON.stringify(lines)}`);
  });

  it("#6740-render-fix: **bold** com espaço normal ao redor continua funcionando (não regride o caso comum)", () => {
    const FIXED = { mode: "fixed" as const, size: 62 };
    const svg = buildFlatCardSvg({ kicker: "x", title: "A **frase em destaque** B", footer: "y" }, FIXED);
    assert.match(svg, />A <tspan font-weight="700">frase em destaque<\/tspan> B</);
  });

  it("parseInlineBold / stripInlineBold (pure helpers)", async () => {
    const mod = await import("../scripts/lib/weekly-flat-card.ts");
    assert.deepEqual(mod.parseInlineBold("sem marcação"), [{ text: "sem marcação", bold: false }]);
    assert.deepEqual(mod.parseInlineBold("a **b** c"), [
      { text: "a ", bold: false },
      { text: "b", bold: true },
      { text: " c", bold: false },
    ]);
    assert.equal(mod.stripInlineBold("a **b** c"), "a b c");
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
        { kicker: "Resumo semanal", title: "Os principais destaques de IA da semana", footer: "diar.ia.br" },
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
