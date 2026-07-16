/**
 * test/poll-ds-tokens.test.ts (#3111)
 *
 * `workers/poll/src/index.ts` e `leaderboard-routes.ts` duplicavam os valores
 * de cor/fonte do design system inline (comentários citando "#1936 DS
 * canônico"), em vez de importar de `scripts/lib/shared/design-tokens.ts`
 * como `scripts/build-cursos-page.ts` (Cursos/Livros) já fazia. Este teste é
 * a trava contra divergência futura pedida na issue:
 *
 *   1. `workers/poll/src/ds-tokens.generated.ts` está em sync com o que
 *      `generate-worker-tokens.ts` produziria a partir da fonte canônica
 *      (mesmo padrão de `test/brevo-dashboard-ds-drift.test.ts` #2125).
 *   2. DS_COLORS/DS_FONTS do generated espelham COLORS/FONTS canônicos.
 *   3. Scan estático: NENHUM literal de cor hex (#RRGGBB) sobrevive no código
 *      fonte de index.ts/leaderboard-routes.ts — força uso de DS_COLORS em
 *      qualquer adição futura (falha imediatamente se alguém hardcodear de
 *      novo, independente do valor).
 *   4. O webfont Geist via Google Fonts foi removido do worker `poll`
 *      (decisão #3111: menor blast radius — alinha com Cursos/Livros, que já
 *      não carregavam o arquivo e caem pra system sans).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COLORS, FONTS } from "../scripts/lib/shared/design-tokens.ts";
import { DS_COLORS, DS_FONTS } from "../workers/poll/src/ds-tokens.generated.ts";
import { generateTokensContent } from "../scripts/generate-worker-tokens.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLL_SRC = resolve(__dirname, "../workers/poll/src");

describe("workers/poll/src/ds-tokens.generated.ts — paridade com design-tokens.ts (#3111)", () => {
  test("DS_COLORS.brand espelha COLORS.brand (teal)", () => {
    assert.equal(DS_COLORS.brand, COLORS.brand);
  });

  test("DS_COLORS.ink espelha COLORS.ink", () => {
    assert.equal(DS_COLORS.ink, COLORS.ink);
  });

  test("DS_COLORS.paper espelha COLORS.paper", () => {
    assert.equal(DS_COLORS.paper, COLORS.paper);
  });

  test("DS_COLORS.paperAlt/rule espelham COLORS.paperAlt/rule (bege)", () => {
    assert.equal(DS_COLORS.paperAlt, COLORS.paperAlt);
    assert.equal(DS_COLORS.rule, COLORS.rule);
  });

  test("DS_FONTS.serif espelha FONTS.serif (Georgia)", () => {
    assert.equal(DS_FONTS.serif, FONTS.serif);
  });

  test("DS_FONTS.sans espelha FONTS.sans (Geist → system sans)", () => {
    assert.equal(DS_FONTS.sans, FONTS.sans);
  });
});

describe("workers/poll/src/ds-tokens.generated.ts: sync gerado×fonte (#3111, mesmo padrão #2125)", () => {
  test("arquivo commitado está em sync com generate-worker-tokens.ts", () => {
    const expectedContent = generateTokensContent(COLORS, FONTS);
    const generatedPath = resolve(POLL_SRC, "ds-tokens.generated.ts");
    const actualContent = readFileSync(generatedPath, "utf8");
    assert.equal(
      actualContent,
      expectedContent,
      "workers/poll/src/ds-tokens.generated.ts diverge do que generate-worker-tokens.ts produziria. " +
      "Rode: npx tsx scripts/generate-worker-tokens.ts --out-dir workers/poll/src",
    );
  });
});

describe("workers/poll/src — nenhum literal de cor hex hardcoded (#3111, trava contra divergência)", () => {
  const HEX_COLOR = /#[0-9A-Fa-f]{6}\b/g;

  // #3113: lib.ts entrou nesta lista quando ganhou seu primeiro uso de
  // DS_COLORS (renderBrandShellStyles/renderBrandFooter) — antes disso o
  // arquivo não tinha cor nenhuma pra travar. Sem incluí-lo aqui, um hex
  // hardcoded futuro em lib.ts passaria batido por este guard.
  // #3516: jogar.ts entrou na mesma lista — página nova com seu próprio
  // <style> inline (padrão do worker: cada página inline o próprio CSS,
  // tokens vêm de DS_COLORS/DS_FONTS, nunca literal).
  // #3517: share.ts entrou na mesma lista — renderShareCardSvg/
  // renderSharePageHtml também estilizam com DS_COLORS/DS_FONTS.
  // #3521: embed.ts entrou na mesma lista — renderEmbedPageHtml (widget
  // embutível) também estiliza com DS_COLORS/DS_FONTS, mesma trava contra
  // divergência futura desde o 1º uso.
  for (const file of ["index.ts", "leaderboard-routes.ts", "lib.ts", "jogar.ts", "share.ts", "embed.ts"]) {
    test(`${file} não contém literais #RRGGBB — cores devem vir de DS_COLORS (ds-tokens.generated.ts)`, () => {
      const src = readFileSync(resolve(POLL_SRC, file), "utf8");
      const matches = src.match(HEX_COLOR) ?? [];
      assert.deepEqual(
        matches,
        [],
        `${file} contém cor(es) hex hardcoded: ${matches.join(", ")} — ` +
        "importe de DS_COLORS (./ds-tokens.generated) em vez de duplicar o valor.",
      );
    });

    test(`${file} importa DS_COLORS e DS_FONTS de ./ds-tokens.generated`, () => {
      const src = readFileSync(resolve(POLL_SRC, file), "utf8");
      assert.match(
        src,
        /from\s+["']\.\/ds-tokens\.generated["']/,
        `${file} deve importar os tokens gerados em vez de duplicar valores`,
      );
    });
  }
});

describe("workers/poll/src — webfont Geist via Google Fonts removido (#3111)", () => {
  // Decisão do editor/autonomia (menor blast radius): Cursos/Livros (as outras
  // 2 páginas do mesmo DS, geradas por scripts/build-{cursos,livros}-page.ts)
  // já declaravam font-family: 'Geist' no CSS SEM nunca carregar o arquivo da
  // fonte — caem pra system sans. O poll era o único dos 3 que de fato
  // buscava o webfont via Google Fonts, introduzindo uma dependência externa
  // e latência extra só nele. Opção escolhida: remover o @import/<link> do
  // poll também, unificando as 3 páginas em system sans (mais barato, sem
  // nova dependência, menos código) em vez de self-hostear Geist nos 3.
  for (const file of ["index.ts", "leaderboard-routes.ts"]) {
    test(`${file} não referencia fonts.googleapis.com / fonts.gstatic.com`, () => {
      const src = readFileSync(resolve(POLL_SRC, file), "utf8");
      assert.doesNotMatch(src, /fonts\.googleapis\.com/);
      assert.doesNotMatch(src, /fonts\.gstatic\.com/);
    });
  }

  test("font-family declarado continua 'Geist' primeiro no stack (cai pra system sans, igual Cursos/Livros)", () => {
    // DS_FONTS.sans (via ds-tokens.generated) preserva 'Geist' como preferência
    // — sem o webfont carregado, todo user-agent cai no fallback do stack
    // (-apple-system/BlinkMacSystemFont/system-ui/sans-serif), igual às
    // páginas Cursos/Livros hoje.
    assert.match(DS_FONTS.sans, /^'Geist'/);
  });
});
