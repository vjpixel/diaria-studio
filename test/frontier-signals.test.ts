/**
 * test/frontier-signals.test.ts (#9359)
 *
 * Sinal determinístico de lançamento oficial de laboratório de fronteira e a
 * garantia de vaga nos finalistas. Casos reais tirados do corpus medido na
 * #9359 (edições 2604–2610) — positivos que o editor aprovou e
 * falsos-positivos que as travas existem pra barrar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectFrontierLaunch,
  isGuaranteedFrontierLaunch,
  pickFrontierLaunchFinalists,
  frontierLabOfUrl,
  FRONTIER_LAUNCH_FINALIST_CAP,
} from "../scripts/lib/frontier-signals.ts";
import { hasLaunchVerb } from "../scripts/lib/launch-detect.ts";
import { mergeChunks } from "../scripts/merge-scored-chunks.ts";
import type { Categorized } from "../scripts/split-articles-for-scoring.ts";

describe("detectFrontierLaunch — casos concretos da #9359", () => {
  const strong: Array<[string, string]> = [
    // 260923 — destaques que o editor trouxe de fora dos candidatos.
    ["https://www.anthropic.com/claude-opus-5-5", "Introducing Claude Opus 5.5"],
    ["https://openai.com/index/introducing-gpt-6-sol-and-luna/", "Introducing GPT-6 Sol and Luna"],
    // 260929 — título é só o nome do modelo.
    ["https://www.anthropic.com/claude-sonnet-5-5", "Claude Sonnet 5.5"],
    // Outros aprovados no corpus.
    ["https://x.ai/news/grok-4-7", "Introducing Grok 4.7"],
    ["https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4/", "Gemini 4 Argon: our next era of frontier intelligence"],
    ["https://openai.com/index/previewing-gpt-5-6-sol", "Previewing GPT-5.6 Sol: a next-generation model"],
  ];
  for (const [url, title] of strong) {
    it(`official/model: ${title}`, () => {
      const s = detectFrontierLaunch({ url, title });
      assert.equal(s?.route, "official");
      assert.equal(s?.strength, "model");
      assert.equal(isGuaranteedFrontierLaunch({ url, title }), true);
    });
  }

  it("título vazio → modelo vem do path (anthropic.com/claude-sonnet-5-5)", () => {
    const s = detectFrontierLaunch({ url: "https://www.anthropic.com/claude-sonnet-5-5", title: "" });
    assert.equal(s?.strength, "model");
    assert.equal(s?.lab, "Anthropic");
  });

  it("260930 'Introducing Dots' (produto sem modelo versionado) → product, NÃO garantido", () => {
    const a = { url: "https://openai.com/index/introducing-dots/", title: "Introducing Dots" };
    assert.deepEqual(detectFrontierLaunch(a), { route: "official", strength: "product", lab: "OpenAI", matched: "Introducing" });
    assert.equal(isGuaranteedFrontierLaunch(a), false);
  });

  it("imprensa com verbo + modelo versionado → press, NÃO garantido (43% de aprovação = base)", () => {
    const a = {
      url: "https://exame.com/inteligencia-artificial/anthropic-lanca-claude-sonnet-5-5-ate-30-mais-barato/",
      title: "Anthropic lança Claude Sonnet 5.5, até 30% mais barato que a versão anterior",
    };
    assert.equal(detectFrontierLaunch(a)?.route, "press");
    assert.equal(isGuaranteedFrontierLaunch(a), false);
  });

  const falsePositives: Array<[string, string, string]> = [
    ["post que só CITA o modelo", "https://openai.com/index/replit", "Replit expands access to software creation with GPT-5.6 Luna"],
    ["guia, não anúncio", "https://openai.com/index/builders-guide-to-gpt-5-6", "The builder’s guide to GPT‑5.6"],
    ["blog.google sem modelo versionado", "https://blog.google/intl/pt-br/produtos/nas-nuvens/como-as-pmes", "Como as PMEs da América Latina estão acelerando o crescimento"],
    ["página evergreen do modelo", "https://deepmind.google/models/gemini/flash/", "Gemini 3.8 Flash — Google DeepMind"],
    ["system card", "https://openai.com/index/gpt-5-5-system-card", "GPT-5.5 System Card"],
    ["docs", "https://docs.x.ai/developers/grok-4-7", "Grok 4.7 | SpaceXAI Docs"],
    ["landing de produto fora de /index", "https://openai.com/gpt-5", "GPT-5 is here"],
    ["hub de safety", "https://deploymentsafety.openai.com/gpt-5-6-preview/nanogpt", "GPT-5.6 Preview System Card - OpenAI Deployment Safety Hub"],
    ["imprensa sem verbo de lançamento", "https://canaltech.com.br/x/google-promete-gemini-4", "Google promete Gemini 4 antes do previsto"],
    ["imprensa com verbo mas sem modelo versionado", "https://canaltech.com.br/x/gemini-ganha", "Google lança novas integrações do Gemini no Workspace"],
  ];
  for (const [why, url, title] of falsePositives) {
    it(`não é lançamento garantido: ${why}`, () => {
      assert.equal(isGuaranteedFrontierLaunch({ url, title }), false);
    });
  }

  it("URL inválida/ausente não lança", () => {
    assert.equal(detectFrontierLaunch({ url: "not a url", title: "OpenAI launches GPT-7" })?.route, "press");
    assert.equal(detectFrontierLaunch({}), null);
    assert.equal(frontierLabOfUrl(undefined), undefined);
  });

  it("subdomínio do laboratório conta como host oficial", () => {
    assert.equal(frontierLabOfUrl("https://alignment.openai.com/x"), "OpenAI");
    assert.equal(frontierLabOfUrl("https://notopenai.com/x"), undefined);
  });
});

describe("hasLaunchVerb (#9359 — export de launch-detect)", () => {
  it("reusa o vocabulário de LAUNCH_KEYWORDS", () => {
    assert.equal(hasLaunchVerb("OpenAI launches GPT-6"), "launches");
    assert.equal(hasLaunchVerb("Anthropic lança Claude"), "lança");
    assert.equal(hasLaunchVerb("Mercado de IA chega a US$ 50 bilhões"), undefined);
  });
});

describe("pickFrontierLaunchFinalists", () => {
  const e = (url: string, title: string) => ({ url, article: { url, title } });
  const ranked = [
    e("https://a.com/1", "Notícia 1"),
    e("https://a.com/2", "Notícia 2"),
    e("https://www.anthropic.com/news/claude-opus-5", "Introducing Claude Opus 5"),
    e("https://x.ai/news/grok-4-5", "Introducing Grok 4.5"),
    e("https://openai.com/index/introducing-gpt-7", "Introducing GPT-7"),
  ];

  it("devolve só os garantidos fora do top-N, até o cap, na ordem de score", () => {
    const out = pickFrontierLaunchFinalists(ranked, 2);
    assert.deepEqual(out.map((x) => x.url), ["https://www.anthropic.com/news/claude-opus-5", "https://x.ai/news/grok-4-5"]);
    assert.equal(out.length, FRONTIER_LAUNCH_FINALIST_CAP);
  });

  it("garantido já dentro do top-N não é duplicado", () => {
    assert.deepEqual(pickFrontierLaunchFinalists(ranked, 4).map((x) => x.url), ["https://openai.com/index/introducing-gpt-7"]);
  });

  it("topN 0 ou cap 0 → nada", () => {
    assert.deepEqual(pickFrontierLaunchFinalists(ranked, 0), []);
    assert.deepEqual(pickFrontierLaunchFinalists(ranked, 2, 0), []);
  });
});

describe("mergeChunks — garantia de vaga nos finalistas (#9359)", () => {
  const mk = (url: string, title: string, category: string) => ({ url, title, category });
  const CAT: Categorized = {
    lancamento: [mk("https://www.anthropic.com/news/claude-opus-5", "Introducing Claude Opus 5", "lancamento")],
    radar: [
      mk("https://a.com/1", "Notícia 1", "noticias"),
      mk("https://a.com/2", "Notícia 2", "noticias"),
      mk("https://a.com/3", "Notícia 3", "noticias"),
    ],
    use_melhor: [],
  };
  const chunks = [{
    scored: [
      { url: "https://a.com/1", score: 90 },
      { url: "https://a.com/2", score: 85 },
      { url: "https://a.com/3", score: 80 },
      // Caso 260727: post oficial do Claude Opus 5 ficou abaixo do corte por score.
      { url: "https://www.anthropic.com/news/claude-opus-5", score: 72 },
    ],
  }];

  it("lançamento oficial abaixo do corte é ACRESCENTADO (não desloca ninguém) e tagueado", () => {
    const r = mergeChunks(CAT, chunks, 2);
    assert.deepEqual(r.finalists.map((f) => f.url), [
      "https://a.com/1",
      "https://a.com/2",
      "https://www.anthropic.com/news/claude-opus-5",
    ]);
    assert.deepEqual(r.frontier_launch_added, ["https://www.anthropic.com/news/claude-opus-5"]);
    assert.equal((r.finalists[2].article as { frontier_launch?: boolean }).frontier_launch, true);
    assert.equal((r.finalists[0].article as { frontier_launch?: boolean }).frontier_launch, undefined);
  });

  it("já dentro do top-N → nada acrescentado", () => {
    const r = mergeChunks(CAT, chunks, 4);
    assert.equal(r.finalists.length, 4);
    assert.deepEqual(r.frontier_launch_added, []);
  });
});
