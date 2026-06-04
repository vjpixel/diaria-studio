import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  singularizeSectionName,
  sectionEmojiPrefix,
  stripEmojiPrefix,
  displaySectionName,
  SECTIONS,
  ALL_SECTION_NAMES_PATTERN,
  SECTION_EMOJI_PREFIX,
  sectionHeaderRegex,
} from "../scripts/lib/section-naming.ts";

describe("singularizeSectionName (#1070, #1324)", () => {
  it("plural quando N≠1 — preserva nome", () => {
    assert.equal(singularizeSectionName("LANÇAMENTOS", 2), "LANÇAMENTOS");
    assert.equal(singularizeSectionName("LANÇAMENTOS", 3), "LANÇAMENTOS");
    assert.equal(singularizeSectionName("LANÇAMENTOS", 0), "LANÇAMENTOS");
  });

  it("singular quando N=1", () => {
    assert.equal(singularizeSectionName("LANÇAMENTOS", 1), "LANÇAMENTO");
    assert.equal(singularizeSectionName("PESQUISAS", 1), "PESQUISA");
    assert.equal(singularizeSectionName("OUTRAS NOTÍCIAS", 1), "OUTRA NOTÍCIA");
  });

  it("aceita nome com emoji prefix existente", () => {
    assert.equal(singularizeSectionName("🚀 LANÇAMENTOS", 1), "LANÇAMENTO");
    assert.equal(singularizeSectionName("🔬 PESQUISAS", 1), "PESQUISA");
    assert.equal(singularizeSectionName("📰 OUTRAS NOTÍCIAS", 1), "OUTRA NOTÍCIA");
  });

  it("VÍDEOS → VÍDEO quando N=1 (#1674)", () => {
    assert.equal(singularizeSectionName("VÍDEOS", 1), "VÍDEO");
    assert.equal(singularizeSectionName("VÍDEOS", 3), "VÍDEOS");
    assert.equal(singularizeSectionName("📺 VÍDEOS", 1), "VÍDEO");
  });

  it("nome desconhecido passa direto", () => {
    assert.equal(singularizeSectionName("DESTAQUES", 1), "DESTAQUES");
    assert.equal(singularizeSectionName("OBSERVAÇÕES", 1), "OBSERVAÇÕES");
  });
});

describe("sectionEmojiPrefix (#1328)", () => {
  it("retorna emoji + space pra LANÇAMENTOS (plural)", () => {
    assert.equal(sectionEmojiPrefix("LANÇAMENTOS"), "🚀 ");
  });

  it("retorna emoji + space pra LANÇAMENTO (singular)", () => {
    assert.equal(sectionEmojiPrefix("LANÇAMENTO"), "🚀 ");
  });

  it("PESQUISAS/PESQUISA → 🔬", () => {
    assert.equal(sectionEmojiPrefix("PESQUISAS"), "🔬 ");
    assert.equal(sectionEmojiPrefix("PESQUISA"), "🔬 ");
  });

  it("OUTRAS NOTÍCIAS/OUTRA NOTÍCIA → 📰", () => {
    assert.equal(sectionEmojiPrefix("OUTRAS NOTÍCIAS"), "📰 ");
    assert.equal(sectionEmojiPrefix("OUTRA NOTÍCIA"), "📰 ");
  });

  it("VÍDEOS/VÍDEO → 📺 (#1674)", () => {
    assert.equal(sectionEmojiPrefix("VÍDEOS"), "📺 ");
    assert.equal(sectionEmojiPrefix("VÍDEO"), "📺 ");
    assert.equal(sectionEmojiPrefix("📺 VÍDEOS"), "📺 ");
  });

  it("nome desconhecido → string vazia", () => {
    assert.equal(sectionEmojiPrefix("OBSERVAÇÕES"), "");
    assert.equal(sectionEmojiPrefix("DESTAQUES"), "");
  });

  it("idempotente — aceita nome com emoji existente", () => {
    assert.equal(sectionEmojiPrefix("🚀 LANÇAMENTOS"), "🚀 ");
  });
});

describe("stripEmojiPrefix", () => {
  it("remove emoji + space do início", () => {
    assert.equal(stripEmojiPrefix("🚀 LANÇAMENTOS"), "LANÇAMENTOS");
    assert.equal(stripEmojiPrefix("🔬 PESQUISAS"), "PESQUISAS");
    assert.equal(stripEmojiPrefix("📰 OUTRAS NOTÍCIAS"), "OUTRAS NOTÍCIAS");
  });

  it("idempotente — sem emoji retorna input", () => {
    assert.equal(stripEmojiPrefix("LANÇAMENTOS"), "LANÇAMENTOS");
    assert.equal(stripEmojiPrefix("VÍDEOS"), "VÍDEOS");
  });

  it("não remove emoji do meio do nome", () => {
    assert.equal(stripEmojiPrefix("LANÇAMENTOS 🚀"), "LANÇAMENTOS 🚀");
  });

  // #1836 review: strip enriquecido pro superset do SECTION_EMOJI_PREFIX —
  // remove prefixo de emoji composto (ZWJ/skin-tone), consistente com o que o
  // header regex casa. Mantém aceitar FE0F (🛠️).
  it("remove prefixo de emoji composto (ZWJ / skin-tone) — #1836", () => {
    assert.equal(stripEmojiPrefix("🛠️ USE MELHOR"), "USE MELHOR"); // FE0F
    assert.equal(stripEmojiPrefix("👨‍💻 USE MELHOR"), "USE MELHOR"); // ZWJ
    assert.equal(stripEmojiPrefix("🙋🏼‍♀️ LANÇAMENTOS"), "LANÇAMENTOS"); // skin-tone+ZWJ
  });
});

describe("displaySectionName — orquestrador (#1324, #1328)", () => {
  it("plural com emoji quando N>1", () => {
    assert.equal(displaySectionName("LANÇAMENTOS", 2), "🚀 LANÇAMENTOS");
    assert.equal(displaySectionName("PESQUISAS", 3), "🔬 PESQUISAS");
    assert.equal(displaySectionName("OUTRAS NOTÍCIAS", 5), "📰 OUTRAS NOTÍCIAS");
  });

  it("singular com emoji quando N=1", () => {
    assert.equal(displaySectionName("LANÇAMENTOS", 1), "🚀 LANÇAMENTO");
    assert.equal(displaySectionName("PESQUISAS", 1), "🔬 PESQUISA");
    assert.equal(displaySectionName("OUTRAS NOTÍCIAS", 1), "📰 OUTRA NOTÍCIA");
  });

  it("idempotente com emoji já presente", () => {
    assert.equal(displaySectionName("🚀 LANÇAMENTOS", 1), "🚀 LANÇAMENTO");
    assert.equal(displaySectionName("🔬 PESQUISAS", 2), "🔬 PESQUISAS");
  });

  it("VÍDEOS com emoji + singular quando N=1 (#1674)", () => {
    assert.equal(displaySectionName("VÍDEOS", 1), "📺 VÍDEO");
    assert.equal(displaySectionName("VÍDEOS", 3), "📺 VÍDEOS");
    assert.equal(displaySectionName("📺 VÍDEOS", 1), "📺 VÍDEO");
  });

  it("nome desconhecido sem emoji, sem singularização", () => {
    assert.equal(displaySectionName("OBSERVAÇÕES", 1), "OBSERVAÇÕES");
  });
});

describe("SECTIONS registry — fonte única (#1737)", () => {
  // Ordem NÃO é load-bearing (os patterns são mutuamente exclusivos sob `^...$`,
  // então `SECTIONS.find(s => s.header.test(raw))` no lint não depende da ordem);
  // checa por conjunto pra não virar teste brittle (review #1835).
  it("tem as 4 seções canônicas + 2 aliases legacy, todas com bucket válido", () => {
    const labels = new Set(SECTIONS.map((s) => s.label));
    for (const l of ["LANÇAMENTOS", "RADAR", "USE MELHOR", "VÍDEOS", "PESQUISAS", "OUTRAS NOTÍCIAS"]) {
      assert.ok(labels.has(l), `falta ${l}`);
    }
    assert.equal(SECTIONS.length, 6);
    const buckets = new Set(["lancamento", "radar", "use_melhor", "video"]);
    for (const s of SECTIONS) assert.ok(buckets.has(s.bucket), s.bucket);
    // legacy só nos aliases (PESQUISAS/OUTRAS NOTÍCIAS), ambos → radar
    assert.deepEqual(
      new Set(SECTIONS.filter((s) => s.legacy).map((s) => s.label)),
      new Set(["PESQUISAS", "OUTRAS NOTÍCIAS"]),
    );
    assert.ok(SECTIONS.filter((s) => s.legacy).every((s) => s.bucket === "radar"));
    // canônicas (não-legacy) cobrem os 4 buckets exatamente uma vez
    assert.deepEqual(
      new Set(SECTIONS.filter((s) => !s.legacy).map((s) => s.bucket)),
      buckets,
    );
  });

  it("ALL_SECTION_NAMES_PATTERN é a alternação dos patterns", () => {
    assert.equal(
      ALL_SECTION_NAMES_PATTERN,
      SECTIONS.map((s) => s.pattern).join("|"),
    );
  });
});

describe("sectionHeaderRegex — builder canônico (#1737)", () => {
  // Headers reais de produção (bold + emoji) — devem casar em todos os modos.
  const REAL_HEADERS = [
    "**🚀 LANÇAMENTOS**",
    "**📡 RADAR**",
    "**🛠️ USE MELHOR**",
    "**📺 VÍDEOS**",
    "**🔬 PESQUISAS**",
    "**📰 OUTRAS NOTÍCIAS**",
  ];

  it("bold opcional + sem captura (lint URL×bucket): casa bold, plain e singular", () => {
    const re = sectionHeaderRegex(String.raw`LAN[ÇC]AMENTOS?`, { flags: "mu" });
    assert.ok(re.test("**🚀 LANÇAMENTOS**"));
    assert.ok(re.test("LANÇAMENTOS")); // plain legacy
    assert.ok(re.test("**🚀 LANÇAMENTO**")); // singular
    assert.ok(re.test("LANCAMENTOS")); // sem cedilha (superset [ÇC])
    assert.ok(!re.test("LANÇAMENTOS extra"));
  });

  it("capture='name' → grupo 1 = nome sem emoji (render/item-header)", () => {
    const re = sectionHeaderRegex(ALL_SECTION_NAMES_PATTERN, {
      capture: "name",
      flags: "mu",
    });
    assert.equal("**🛠️ USE MELHOR**".match(re)?.[1], "USE MELHOR");
    assert.equal("**📡 RADAR**".match(re)?.[1], "RADAR");
  });

  it("capture='with-emoji' → grupo 1 = emoji + nome (singularize)", () => {
    const re = sectionHeaderRegex(ALL_SECTION_NAMES_PATTERN, {
      bold: "required",
      capture: "with-emoji",
      flags: "u",
    });
    assert.equal("**🚀 LANÇAMENTOS**".match(re)?.[1], "🚀 LANÇAMENTOS");
  });

  it("bold='required' NÃO casa header plain (sem **)", () => {
    const re = sectionHeaderRegex(String.raw`RADAR`, {
      bold: "required",
      flags: "u",
    });
    assert.ok(re.test("**RADAR**"));
    assert.ok(!re.test("RADAR"));
  });

  it("emoji prefix tight: NÃO casa dígitos/pontuação como prefixo (#1691)", () => {
    const re = sectionHeaderRegex(String.raw`RADAR`, { flags: "mu" });
    assert.ok(re.test("**📡 RADAR**"));
    assert.ok(!re.test("123 RADAR"));
    assert.ok(!re.test("*** RADAR"));
  });

  it("todos os headers reais casam nos 3 modos de captura", () => {
    const reName = sectionHeaderRegex(ALL_SECTION_NAMES_PATTERN, { capture: "name", flags: "mu" });
    const reEmoji = sectionHeaderRegex(ALL_SECTION_NAMES_PATTERN, { bold: "required", capture: "with-emoji", flags: "u" });
    const reNone = sectionHeaderRegex(ALL_SECTION_NAMES_PATTERN, { flags: "mu" });
    for (const h of REAL_HEADERS) {
      assert.ok(reName.test(h), `name: ${h}`);
      assert.ok(reEmoji.test(h), `emoji: ${h}`);
      assert.ok(reNone.test(h), `none: ${h}`);
    }
  });

  it("SECTION_EMOJI_PREFIX cobre todos os emojis de seção", () => {
    const re = new RegExp(`^${SECTION_EMOJI_PREFIX}$`, "u");
    for (const e of ["🚀 ", "📡 ", "🛠️ ", "📺 ", "🔬 ", "📰 "]) {
      assert.ok(re.test(e), e);
    }
    assert.ok(re.test("")); // prefixo é opcional
  });

  // review #1835: o builder sempre fecha com `\s*$`, então tolera trailing
  // whitespace no header (singularize antes usava `\*\*$` e NÃO casava
  // `**RADAR** ` — agora casa e o `\s*` consome o espaço no replace). Pin pra
  // não regredir essa tolerância (era silent-drop fora do range do harness).
  it("tolera trailing whitespace no header (`\\s*$`)", () => {
    const reNone = sectionHeaderRegex(String.raw`RADAR`, { flags: "mu" });
    assert.ok(reNone.test("**📡 RADAR** ")); // 1 espaço final
    assert.ok(reNone.test("**📡 RADAR**\t"));
    const reEmoji = sectionHeaderRegex(ALL_SECTION_NAMES_PATTERN, {
      bold: "required",
      capture: "with-emoji",
      flags: "u",
    });
    // captura NÃO inclui o trailing whitespace (fica fora do grupo)
    assert.equal("**🚀 LANÇAMENTOS**  ".match(reEmoji)?.[1], "🚀 LANÇAMENTOS");
  });
});
