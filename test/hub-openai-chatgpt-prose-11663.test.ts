/**
 * #11663 — reconciliação da prosa do hub openai-chatgpt com o dataset
 * regenerado (edições de 17/09 a 28/10/2026).
 *
 * Trava os dois pontos que a revisão mudou em código, não só em texto:
 * (1) a manchete em que a OpenAI é o ALVO de uma invasão ("Claude ajudou a
 * invadir a OpenAI") não conta como episódio de IA da OpenAI invadindo
 * sistemas; (2) com o 16º lançamento (GPT-6.1 Terra), a prosa não volta a
 * dizer que a série terminou em 22/07 nem que o hiato de 53 dias é o maior.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOpenaiChatgptFaq, getOpenaiChatgptHub } from "../scripts/lib/hubs/openai-chatgpt.ts";
import type { HubSourceEntry } from "../scripts/generate-hub-sources.ts";

function entry(date: string, headline: string): HubSourceEntry {
  return {
    date,
    editionSlug: `slug-${date}`,
    url: `https://diar.ia.br/p/slug-${date}`,
    matchedHeadlines: [headline],
    primarySourceUrls: [],
    editionTitle: headline,
  } as HubSourceEntry;
}

describe("#11663 — hub openai-chatgpt", () => {
  it("OpenAI como alvo de invasão não conta no FAQ de agentes invadindo sistemas", () => {
    const sources = [
      entry("2026-07-23", "IA agiu sozinha e hackeou startup, revela OpenAI"),
      entry("2026-09-21", "Claude ajudou a invadir a OpenAI em menos de 3 dias"),
    ];
    const faq = buildOpenaiChatgptFaq(sources);
    const hack = faq.find((f) => /invadindo sistemas/.test(f.question));
    assert.ok(hack, "FAQ de invasão ausente");
    assert.match(hack.answer, /^Sim, 1 episódios/);
  });

  it("prosa real não declara o fim da série de lançamentos em 22/07 nem o hiato de 53 dias como o maior", () => {
    const hub = getOpenaiChatgptHub();
    const prose = [hub.introParagraph, ...hub.sections.flatMap((s) => s.paragraphs), ...hub.faq.map((f) => f.answer)].join("\n");
    assert.doesNotMatch(prose, /fechou a série de lançamentos/);
    assert.doesNotMatch(prose, /maior hiato do período/);
    assert.doesNotMatch(prose, /mais recente do período/);
    const s1 = hub.sections[0].paragraphs.join("\n");
    assert.match(s1, /GPT-6\.1 Terra/);
    assert.match(s1, /98 dias, o maior intervalo da série/);
  });
});
