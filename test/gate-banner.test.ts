import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { visualWidth, padRightVisual, renderGateBanner } from "../scripts/lib/gate-banner.ts";

describe("visualWidth (#751 — emoji-aware terminal width)", () => {
  it("string ASCII simples", () => {
    assert.equal(visualWidth("hello"), 5);
  });

  it("string vazia", () => {
    assert.equal(visualWidth(""), 0);
  });

  it("emoji ocupa 2 células", () => {
    assert.equal(visualWidth("🟡"), 2);
  });

  it("emoji + texto ASCII: 🟡 GATE = 2 + 1 + 4 = 7", () => {
    // 🟡 = 2 cells, space = 1, G=1, A=1, T=1, E=1 → 7
    assert.equal(visualWidth("🟡 GATE"), 7);
  });

  it("múltiplos emoji", () => {
    // 🟡🟢 = 4 cells
    assert.equal(visualWidth("🟡🟢"), 4);
  });

  it("caractere ASCII estendido (< 0xff00) conta como 1", () => {
    // 'é' U+00E9
    assert.equal(visualWidth("é"), 1);
  });

  it("em-dash (U+2014) conta como 1", () => {
    assert.equal(visualWidth("—"), 1);
  });

  it("string mista emoji + ASCII + acentuada", () => {
    // "✅ OK" → ✅ está em Misc symbols (0x2600–0x27bf)? No, ✅ is U+2705 which is in 0x1f300-0x1faff? Let's check:
    // U+2705 = 9989 decimal. 0x1f300 = 127744, 0x2705 = 9989 — not in emoji range but in Misc symbols 0x2600-0x27bf (9728-10175)?
    // 0x2705 = 9989 > 0x27bf = 10175? No, 0x27bf = 10175 and 0x2705 = 9989 < 10175, so it IS in 0x2600-0x27bf.
    // "✅ OK" → 2 + 1 + 1 + 1 = 5
    assert.equal(visualWidth("✅ OK"), 5);
  });
});

describe("padRightVisual (#751)", () => {
  it("pad com espaços para atingir largura alvo", () => {
    assert.equal(padRightVisual("hello", 10), "hello     ");
  });

  it("não adiciona nada quando já está no alvo", () => {
    assert.equal(padRightVisual("hello", 5), "hello");
  });

  it("não remove chars quando string excede alvo", () => {
    assert.equal(padRightVisual("hello world", 5), "hello world");
  });

  it("pad correto com emoji (🟡 hi = 5 visual cells → 5 spaces para target 10)", () => {
    // 🟡=2, ' '=1, h=1, i=1 → 5 visual cells
    const result = padRightVisual("🟡 hi", 10);
    assert.equal(result, "🟡 hi     ");
    assert.equal(visualWidth(result), 10);
  });

  it("pad com fill customizado", () => {
    assert.equal(padRightVisual("ab", 5, "-"), "ab---");
  });
});

describe("renderGateBanner (#751 — banner with emoji-aware alignment)", () => {
  it("banner sem emoji tem todas as linhas com mesma largura visual", () => {
    const banner = renderGateBanner("GATE 1", ["Stage 1 concluído", "2 artigos"], 40);
    const lines = banner.split("\n");
    const widths = lines.map((l) => visualWidth(l));
    const allSame = widths.every((w) => w === widths[0]);
    assert.ok(allSame, `Larguras inconsistentes: ${widths.join(", ")}`);
    assert.equal(widths[0], 40);
  });

  it("banner com emoji tem todas as linhas com mesma largura visual", () => {
    const banner = renderGateBanner("🟡 GATE 1", ["✅ Stage 1 ok", "📰 3 artigos"], 50);
    const lines = banner.split("\n");
    const widths = lines.map((l) => visualWidth(l));
    const allSame = widths.every((w) => w === widths[0]);
    assert.ok(allSame, `Larguras inconsistentes com emoji: ${widths.join(", ")}`);
    assert.equal(widths[0], 50);
  });

  it("banner com em-dash tem alinhamento correto", () => {
    const banner = renderGateBanner("Stage 1 — Pesquisa", ["Resultado: ok"], 50);
    const lines = banner.split("\n");
    const widths = lines.map((l) => visualWidth(l));
    const allSame = widths.every((w) => w === widths[0]);
    assert.ok(allSame, `Larguras inconsistentes com em-dash: ${widths.join(", ")}`);
  });

  it("usa largura padrão 50 quando não especificada", () => {
    const banner = renderGateBanner("Test", []);
    const firstLine = banner.split("\n")[0];
    assert.equal(visualWidth(firstLine), 50);
  });

  it("título e linhas aparecem no banner", () => {
    const banner = renderGateBanner("Meu título", ["linha 1", "linha 2"], 50);
    assert.ok(banner.includes("Meu título"), "título deve estar no banner");
    assert.ok(banner.includes("linha 1"), "linha 1 deve estar no banner");
    assert.ok(banner.includes("linha 2"), "linha 2 deve estar no banner");
  });
});
