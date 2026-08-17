/**
 * test/studio-css-badge-border.test.ts (#5484)
 *
 * Trava a invariante visual dos badges de Classificação da Triagem: **borda e
 * texto na mesma cor**.
 *
 * **Por que existe.** Os 4 valores de `execTrack` viraram badges com o mesmo
 * desenho, mas só 3 casavam borda e texto (`border-color: var(--status-ok);
 * color: var(--status-ok)` e irmãos). O 4º — `.dispatch-fora-de-rodada` —
 * ficou herdando `border: 1px solid var(--rule)` do `.dispatch-badge` base,
 * uma cor de linha divisória com 1,21:1 de contraste contra o papel: o
 * contorno sumia, e o badge deixava de parecer um badge.
 *
 * O editor notou de fora ("a linha em torno de Fora de rodada deveria ser da
 * mesma cor do texto") — pela SEGUNDA vez seguida reportando um defeito
 * visual deste mesmo bloco de CSS que nenhum teste enxergava (o anterior foi
 * o texto ilegível do #5482). Um par que só existe por convenção, repetido à
 * mão em cada variante nova, quebra na variante seguinte: é dívida, não
 * estilo.
 *
 * **O que cobre.** Só a relação borda↔texto DENTRO de cada regra
 * `.dispatch-*`. Não valida qual cor é (isso é decisão de design), nem
 * contraste (não dá pra calcular sem resolver token + opacidade + fundo —
 * ver o número medido à mão no comentário do próprio CSS).
 *
 * @see scripts/studio-ui/public/triagem.css
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripCssComments } from "./helpers/css.ts";

const CSS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "studio-ui",
  "public",
  "triagem.css",
);

/** Variantes de badge de Classificação, ignorando a regra base
 * `.dispatch-badge` (que define forma, não cor). */
const VARIANT_RULE = /^\s*\.(dispatch-(?!badge\b)[a-z-]+)\s*\{([^}]*)\}/gm;

function declaracao(corpo: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(corpo);
  return m ? m[1].trim() : null;
}

describe("badges de Classificação — borda casa com o texto (#5484)", () => {
  const css = stripCssComments(readFileSync(CSS_PATH, "utf8"));
  const variantes = [...css.matchAll(VARIANT_RULE)].map((m) => ({
    classe: m[1],
    corpo: m[2],
  }));

  it("encontra as variantes (guarda contra o teste virar no-op)", () => {
    // Se um refactor renomear o prefixo, o teste não pode passar em silêncio
    // por não ter achado nada pra checar.
    assert.ok(variantes.length >= 4, `esperava ≥4 variantes .dispatch-*, achei ${variantes.length}`);
  });

  for (const { classe, corpo } of [...css.matchAll(VARIANT_RULE)].map((m) => ({ classe: m[1], corpo: m[2] }))) {
    it(`.${classe}: borda e texto na mesma cor`, () => {
      const cor = declaracao(corpo, "color");
      const borda = declaracao(corpo, "border-color");

      assert.ok(
        borda,
        `.${classe} não declara border-color — herdaria a borda neutra do .dispatch-badge base, ` +
          `que é cor de linha divisória e some contra o papel. Declare border-color explicitamente ` +
          `(use currentColor quando a cor do texto vier por herança/opacidade).`,
      );

      // `currentColor` É "a mesma cor do texto", por definição — vale tanto
      // quando a variante declara `color` quanto quando ela herda.
      if (borda === "currentColor") return;

      assert.equal(
        borda,
        cor,
        `.${classe}: border-color (${borda}) diverge de color (${cor}). ` +
          `Use o mesmo valor nos dois, ou currentColor.`,
      );
    });
  }
});
