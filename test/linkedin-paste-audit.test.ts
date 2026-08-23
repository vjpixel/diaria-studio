/**
 * test/linkedin-paste-audit.test.ts (#5988)
 *
 * Cobre `scripts/lib/linkedin-paste-audit.ts`: contagem de âncoras, UTM
 * preservada/divergente/ausente, `textContent.length` dentro/fora da
 * tolerância, o padrão específico do bug de split de âncora "diar.ia.br"
 * nu (achado 260823, PR #5987), e o caso "tudo ok".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  auditLinkedinPaste,
  extractAnchorsFromHtml,
  stripHtmlToText,
  looksLikeBareDomainAnchorText,
  TEXT_LENGTH_TOLERANCE_RATIO,
  type LinkedinPasteAuditInput,
} from "../scripts/lib/linkedin-paste-audit.ts";

const CTA_ABERTURA = `<a href="https://diar.ia.br/?utm_source=linkedin&utm_medium=newsletter&utm_campaign=ln-26w34&utm_content=cta-abertura">Assinar a edição diária</a>`;
const CTA_FIM = `<a href="https://diar.ia.br/?utm_source=linkedin&utm_medium=newsletter&utm_campaign=ln-26w34&utm_content=cta-fim">Assine grátis, é rapidinho →</a>`;
const MENCAO = `<a href="https://diar.ia.br/?utm_source=linkedin&utm_medium=newsletter&utm_campaign=ln-26w34&utm_content=mencao-abertura">diar.ia.br, newsletter de IA</a>`;

function sourceHtmlWith(...anchorsHtml: string[]): string {
  return `<p>Abertura com uma menção a ${anchorsHtml[0] ?? ""} no meio da frase.</p>\n<h2>1. Título</h2>\n<p>Corpo do destaque.</p>\n<p>${anchorsHtml.slice(1).join("</p>\n<p>")}</p>`;
}

describe("extractAnchorsFromHtml", () => {
  it("extrai href + texto de cada âncora, decodificando entidades", () => {
    const html = `<p>Veja <a href="https://exemplo.com/?a=1&amp;b=2">o link &quot;especial&quot;</a> aqui.</p>`;
    const anchors = extractAnchorsFromHtml(html);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].href, "https://exemplo.com/?a=1&amp;b=2");
    assert.equal(anchors[0].text, 'o link "especial"');
  });

  it("retorna [] quando não há âncoras", () => {
    assert.deepEqual(extractAnchorsFromHtml("<p>Sem links aqui.</p>"), []);
  });
});

describe("stripHtmlToText", () => {
  it("remove tags e decodifica entidades comuns", () => {
    assert.equal(stripHtmlToText("<p>Foo &amp; Bar</p>\n<p>Baz&nbsp;Qux</p>"), "Foo & Bar\nBaz Qux");
  });
});

describe("looksLikeBareDomainAnchorText", () => {
  it("detecta o wordmark sozinho ou seguido de continuação (o padrão do bug PR #5987)", () => {
    assert.ok(looksLikeBareDomainAnchorText("diar.ia.br"));
    assert.ok(looksLikeBareDomainAnchorText("diar.ia.br, newsletter de IA"));
    assert.ok(looksLikeBareDomainAnchorText("  diar.ia.br "));
    assert.ok(looksLikeBareDomainAnchorText("DIAR.IA.BR."));
  });

  it("não marca texto que não começa com o wordmark", () => {
    assert.ok(!looksLikeBareDomainAnchorText("Assine em diar.ia.br"));
    assert.ok(!looksLikeBareDomainAnchorText("Assine grátis →"));
    assert.ok(!looksLikeBareDomainAnchorText("diariabrasil.com"));
  });
});

describe("auditLinkedinPaste — caso tudo ok", () => {
  it("ok:true, issues:[] quando âncoras e texto batem", () => {
    const sourceHtml = sourceHtmlWith(MENCAO, CTA_ABERTURA, CTA_FIM);
    const pastedAnchors = extractAnchorsFromHtml(sourceHtml); // simula paste perfeito
    const input: LinkedinPasteAuditInput = {
      sourceHtml,
      pastedAnchors,
      pastedTextLength: stripHtmlToText(sourceHtml).length,
    };
    const result = auditLinkedinPaste(input);
    assert.deepEqual(result, { ok: true, issues: [] });
  });
});

describe("auditLinkedinPaste — contagem de âncoras divergente", () => {
  it("flags quando o colado tem menos âncoras que a fonte", () => {
    const sourceHtml = sourceHtmlWith(MENCAO, CTA_ABERTURA, CTA_FIM);
    const allAnchors = extractAnchorsFromHtml(sourceHtml);
    const input: LinkedinPasteAuditInput = {
      sourceHtml,
      pastedAnchors: allAnchors.slice(0, 2), // perdeu 1
      pastedTextLength: stripHtmlToText(sourceHtml).length,
    };
    const result = auditLinkedinPaste(input);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => /Contagem de âncoras diverge/.test(i)), result.issues.join("\n"));
  });

  it("flags quando o colado tem MAIS âncoras que a fonte (ex: split criou uma extra)", () => {
    const sourceHtml = sourceHtmlWith(MENCAO, CTA_ABERTURA);
    const allAnchors = extractAnchorsFromHtml(sourceHtml);
    const input: LinkedinPasteAuditInput = {
      sourceHtml,
      pastedAnchors: [...allAnchors, { href: "http://diar.ia.br/", text: "diar.ia.br" }],
      pastedTextLength: stripHtmlToText(sourceHtml).length,
    };
    const result = auditLinkedinPaste(input);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => /Contagem de âncoras diverge/.test(i)), result.issues.join("\n"));
  });
});

describe("auditLinkedinPaste — UTM ausente/divergente numa âncora preservada", () => {
  it("flags utm_campaign divergente mesmo com contagem e texto batendo", () => {
    const sourceHtml = sourceHtmlWith(CTA_ABERTURA, CTA_FIM);
    const pastedAnchors = extractAnchorsFromHtml(sourceHtml).map((a) => ({
      ...a,
      href: a.href.includes("cta-abertura") ? a.href.replace("ln-26w34", "ln-26w33") : a.href,
    }));
    const input: LinkedinPasteAuditInput = { sourceHtml, pastedAnchors, pastedTextLength: stripHtmlToText(sourceHtml).length };
    const result = auditLinkedinPaste(input);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => /utm_campaign divergente/.test(i)), result.issues.join("\n"));
  });

  it("flags UTM ausente (href virou link cru sem query) numa âncora com texto preservado", () => {
    const sourceHtml = sourceHtmlWith(CTA_ABERTURA, CTA_FIM);
    const pastedAnchors = extractAnchorsFromHtml(sourceHtml).map((a) => (a.text === "Assinar a edição diária" ? { ...a, href: "https://diar.ia.br/" } : a));
    const input: LinkedinPasteAuditInput = { sourceHtml, pastedAnchors, pastedTextLength: stripHtmlToText(sourceHtml).length };
    const result = auditLinkedinPaste(input);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => /utm_campaign divergente/.test(i) && i.includes("Assinar a edição diária")), result.issues.join("\n"));
  });

  it("não audita âncoras da fonte que já não carregam UTM (nada a perder)", () => {
    const sourceHtml = `<p>Veja <a href="https://exemplo-externo.com/artigo">a fonte</a> original.</p>`;
    const pastedAnchors = [{ href: "https://exemplo-externo.com/artigo-diferente", text: "a fonte" }];
    const result = auditLinkedinPaste({ sourceHtml, pastedAnchors, pastedTextLength: stripHtmlToText(sourceHtml).length });
    assert.equal(result.ok, true, result.issues.join("\n"));
  });
});

describe("auditLinkedinPaste — textContent.length muito menor que o esperado (perda de conteúdo)", () => {
  it("flags quando a diferença excede a tolerância", () => {
    const sourceHtml = sourceHtmlWith(MENCAO, CTA_ABERTURA, CTA_FIM);
    const expected = stripHtmlToText(sourceHtml).length;
    const pastedAnchors = extractAnchorsFromHtml(sourceHtml);
    const result = auditLinkedinPaste({
      sourceHtml,
      pastedAnchors,
      pastedTextLength: Math.floor(expected * (1 - TEXT_LENGTH_TOLERANCE_RATIO - 0.05)), // bem abaixo da tolerância
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => /Tamanho do texto colado diverge/.test(i) && /menor/.test(i)), result.issues.join("\n"));
  });

  it("NÃO flags quando a diferença está dentro da tolerância (ruído de normalização de espaçamento)", () => {
    const sourceHtml = sourceHtmlWith(MENCAO, CTA_ABERTURA, CTA_FIM);
    const expected = stripHtmlToText(sourceHtml).length;
    const pastedAnchors = extractAnchorsFromHtml(sourceHtml);
    const result = auditLinkedinPaste({
      sourceHtml,
      pastedAnchors,
      pastedTextLength: Math.floor(expected * (1 - TEXT_LENGTH_TOLERANCE_RATIO / 2)), // metade da tolerância
    });
    assert.equal(
      result.issues.some((i) => /Tamanho do texto colado diverge/.test(i)),
      false,
      result.issues.join("\n"),
    );
  });

  it("flags também quando o colado é MAIOR que o esperado (indício de paste duplicado)", () => {
    const sourceHtml = sourceHtmlWith(MENCAO, CTA_ABERTURA, CTA_FIM);
    const expected = stripHtmlToText(sourceHtml).length;
    const pastedAnchors = extractAnchorsFromHtml(sourceHtml);
    const result = auditLinkedinPaste({
      sourceHtml,
      pastedAnchors,
      pastedTextLength: Math.ceil(expected * 2), // dobrou — cenário de duplicação
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => /Tamanho do texto colado diverge/.test(i) && /maior/.test(i)), result.issues.join("\n"));
  });
});

describe("auditLinkedinPaste — bug de split de âncora 'diar.ia.br' nu (PR #5987)", () => {
  it("detecta a âncora dividida em duas (fragmento sem UTM + fragmento com UTM) e cita o padrão conhecido", () => {
    const sourceHtml = sourceHtmlWith(MENCAO, CTA_ABERTURA);
    // Simula o split real: "diar.ia.br, newsletter de IA" virou 2 âncoras —
    // "diar.ia.br" (sem UTM, href cru) + ", newsletter de IA" (com a UTM original).
    const pastedAnchors = [
      { href: "http://diar.ia.br/", text: "diar.ia.br" },
      {
        href: "https://diar.ia.br/?utm_source=linkedin&utm_medium=newsletter&utm_campaign=ln-26w34&utm_content=mencao-abertura",
        text: ", newsletter de IA",
      },
      ...extractAnchorsFromHtml(sourceHtml).filter((a) => a.text !== "diar.ia.br, newsletter de IA"),
    ];
    const result = auditLinkedinPaste({ sourceHtml, pastedAnchors, pastedTextLength: stripHtmlToText(sourceHtml).length });
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some((i) => i.includes("diar.ia.br, newsletter de IA") && /PR #5987/.test(i) && /não clicar direto sobre o link colado|NUNCA clicar direto sobre o link colado/i.test(i)),
      result.issues.join("\n"),
    );
  });

  it("não emite o hint do PR #5987 quando a âncora perdida não começa com o wordmark", () => {
    const sourceHtml = sourceHtmlWith(CTA_ABERTURA, CTA_FIM);
    const pastedAnchors = extractAnchorsFromHtml(sourceHtml).filter((a) => a.text !== "Assinar a edição diária");
    const result = auditLinkedinPaste({ sourceHtml, pastedAnchors, pastedTextLength: stripHtmlToText(sourceHtml).length });
    assert.equal(result.ok, false);
    const anchorIssue = result.issues.find((i) => i.includes("Assinar a edição diária"));
    assert.ok(anchorIssue, result.issues.join("\n"));
    assert.ok(!/PR #5987/.test(anchorIssue!), anchorIssue);
  });
});
