import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  humanize,
  applyRemovals,
  applySubstitutions,
  flagLongSentences,
  flagMechanicalParallelism,
  flagRepetitiveConnectives,
  recapitalizeSentenceStarts,
} from "../scripts/humanize.ts";

describe("applyRemovals", () => {
  // applyRemovals NÃO recapitaliza — isso é feito por humanize() no fim.
  // Por isso os outputs ficam com a próxima palavra em minúscula às vezes.
  it("remove 'É importante notar que' do início", () => {
    const r = applyRemovals("É importante notar que o modelo é open source.");
    assert.equal(r.text, "o modelo é open source.");
    assert.equal(r.count, 1);
  });

  it("remove 'Vale destacar que' após pontuação", () => {
    const r = applyRemovals("Lançamento ontem. Vale destacar que custa $20/mês.");
    assert.equal(r.text, "Lançamento ontem. custa $20/mês.");
    assert.equal(r.count, 1);
  });

  it("remove múltiplas muletas no mesmo texto", () => {
    const r = applyRemovals(
      "É importante notar que A. Cabe destacar que B. Vale ressaltar que C.",
    );
    assert.equal(r.text, "A. B. C.");
    assert.equal(r.count, 3);
  });

  it("NÃO remove muleta no meio de sentença", () => {
    // Aqui a muleta vem após "porque", não após pontuação forte
    const r = applyRemovals("Compraram porque é importante notar que era barato.");
    assert.equal(r.count, 0);
    // Texto não muda
    assert.equal(r.text, "Compraram porque é importante notar que era barato.");
  });

  it("texto sem muletas passa intacto", () => {
    const r = applyRemovals("O modelo é bom. A documentação é clara.");
    assert.equal(r.count, 0);
    assert.equal(r.text, "O modelo é bom. A documentação é clara.");
  });

  it("variações 'vale a pena destacar que' / 'vale destacar que'", () => {
    const r = applyRemovals("Vale a pena destacar que A. Vale destacar que B.");
    assert.equal(r.text, "A. B.");
    assert.equal(r.count, 2);
  });
});

describe("applySubstitutions", () => {
  // applySubstitutions tampouco recapitaliza — replacements são lower-case
  // e o pipeline final em humanize() corrige o início de sentença.
  it("'desta forma' → 'Assim'", () => {
    const r = applySubstitutions("Desta forma, o resultado é claro.");
    assert.equal(r.text, "Assim, o resultado é claro.");
    assert.equal(r.count, 1);
  });

  it("'em última análise' → 'no fim' (case raw, sem recap)", () => {
    const r = applySubstitutions("Em última análise, vale a pena.");
    assert.equal(r.text, "no fim, vale a pena.");
    assert.equal(r.count, 1);
  });

  it("'no entanto, é' → 'mas é' — lookahead permite match com char acentuado final", () => {
    // Caso problemático: \b após `é` (non-word) não fecha em JS regex —
    // o pattern usa (?=\s|[,.!?]|$) em vez de \b final pra confirmar boundary.
    const r = applySubstitutions("Promete entrega rápida. No entanto, é caro.");
    assert.equal(r.text, "Promete entrega rápida. mas é caro.");
    assert.equal(r.count, 1);
  });

  it("texto sem padrões passa intacto", () => {
    const r = applySubstitutions("O modelo é bom.");
    assert.equal(r.count, 0);
    assert.equal(r.text, "O modelo é bom.");
  });
});

describe("flagLongSentences", () => {
  it("detecta sentença > 30 palavras", () => {
    // Sentença com 35 palavras
    const sentence =
      "A metodologia cruza as características técnicas e operacionais de cada ocupação no mercado brasileiro com as capacidades emergentes dos modelos generativos atuais para identificar quais funções correm risco real de automação no curto prazo do próximo ciclo.";
    const flags = flagLongSentences(sentence);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].rule, "long_sentence");
  });

  it("sentenças curtas passam", () => {
    const flags = flagLongSentences("Lançou ontem. Custa $20. É open source.");
    assert.equal(flags.length, 0);
  });
});

describe("flagMechanicalParallelism", () => {
  it("detecta 'não apenas X, mas também Y'", () => {
    const flags = flagMechanicalParallelism(
      "O modelo não apenas reduz custo, mas também acelera entrega.",
    );
    assert.equal(flags.length, 1);
    assert.equal(flags[0].rule, "mechanical_parallelism");
  });

  it("textos sem o padrão passam", () => {
    const flags = flagMechanicalParallelism("O modelo reduz custo e acelera entrega.");
    assert.equal(flags.length, 0);
  });
});

describe("flagRepetitiveConnectives", () => {
  it("detecta 'Além disso' repetido em janela curta", () => {
    const text =
      "Lançou modelo novo. Além disso, abriu repo público. " +
      "Além disso, dobrou contexto.";
    const flags = flagRepetitiveConnectives(text);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].rule, "repetitive_connective");
  });

  it("conectivos espaçados (>500 chars) não geram flag", () => {
    const text =
      "Além disso, A. " +
      "Filler ".repeat(150) + // ~900 chars
      "Além disso, B.";
    const flags = flagRepetitiveConnectives(text);
    assert.equal(flags.length, 0);
  });
});

describe("humanize — integração", () => {
  it("aplica removals + substitutions + flags em pipeline", () => {
    const input =
      "É importante notar que o modelo é bom. " +
      "Vale destacar que o custo é baixo. " +
      "Desta forma, o sistema não apenas funciona, mas também escala.";
    const r = humanize(input);
    // 2 muletas removidas (ambas em início de sentença após pontuação forte)
    assert.equal(r.report.removals_count, 2);
    // 1 substitution: "Desta forma," → "Assim,"
    assert.equal(r.report.substitutions_count, 1);
    // 1 flag: paralelismo mecânico
    assert.equal(r.report.flags.length, 1);
    assert.equal(r.report.flags[0].rule, "mechanical_parallelism");
    assert.ok(!r.text.includes("É importante notar que"));
    assert.ok(!r.text.includes("Vale destacar que"));
    assert.ok(r.text.includes("Assim,"));
    // Recapitalização — primeira sentença começa com "O"
    assert.ok(r.text.startsWith("O modelo"), `text começa com: "${r.text.slice(0, 30)}"`);
  });

  it("recapitaliza após substitution lowercase", () => {
    const r = humanize("Em última análise, vale a pena.");
    assert.equal(r.text, "No fim, vale a pena.");
  });

  it("texto limpo passa sem mudanças", () => {
    const input = "Lançou modelo. Custa $20. Open source.";
    const r = humanize(input);
    assert.equal(r.text, input);
    assert.equal(r.report.removals_count, 0);
    assert.equal(r.report.substitutions_count, 0);
    assert.equal(r.report.flags.length, 0);
  });
});

describe("recapitalizeSentenceStarts — URL guard (#163)", () => {
  // Nota: a função SEMPRE capitaliza a primeira letra do texto (start-of-string).
  // Estes tests focam só em garantir que URLs após pontuação NÃO são tocadas.

  it("URL após período em linha própria NÃO é capitalizada", () => {
    const r = recapitalizeSentenceStarts("texto. Outra frase.\nhttps://example.com");
    assert.ok(r.includes("\nhttps://example.com"), `URL preservada: ${r}`);
    assert.ok(!r.includes("Https://"), `não há Https: ${r}`);
  });

  it("URL após exclamação NÃO é capitalizada", () => {
    const r = recapitalizeSentenceStarts("Acabou! Que ótimo!\nhttps://example.com/path");
    assert.ok(r.includes("\nhttps://example.com/path"), `URL preservada: ${r}`);
  });

  it("URL após interrogação NÃO é capitalizada", () => {
    const r = recapitalizeSentenceStarts("Funciona? Saberemos em breve?\nhttps://example.com");
    assert.ok(r.includes("\nhttps://example.com"), `URL preservada: ${r}`);
  });

  it("http:// (sem s) também é preservada", () => {
    const r = recapitalizeSentenceStarts("Lá vai. Frase.\nhttp://example.com");
    assert.ok(r.includes("\nhttp://example.com"), `URL preservada: ${r}`);
  });

  it("recapitalização normal (não-URL) continua funcionando", () => {
    const text = "primeira frase. segunda frase.";
    assert.equal(
      recapitalizeSentenceStarts(text),
      "Primeira frase. Segunda frase.",
    );
  });

  it("mistura URL + frase normal — só recapitaliza a frase, não a URL", () => {
    const text = "intro paragrafo.\nhttps://example.com\nOutro paragrafo.";
    const r = recapitalizeSentenceStarts(text);
    // Goal: URL fica intacta (não vira Https); resto fica como começou
    assert.ok(r.includes("https://"), `URL preservada: ${r}`);
    assert.ok(!r.includes("Https://"), `não há Https: ${r}`);
    // Recapitalização do início do texto
    assert.ok(r.startsWith("Intro paragrafo"), `Início recapitalizado: ${r}`);
  });

  it("regression — repro exato do issue body", () => {
    const text = "texto.\nhttps://example.com";
    const r = recapitalizeSentenceStarts(text);
    // Antes do fix, "https" virava "Https". Agora só o "t" inicial fica em maiúscula.
    assert.equal(r, "Texto.\nhttps://example.com");
  });
});
