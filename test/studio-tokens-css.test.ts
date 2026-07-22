/**
 * test/studio-tokens-css.test.ts (#3555) — CSS de tokens do DS servido em
 * `/tokens.generated.css`. Garante paridade com scripts/lib/shared/design-tokens.ts
 * (sem precisar de um teste de drift de arquivo commitado — ver rationale em
 * tokens-css.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTokensCss, STATUS_COLORS, STATUS_COLORS_DARK } from "../scripts/studio-ui/tokens-css.ts";
import { COLORS, DARK_COLORS, FONTS } from "../scripts/lib/shared/design-tokens.ts";

describe("buildTokensCss (#3555)", () => {
  it("inclui os valores canônicos de COLORS/FONTS como custom properties", () => {
    const css = buildTokensCss();
    assert.ok(css.includes(`--brand: ${COLORS.brand};`));
    assert.ok(css.includes(`--ink: ${COLORS.ink};`));
    assert.ok(css.includes(`--paper: ${COLORS.paper};`));
    assert.ok(css.includes(`--font-sans: ${FONTS.sans};`));
  });

  it("tem exatamente 2 blocos :root — o base e o override dentro do @media dark (#3876)", () => {
    const css = buildTokensCss();
    assert.equal((css.match(/:root/g) ?? []).length, 2);
  });

  it("o bloco :root BASE (fora do @media) contém os valores claros de --paper/--ink", () => {
    const css = buildTokensCss();
    const base = css.slice(0, css.indexOf("@media"));
    assert.ok(base.includes(`--paper: ${COLORS.paper};`));
    assert.ok(base.includes(`--ink: ${COLORS.ink};`));
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

describe("dark mode — @media (prefers-color-scheme: dark) (#3876)", () => {
  it("emite exatamente 1 bloco @media (prefers-color-scheme: dark)", () => {
    const css = buildTokensCss();
    assert.equal((css.match(/@media \(prefers-color-scheme: dark\)/g) ?? []).length, 1);
  });

  it("sobrescreve --paper/--ink com o par invertido (DARK_COLORS), --on-ink com COLORS.ink", () => {
    const css = buildTokensCss();
    const darkBlock = css.slice(css.indexOf("@media"));
    assert.ok(darkBlock.includes(`--paper: ${DARK_COLORS.paperDark};`));
    assert.ok(darkBlock.includes(`--ink: ${DARK_COLORS.inkOnDark};`));
    assert.ok(darkBlock.includes(`--on-ink: ${COLORS.ink};`));
  });

  it("--paper-alt (dark) é um color-mix() derivado, não um hex hardcoded", () => {
    const css = buildTokensCss();
    const darkBlock = css.slice(css.indexOf("@media"));
    assert.match(darkBlock, /--paper-alt: color-mix\(in srgb, .*\);/);
  });

  it("sobrescreve --status-ok/--status-danger/--status-info com STATUS_COLORS_DARK (calibrados pro fundo escuro)", () => {
    const css = buildTokensCss();
    const darkBlock = css.slice(css.indexOf("@media"));
    assert.ok(darkBlock.includes(`--status-ok: ${STATUS_COLORS_DARK.ok};`));
    assert.ok(darkBlock.includes(`--status-danger: ${STATUS_COLORS_DARK.danger};`));
    assert.ok(darkBlock.includes(`--status-info: ${STATUS_COLORS_DARK.info};`));
  });

  it("NÃO sobrescreve --status-warn/--status-warn-ink no bloco dark (já calibrado o bastante pro fundo escuro, ver docstring)", () => {
    const css = buildTokensCss();
    const darkBlock = css.slice(css.indexOf("@media"));
    assert.ok(!darkBlock.includes("--status-warn:"));
    assert.ok(!darkBlock.includes("--status-warn-ink:"));
  });

  it("aceita overrides injetados de dark/statusDark (mesma testabilidade dos demais parâmetros)", () => {
    const css = buildTokensCss(COLORS, FONTS, STATUS_COLORS, { ...DARK_COLORS, paperDark: "#000001" }, { ...STATUS_COLORS_DARK, ok: "#00ff00" });
    const darkBlock = css.slice(css.indexOf("@media"));
    assert.ok(darkBlock.includes("--paper: #000001;"));
    assert.ok(darkBlock.includes("--status-ok: #00ff00;"));
  });

  it("STATUS_COLORS_DARK cobre só ok/danger/info (warn fica de fora deliberadamente)", () => {
    assert.deepEqual(Object.keys(STATUS_COLORS_DARK).sort(), ["danger", "info", "ok"]);
  });
});
