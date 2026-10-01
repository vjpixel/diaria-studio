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
    assert.ok(!isNonContentUrl("https://example.com/how-to-opt-out-of-ai-training"));
    assert.ok(!isNonContentUrl("https://example.com/blog/why-users-unsubscribe-from-ai-apps"));
    assert.ok(isNonContentUrl("https://example.com/opt-out?id=1"));
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

describe("#9292 newsletter_extracted: anti_bot, allowlist e contagem alinhada", () => {
  const antiBot = {
    url: "https://openai.com/index/introducing-gpt-6-3",
    title: "Introducing GPT-6.3",
    flag: "newsletter_extracted",
    verify_verdict: "anti_bot",
    summary: "OpenAI lança o GPT-6.3.",
  };
  const uncertain = {
    url: "https://openai.com/index/introducing-gpt-6-4",
    title: "Introducing GPT-6.4",
    flag: "newsletter_extracted",
    verify_verdict: "uncertain",
    summary: "OpenAI lança o GPT-6.4.",
  };
  const nonOfficial = {
    url: "https://some-blog.example/robot-vacuum-review",
    title: "Robot vacuum hands-on",
    flag: "newsletter_extracted",
    verify_verdict: "uncertain",
  };

  it("anti_bot com summary conta como verificado e fica em LANÇAMENTOS", () => {
    assert.equal(isUnverifiedNewsletterExtract(antiBot), false);
    const { approved: out } = demoteNotATool({ lancamento: [antiBot], radar: [] });
    assert.deepEqual((out.lancamento ?? []).map((i) => i.url), [antiBot.url]);
  });

  it("allowlist protege o item da demoção (escolha do editor)", () => {
    const allow = ["openai.com/index/introducing-gpt-6-4"];
    assert.equal(isUnverifiedNewsletterExtract(uncertain, allow), false);
    const summary = validateLancamentosFromApproved({ lancamento: [uncertain], radar: [] }, allow);
    assert.equal(summary.unverified_extract.length, 0);
    const { approved: out } = demoteNotATool({ lancamento: [uncertain], radar: [] }, allow);
    assert.deepEqual((out.lancamento ?? []).map((i) => i.url), [uncertain.url]);
  });

  it("contagem unverified_extract == itens que demoteNotATool move por esse motivo", () => {
    const approved = { lancamento: [antiBot, uncertain, nonOfficial], radar: [] };
    const summary = validateLancamentosFromApproved(approved);
    const { approved: out } = demoteNotATool(approved);
    const movedByReason = (out.radar ?? [])
      .filter((r) => r.demoted_reason === "unverified_newsletter_extract")
      .map((r) => r.url)
      .sort();
    assert.deepEqual(summary.unverified_extract.map((u) => u.url).sort(), movedByReason);
    assert.deepEqual(movedByReason, [nonOfficial.url, uncertain.url].sort());
  });
});
