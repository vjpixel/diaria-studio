/**
 * test/studio-tokens-css.test.ts (#3555) — CSS de tokens do DS servido em
 * `/tokens.generated.css`. Garante paridade com scripts/lib/shared/design-tokens.ts
 * (sem precisar de um teste de drift de arquivo commitado — ver rationale em
 * tokens-css.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTokensCss } from "../scripts/studio-ui/tokens-css.ts";
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
