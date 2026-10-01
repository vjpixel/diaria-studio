/**
 * #9250 — item extraído de newsletter do inbox (edição 261001, 7min.ai) virou
 * LANÇAMENTO com o ASSUNTO do e-mail como título, sem summary, com um link de
 * unsubscribe do buttondown em `cluster_sources`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { titleFromSubmittedSubject } from "../scripts/enrich-inbox-articles.ts";
import { isNonContentUrl, extractNewsletterUrls } from "../scripts/inject-inbox-urls.ts";
import {
  demoteNotATool,
  isUnverifiedNewsletterExtract,
  validateLancamentosFromApproved,
} from "../scripts/validate-lancamentos.ts";

const SUBJECT =
  "S-1 da Anthropic revela prejuízo de US$ 42 bi, e OpenAI reage com agentes Dots e busca avaliação de US$ 1,4 tri";

describe("#9250 título: newsletter_extracted nunca herda o assunto do e-mail", () => {
  it("retorna null para newsletter_extracted com placeholder", () => {
    const t = titleFromSubmittedSubject({
      url: "https://openai.com/index/introducing-gpt-6-1-sol",
      title: '(newsletter:"7min.ai")',
      flag: "newsletter_extracted",
      submitted_subject: SUBJECT,
    });
    assert.equal(t, null);
  });

  it("editor_submitted continua usando o assunto (#1641 intacto)", () => {
    const t = titleFromSubmittedSubject({
      url: "https://example.com/a",
      title: "(inbox)",
      flag: "editor_submitted",
      submitted_subject: "Fwd: Lançamento X",
    });
    assert.equal(t, "Lançamento X");
  });
});

describe("#9250 links de unsubscribe/preferências nunca viram candidato", () => {
  it("reconhece o caso real e variantes comuns", () => {
    assert.ok(
      isNonContentUrl(
        "https://buttondown.com/unsubscribe/876e0601-c931-40aa-be2a-0604660d23d1?email=2f33521b",
      ),
    );
    assert.ok(isNonContentUrl("https://example.substack.com/action/disable_email?token=x&type=unsubscribe"));
    assert.ok(isNonContentUrl("https://news.example.com/manage-preferences?id=1"));
    assert.ok(isNonContentUrl("https://x.us1.list-manage.com/profile?u=1"));
  });

  it("não filtra artigo legítimo", () => {
    assert.ok(!isNonContentUrl("https://openai.com/index/introducing-gpt-6-1-sol"));
    assert.ok(!isNonContentUrl("https://techcrunch.com/2026/09/29/unsubstantiated-claims-about-ai"));
  });

  it("extractNewsletterUrls descarta o unsubscribe", () => {
    const out = extractNewsletterUrls([
      {
        iso: "2026-09-30T09:11:03.000Z",
        from: "7min.ai <news@7min.ai>",
        subject: SUBJECT,
        urls: [
          "https://openai.com/index/introducing-gpt-6-1-sol",
          "https://buttondown.com/unsubscribe/876e0601?email=2f33",
        ],
      },
    ]);
    assert.deepEqual(
      out.map((a) => a.url),
      ["https://openai.com/index/introducing-gpt-6-1-sol"],
    );
  });
});

describe("#9250 LANÇAMENTOS exige summary verificado em newsletter_extracted", () => {
  const unverified = {
    url: "https://openai.com/index/introducing-gpt-6-1-sol",
    title: "Introducing GPT-6.1 Sol",
    flag: "newsletter_extracted",
    verify_verdict: "uncertain",
  };
  const verified = {
    url: "https://openai.com/index/introducing-gpt-6-2",
    title: "Introducing GPT-6.2",
    flag: "newsletter_extracted",
    verify_verdict: "accessible",
    summary: "OpenAI lança o GPT-6.2.",
  };

  it("predicado", () => {
    assert.equal(isUnverifiedNewsletterExtract(unverified), true);
    assert.equal(isUnverifiedNewsletterExtract({ ...verified, summary: "  " }), true);
    assert.equal(isUnverifiedNewsletterExtract(verified), false);
    assert.equal(isUnverifiedNewsletterExtract({ url: "x", flag: "editor_submitted" }), false);
  });

  it("validate + demote movem o item não verificado pra radar", () => {
    const approved = { lancamento: [unverified, verified], radar: [] };
    const summary = validateLancamentosFromApproved(approved);
    assert.deepEqual(
      summary.unverified_extract.map((u) => u.url),
      [unverified.url],
    );
    assert.equal(summary.final_count, 1);
    const { approved: out } = demoteNotATool(approved);
    assert.deepEqual(
      (out.lancamento ?? []).map((i) => i.url),
      [verified.url],
    );
    const moved = (out.radar ?? []).find((r) => r.url === unverified.url);
    assert.equal(moved?.demoted_reason, "unverified_newsletter_extract");
  });
});
