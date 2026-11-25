import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNewsletterConsensus, consensusUnscoredArticles, realTitle, renderNewsletterConsensus, storyDate, type ConsensusLink } from "../scripts/lib/newsletter-consensus.ts";
import { applyDecisions, buildIntake, joinKey } from "../scripts/audit-newsletter-intake.ts";
import { consensusAlwaysSenders, validateSenderRegistry } from "../scripts/lib/newsletter-senders.ts";
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
  it("The News usa endereço exato do registro, filtro do pool e inclui IA com uma só menção", () => {
    const always = new Set(["created@thenewscc.com.br", "newsletter@thenewscc.com.br"]);
    const buildTN = (links: ConsensusLink[]) => buildNewsletterConsensus(links, [], [], [], joinKey, always);
    for (const sender of always) {
      const out = buildTN([link("https://a.test/ia", "OpenAI announces ChatGPT update", `Renomeado <${sender}>`)]);
      assert.equal(out.length, 1); assert.equal(out[0].the_news, true);
    }
    assert.equal(buildTN([link("https://a.test/sports", "Resultado da rodada de futebol", "created@thenewscc.com.br")]).length, 0);
    assert.equal(buildTN([link("https://a.test/ia", "ChatGPT update", "The News <fake@x.test>")]).length, 0);
    // Sem a marca no registro, nem o endereço do The News ativa a exceção.
    assert.equal(build([link("https://a.test/ia", "OpenAI announces ChatGPT update", "created@thenewscc.com.br")]).length, 0);
  });
  it("marca consensus_ai_always: só aprovados, validada, preservada em nova decisão e presente no seed real", () => {
    const reg = {version: 1 as const, senders: {
      "a@x.test": {status: "aprovado" as const, reason: "r", decided_at: "2026-11-24", consensus_ai_always: true},
      "b@x.test": {status: "rejeitado" as const, reason: "r", decided_at: "2026-11-24", consensus_ai_always: true},
      "c@x.test": {status: "aprovado" as const, reason: "r", decided_at: "2026-11-24"}}};
    assert.deepEqual([...consensusAlwaysSenders(reg)], ["a@x.test"]);
    assert.throws(() => validateSenderRegistry({version: 1, senders: {"a@x.test": {...reg.senders["a@x.test"], consensus_ai_always: "sim"}}}), /consensus_ai_always/);
    const dir = mkdtempSync(join(tmpdir(), "consensus-13885-"));
    const path = join(dir, "senders.json");
    writeFileSync(path, JSON.stringify(reg));
    applyDecisions(path, {"a@x.test": {status: "aprovado", reason: "redecidido", decided_at: "2026-11-25"}});
    assert.equal(JSON.parse(readFileSync(path, "utf8")).senders["a@x.test"].consensus_ai_always, true);
    const seed = validateSenderRegistry(JSON.parse(readFileSync(new URL("../seed/newsletter-senders.json", import.meta.url), "utf8")));
    assert.ok(consensusAlwaysSenders(seed).has("created@thenewscc.com.br"));
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
  describe("review da PR #13917: consenso falso e encadeamento", () => {
    const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/newsletter-consensus-13885/261124-encadeamento.json", import.meta.url), "utf8")).links as ConsensusLink[];
    it("título genérico (Home, Home | Marca) não junta URLs diferentes nem vira assunto", () => {
      assert.equal(realTitle("Home"), false); assert.equal(realTitle("Home | AI Dev & Research News (Marktechpost.com)"), false);
      assert.equal(realTitle("Introducing Gemini 4 Neon"), true);
      assert.equal(build([link("https://www.anthropic.com/", "Home", "a@x.test"),
        link("https://www.deasylabs.com/?shad=1", "Home", "b@x.test")]).length, 0);
      assert.equal(build(fixture()).some((g) => g.urls.includes("https://www.deasylabs.com/?shad=1")), false);
    });
    it("título de 1-2 palavras e raiz de site só juntam pela URL", () => {
      assert.equal(build([link("https://a.test/p", "Anthropic", "a@x.test"), link("https://b.test/q", "Anthropic", "b@x.test")]).length, 0);
      assert.equal(build([link("https://a.test/", "Anthropic launches Claude Sonnet 5.5", "a@x.test"),
        link("https://b.test/y", "Anthropic launches Claude Sonnet 5.5", "b@x.test")]).length, 0);
      // Mesma URL continua sendo consenso mesmo com título curto.
      assert.equal(build([link("https://a.test/p", "Anthropic", "a@x.test"), link("https://a.test/p", "Anthropic", "b@x.test")])[0].count, 2);
    });
    it("rótulos próprios diferentes (Crossfade × seo-skills) não se juntam por ferramentas citadas", () => {
      assert.equal(build(fixture()).some((g) => g.urls.includes("https://crossfade.company/")), false);
    });
    it("URL só entra casando com o representante, nunca com um membro intermediário", () => {
      // B casa com A (Dots) e com C (Argon); C não casa com o representante A: sem single-linkage.
      const out = build([link("https://a.test/1", "OpenAI launches Dots for ChatGPT users", "a@x.test"),
        link("https://a.test/1", "OpenAI launches Dots for ChatGPT users", "b@x.test"),
        link("https://b.test/2", "OpenAI pairs Dots with Argon in new bundle", "c@x.test"),
        link("https://c.test/3", "OpenAI Argon model leaks ahead of launch", "d@x.test")]);
      const group = out.find((g) => g.urls.includes("https://a.test/1"))!;
      assert.equal(group.urls.includes("https://b.test/2"), true);
      assert.equal(group.urls.includes("https://c.test/3"), false);
      assert.equal(group.count, 3);
    });
    it("Jensen Huang (D1 261124) conta 4 newsletters, não 5: as matérias de 17/11 são outro evento", () => {
      const out = build(fixture());
      const jensen = out.find((g) => g.urls.some((u) => u.includes("nvidia-board-reinstates")))!;
      assert.equal(jensen.count, 4);
      assert.equal(jensen.newsletters.some((n) => /7min/.test(n)), false);
      assert.equal(jensen.urls.some((u) => u.includes("/2026/11/17/")), false);
    });
    it("#13921: anúncio (17/11) e cobertura do mesmo fato (20/11) seguem no mesmo assunto", () => {
      const links = [link("https://a.test/2026/11/17/x", "Anthropic launches Claude Sonnet 5.5 for everyone", "a@x.test"),
        link("https://b.test/2026/11/20/y", "Anthropic launches Claude Sonnet 5.5 for all users", "b@x.test")];
      const out = build(links);
      assert.equal(out.length, 1); assert.equal(out[0].count, 2);
      // Metadado do pool (data de publicação) vale igual à data da URL.
      const meta = [{url: "https://c.test/p", date: "2026-11-17"}, {url: "https://d.test/q", published_date: "2026-11-20T08:00:00Z"}];
      const viaMeta = buildNewsletterConsensus([link("https://c.test/p", links[0].title, "a@x.test"),
        link("https://d.test/q", links[1].title, "b@x.test")], meta, [], [], joinKey);
      assert.equal(viaMeta.length, 1); assert.equal(viaMeta[0].count, 2);
    });
    it("#13921: representante expulso pela data não deixa os restantes juntos só por casarem com ele", () => {
      // Os 3 de 23/11 casam com o representante de 17/11, mas não entre si.
      const out = build([link("https://a.test/2026/11/17/dots", "OpenAI launches Dots for ChatGPT users", "a@x.test"),
        link("https://a.test/2026/11/17/dots", "OpenAI launches Dots for ChatGPT users", "b@x.test"),
        link("https://b.test/2026/11/23/worldwide", "Dots launches for ChatGPT users worldwide", "c@x.test"),
        link("https://c.test/2026/11/23/brazil", "Launches Dots for ChatGPT users in Brazil", "d@x.test"),
        link("https://d.test/2026/11/23/today", "Dots for ChatGPT users launches today", "e@x.test")]);
      assert.deepEqual(out.map((g) => [g.urls, g.count]), [[["https://a.test/2026/11/17/dots"], 2]]);
    });
    it("#13921: dia ou mês inválido no caminho da URL não vira outra data", () => {
      assert.equal(storyDate("https://x.test/2026/11/45/a"), null);
      assert.equal(storyDate("https://x.test/2026/02/30/a"), null);
      assert.equal(storyDate("https://x.test/2026/13/01/a"), null);
      assert.equal(storyDate("https://x.test/2028/02/29/a"), Date.UTC(2028, 1, 29));
    });
    it("data vem do metadado ou do caminho da URL", () => {
      assert.equal(storyDate("https://techcrunch.com/2026/11/17/x"), Date.UTC(2026, 10, 17));
      assert.equal(storyDate("https://metr.org/blog/2026-11-20-q4"), Date.UTC(2026, 10, 20));
      assert.equal(storyDate("https://x.test/a", {date: "2026-11-23T10:00:00Z"}), Date.UTC(2026, 10, 23));
      assert.equal(storyDate("https://openai.com/index/x"), null);
    });
    it("Assunto sem título real mostra domínio+caminho e o placeholder não vai como title ao scorer", () => {
      const out = build([link("https://thinkingmachines.ai/news/inkling-2-mini", "(newsletter:A)", "a@x.test", null),
        link("https://thinkingmachines.ai/news/inkling-2-mini", "(newsletter:B)", "b@x.test", null)]);
      assert.equal(out[0].title, "título pendente (thinkingmachines.ai/news/inkling-2-mini)");
      assert.equal(out[0].title_pending, true);
      assert.doesNotMatch(renderNewsletterConsensus(out).join("\n"), /\(newsletter:/);
      const [art] = consensusUnscoredArticles(out, [{url: out[0].url, title: "(newsletter:A)", summary: "s"}], joinKey);
      assert.equal(art.title, undefined); assert.equal(art.title_unresolved, true); assert.equal(art.summary, "s");
      const [real] = consensusUnscoredArticles(build([link("https://a.test/x", "Introducing Gemini 4 Neon", "a@x.test", null),
        link("https://a.test/x", "Introducing Gemini 4 Neon", "b@x.test", null)]), [], joinKey);
      assert.equal(real.title, "Introducing Gemini 4 Neon");
    });
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
  it("intake liga a marca do registro: IA do remetente marcado entra com 1 só newsletter", () => {
    const url = "https://openai.com/index/solo-launch";
    const mk = (flag: boolean) => ({version: 1 as const, senders: {"tn@x.test": {status: "aprovado" as const, reason: "t", decided_at: "2026-11-24",
      ...(flag ? {consensus_ai_always: true} : {})}}});
    const threads = [{thread_id: "t", sender: "The News <tn@x.test>", body: url, subject: "s", date: "2026-11-24"}];
    const scores = [{articles: [{url, title: "OpenAI launches ChatGPT update", score: 75}]}];
    const on = buildIntake(threads, mk(true), scores, [], []).newsletter_consensus;
    assert.equal(on.length, 1); assert.equal(on[0].the_news, true); assert.equal(on[0].score, 75);
    assert.equal(buildIntake(threads, mk(false), scores, [], []).newsletter_consensus.length, 0);
  });
});
