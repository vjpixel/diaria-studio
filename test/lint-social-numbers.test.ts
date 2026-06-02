import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMagnitude,
  normalizeDigits,
  extractMoneyFigures,
  sourceFigureKeys,
  findUnsourcedFigures,
  highlightSourceText,
  parseSocialByDestaque,
  lintSocialNumbers,
} from "../scripts/lint-social-numbers.ts";

describe("normalizeMagnitude (#1711)", () => {
  it("bilhões/billion/bi/bn/B → B", () => {
    for (const u of ["bilhões", "billion", "bi", "bn", "B", "Bilhões"]) {
      assert.equal(normalizeMagnitude(u), "B");
    }
  });
  it("milhões/million/mi/M → M", () => {
    for (const u of ["milhões", "million", "mi", "M"]) {
      assert.equal(normalizeMagnitude(u), "M");
    }
  });
  it("desconhecido → ''", () => {
    assert.equal(normalizeMagnitude("xyz"), "");
  });
});

describe("normalizeDigits (#1711)", () => {
  it("separador de milhar some", () => {
    assert.equal(normalizeDigits("1.000"), "1000");
    assert.equal(normalizeDigits("1,234,567"), "1234567");
  });
  it("decimal de 1-2 dígitos preservado", () => {
    assert.equal(normalizeDigits("2,5"), "2.5");
    assert.equal(normalizeDigits("2.50"), "2.5");
  });
  it("número simples inalterado", () => {
    assert.equal(normalizeDigits("965"), "965");
  });
});

describe("extractMoneyFigures (#1711)", () => {
  it("extrai cifra com magnitude por extenso", () => {
    const f = extractMoneyFigures("levantou US$ 965 bilhões em valuation");
    assert.equal(f.length, 1);
    assert.equal(f[0].key, "965B");
  });
  it("extrai cifra com magnitude abreviada colada", () => {
    const f = extractMoneyFigures("avaliada em $10B após a rodada");
    assert.equal(f[0].key, "10B");
  });
  it("R$ com decimal PT", () => {
    const f = extractMoneyFigures("R$ 2,5 bi em receita");
    assert.equal(f[0].key, "2.5B");
  });
  it("NÃO extrai cifra SEM magnitude (específica demais / comum)", () => {
    assert.deepEqual(extractMoneyFigures("custou US$ 50 por mês"), []);
  });
  it("NÃO extrai porcentagem", () => {
    assert.deepEqual(extractMoneyFigures("cresceu 45% no trimestre"), []);
  });

  it("#1722: 'R$ 35 mil' → 35K (não 35M — mil antes de mi)", () => {
    const f = extractMoneyFigures("concorra a R$ 35 mil em prêmios");
    assert.equal(f[0].key, "35K");
  });

  it("#1722: 'US$ 50 milhões' → 50M (milh\\w* vence mil/mi)", () => {
    assert.equal(extractMoneyFigures("US$ 50 milhões em receita")[0].key, "50M");
  });

  it("#1722: 'trimestre' NÃO é magnitude 'tri' (lookahead)", () => {
    // "tri" seguido de letra (m) não casa → sem cifra fabricada.
    assert.deepEqual(extractMoneyFigures("US$ 10 no trimestre passado"), []);
    assert.deepEqual(extractMoneyFigures("US$ 10 trimestrais"), []);
  });

  it("'US$ 1,5 trilhão' → 1.5T", () => {
    assert.equal(extractMoneyFigures("avaliado em US$ 1,5 trilhão")[0].key, "1.5T");
  });
});

describe("sourceFigureKeys (#1711) — com e sem símbolo de moeda", () => {
  it("captura cifra sem símbolo na fonte ('965 bilhões de dólares')", () => {
    const keys = sourceFigureKeys("avaliada em 965 bilhões de dólares");
    assert.ok(keys.has("965B"));
  });
});

describe("findUnsourcedFigures (#1711) — caso real 260602", () => {
  it("flaga 'US$ 965 bilhões' ausente da fonte (alucinação)", () => {
    const social = "A Anthropic vai abrir capital; a última rodada levantou US$ 965 bilhões em valuation.";
    const source = "Anthropic planeja IPO, diz The Guardian. A empresa busca novos investidores.";
    const unsourced = findUnsourcedFigures(social, source);
    assert.equal(unsourced.length, 1);
    assert.equal(unsourced[0].key, "965B");
  });

  it("NÃO flaga cifra que ESTÁ na fonte (mesmo formato diferente)", () => {
    const social = "A startup foi avaliada em US$ 10B.";
    const source = "A startup atingiu valuation de 10 bilhões de dólares.";
    assert.deepEqual(findUnsourcedFigures(social, source), []);
  });

  it("post sem cifras → nada a flagar", () => {
    assert.deepEqual(findUnsourcedFigures("A OpenAI lançou um novo modelo hoje.", "fonte qualquer"), []);
  });
});

describe("highlightSourceText (#1722) — fonte do destaque N", () => {
  const approved = {
    highlights: [
      { article: { title: "Anthropic planeja IPO", summary: "Sem cifra na fonte." } },
      { article: { title: "Outro destaque", summary: "Cresceu 10 bilhões." } },
    ],
  };
  it("retorna title+summary do highlight N-1", () => {
    assert.match(highlightSourceText(approved, 1), /Anthropic planeja IPO/);
    assert.match(highlightSourceText(approved, 2), /10 bilhões/);
  });
  it("N fora de range → ''", () => {
    assert.equal(highlightSourceText(approved, 9), "");
  });
});

describe("parseSocialByDestaque (#1722)", () => {
  it("separa posts por ## dN (LinkedIn + Facebook concatenados)", () => {
    const md = `# LinkedIn

## d1

Post LinkedIn d1 com US$ 965 bilhões.

### comment_diaria

Comentário d1.

## d2

Post d2.

# Facebook

## d1

Post Facebook d1.

## d2

Post Facebook d2.`;
    const map = parseSocialByDestaque(md);
    assert.match(map.get(1) ?? "", /Post LinkedIn d1/);
    assert.match(map.get(1) ?? "", /Comentário d1/);
    assert.match(map.get(1) ?? "", /Post Facebook d1/); // os dois canais juntos
    assert.doesNotMatch(map.get(1) ?? "", /Post d2/);
  });
});

describe("lintSocialNumbers (#1722) — per-destaque, caso 260602", () => {
  it("flaga '965B' no post d1 mesmo que esteja na fonte de OUTRO destaque", () => {
    // O bug 260602: "965B" aparecia num item use_melhor, mas o post d1 (Anthropic
    // IPO) o citou como valuation — ausente da fonte do d1. Per-destaque pega isso.
    const social = `# LinkedIn

## d1

A Anthropic vai abrir capital; a rodada levantou US$ 965 bilhões em valuation.

## d2

Post d2 sem cifras.`;
    const approved = {
      highlights: [
        { article: { title: "Anthropic planeja IPO", summary: "Empresa busca investidores, diz Guardian." } },
        { article: { title: "Outro", summary: "Item com US$ 965 bilhões em outro contexto." } },
      ],
    };
    const findings = lintSocialNumbers(social, approved);
    const d1 = findings.find((f) => f.destaque === 1);
    assert.ok(d1, "d1 deve ter finding");
    assert.equal(d1!.unsourced[0].key, "965B");
  });

  it("NÃO flaga cifra que ESTÁ na fonte do próprio destaque", () => {
    const social = `# LinkedIn

## d1

A startup foi avaliada em US$ 10B.`;
    const approved = {
      highlights: [{ article: { title: "Startup X", summary: "Atingiu valuation de 10 bilhões de dólares." } }],
    };
    assert.deepEqual(lintSocialNumbers(social, approved), []);
  });
});
