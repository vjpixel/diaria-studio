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
