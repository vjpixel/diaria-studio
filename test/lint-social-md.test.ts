import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPlatformSection,
  lintLinkedinCTAs,
  lintFacebookCTAs,
  lintSocialMd,
  lintRelativeTime,
  lintLinkedinSchema,
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

describe("lintLinkedinSchema (#595)", () => {
  function buildMd(parts: { d1?: string; d2?: string; d3?: string }): string {
    const sections: string[] = ["# LinkedIn", ""];
    if (parts.d1) sections.push("## d1", parts.d1);
    if (parts.d2) sections.push("## d2", parts.d2);
    if (parts.d3) sections.push("## d3", parts.d3);
    return sections.join("\n");
  }

  function fullDestaque(): string {
    const main = "X".repeat(1300);
    // comment_diaria: 200-400 chars tolerância. Inclui {edition_url} placeholder.
    const cd =
      "Edição completa com mais 9 destaques de IA do dia em {edition_url}" +
      "\n\nReceba a Diar.ia todo dia por e-mail, assine grátis em diar.ia.br" +
      "\n\nMais sobre esse e outros casos.";
    // comment_pixel: 300-600 chars tolerância. ~400.
    const cp =
      "Pra quem implanta agente em produção, o frame mudou: a discussão central " +
      "não é mais 'esse modelo é seguro?' e sim 'qual é o blast radius de um agente " +
      "que se replica sozinho?' Permissão de rede vira controle primário, não " +
      "secundário. E a maioria dos setups que vi essa semana não trata assim.";
    return `\n${main}\n\n### comment_diaria\n\n${cd}\n\n### comment_pixel\n\n${cp}\n`;
  }

  it("ok=true quando todos 3 destaques têm main + comment_diaria + comment_pixel", () => {
    const md = buildMd({ d1: fullDestaque(), d2: fullDestaque(), d3: fullDestaque() });
    const r = lintLinkedinSchema(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.destaques.length, 3);
    for (const d of r.destaques) {
      assert.equal(d.has_main, true);
      assert.equal(d.has_comment_diaria, true);
      assert.equal(d.has_comment_pixel, true);
    }
  });

  it("ok=false quando comment_diaria ausente em d2", () => {
    const dWithoutComments = `\n${"X".repeat(1300)}\n`;
    const md = buildMd({
      d1: fullDestaque(),
      d2: dWithoutComments,
      d3: fullDestaque(),
    });
    const r = lintLinkedinSchema(md);
    assert.equal(r.ok, false);
    const errs = r.errors.filter((e) => e.destaque === "d2");
    assert.ok(errs.some((e) => e.rule === "missing_comment_diaria"));
    assert.ok(errs.some((e) => e.rule === "missing_comment_pixel"));
  });

  it("ok=false quando comment_pixel ausente em d3", () => {
    const dPartial = `\n${"X".repeat(1300)}\n\n### comment_diaria\n\nEdição completa em {edition_url}\n\nReceba em diar.ia.br\n\nMais sobre o caso.\n`;
    const md = buildMd({ d1: fullDestaque(), d2: fullDestaque(), d3: dPartial });
    const r = lintLinkedinSchema(md);
    assert.equal(r.ok, false);
    const errs = r.errors.filter((e) => e.destaque === "d3");
    assert.ok(errs.some((e) => e.rule === "missing_comment_pixel"));
    // comment_diaria está presente
    assert.ok(!errs.some((e) => e.rule === "missing_comment_diaria"));
  });

  it("warning de char count quando main muito curto", () => {
    const dSmallMain = `\n${"X".repeat(500)}\n\n### comment_diaria\n\nEdição completa em {edition_url}\n\nReceba em diar.ia.br\n\nMais sobre o caso.\n\n### comment_pixel\n\n${"Y".repeat(400)}\n`;
    const md = buildMd({ d1: dSmallMain, d2: fullDestaque(), d3: fullDestaque() });
    const r = lintLinkedinSchema(md);
    assert.equal(r.ok, false);
    const errs = r.errors.filter((e) => e.destaque === "d1" && e.rule === "main_chars_out_of_range");
    assert.equal(errs.length, 1);
  });

  it("#595: erro quando comment_diaria sem placeholder {edition_url} nem URL resolvida", () => {
    const dWithoutUrl = `\n${"X".repeat(1300)}\n\n### comment_diaria\n\nReceba notícias de IA em diar.ia.br hoje mesmo, é grátis e simples.\n\n### comment_pixel\n\n${"Y".repeat(400)}\n`;
    const md = buildMd({ d1: dWithoutUrl, d2: fullDestaque(), d3: fullDestaque() });
    const r = lintLinkedinSchema(md);
    assert.equal(r.ok, false);
    const errs = r.errors.filter(
      (e) => e.destaque === "d1" && e.rule === "comment_diaria_missing_edition_url",
    );
    assert.equal(errs.length, 1);
  });

  it("#595: aceita comment_diaria com URL diar.ia.br/p/<slug> (resolvido pós-Stage 4)", () => {
    const dResolved = `\n${"X".repeat(1300)}\n\n### comment_diaria\n\nEdição completa em https://diar.ia.br/p/modelos-replicam\n\nReceba grátis em diar.ia.br\n\nÉ rápido.\n\n### comment_pixel\n\n${"Y".repeat(400)}\n`;
    const md = buildMd({ d1: dResolved, d2: fullDestaque(), d3: fullDestaque() });
    const r = lintLinkedinSchema(md);
    const errs = r.errors.filter((e) => e.rule === "comment_diaria_missing_edition_url");
    assert.equal(errs.length, 0);
  });

  it("ok=true em md sem seção LinkedIn (no-op)", () => {
    const md = "# Facebook\n\n## d1\nApenas FB.\n";
    const r = lintLinkedinSchema(md);
    assert.equal(r.ok, true);
    assert.equal(r.destaques.length, 0);
  });
});
