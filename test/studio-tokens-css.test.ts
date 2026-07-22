/**
 * test/studio-tokens-css.test.ts (#3555) — CSS de tokens do DS servido em
 * `/tokens.generated.css`. Garante paridade com scripts/lib/shared/design-tokens.ts
 * (sem precisar de um teste de drift de arquivo commitado — ver rationale em
 * tokens-css.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTokensCss, STATUS_COLORS } from "../scripts/studio-ui/tokens-css.ts";
import { COLORS, FONTS } from "../scripts/lib/shared/design-tokens.ts";

describe("buildTokensCss (#3555)", () => {
  it("inclui os valores canônicos de COLORS/FONTS como custom properties", () => {
    const css = buildTokensCss();
    assert.ok(css.includes(`--brand: ${COLORS.brand};`));
    assert.ok(css.includes(`--ink: ${COLORS.ink};`));
    assert.ok(css.includes(`--paper: ${COLORS.paper};`));
    assert.ok(css.includes(`--font-sans: ${FONTS.sans};`));
  });

  it("é sempre um único bloco :root", () => {
    const css = buildTokensCss();
    assert.equal((css.match(/:root/g) ?? []).length, 1);
  });

  it("aceita overrides injetados (testabilidade sem depender do módulo canônico)", () => {
    const css = buildTokensCss(
      { ...COLORS, brand: "#000000" },
      FONTS,
    );
    assert.ok(css.includes("--brand: #000000;"));
  });
});

describe("STATUS_COLORS / tokens semânticos de status (#3874)", () => {
  it("inclui os 4 tokens semânticos + o par de texto de warn como custom properties", () => {
    const css = buildTokensCss();
    assert.ok(css.includes(`--status-ok: ${STATUS_COLORS.ok};`));
    assert.ok(css.includes(`--status-warn: ${STATUS_COLORS.warn};`));
    assert.ok(css.includes(`--status-warn-ink: ${STATUS_COLORS.warnInk};`));
    assert.ok(css.includes(`--status-danger: ${STATUS_COLORS.danger};`));
    assert.ok(css.includes(`--status-info: ${STATUS_COLORS.info};`));
  });

  it("aceita override de status injetado (mesma testabilidade de colors/fonts)", () => {
    const css = buildTokensCss(COLORS, FONTS, { ...STATUS_COLORS, danger: "#000001" });
    assert.ok(css.includes("--status-danger: #000001;"));
  });

  it("STATUS_COLORS não vaza pra design-tokens.ts (paleta editorial fica só ink/bege/papel/teal)", () => {
    for (const hex of Object.values(STATUS_COLORS)) {
      assert.ok(!Object.values(COLORS).includes(hex), `${hex} não deveria estar em COLORS (design-tokens.ts é a paleta editorial, não status de UI)`);
    }
  });
});
