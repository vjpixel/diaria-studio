/**
 * story-grouping-9360.test.ts (#9360, padrão 2)
 *
 * Regressão: várias coberturas da MESMA história sobreviviam no pool
 * (LANÇAMENTOS + RADAR) e o editor cortava todas no gate 4. Decisão do editor
 * (briefing 261002): agrupar, manter a fonte primária (domínio oficial da
 * empresa da história; senão maior score) e mandar as demais pros descartados.
 * Títulos/URLs reais das edições 260930 e 261001.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  groupSameStory,
  modelVersionTokens,
  sameStorySignal,
  isOfficialForStory,
} from "../scripts/lib/story-grouping.ts";
import { dedupIntraEdition } from "../scripts/dedup-intra-edition.ts";
import { sameEvent } from "../scripts/lib/event-dedup.ts";

const VB_SONNET = {
  url: "https://venturebeat.com/technology/anthropic-launches-claude-sonnet-5-5-with-30-cost-reduction-per-task-due-to-faster-speeds-and-fewer-tool-calls",
  title:
    "Anthropic launches Claude Sonnet 5.5 with 30% cost reduction per-task due to faster speeds and fewer tool calls",
  score: 70,
};
const AWS_SONNET = {
  url: "https://aws.amazon.com/blogs/machine-learning/introducing-claude-sonnet-5-5-on-aws/",
  title: "Introducing Claude Sonnet 5.5 on AWS",
  score: 62,
};
const BLOG_GOOGLE_ARGON = {
  url: "https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/",
  title: "Gemini 4 Argon: our next era of frontier intelligence",
  score: 60,
};
const CNN_ARGON = {
  url: "https://www.cnnbrasil.com.br/economia/money/inteligencia-artificial/apos-meses-de-atrasos-google-anuncia-argon-seu-principal-modelo-de-ia/",
  title: "Após meses de atrasos, Google anuncia Argon, seu principal modelo de IA",
  score: 78,
};
const VB_ARGON = {
  url: "https://venturebeat.com/technology/google-unveils-gemini-4-argon-retaking-benchmark-lead-over-openai-and-anthropic-but-in-limited-release",
  title:
    "Google unveils Gemini 4 Argon, retaking benchmark lead over OpenAI and Anthropic — but in limited release",
  score: 68,
};
const VB_DOTS = {
  url: "https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams",
  title:
    "OpenAI launches Dots, always-on AI agent coworkers, and ChatGPT Space where they can collaborate with human teams",
  score: 88,
};
const EXAME_DOTS = {
  url: "https://exame.com/inteligencia-artificial/openai-lanca-dots-agentes-de-ia-autonomos-que-operam-no-gpt-6-astra/",
  title: "A OpenAI quer controlar seu PC: como funciona o 'dots', o agente do ChatGPT",
  score: 81,
};
const WIRED_UNRELATED = {
  url: "https://www.wired.com/story/ai-agents-dots-devday-muse-battling-it-out/",
  title: "The Battle to Be Your Personal AI Agent Is Here",
  score: 60,
};

describe("modelVersionTokens (#9360)", () => {
  it("extrai família + versão", () => {
    assert.deepEqual([...modelVersionTokens("Introducing Claude Sonnet 5.5 on AWS")], ["sonnet 5.5"]);
    assert.deepEqual([...modelVersionTokens("OpenAI's GPT-6.1 Sol offers ...")], ["gpt 6.1"]);
    assert.deepEqual([...modelVersionTokens("Gemini 4 Argon: our next era")], ["gemini 4"]);
  });
  it("sem versão não gera token", () => {
    assert.equal(modelVersionTokens("Build plugins for Claude with the directory").size, 0);
  });
  it("sufixo de letra é outro modelo (gpt-4o não é gpt 4)", () => {
    assert.equal(modelVersionTokens("GPT-4o mini gets cheaper").size, 0);
  });
  it("mesma versão mas histórias diferentes NÃO agrupam (review PR #9430)", () => {
    for (const [a, b] of [
      ["GPT-6.1 banido em escolas", "GPT-6.1 ganha novo modo de voz"],
      ["Claude Opus 5.5 vaza prompt de sistema", "Como usar o Claude Opus 5.5 para planilhas"],
      ["Llama 4 lawsuit filed by authors", "Meta releases Llama 4 Scout"],
      ["Gemini 3 chega ao Android Auto", "Gemini 3 é acusado de viés em eleições"],
      ["GPT-4o mini gets cheaper", "Court rules on GPT-4 training data"],
    ]) {
      assert.equal(sameStorySignal(a, b), null, `${a} × ${b}`);
    }
  });
  it("mesma versão + os dois anunciando lançamento agrupa", () => {
    assert.equal(sameStorySignal(VB_SONNET.title, "Quase um Opus por uma fração do preço: novo Claude Sonnet 5.5 chega 30% mais barato"), "model_version");
  });
  it("versões diferentes do mesmo modelo não casam", () => {
    assert.equal(sameStorySignal("Claude Sonnet 5.5 chega", "Claude Sonnet 5 ganha recurso"), null);
  });
});

describe("isOfficialForStory (#9360)", () => {
  it("blog.google é a fonte primária de uma história do Google", () => {
    assert.equal(isOfficialForStory(BLOG_GOOGLE_ARGON.url, [CNN_ARGON.title, VB_ARGON.title]), true);
  });
  it("aws.amazon.com NÃO é a fonte primária do lançamento da Anthropic", () => {
    assert.equal(isOfficialForStory(AWS_SONNET.url, [VB_SONNET.title]), false);
  });
  it("imprensa nunca é oficial", () => {
    assert.equal(isOfficialForStory(VB_ARGON.url, [BLOG_GOOGLE_ARGON.title]), false);
  });
});

describe("groupSameStory (#9360)", () => {
  it("Argon (261001): mantém blog.google mesmo com score menor; CNN e VentureBeat vão pros descartados", () => {
    const r = groupSameStory({ lancamento: [BLOG_GOOGLE_ARGON], radar: [CNN_ARGON, VB_ARGON] });
    assert.deepEqual(r.buckets.lancamento.map((a) => a.url), [BLOG_GOOGLE_ARGON.url]);
    assert.deepEqual(r.buckets.radar, []);
    assert.deepEqual(r.removed.map((x) => x.url).sort(), [CNN_ARGON.url, VB_ARGON.url].sort());
    assert.ok(r.removed.every((x) => x.kept_url === BLOG_GOOGLE_ARGON.url));
    // descartados preservados como cluster_sources da primária (#3920/#4185)
    const srcs = (r.buckets.lancamento[0].cluster_sources ?? []).map((c) => c.url).sort();
    assert.deepEqual(srcs, [CNN_ARGON.url, VB_ARGON.url].sort());
  });

  it("Sonnet 5.5 (261001): sem oficial da Anthropic, fica a de maior score (AWS sai)", () => {
    const r = groupSameStory({ radar: [VB_SONNET, AWS_SONNET] });
    assert.deepEqual(r.buckets.radar.map((a) => a.url), [VB_SONNET.url]);
    assert.deepEqual(r.removed.map((x) => x.url), [AWS_SONNET.url]);
  });

  it("Dots (261001): duas coberturas viram uma; história diferente da mesma empresa fica", () => {
    const r = groupSameStory({ radar: [VB_DOTS, EXAME_DOTS, WIRED_UNRELATED] });
    assert.deepEqual(r.buckets.radar.map((a) => a.url), [VB_DOTS.url, WIRED_UNRELATED.url]);
    assert.deepEqual(r.removed.map((x) => x.url), [EXAME_DOTS.url]);
  });

  it("submissão do editor nunca sai e vira a primária", () => {
    const editor = { ...CNN_ARGON, flag: "editor_submitted" };
    const r = groupSameStory({ lancamento: [BLOG_GOOGLE_ARGON], radar: [editor, VB_ARGON] });
    assert.ok(r.buckets.radar.some((a) => a.url === CNN_ARGON.url));
    assert.ok(!r.removed.some((x) => x.url === CNN_ARGON.url));
    assert.ok(r.removed.every((x) => x.kept_url === CNN_ARGON.url));
  });

  it("histórias diferentes não agrupam e não mutam o input", () => {
    const input = { radar: [VB_SONNET, CNN_ARGON, VB_DOTS] };
    const snapshot = JSON.stringify(input);
    const r = groupSameStory(input);
    assert.equal(r.removed.length, 0);
    assert.equal(r.buckets.radar.length, 3);
    assert.equal(JSON.stringify(input), snapshot);
  });

  it("mesma URL em LANÇAMENTOS e RADAR não é tratada como outra cobertura", () => {
    const r = groupSameStory({ lancamento: [BLOG_GOOGLE_ARGON], radar: [BLOG_GOOGLE_ARGON] });
    assert.equal(r.removed.length, 0);
  });
});

describe("groupSameStory — guardas do review da PR #9430", () => {
  it("cópia de destaque no bucket nunca sai; a oficial segue primária (#4943/#2397)", () => {
    const r = groupSameStory(
      { lancamento: [BLOG_GOOGLE_ARGON], radar: [CNN_ARGON, VB_ARGON] },
      { protectedUrls: [VB_ARGON.url] },
    );
    assert.ok(r.buckets.radar.some((a) => a.url === VB_ARGON.url));
    assert.deepEqual(r.buckets.lancamento.map((a) => a.url), [BLOG_GOOGLE_ARGON.url]);
    assert.deepEqual(r.removed.map((x) => x.url), [CNN_ARGON.url]);
    assert.ok(r.removed.every((x) => x.kept_url === BLOG_GOOGLE_ARGON.url));
    assert.ok(r.spared.some((x) => x.url === VB_ARGON.url && x.reason === "protected"));
  });

  it("duas submissões do editor no mesmo grupo: as duas ficam", () => {
    const r = groupSameStory({
      radar: [{ ...CNN_ARGON, flag: "editor_submitted" }, { ...VB_ARGON, flag: "editor_submitted" }],
    });
    assert.equal(r.removed.length, 0);
    assert.equal(r.buckets.radar.length, 2);
  });

  it("LANÇAMENTOS oficial de outra empresa sai em favor da cobertura da história (cross-bucket)", () => {
    const r = groupSameStory({ lancamento: [AWS_SONNET], radar: [VB_SONNET] });
    assert.deepEqual(r.buckets.lancamento, []);
    assert.deepEqual(r.buckets.radar.map((a) => a.url), [VB_SONNET.url]);
    assert.equal(r.removed[0].bucket, "lancamento");
  });

  it("sinal registrado contra a primária, mesmo quando a âncora perde o posto", () => {
    const r = groupSameStory({ lancamento: [AWS_SONNET], radar: [VB_SONNET] });
    assert.ok(["event", "model_version"].includes(r.removed[0].signal));
    assert.equal(r.removed[0].url, AWS_SONNET.url);
  });

  it("cluster_sources que o perdedor já carregava passam para a primária", () => {
    const loser = { ...CNN_ARGON, cluster_sources: [{ url: "https://g1.globo.com/argon" }] };
    const r = groupSameStory({ lancamento: [BLOG_GOOGLE_ARGON], radar: [loser] });
    const srcs = (r.buckets.lancamento[0].cluster_sources ?? []).map((c) => c.url);
    assert.ok(srcs.includes(CNN_ARGON.url));
    assert.ok(srcs.includes("https://g1.globo.com/argon"));
  });

  it("'IAs' não é nome distintivo (calibração 260820)", () => {
    assert.equal(
      sameEvent("11 prompts para foto profissional no ChatGPT e outras IAs", 'OpenAI desmancha equipe responsável por "conter" rebelião de IAs'),
      null,
    );
  });
});

describe("dedupIntraEdition integra o agrupamento (#9360)", () => {
  it("destaque de qualquer rank presente no bucket é protegido", () => {
    const { kept, removed } = dedupIntraEdition({
      highlights: [{ rank: 5, url: VB_ARGON.url, title: VB_ARGON.title }],
      lancamento: [BLOG_GOOGLE_ARGON],
      radar: [VB_ARGON, CNN_ARGON],
      use_melhor: [],
      video: [],
    });
    assert.ok((kept.radar ?? []).some((a) => a.url === VB_ARGON.url));
    assert.ok(!removed.some((r) => r.url === VB_ARGON.url));
  });

  it("removidos aparecem com match_type story_group (sidecar → descartados)", () => {
    const { kept, removed } = dedupIntraEdition({
      highlights: [],
      lancamento: [BLOG_GOOGLE_ARGON],
      radar: [CNN_ARGON, VB_ARGON, VB_SONNET, AWS_SONNET],
      use_melhor: [],
      video: [],
    });
    assert.deepEqual((kept.lancamento ?? []).map((a) => a.url), [BLOG_GOOGLE_ARGON.url]);
    assert.deepEqual((kept.radar ?? []).map((a) => a.url), [VB_SONNET.url]);
    const grouped = removed.filter((r) => r.match_type === "story_group");
    assert.ok(grouped.every((r) => typeof r.story_signal === "string"));
    assert.deepEqual(
      grouped.map((r) => r.url).sort(),
      [CNN_ARGON.url, VB_ARGON.url, AWS_SONNET.url].sort(),
    );
  });
});

describe("groupSameStory x bônus de cobertura/menção (#9443)", () => {
  it("primária oficial herda o bônus que o perdedor (já boostado) tinha", () => {
    const vb = { ...VB_ARGON, score: 85, newsletter_mentions: ["a", "b", "c"], score_bonus_newsletter: 15 };
    const r = groupSameStory({ lancamento: [{ ...BLOG_GOOGLE_ARGON, score: 60 }], radar: [vb] });
    const p = r.buckets.lancamento[0] as typeof BLOG_GOOGLE_ARGON & {
      score_bonus_coverage?: number;
      score_bonus_newsletter?: number;
    };
    assert.equal(p.url, BLOG_GOOGLE_ARGON.url);
    assert.equal(p.score_bonus_newsletter, 15);
    assert.equal(p.score_bonus_coverage, 5);
    assert.equal(p.score, 60 + 15 + 5);
  });

  it("não recontar bônus que a primária já tinha", () => {
    const prim = { ...BLOG_GOOGLE_ARGON, score: 70, newsletter_mentions: ["a"], score_bonus_newsletter: 5 };
    const r = groupSameStory({ lancamento: [prim], radar: [{ ...CNN_ARGON, newsletter_mentions: ["a"] }] });
    const p = r.buckets.lancamento[0] as typeof prim & { score_bonus_coverage?: number };
    assert.equal(p.score, 75);
    assert.equal(p.score_bonus_coverage, 5);
  });
});
