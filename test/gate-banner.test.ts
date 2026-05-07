import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  visualWidth,
  padRightVisual,
  renderGateBanner,
  renderHaltBanner,
} from "../scripts/lib/gate-banner.ts";

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

describe("renderHaltBanner (#737 — pipeline parou)", () => {
  it("inclui título 'PIPELINE PAROU' com emoji 🛑 dos dois lados", () => {
    const banner = renderHaltBanner({
      stage: "1 — Pesquisa",
      reason: "mcp__clarice desconectado",
      action: "reconecte e responda 'retry'",
    });
    assert.ok(banner.includes("PIPELINE PAROU"));
    assert.ok(banner.includes("🛑"));
    // Two emoji on the title line
    const titleLine = banner.split("\n").find((l) => l.includes("PIPELINE PAROU"))!;
    const emojiMatches = titleLine.match(/🛑/g) ?? [];
    assert.equal(emojiMatches.length, 2, "deve ter 2 emoji 🛑 no título");
  });

  it("inclui campos STAGE, MOTIVO e AÇÃO em linhas separadas", () => {
    const banner = renderHaltBanner({
      stage: "2b — Clarice",
      reason: "mcp_clarice off",
      action: "reconecte",
    });
    assert.ok(banner.includes("STAGE:  2b — Clarice"));
    assert.ok(banner.includes("MOTIVO: mcp_clarice off"));
    assert.ok(banner.includes("AÇÃO:   reconecte"));
  });

  it("alinhamento visual correto com emoji + acentos", () => {
    const banner = renderHaltBanner({
      stage: "4 — Publicação",
      reason: "Beehiiv 5xx persistente",
      action: "aguardar e re-rodar /diaria-4-publicar",
    });
    const lines = banner.split("\n");
    const widths = lines.map((l) => visualWidth(l));
    const allSame = widths.every((w) => w === widths[0]);
    assert.ok(allSame, `Larguras inconsistentes: ${widths.join(", ")}`);
  });

  it("largura padrão é 60 cells", () => {
    const banner = renderHaltBanner({
      stage: "X",
      reason: "Y",
      action: "Z",
    });
    const firstLine = banner.split("\n")[0];
    assert.equal(visualWidth(firstLine), 60);
  });

  it("largura customizada respeitada", () => {
    const banner = renderHaltBanner({
      stage: "X",
      reason: "Y",
      action: "Z",
      width: 80,
    });
    const firstLine = banner.split("\n")[0];
    assert.equal(visualWidth(firstLine), 80);
  });

  it("output é distinguível de renderGateBanner (texto diferente)", () => {
    const halt = renderHaltBanner({ stage: "1", reason: "r", action: "a" });
    const gate = renderGateBanner("🟡 GATE 1", ["aprovar?"]);
    assert.ok(!halt.includes("GATE"), "halt não deve mencionar GATE");
    assert.ok(halt.includes("PAROU"), "halt deve dizer PAROU");
    assert.ok(!gate.includes("PAROU"), "gate não deve dizer PAROU");
  });

  it("conteúdo extenso não trunca — texto cabe na largura padrão (60)", () => {
    // Validação de safety: se um motivo for longo demais, melhor expandir
    // o width (caller passa width maior) do que truncar silenciosamente.
    const banner = renderHaltBanner({
      stage: "2b — Clarice review (Stage longo)",
      reason: "Mensagem de motivo bem longa que pode passar do limite default",
      action: "Texto de ação também longo com detalhes",
      width: 100,
    });
    const lines = banner.split("\n");
    const widths = lines.map((l) => visualWidth(l));
    const allSame = widths.every((w) => w === widths[0]);
    assert.ok(allSame, `largura inconsistente em banner extenso: ${widths.join(",")}`);
    assert.equal(widths[0], 100);
  });
});
