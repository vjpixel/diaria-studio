import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findForbiddenPhrases,
  formatIssues,
  CATEGORY_RULES,
  FORBIDDEN_PATTERNS,
} from "../scripts/lib/lint-image-prompt.ts";

describe("findForbiddenPhrases — detecção de violações (#810)", () => {
  it("retorna [] pra prompt limpo", () => {
    const r = findForbiddenPhrases(
      "Pintura impasto Van Gogh de servidores em data center, 2:1",
    );
    assert.deepEqual(r, []);
  });

  it("retorna [] pra string vazia", () => {
    assert.deepEqual(findForbiddenPhrases(""), []);
  });

  it("retorna [] pra input não-string (defensive)", () => {
    assert.deepEqual(findForbiddenPhrases(null as unknown as string), []);
    assert.deepEqual(findForbiddenPhrases(undefined as unknown as string), []);
  });

  it("detecta 'Noite Estrelada' (PT)", () => {
    const r = findForbiddenPhrases("Recriar Noite Estrelada com servidores");
    assert.equal(r.length, 1);
    assert.equal(r[0].category, "starry_night_pt");
    assert.equal(r[0].match, "Noite Estrelada");
  });

  it("case-insensitive — 'noite estrelada' lowercase também detecta", () => {
    const r = findForbiddenPhrases("noite estrelada com edits");
    assert.equal(r.length, 1);
    assert.equal(r[0].category, "starry_night_pt");
  });

  it("detecta 'Starry Night' (EN)", () => {
    const r = findForbiddenPhrases("Recreate Starry Night with servers");
    assert.equal(r.length, 1);
    assert.equal(r[0].category, "starry_night_en");
  });

  it("detecta 'The Starry Night' como Starry Night (subset match)", () => {
    const r = findForbiddenPhrases("In the style of The Starry Night");
    assert.equal(r.length, 1);
    assert.equal(r[0].category, "starry_night_en");
    assert.equal(r[0].match, "Starry Night");
  });

  it("detecta múltiplas ocorrências do mesmo pattern", () => {
    const r = findForbiddenPhrases(
      "Noite Estrelada com servidores e mais Noite Estrelada ao fundo",
    );
    assert.equal(r.length, 2);
    assert.ok(r.every((i) => i.category === "starry_night_pt"));
    // Ordenado por position
    assert.ok(r[0].index < r[1].index);
  });

  it("detecta resolução em pixels (1024x1024)", () => {
    const r = findForbiddenPhrases("Render em 1024x1024 detalhado");
    assert.equal(r.length, 1);
    assert.equal(r[0].category, "pixel_resolution");
    assert.equal(r[0].match, "1024x1024");
  });

  it("detecta resolução com espaços (800 x 600)", () => {
    const r = findForbiddenPhrases("Tamanho 800 x 600 ou 1920 X 1080");
    assert.equal(r.length, 2);
    assert.ok(r.every((i) => i.category === "pixel_resolution"));
  });

  it("detecta '500px' / '500 pixels'", () => {
    const r1 = findForbiddenPhrases("Width 500px");
    assert.equal(r1.length, 1);
    assert.equal(r1[0].category, "pixel_count");

    const r2 = findForbiddenPhrases("Tamanho 1024 pixels de largura");
    assert.equal(r2.length, 1);
    assert.equal(r2[0].category, "pixel_count");
  });

  it("detecta DPI", () => {
    const r1 = findForbiddenPhrases("Render em 300 dpi");
    assert.equal(r1.length, 1);
    assert.equal(r1[0].category, "dpi");

    const r2 = findForbiddenPhrases("150DPI alta resolução");
    assert.equal(r2.length, 1);
    assert.equal(r2[0].category, "dpi");
  });

  it("detecta múltiplas categorias num único prompt", () => {
    const r = findForbiddenPhrases(
      "Recriar Noite Estrelada em 1024x1024 a 300 dpi",
    );
    assert.equal(r.length, 3);
    const categories = r.map((i) => i.category).sort();
    assert.deepEqual(categories.sort(), ["dpi", "pixel_resolution", "starry_night_pt"]);
  });

  it("issues ordenados por position (text reading order)", () => {
    const r = findForbiddenPhrases(
      "Render em 1024x1024 baseado em Noite Estrelada com 300 dpi",
    );
    assert.equal(r.length, 3);
    // Pixel resolution vem antes de Noite Estrelada que vem antes de DPI
    assert.equal(r[0].category, "pixel_resolution");
    assert.equal(r[1].category, "starry_night_pt");
    assert.equal(r[2].category, "dpi");
  });

  it("não confunde 'starry sky' (legítimo) com 'starry night' (proibido)", () => {
    const r = findForbiddenPhrases("Starry sky over data center");
    assert.equal(r.length, 0);
  });

  it("não confunde 'noite' isolado (legítimo) com 'Noite Estrelada' (proibido)", () => {
    const r = findForbiddenPhrases("Cena noturna em fim de noite");
    assert.equal(r.length, 0);
  });

  it("não confunde número isolado com pixel count ('500 servidores')", () => {
    const r = findForbiddenPhrases("Render com 500 servidores empilhados");
    assert.equal(r.length, 0);
  });
});

describe("formatIssues — output legível pro stderr (#810)", () => {
  it("retorna string vazia pra issues vazias", () => {
    assert.equal(formatIssues("prompt", []), "");
  });

  it("inclui contador de violações", () => {
    const issues = findForbiddenPhrases("Noite Estrelada");
    const out = formatIssues("Noite Estrelada", issues);
    assert.match(out, /1 violação\(ões\) encontrada\(s\)/);
  });

  it("inclui categoria + match + contexto pra cada issue", () => {
    const prompt = "Recriar Noite Estrelada em estilo Van Gogh";
    const issues = findForbiddenPhrases(prompt);
    const out = formatIssues(prompt, issues);
    assert.match(out, /\[starry_night_pt\]/);
    assert.match(out, /match="Noite Estrelada"/);
    assert.match(out, /contexto.*Recriar/);
  });
});

describe("CATEGORY_RULES — descritivos pra cada categoria (#810)", () => {
  it("toda categoria tem rule descritiva associada", () => {
    for (const { category } of FORBIDDEN_PATTERNS) {
      assert.ok(
        CATEGORY_RULES[category],
        `categoria ${category} não tem rule em CATEGORY_RULES`,
      );
      assert.ok(
        CATEGORY_RULES[category].length > 20,
        `rule de ${category} muito curta: ${CATEGORY_RULES[category]}`,
      );
    }
  });

  it("CATEGORY_RULES não tem keys órfãs (sem pattern correspondente)", () => {
    const patternCategories = new Set(FORBIDDEN_PATTERNS.map((p) => p.category));
    for (const key of Object.keys(CATEGORY_RULES)) {
      assert.ok(
        patternCategories.has(key as never),
        `CATEGORY_RULES tem '${key}' mas FORBIDDEN_PATTERNS não — drift`,
      );
    }
  });
});
