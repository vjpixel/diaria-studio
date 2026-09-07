/**
 * test/annual-render.test.ts (#7569)
 *
 * O render monta o HTML que vai por e-mail para a base inteira — o último
 * lugar onde um erro ainda é barato. O que estes testes travam:
 *
 * 1. **Escaping.** Título e corpo vêm de texto escrito por agente e são
 *    interpolados dentro de atributos (`alt="..."`, `href="..."`). Aspas
 *    retas em português são comuns (`Sam Altman diz "a IA muda tudo"`) e
 *    fechariam o atributo no meio.
 * 2. **O placeholder da carta do editor nunca vaza pro e-mail** — publicar
 *    "[Placeholder — carta do editor]" para a base é o pior desfecho
 *    possível desta skill.
 * 3. **As seções finais aparecem.** "O que mudou" e "Previsões" são metade
 *    do valor editorial da anual; sumirem em silêncio é indistinguível de
 *    terem sido escritas curtas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAnnualDraft } from "../scripts/lib/anual/annual-parse.ts";
import { renderAnnualEmail, inlineMarkdown } from "../scripts/lib/anual/annual-render.ts";

const BRAND = "#00A0A0";

function draftMd(opts: { tipo?: "aniversario" | "janeiro"; tema1?: string } = {}) {
  const tipo = opts.tipo ?? "aniversario";
  return [
    "**ASSUNTO (3 OPÇÕES)**",
    "1. Um ano de IA",
    "",
    "**PREVIEW**",
    "",
    "O ano em uma linha.",
    "",
    "**INTRO**",
    "",
    "Os doze meses foram assim.",
    "",
    ...(tipo === "aniversario"
      ? ["**ANIVERSÁRIO**", "", "Saíram 256 edições diárias.", "", "**CARTA DO EDITOR**", "", "[Placeholder — carta do editor, a ser escrita antes da publicação.]", ""]
      : []),
    "**TEMA 1 | ENERGIA**",
    "",
    opts.tema1 ?? "Título do primeiro tema",
    "",
    "Parágrafo com [um fato ancorado](https://exemplo.com/a).",
    "",
    "O fio condutor:",
    "O que o tema revelou.",
    "",
    "**TEMA 2 | TRABALHO**",
    "",
    "Título do segundo tema",
    "",
    "Parágrafo do segundo tema.",
    "",
    "**TEMA 3 | REGULAÇÃO**",
    "",
    "Título do terceiro tema",
    "",
    "Parágrafo do terceiro tema.",
    "",
    "**O QUE MUDOU**",
    "",
    "No começo era uma coisa; no fim, outra.",
    "",
    "**PREVISÕES**",
    "",
    "Estas previsões saem da leitura do próprio período.",
    "",
    "**PARA ENCERRAR**",
    "",
    "Até a próxima retrospectiva.",
    "",
  ].join("\n");
}

const IMAGES = { 1: "https://img.invalid/1.jpg", 2: "https://img.invalid/2.jpg", 3: "https://img.invalid/3.jpg" };

function render(md: string, tipo: "aniversario" | "janeiro" = "aniversario") {
  return renderAnnualEmail(parseAnnualDraft(md), { windowLabel: "agosto/2025 a agosto/2026", tipo, images: IMAGES });
}

describe("escaping — o texto vem de agente e entra em atributo HTML", () => {
  it("aspas no título não quebram o alt da imagem", () => {
    const r = render(draftMd({ tema1: 'Sam Altman diz "a IA muda tudo"' }));
    assert.ok(r.html.includes("&quot;a IA muda tudo&quot;"), "as aspas precisam sair escapadas");
    assert.ok(
      !/alt="[^"]*"a IA/.test(r.html),
      "aspas cruas dentro de alt=\"...\" fecham o atributo e vazam o resto como marcação",
    );
  });

  it("< e & no texto viram entidade, não marcação", () => {
    const out = inlineMarkdown("Custo < 5% & subindo", BRAND);
    assert.equal(out, "Custo &lt; 5% &amp; subindo");
  });

  it("link markdown vira <a> com a URL preservada", () => {
    const out = inlineMarkdown("veja [o estudo](https://exemplo.com/x?a=1&b=2)", BRAND);
    assert.ok(out.includes('href="https://exemplo.com/x?a=1&amp;b=2"'));
    assert.ok(out.includes(">o estudo</a>"));
  });

  it("negrito vira <strong>", () => {
    assert.ok(inlineMarkdown("isto é **importante**", BRAND).includes("<strong>importante</strong>"));
  });

  it("aspas na URL do link não escapam do atributo href", () => {
    const out = inlineMarkdown('veja [x](https://exemplo.com/a"onload=alert(1))', BRAND);
    assert.ok(!/href="[^"]*"onload/.test(out), "URL com aspas não pode injetar atributo novo");
  });
});

describe("carta do editor", () => {
  it("placeholder nunca chega ao e-mail, e o render avisa", () => {
    const r = render(draftMd());
    assert.ok(!r.html.includes("Placeholder"));
    assert.ok(r.warnings.some((w) => w.includes("placeholder")));
  });

  it("carta escrita aparece no e-mail", () => {
    const md = draftMd().replace(
      "[Placeholder — carta do editor, a ser escrita antes da publicação.]",
      "Faz um ano que esta newsletter existe.",
    );
    const r = render(md);
    assert.ok(r.html.includes("Faz um ano que esta newsletter existe."));
    assert.ok(!r.warnings.some((w) => w.includes("placeholder")));
  });
});

describe("blocos por tipo de rodada", () => {
  it("rodada de janeiro não renderiza o bloco de aniversário, e avisa se ele veio", () => {
    const r = render(draftMd({ tipo: "aniversario" }), "janeiro");
    assert.ok(!r.html.includes("256 edições diárias"));
    assert.ok(r.warnings.some((w) => w.includes("rodada de janeiro com bloco ANIVERSÁRIO")));
  });

  it("rodada de aniversário SEM o bloco avisa em vez de sair calada", () => {
    const r = render(draftMd({ tipo: "janeiro" }), "aniversario");
    assert.ok(r.warnings.some((w) => w.includes("sem bloco ANIVERSÁRIO")));
  });
});

describe("seções do corpo", () => {
  const r = render(draftMd());

  it("intro, temas, o que mudou, previsões e encerramento estão no HTML", () => {
    for (const trecho of [
      "Os doze meses foram assim.",
      "Título do primeiro tema",
      "Título do terceiro tema",
      "No começo era uma coisa; no fim, outra.",
      "Estas previsões saem da leitura do próprio período.",
      "Até a próxima retrospectiva.",
    ]) {
      assert.ok(r.html.includes(trecho), `sumiu do e-mail: ${trecho}`);
    }
  });

  it("o rótulo da janela aparece — é o que diz o período coberto", () => {
    assert.ok(r.html.includes("agosto/2025 a agosto/2026"));
  });

  it("o fio condutor de um tema aparece", () => {
    assert.ok(r.html.includes("O que o tema revelou."));
  });

  it("uma imagem por tema, na ordem", () => {
    assert.equal(r.imageCount, 3);
    assert.deepEqual(r.missingImages, []);
    assert.ok(r.html.indexOf(IMAGES[1]) < r.html.indexOf(IMAGES[2]));
  });

  it("o HTML é um documento completo com fundo explícito", () => {
    assert.ok(r.html.startsWith("<!DOCTYPE html>"));
    assert.ok(r.html.includes("<table"));
    assert.ok(/background:#FFFFFF/i.test(r.html), "e-mail sem fundo explícito vira cinza em dark mode");
  });
});
