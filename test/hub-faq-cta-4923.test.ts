/**
 * test/hub-faq-cta-4923.test.ts (#4923)
 *
 * Regression: o FAQ final de cada hub tinha uma pergunta de CTA de
 * assinatura ("Como acompanho as próximas notícias sobre X?") sem número
 * nem link — o único item, dos 6-10 de cada hub, sem nenhum dado próprio. O
 * header já tem CTA próprio ("Assine a diar.ia.br →"), então o slot de FAQ
 * não precisa duplicá-lo. Este teste é a asserção que teria pego o defeito
 * original: TODA resposta de FAQ, em TODOS os hubs, carrega pelo menos 1
 * dígito ou 1 link interno `diar.ia.br`.
 *
 * `anthropic-claude` ganhou, além da troca, uma pergunta nova cobrindo a
 * S4 ("Em quais produtos e parcerias o Claude já apareceu?") — a seção mais
 * linkada do hub (15 links) e a única sem porta de entrada no FAQ.
 * `meta-ai` tinha o MESMO padrão de CTA-sem-dado que os 3 hubs originais
 * (verificado ao vivo contra o dataset real antes deste fix) — incluído no
 * mesmo escopo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HUB_LOADERS } from "../scripts/build-hub-page.ts";
import { buildOpenaiChatgptFaq } from "../scripts/lib/hubs/openai-chatgpt.ts";
import { buildMetaAiFaq } from "../scripts/lib/hubs/meta-ai.ts";

describe("#4923 — nenhum FAQ termina em CTA-sem-dado", () => {
  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`hub "${slug}": toda resposta de FAQ tem pelo menos 1 dígito ou 1 link diar.ia.br`, () => {
      const hub = HUB_LOADERS[slug]();
      for (const item of hub.faq) {
        const hasDigit = /\d/.test(item.answer);
        const hasInternalLink = /\[[^\]]+\]\(https:\/\/diar\.ia\.br\//.test(item.answer);
        assert.ok(
          hasDigit || hasInternalLink,
          `hub "${slug}", pergunta "${item.question}": resposta sem dígito nem link — ` +
            `${item.answer}`,
        );
      }
    });
  }

  it('anthropic-claude: pelo menos 1 "question" do FAQ casa /integra|parceri|produto/i (item 2 da issue — cobertura da S4)', () => {
    const hub = HUB_LOADERS["anthropic-claude"]();
    const matching = hub.faq.filter((f) => /integra|parceri|produto/i.test(f.question));
    assert.ok(
      matching.length > 0,
      `Nenhuma pergunta do FAQ de anthropic-claude casa /integra|parceri|produto\\/i.\n` +
        `Perguntas atuais:\n  ${hub.faq.map((f) => f.question).join("\n  ")}`,
    );
  });

  it("openai-chatgpt: pattern acentuado novo (saúde/prontuário/diagnóstico) sobrevive a texto NFD — mesma classe de bug do NFD/NFC original", () => {
    // Fixture sintético em NFD (mesmo molde do teste gêmeo de
    // anthropic-claude.ts) — decoupla esta proteção do estado real de
    // openai-chatgpt-sources.generated.json. Sem a normalização NFC dentro
    // de `countMatching`, este regex acentuado bateria 0 contra manchete em
    // NFD, do mesmo jeito que `/anthropic lanç/i` batia 0 antes do fix
    // original.
    const synthetic = [
      {
        date: "2026-01-01",
        editionSlug: "edicao-1",
        url: "https://diar.ia.br/p/edicao-1",
        matchedHeadlines: ["ChatGPT aplica medidas para cuidado com saúde mental".normalize("NFD")],
      },
      {
        date: "2026-02-01",
        editionSlug: "edicao-2",
        url: "https://diar.ia.br/p/edicao-2",
        matchedHeadlines: ["OpenAI conecta prontuário médico ao ChatGPT".normalize("NFD")],
      },
    ];
    const faq = buildOpenaiChatgptFaq(synthetic as never);
    const saudeFaq = faq.find((f) => /saúde apareceu como tema/.test(f.question));
    assert.ok(saudeFaq);
    assert.match(saudeFaq.answer, /Foram 2 manchetes/);
  });

  it('meta-ai: pattern acentuado novo ("óculos") sobrevive a texto NFD — mesma classe de bug do NFD/NFC original', () => {
    const synthetic = [
      {
        date: "2026-01-01",
        editionSlug: "edicao-1",
        url: "https://diar.ia.br/p/edicao-1",
        matchedHeadlines: ["Meta Ray-Ban Display: óculos com tela e IA".normalize("NFD")],
      },
      {
        date: "2026-02-01",
        editionSlug: "edicao-2",
        url: "https://diar.ia.br/p/edicao-2",
        matchedHeadlines: ["Meta AI chega ao Brasil".normalize("NFD")],
      },
    ];
    const faq = buildMetaAiFaq(synthetic as never);
    const alcanceFaq = faq.find((f) => /produtos de consumo/.test(f.question));
    assert.ok(alcanceFaq);
    assert.match(alcanceFaq.answer, /^2 lançamentos/);
  });
});
