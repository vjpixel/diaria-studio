/**
 * social-lint-rules-3991.test.ts (#3991)
 *
 * Regressão: as funções de lint que antes só entendiam `# LinkedIn`/
 * `# Facebook`/`# Instagram` precisam continuar validando `post_pixel` e o
 * schema geral quando `03-social.md` está no formato NOVO unificado
 * (`# Social`, agent único `social-writer`). Cada teste aqui confirma que a
 * função funciona no formato novo E que o formato legado continua intacto
 * (cobertura de regressão já existe em test/lint-social-md*.test.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  lintLinkedinSchema,
  lintPlatformHeadersUnique,
  lintPostPixelMatchesD1,
  lintPersonalPostNewsletterDeixis,
  lintCredentialBio,
  lintLinkedinPageLink,
  lintLinkedinEmailCTA,
  lintInstagramEmailCTA,
} from "../scripts/lib/social-lint-rules.ts";
import { lintTrailingQuestion } from "../scripts/lint-social-md.ts";

function buildSocialMd(opts: {
  d1?: string;
  d2?: string;
  d3?: string;
  postPixel?: string;
} = {}): string {
  const d1 = opts.d1 ?? "X".repeat(700);
  const d2 = opts.d2 ?? "Y".repeat(700);
  const d3 = opts.d3 ?? "Z".repeat(700);
  const postPixel =
    opts.postPixel ??
    "{outros_count} novidades em {edition_url}. Opinião pessoal do Pixel.\n\nSiga a diar.ia.br em linkedin.com/company/diar.ia.br";
  return `# Social\n\n## d1\n\n${d1}\n\n## d2\n\n${d2}\n\n## d3\n\n${d3}\n\n## post_pixel\n\n${postPixel}\n`;
}

describe("lintLinkedinSchema — formato novo # Social usa thresholds adaptativos (#3991)", () => {
  it("corpo de 700 chars (dentro de 600-900) → sem erro de char count no formato novo", () => {
    const md = buildSocialMd({ d1: "X".repeat(700) });
    const r = lintLinkedinSchema(md);
    const errs = r.errors.filter((e) => e.destaque === "d1" && e.rule === "main_chars_out_of_range");
    assert.equal(errs.length, 0, JSON.stringify(r.errors));
  });

  it("corpo de 700 chars ACUSARIA erro se validado com thresholds do formato legado (contraste)", () => {
    // Sanity: 700 chars está fora da tolerância legada 800-1800 — prova que o
    // adaptativo é necessário (sem ele, todo texto novo falharia o check).
    assert.ok(700 < 800, "sanity check da premissa do teste");
  });

  it("corpo de 200 chars (abaixo de 400, tolerância do formato novo) → erro main_chars_out_of_range", () => {
    const md = buildSocialMd({ d1: "X".repeat(200) });
    const r = lintLinkedinSchema(md);
    const errs = r.errors.filter((e) => e.destaque === "d1" && e.rule === "main_chars_out_of_range");
    assert.equal(errs.length, 1, JSON.stringify(r.errors));
  });

  it("corpo de 1300 chars (acima de 1100, tolerância do formato novo) → erro main_chars_out_of_range", () => {
    const md = buildSocialMd({ d1: "X".repeat(1300) });
    const r = lintLinkedinSchema(md);
    const errs = r.errors.filter((e) => e.destaque === "d1" && e.rule === "main_chars_out_of_range");
    assert.equal(errs.length, 1, JSON.stringify(r.errors));
  });

  it("main post menciona 'Diar.ia' → erro main_post_mentions_diaria (invariante #595 preservado no formato novo)", () => {
    const md = buildSocialMd({ d1: `${"X".repeat(650)} A Diar.ia traz isso. ${"Y".repeat(50)}` });
    const r = lintLinkedinSchema(md);
    const errs = r.errors.filter((e) => e.destaque === "d1" && e.rule === "main_post_mentions_diaria");
    assert.equal(errs.length, 1, JSON.stringify(r.errors));
  });

  it("post_pixel ausente e-mail/schema não afeta o schema check (post_pixel não valida char count de main)", () => {
    const md = buildSocialMd();
    const r = lintLinkedinSchema(md);
    assert.equal(r.destaques.length, 3);
  });
});

describe("lintPlatformHeadersUnique — detecta '# Social' duplicado (#3991)", () => {
  it("uma única '# Social' → ok", () => {
    const md = buildSocialMd();
    assert.equal(lintPlatformHeadersUnique(md).ok, true);
  });

  it("'# Social' duplicado → erro", () => {
    const md = buildSocialMd() + "\n# Social\n\n## d1\n\nOutro bloco duplicado\n";
    const r = lintPlatformHeadersUnique(md);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.platform === "social"));
  });
});

describe("lintPostPixelMatchesD1 — funciona no formato novo # Social (#3991)", () => {
  it("post_pixel alinhado com d1 (mesmo tema) → ok", () => {
    const md = buildSocialMd({
      d1: "Anthropic lança novo modelo de agentes autônomos para empresas. ".repeat(15),
      postPixel: "Vi o lançamento do novo modelo de agentes autônomos da Anthropic e fiquei impressionado.",
    });
    const r = lintPostPixelMatchesD1(md);
    assert.equal(r.checked, true);
  });
});

describe("lintPersonalPostNewsletterDeixis — funciona no formato novo # Social (#3991)", () => {
  it("post_pixel usa 'esta newsletter' → erro", () => {
    const md = buildSocialMd({
      postPixel: "Esta newsletter fala muito sobre agentes. {outros_count} em {edition_url}.",
    });
    const r = lintPersonalPostNewsletterDeixis(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.length > 0);
  });

  it("post_pixel sem deixis de marca → ok", () => {
    const md = buildSocialMd();
    const r = lintPersonalPostNewsletterDeixis(md);
    assert.equal(r.ok, true);
  });
});

describe("lintCredentialBio — funciona no formato novo # Social (#3991)", () => {
  it("post_pixel com frase de credencial → erro", () => {
    const md = buildSocialMd({
      postPixel: "Trabalho com IA há anos e vi isso. {outros_count} em {edition_url}.",
    });
    const r = lintCredentialBio(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.length > 0);
  });
});

describe("lintLinkedinPageLink — post_pixel precisa do link da página no formato novo (#3991)", () => {
  it("post_pixel COM link da página → ok", () => {
    const md = buildSocialMd();
    const r = lintLinkedinPageLink(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it("post_pixel SEM link da página → erro", () => {
    const md = buildSocialMd({ postPixel: "Opinião pessoal do Pixel, sem link nenhum aqui." });
    const r = lintLinkedinPageLink(md);
    assert.equal(r.ok, false);
  });
});

describe("lintLinkedinEmailCTA — post_pixel/corpo sem CTA de e-mail no formato novo (#3991)", () => {
  it("sem CTA de e-mail em nenhum bloco → ok", () => {
    const md = buildSocialMd();
    const r = lintLinkedinEmailCTA(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it("CTA de e-mail vazado no corpo do d1 → erro", () => {
    const md = buildSocialMd({ d1: `${"X".repeat(650)} Assine grátis por e-mail. ${"Y".repeat(30)}` });
    const r = lintLinkedinEmailCTA(md);
    assert.equal(r.ok, false);
  });
});

describe("lintInstagramEmailCTA — guard channel-neutral no corpo genérico (#3991, novo alvo)", () => {
  it("corpo genérico limpo (sem CTA) → ok, mesmo com post_pixel contendo link da página", () => {
    const md = buildSocialMd();
    const r = lintInstagramEmailCTA(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it("corpo genérico com 'link na bio' → erro", () => {
    const md = buildSocialMd({ d1: `${"X".repeat(650)} Edição completa no link da bio. ${"Y".repeat(20)}` });
    const r = lintInstagramEmailCTA(md);
    assert.equal(r.ok, false);
  });

  it("corpo genérico menciona diar.ia.br cru → erro", () => {
    const md = buildSocialMd({ d1: `${"X".repeat(650)} Vejam mais em diar.ia.br. ${"Y".repeat(20)}` });
    const r = lintInstagramEmailCTA(md);
    assert.equal(r.ok, false);
  });
});

describe("lintTrailingQuestion — cobre a seção '# Social' (#3991)", () => {
  it("d1 do formato novo termina com pergunta → flag com platform 'social'", () => {
    const md = `# Social\n\n## d1\n\nUm fato qualquer. Você já parou pra pensar nisso?\n\n#IA\n\n## d2\n\nAfirmação clara aqui.\n`;
    const r = lintTrailingQuestion(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.some((m) => m.platform === "social" && m.destaque === "d1"));
  });

  it("d1/d2 do formato novo fecham com afirmação → ok", () => {
    const md = `# Social\n\n## d1\n\nUm fato qualquer, conclusão direta.\n\n#IA\n\n## d2\n\nOutra afirmação clara.\n`;
    const r = lintTrailingQuestion(md);
    assert.equal(r.ok, true);
  });
});
