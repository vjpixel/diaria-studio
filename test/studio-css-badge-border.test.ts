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

/** Qualquer regra CSS: lista de seletores + corpo. O filtro por
 * `.dispatch-*` acontece DEPOIS, por seletor individual — capturar a regra
 * inteira primeiro é o que faz `.dispatch-x, .dispatch-y { … }` ser visto.
 * A versão anterior exigia `.dispatch-` colado no início da regra, então uma
 * variante declarada em seletor combinado era ignorada em SILÊNCIO: não
 * gerava `it()`, e o piso de contagem não acusava porque as 4 atuais já o
 * satisfaziam (achado no review do PR #5486).
 *
 * Sem âncora de início de propósito: uma versão com `(^|\})` na frente
 * CONSUMIA o `}` de cada regra como âncora da seguinte, casando uma regra sim
 * / uma não — achou 2 das 4 variantes, e foi o piso de contagem abaixo que
 * acusou. Seletor não pode conter `{`/`}`, então `[^{}]+` já começa
 * naturalmente logo após o `}` anterior. */
const ANY_RULE = /([^{}]+)\{([^}]*)\}/g;

/** `.dispatch-algo`, exceto a regra base `.dispatch-badge` (que define forma,
 * não cor). */
const VARIANT_SELECTOR = /^\.(dispatch-(?!badge$)[a-z-]+)$/;

/** Estilos de borda válidos em `border: …` shorthand — descartados na busca
 * pela COR dentro do shorthand. */
const BORDER_STYLES = new Set([
  "none", "hidden", "dotted", "dashed", "solid", "double",
  "groove", "ridge", "inset", "outset",
]);

function declaracao(corpo: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(corpo);
  return m ? m[1].trim() : null;
}

/**
 * Cor da borda, aceitando tanto `border-color:` quanto o shorthand `border:`.
 *
 * O shorthand importa: é a forma PREDOMINANTE no resto deste arquivo
 * (`.label-chip`, `.draft-tag`, o próprio `.dispatch-badge` base). Sem
 * reconhecê-lo, uma variante futura escrita com `border: 1px solid X` falhava
 * com a mensagem "não declara border-color" — factualmente errada, já que a
 * borda ESTÁ definida (achado no review do PR #5486).
 *
 * Dentro do shorthand, a cor é o token que não é largura (tem dígito) nem
 * palavra-chave de estilo. `var(--x)`/`currentColor` caem naturalmente aí.
 */
function corDaBorda(corpo: string): string | null {
  const direta = declaracao(corpo, "border-color");
  if (direta) return direta;

  const short = declaracao(corpo, "border");
  if (!short) return null;
  const token = short
    .split(/\s+(?![^(]*\))/) // não quebra dentro de `var( … )`
    .find((t) => t && !/\d/.test(t) && !BORDER_STYLES.has(t.toLowerCase()));
  return token ?? null;
}

/** `currentColor` é case-insensitive em CSS — comparar como string exata
 * reprovaria `currentcolor`, que é válido e visualmente idêntico. */
function ehCurrentColor(valor: string | null): boolean {
  return valor?.toLowerCase() === "currentcolor";
}

/** Todas as variantes `.dispatch-*` do arquivo, incluindo as declaradas em
 * seletor combinado (cada uma vira uma entrada própria). */
function variantesDe(css: string): Array<{ classe: string; corpo: string }> {
  const out: Array<{ classe: string; corpo: string }> = [];
  for (const m of css.matchAll(ANY_RULE)) {
    const seletores = m[1].split(",").map((sel) => sel.trim());
    for (const sel of seletores) {
      const hit = VARIANT_SELECTOR.exec(sel);
      if (hit) out.push({ classe: hit[1], corpo: m[2] });
    }
  }
  return out;
}

describe("badges de Classificação — borda casa com o texto (#5484)", () => {
  const css = stripCssComments(readFileSync(CSS_PATH, "utf8"));
  const variantes = variantesDe(css);

  it("encontra as variantes (guarda contra o teste virar no-op)", () => {
    // Se um refactor renomear o prefixo, o teste não pode passar em silêncio
    // por não ter achado nada pra checar.
    assert.ok(variantes.length >= 4, `esperava ≥4 variantes .dispatch-*, achei ${variantes.length}`);
  });

  for (const { classe, corpo } of variantes) {
    it(`.${classe}: borda e texto na mesma cor`, () => {
      const cor = declaracao(corpo, "color");
      const borda = corDaBorda(corpo);

      assert.ok(
        borda,
        `.${classe} não declara border-color — herdaria a borda neutra do .dispatch-badge base, ` +
          `que é cor de linha divisória e some contra o papel. Declare border-color explicitamente ` +
          `(use currentColor quando a cor do texto vier por herança/opacidade).`,
      );

      // `currentColor` É "a mesma cor do texto", por definição — vale tanto
      // quando a variante declara `color` quanto quando ela herda.
      if (ehCurrentColor(borda)) return;

      assert.equal(
        borda,
        cor,
        `.${classe}: border-color (${borda}) diverge de color (${cor}). ` +
          `Use o mesmo valor nos dois, ou currentColor.`,
      );
    });
  }
});
