import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildNewsletterConsensus, renderNewsletterConsensus, type ConsensusLink } from "../scripts/lib/newsletter-consensus.ts";
import { buildIntake, joinKey } from "../scripts/audit-newsletter-intake.ts";
const link = (url: string, title: string, newsletter: string, score: number | null = 70): ConsensusLink =>
  ({url, title, newsletter, score, destino: "fora da edição", in_pool: false});
const build = (links: ConsensusLink[], final: Record<string, unknown>[] = [], removals: Record<string, unknown>[] = []) =>
  buildNewsletterConsensus(links, [], final, removals, joinKey);
describe("consenso por assunto #13885", () => {
  it("une URLs diferentes pelo mesmo sinal de história do pool e escolhe maior score", () => {
    const out = build([link("https://a.test/x", "Anthropic launches Claude Sonnet 5.5", "A <a@x.test>", 50),
      link("https://b.test/y", "Introducing Claude Sonnet 5.5 on AWS", "B <b@x.test>", 90),
      link("https://b.test/y", "Introducing Claude Sonnet 5.5 on AWS", "B <B@x.test>", 90)],
      [{url: "https://c.test/z", title: "Anthropic announces Claude Sonnet 5.5", destination: "D2"}]);
    assert.equal(out.length, 1); assert.equal(out[0].count, 2); assert.equal(out[0].score, 90);
    assert.equal(out[0].destino, "D2"); assert.equal(out[0].urls.length, 2);
  });
  it("não une assuntos diferentes de um mesmo modelo nem títulos placeholder", () => {
    assert.equal(build([link("https://a.test/x", "Claude Sonnet 5.5 banned in schools", "a@x.test"),
      link("https://b.test/y", "Anthropic launches Claude Sonnet 5.5", "b@x.test")]).length, 0);
    assert.equal(build([link("https://a.test/x", "(newsletter:A)", "a@x.test"),
      link("https://b.test/y", "(newsletter:A)", "b@x.test")]).length, 0);
  });
  it("The News usa endereço exato, filtro do pool e inclui IA com uma só menção", () => {
    for (const sender of ["created@thenewscc.com.br", "newsletter@thenewscc.com.br"]) {
      const out = build([link("https://a.test/ia", "OpenAI announces ChatGPT update", `Renomeado <${sender}>`)]);
      assert.equal(out.length, 1); assert.equal(out[0].the_news, true);
    }
    assert.equal(build([link("https://a.test/sports", "Resultado da rodada de futebol", "created@thenewscc.com.br")]).length, 0);
    assert.equal(build([link("https://a.test/ia", "ChatGPT update", "The News <fake@x.test>")]).length, 0);
  });
  it("expõe remoção real e pendência sem inventar score ou motivo", () => {
    const links = [link("https://a.test/x", "Introducing Gemini 4 Neon", "a@x.test", null),
      link("https://a.test/x", "Introducing Gemini 4 Neon", "b@x.test", null)];
    const out = build(links, [], [{url: links[0].url, dedup_note: "já publicado na janela"}]);
    assert.equal(out[0].score, null); assert.match(out[0].destino, /já publicado na janela/);
    assert.match(renderNewsletterConsensus(out).join("\n"), /PENDENTE/);
    assert.match(build(links)[0].destino, /motivo não registrado/);
  });
  it("regressão real 261124: Gemini 4 Neon citado por 4 newsletters fora do pool sem score", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/newsletter-consensus-13885/261124.json", import.meta.url), "utf8"));
    const out = build(fixture.links);
    assert.equal(out.length, 1); assert.equal(out[0].count, 4); assert.equal(out[0].score, null);
    assert.equal(out[0].title, "Introducing Gemini 4 Neon");
    assert.match(out[0].destino, /fora da edição/);
    const scored = fixture.links.map((l: ConsensusLink, i: number) => ({...l, score: i === 0 ? 82 : l.score}));
    assert.equal(build(scored)[0].score, 82);
  });
  it("intake inclui o bloco sem mudar os links e aceita pontuação suplementar", () => {
    const reg = {version: 1 as const, senders: {"a@x.test": {status: "aprovado" as const, reason: "teste", decided_at: "2026-11-24"},
      "b@x.test": {status: "aprovado" as const, reason: "teste", decided_at: "2026-11-24"}}};
    const url = "https://openai.com/index/test-launch";
    const threads = ["a", "b"].map((id) => ({thread_id: id, sender: `${id}@x.test`, body: url, subject: "s", date: "2026-11-24"}));
    const result = buildIntake(threads, reg, [{articles: [{url, title: "OpenAI launches ChatGPT update", score: 82}]}], [],
      [{url, title: "OpenAI launches ChatGPT update", destination: "destaque"}]);
    assert.equal(result.links.length, 2);
    assert.equal(result.newsletter_consensus[0].score, 82);
    assert.equal(result.newsletter_consensus[0].destino, "D1");
    assert.equal(result.newsletter_consensus[0].count, 2);
  });
});
