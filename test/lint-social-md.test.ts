import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPlatformSection,
  lintLinkedinCTAs,
  lintFacebookCTAs,
  lintSocialMd,
  lintRelativeTime,
} from "../scripts/lint-social-md.ts";

const validMd = `# LinkedIn

## d1

Texto do post.

Receba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br

#Hashtag

## d2

Outro texto.

Receba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br

#Hashtag

# Facebook

## d1

Post do Facebook.

Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.

#Hashtag
`;

describe("extractPlatformSection", () => {
  it("extrai LinkedIn section", () => {
    const sec = extractPlatformSection(validMd, "linkedin");
    assert.ok(sec);
    assert.ok(sec!.includes("## d1"));
    assert.ok(!sec!.includes("Post do Facebook"));
  });

  it("extrai Facebook section", () => {
    const sec = extractPlatformSection(validMd, "facebook");
    assert.ok(sec);
    assert.ok(sec!.includes("Post do Facebook"));
  });

  it("retorna null quando seção ausente", () => {
    const sec = extractPlatformSection("# Twitter\n## d1", "linkedin");
    assert.equal(sec, null);
  });

  it("normaliza CRLF", () => {
    const md = "# LinkedIn\r\n## d1\r\nFoo\r\n";
    const sec = extractPlatformSection(md, "linkedin");
    assert.ok(sec);
  });
});

describe("lintLinkedinCTAs (#602)", () => {
  it("aceita 'em diar.ia.br' (formato canônico)", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br\n";
    assert.deepEqual(lintLinkedinCTAs(sec), []);
  });

  it("rejeita 'em https://diar.ia.br' (prefix)", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br\n";
    const errors = lintLinkedinCTAs(sec);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].rule, "no_https_prefix");
  });

  it("rejeita markdown link wrapper", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em [diar.ia.br](https://diar.ia.br)\n";
    const errors = lintLinkedinCTAs(sec);
    assert.equal(errors.length, 1);
  });

  it("rejeita ponto final", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br.\n";
    const errors = lintLinkedinCTAs(sec);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].rule, "no_trailing_period");
  });

  it("ignora linhas que mencionam diar.ia.br fora do CTA", () => {
    const sec = "O domínio diar.ia.br é citado em outro contexto.\n";
    assert.deepEqual(lintLinkedinCTAs(sec), []);
  });
});

describe("lintFacebookCTAs (#602)", () => {
  it("aceita 'em https://diar.ia.br.' (formato canônico Facebook)", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.\n";
    assert.deepEqual(lintFacebookCTAs(sec), []);
  });

  it("aceita markdown link wrapper (Drive auto-conversion)", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em [https://diar.ia.br](https://diar.ia.br).\n";
    assert.deepEqual(lintFacebookCTAs(sec), []);
  });

  it("rejeita 'em diar.ia.br' sem prefix", () => {
    const sec = "Receba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br\n";
    const errors = lintFacebookCTAs(sec);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].rule, "missing_https_prefix");
  });
});

describe("lintSocialMd integration", () => {
  it("md válido (LinkedIn sem prefix + Facebook com prefix) passa", () => {
    const result = lintSocialMd(validMd);
    assert.equal(result.ok, true);
  });

  it("LinkedIn com https:// + Facebook ok → falha só em LinkedIn", () => {
    const md = validMd.replace("em diar.ia.br\n\n#Hashtag", "em https://diar.ia.br\n\n#Hashtag");
    const result = lintSocialMd(md);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.platform === "linkedin"));
    assert.ok(!result.errors.some((e) => e.platform === "facebook"));
  });

  it("Facebook sem https:// → falha só em Facebook", () => {
    const md =
      "# LinkedIn\n## d1\nReceba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br\n\n# Facebook\n## d1\nReceba notícias de IA todo dia por e-mail, assine grátis em diar.ia.br\n";
    const result = lintSocialMd(md);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.platform === "facebook"));
  });
});

describe("lintRelativeTime (social, #747)", () => {
  it("ok sem referências temporais relativas", () => {
    const md = "# LinkedIn\n\nPost sem problemas, publicado em 2026-05-06.";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0);
  });

  it("detecta 'hoje' em post social", () => {
    const md = "# LinkedIn\n\nHoje a OpenAI lançou o GPT-6.\n\nassine em diar.ia.br";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches[0].word.toLowerCase(), "hoje");
  });

  it("detecta 'esta semana' com número da linha correto", () => {
    const md = "# LinkedIn\n\nEsta semana a regulação avançou no Brasil.\n\n# Facebook";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches[0].line, 3);
  });
});

describe("lintRelativeTime expansion (social, #877)", () => {
  it("detecta 'Hoje a Anthropic anunciou' (caso canônico do issue)", () => {
    const md = "# LinkedIn\n\nHoje a Anthropic anunciou um novo modelo.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.some((m) => m.word.toLowerCase() === "hoje"));
  });

  it("detecta 'há 3 dias' / 'há 2 semanas' / 'há 1 mês'", () => {
    for (const phrase of ["há 3 dias", "há 2 semanas", "há 1 mês", "há 6 meses"]) {
      const md = `# LinkedIn\n\nO modelo foi anunciado ${phrase}.\n`;
      const r = lintRelativeTime(md);
      assert.equal(r.ok, false, `esperava match para "${phrase}"`);
    }
  });

  it("detecta 'próxima semana' (sem 'na' obrigatório)", () => {
    const md = "# LinkedIn\n\nPróxima semana o GPT-6 será aberto a beta.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
  });

  it("detecta múltiplos matches numa linha", () => {
    const md = "# LinkedIn\n\nHoje a OpenAI fez um anúncio. Recentemente eles também atualizaram.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches.length, 2);
    const words = r.matches.map((m) => m.word.toLowerCase());
    assert.ok(words.includes("hoje"));
    assert.ok(words.includes("recentemente"));
  });

  it("não casa palavras compostas tipo 'ontem-feira' (hifenado)", () => {
    const md = "# LinkedIn\n\nElaborado pela ontem-feira corp.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true);
  });

  it("não casa 'anteontem' (sufixo de 'ontem')", () => {
    const md = "# LinkedIn\n\nIsso aconteceu anteontem mas seguimos em frente.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true);
  });

  it("pula match dentro de aspas duplas (citação direta de fonte)", () => {
    const md = `# LinkedIn\n\nO CEO disse "hoje vamos lançar tudo" durante o evento.\n`;
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true, JSON.stringify(r.matches));
  });

  it("pula match dentro de aspas curvas (smart quotes)", () => {
    const md = `# LinkedIn\n\nO CEO disse “ontem fechamos o trato” no anúncio.\n`;
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true);
  });

  it("pula match dentro de aspas simples (com espaço antes)", () => {
    const md = `# LinkedIn\n\nA fonte: 'esta semana foi histórica' marcou tudo.\n`;
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true);
  });

  it("ainda detecta match fora de aspas mesmo quando há aspas na mesma linha", () => {
    const md = `# LinkedIn\n\nHoje, segundo "fonte interna", houve mudança.\n`;
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].word.toLowerCase(), "hoje");
  });

  it("apóstrofo em palavra (d'água, L'Oréal) não conta como aspas", () => {
    const md = "# LinkedIn\n\nA L'Oréal não tem nada a ver, mas hoje teve outro anúncio.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    // 'hoje' não está dentro de aspas — deve ser detectado
    assert.ok(r.matches.some((m) => m.word.toLowerCase() === "hoje"));
  });

  // -- Overlap / boundary edge cases (P2 review #890) ---------------------
  it("'há 3 dias atrás' detecta 'há 3 dias' uma única vez (sem overlap)", () => {
    // 'atrás' depois de 'há 3 dias' não deve gerar match duplicado nem evitar
    // o match (lookahead `(?![\\w-])` para o fim da frase deve se satisfazer
    // com o espaço antes de 'atrás').
    const md = "# LinkedIn\n\nO modelo foi anunciado há 3 dias atrás no evento.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    const haCount = r.matches.filter((m) =>
      /^há \d+ dias?$/i.test(m.word),
    ).length;
    assert.equal(haCount, 1, `esperava 1 match 'há N dias', achou ${haCount}`);
  });

  it("'ahoje' (prefix grudado em palavra) NÃO casa 'hoje'", () => {
    const md = "# LinkedIn\n\nA palavra ahoje é inventada e não é referência.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, true);
  });

  it("'hoje,' (vírgula sufixo) casa 'hoje' normalmente", () => {
    const md = "# LinkedIn\n\nHoje, a empresa anunciou um novo modelo.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.some((m) => m.word.toLowerCase() === "hoje"));
  });

  it("'hoje.' (ponto sufixo) casa 'hoje' normalmente", () => {
    const md = "# LinkedIn\n\nA empresa anunciou hoje.\n";
    const r = lintRelativeTime(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.some((m) => m.word.toLowerCase() === "hoje"));
  });
});
