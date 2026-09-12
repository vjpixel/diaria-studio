/**
 * test/annual-draft-lint.test.ts (#7569)
 *
 * O lint da anual existe para pegar, ANTES do envio, as três formas de a
 * edição sair quebrada:
 *
 *   1. label sem negrito → o render não separa as seções e o e-mail sai como
 *      um bloco só de prosa, sem imagem (mesma causa raiz do #2794 no mensal);
 *   2. N de temas fora de 3–7, ou numeração fora de sequência;
 *   3. o bloco de aniversário no tipo errado de rodada.
 *
 * E a diferença que mais convida a bug: **o número de temas é variável**.
 * Qualquer coisa aqui que assuma 3 está errada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintAnnualDraft, LIMITS, MIN_THEMES, MAX_THEMES } from "../scripts/lint-annual-draft.ts";
import { parseAnnualDraft, themeCharCount } from "../scripts/lib/anual/annual-parse.ts";
import { renderAnnualEmail } from "../scripts/lib/anual/annual-render.ts";

function theme(n: number, name = "TEMA") {
  return [
    `**TEMA ${n} | ${name}**`,
    "",
    `Título narrativo do tema ${n}`,
    "",
    `Primeiro parágrafo do tema ${n}, com um [fato ancorado](https://exemplo.com/${n}).`,
    "",
    `Segundo parágrafo do tema ${n}, com a linha do tempo do ano.`,
    "",
    "O fio condutor:",
    `O que o tema ${n} revelou sobre o período.`,
    "",
  ].join("\n");
}

function draft(opts: { themes?: number; tipo?: "aniversario" | "janeiro"; extra?: string } = {}) {
  const n = opts.themes ?? 3;
  const tipo = opts.tipo ?? "aniversario";
  return [
    "**ASSUNTO (3 OPÇÕES)**",
    "1. Um ano de IA em cinco atos",
    "2. O ano em que a IA virou infraestrutura",
    "3. Doze meses, cinco viradas",
    "",
    "**PREVIEW**",
    "",
    "O que mudou entre agosto de 2025 e agosto de 2026.",
    "",
    "**INTRO**",
    "",
    "Os doze meses entre agosto de 2025 e agosto de 2026 foram assim.",
    "",
    ...(tipo === "aniversario"
      ? [
          "**ANIVERSÁRIO**",
          "",
          "Saíram 256 edições diárias, 5 digests mensais e 1 artigo especial.",
          "",
        ]
      : []),
    ...Array.from({ length: n }, (_, i) => theme(i + 1)),
    "**O QUE MUDOU**",
    "",
    "No começo da janela o assunto era um; no fim, outro.",
    "",
    "**PREVISÕES**",
    "",
    "Estas previsões saem da leitura do próprio período.",
    "",
    "**PARA ENCERRAR**",
    "",
    "Até a próxima retrospectiva.",
    "",
    opts.extra ?? "",
  ].join("\n");
}

describe("N de temas é variável", () => {
  it("aceita qualquer N entre 3 e 7", () => {
    for (let n = MIN_THEMES; n <= MAX_THEMES; n++) {
      const r = lintAnnualDraft(draft({ themes: n }), "aniversario");
      assert.equal(r.ok, true, `N=${n} devia passar: ${r.errors.join("; ")}`);
      assert.equal(r.themes, n);
    }
  });

  it("reprova abaixo do piso e acima do teto", () => {
    assert.equal(lintAnnualDraft(draft({ themes: 2 }), "aniversario").ok, false);
    assert.equal(lintAnnualDraft(draft({ themes: 8 }), "aniversario").ok, false);
  });

  it("o render emite uma imagem por tema, seja qual for o N", () => {
    for (const n of [3, 5, 7]) {
      const parsed = parseAnnualDraft(draft({ themes: n }));
      const images = Object.fromEntries(parsed.themes.map((t) => [t.index, `https://x.invalid/${t.index}.jpg`]));
      const r = renderAnnualEmail(parsed, { windowLabel: "x", tipo: "aniversario", images });
      assert.equal(r.imageCount, n, `N=${n}`);
      assert.deepEqual(r.missingImages, []);
    }
  });

  it("numeração fora de sequência reprova", () => {
    const md = draft({ themes: 3 }).replace("**TEMA 2 | TEMA**", "**TEMA 4 | TEMA**");
    const r = lintAnnualDraft(md, "aniversario");
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("fora de sequência")));
  });
});

describe("guardrail de render", () => {
  it("label sem negrito reprova antes de a edição sair", () => {
    const md = draft().replace("**O QUE MUDOU**", "O QUE MUDOU");
    const r = lintAnnualDraft(md, "aniversario");
    // Sem o negrito, o texto da seção é absorvido pelo tema anterior — o que
    // o lint vê é a seção desaparecida, não um label desconhecido.
    assert.ok(
      r.warnings.some((w) => w.includes("O QUE MUDOU")) || r.errors.length > 0,
      "a seção perdida precisa aparecer em algum lugar do relatório",
    );
  });

  it("label desconhecido reprova", () => {
    const r = lintAnnualDraft(draft({ extra: "**SEÇÃO INVENTADA**\n\nTexto.\n" }), "aniversario");
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("label não reconhecido")));
  });

  it("tema sem imagem seria pego pela sonda", () => {
    const parsed = parseAnnualDraft(draft({ themes: 4 }));
    const r = renderAnnualEmail(parsed, {
      windowLabel: "x",
      tipo: "aniversario",
      images: { 1: "https://x.invalid/1.jpg", 2: "https://x.invalid/2.jpg" },
    });
    assert.deepEqual(r.missingImages, [3, 4]);
    assert.equal(r.imageCount, 2);
  });
});

describe("seções que a anual não tem", () => {
  for (const label of ["USE MELHOR", "RADAR", "É IA?"]) {
    it(`"${label}" reprova`, () => {
      const r = lintAnnualDraft(draft({ extra: `**${label}**\n\nAlgum conteúdo.\n` }), "aniversario");
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.includes(label)));
    });
  }
});

describe("bloco de aniversário por tipo de rodada", () => {
  it("falta na rodada de aniversário reprova", () => {
    const r = lintAnnualDraft(draft({ tipo: "janeiro" }), "aniversario");
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("sem bloco ANIVERSÁRIO")));
  });

  it("sobra na rodada de janeiro reprova", () => {
    const r = lintAnnualDraft(draft({ tipo: "aniversario" }), "janeiro");
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("não leva bloco ANIVERSÁRIO")));
  });

  it("rodada de janeiro sem o bloco passa", () => {
    assert.equal(lintAnnualDraft(draft({ tipo: "janeiro" }), "janeiro").ok, true);
  });
});

describe("carta do editor removida do pipeline (#7587 item 1)", () => {
  it("um draft sem CARTA DO EDITOR passa limpo — não é mais exigida nem sinalizada", () => {
    const r = lintAnnualDraft(draft(), "aniversario");
    assert.equal(r.ok, true);
    assert.equal((r as unknown as Record<string, unknown>).editor_letter_pending, undefined);
  });

  it("se o label ainda aparecer no draft (resíduo de edição antiga), vira erro de label não reconhecido", () => {
    const md = draft().replace(
      "Saíram 256 edições diárias, 5 digests mensais e 1 artigo especial.",
      "Saíram 256 edições diárias, 5 digests mensais e 1 artigo especial.\n\n**CARTA DO EDITOR**\n\nTexto.",
    );
    const r = lintAnnualDraft(md, "aniversario");
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("label não reconhecido")));
  });
});

describe("contagem de caracteres", () => {
  it("desconta a URL dos links ancorados, conta a âncora", () => {
    const t = parseAnnualDraft(
      "**TEMA 1 | X**\n\nTítulo\n\nabc [ancora](https://exemplo.com/um/caminho/bem/longo).\n",
    ).themes[0];
    // "Título" (6) + "\n" + "abc ancora." (11) + "\n" (do fio vazio) = 19.
    // O ponto do teste é a URL não contar: com ela seriam 19 + 37.
    assert.equal(themeCharCount(t), 19);
    assert.ok(
      t.paragraphs.join("").includes("exemplo.com"),
      "a URL segue no texto do parágrafo — o que a contagem faz é não contá-la, não removê-la",
    );
  });

  it("tema acima do teto é aviso, não erro", () => {
    const gordo = draft().replace(
      "Segundo parágrafo do tema 1, com a linha do tempo do ano.",
      "x".repeat(2500),
    );
    const r = lintAnnualDraft(gordo, "aniversario");
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.includes("TEMA 1") && w.includes("teto")));
  });

  it("teto do tema é 1.500, o mesmo do D1 da mensal — 1.600 já acusa", () => {
    // Com o teto antigo (2.000), um tema de ~1.600 passava calado: foi o caso
    // de 3 dos 6 temas da 1ª edição (1.793 / 1.545 / 1.511).
    assert.equal(LIMITS.theme, 1500);
    const medio = draft().replace(
      "Segundo parágrafo do tema 1, com a linha do tempo do ano.",
      "x".repeat(1600),
    );
    const r = lintAnnualDraft(medio, "aniversario");
    assert.ok(r.warnings.some((w) => w.includes("TEMA 1") && w.includes("teto")), r.warnings.join("; "));
  });

  it("O QUE MUDOU e PREVISÕES também descontam a URL do relink (#7587 item 3)", () => {
    // Só a URL cresce (relink coloca uma URL longa cheia de UTM) — sem o
    // desconto, o mesmo texto passaria a acusar teto estourado só por causa
    // do comprimento do link, não do que o leitor lê.
    const urlLonga = "https://diar.ia.br/p/edicao-de-origem?utm_source=diaria&utm_medium=email&utm_campaign=anual-2026-aniversario&utm_term=algum-fato-ancorado-bem-especifico";
    const comLink = draft().replace(
      "No começo da janela o assunto era um; no fim, outro.",
      `No começo da janela o [assunto](${urlLonga}) era um; no fim, outro.`,
    );
    const r = lintAnnualDraft(comLink, "aniversario");
    assert.ok(
      !r.warnings.some((w) => w.startsWith("O QUE MUDOU")),
      `não devia acusar teto só pela URL: ${r.warnings.join("; ")}`,
    );
  });
});
