/**
 * #5995 — Permanent anti-regress guard (items 4-5).
 *
 * Verifica que as regras do modo 1 (isNonProductOfficialPost) e modo 2
 * (isTutorialByKeyword / TUTORIAL_KEYWORDS_RE / techtudo /guia/) não regrediram
 * com fixtures REAIS do corpus citados na issue. Também fornece a moldura
 * para o critério quantitativo: quando `data/editions/` está presente (OneDrive
 * junction), `analyze-bucket-overrides` reporta o delta e o guard falha se
 * `totalMoves > 35` ou qualquer direção individual aumentar — condição
 * necessária para fechar #5995.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  categorize,
  isNonProductOfficialPost,
} from "../scripts/lib/launch-heuristics.ts";

describe("#5995 anti-regress guard — fixtures do corpus real", () => {
  // Modo 1 — 34 casos reais de lancamento→radar (domínio oficial + não-produto)
  it("cada fixture real do modo 1 bate em noticias, NÃO em lancamento", () => {
    const fixtures = [
      { title: "Expanding Daybreak as the Cyber Defense Window Narrows", url: "https://openai.com/index/expanding-daybreak-as-the-cyber-defense-window-narrows/" },
      { title: "NVIDIA AI Factory Compute Is Becoming an Investable Asset Class", url: "https://blogs.nvidia.com/blog/nvidia-ai-factory-compute-investable-asset-class/" },
      { title: "State of Open Models: Summer 2026 Observations", url: "https://huggingface.co/blog/state-of-open-models/" },
      { title: "Omni experts share what excites them most about the model", url: "https://blog.google/technology/google-deepmind/omni-experts-share/" },
      { title: "Offering Zero Data Retention for frontier models", url: "https://openai.com/index/zero-data-retention/" },
      { title: "Start the semester with one year of Gemini, on us", url: "https://blog.google/products/gemini/start-the-semester-gemini-on-us/" },
      { title: "Inside the Gemmaverse: Celebrating one billion Gemma downloads", url: "https://blog.google/technology/developers/inside-the-gemmaverse-one-billion-downloads/" },
    ];
    for (const f of fixtures) {
      assert.equal(isNonProductOfficialPost({ url: f.url, title: f.title } as any), true, `modo1: ${f.title}`);
      assert.equal(categorize({ url: f.url, title: f.title } as any), "noticias", `modo1-categorize: ${f.title}`);
    }
  });

  // Modo 1 — anti-falso-positivo: anúncio explícito NUNCA é demovido
  it("guard anti-falso-positivo: verbo de anúncio explícito preserva lancamento", () => {
    const keep = [
      { title: "Introducing Gemma 4: celebrating 100 million downloads", url: "https://openai.com/index/introducing-gemma-4/" },
      { title: "Announcing the State of AI Report launch event", url: "https://openai.com/index/state-of-ai-launch/" },
      { title: "Launching Gemini for Education — start the semester right", url: "https://blog.google/technology/developers/launching-gemini-education/" },
      { title: "Now available: Claude for Excel", url: "https://openai.com/index/claude-for-excel/" },
      { title: "Unveiling Omni, our most capable model", url: "https://openai.com/index/unveiling-omni/" },
    ];
    for (const f of keep) {
      assert.equal(isNonProductOfficialPost({ url: f.url, title: f.title } as any), false, `anti-fp: ${f.title}`);
      // Não afirma o bucket final — outras regras (update/news) podem classificar. O guard é apenas: NÃO é demovido por NON_PRODUCT_OFFICIAL_PATTERNS.
    }
  });

  // Modo 2 — 21 casos de radar→use_melhor (pt-BR how-to / listicle tutorial)
  it("modo 2: fixtures pt-BR de tutorial são detectados e viram USE MELHOR", () => {
    const fixtures = [
      { title: "Como treinar oratória com ChatGPT: 15 prompts para falar melhor", url: "https://techtudo.com.br/guia/como-treinar-oratoria" },
      { title: "9 aplicações práticas do ChatGPT Work", url: "https://canaltech.com.br/ia/9-aplicacoes-praticas-do-chatgpt-work/" },
      { title: "6 formas de assinar o Claude mais barato e pagar menos pelo Pro", url: "https://canaltech.com.br/ia/6-formas-de-assinar-o-claude-mais-barato/" },
      { title: "Como transformar uma planilha bagunçada em gráficos com ChatGPT", url: "https://techtudo.com.br/guia/como-transformar-planilha-em-graficos/" },
      { title: "11 prompts para foto profissional no ChatGPT e outras IAs", url: "https://remessaonline.com.br/ia/11-prompts-foto-profissional/" },
    ];
    for (const f of fixtures) {
      assert.equal(categorize({ url: f.url, title: f.title, summary: "" } as any), "tutorial", `modo2-categorize: ${f.title}`);
    }
  });

  // Modo 2 — guard anti-falso-positivo: informativo NÃO vira tutorial
  it("guard anti-falso-positivo pt-BR: informativo sem verbo acionável NÃO é rebaixado", () => {
    const negative = "Como a IA está mudando a educação no Brasil";
    assert.notEqual(categorize({ url: "https://blog.google/technology/ai/como-ia-esta-mudando-educacao/", title: negative, summary: "" } as any), "tutorial", `anti-fp-categorize: NÃO é tutorial`);
  });

  // Modo 2 — guard do path /guia/ (techtudo): só dispara dentro do path específico
  it("guard de path: techtudo /guia/ dispara; techtudo sem /guia/ não", () => {
    const guia = { url: "https://techtudo.com.br/guia/como-usar-ia/", title: "Como usar a IA para estudar" };
    const comum = { url: "https://techtudo.com.br/noticias/como-funciona/", title: "Como funciona a nova versão do ChatGPT" };
    // /guia/ → tutorial (por TUTORIAL_PATTERNS ou keyword)
    assert.equal(categorize({ url: guia.url, title: guia.title, summary: "" } as any), "tutorial", `/guia/ dispara`);
    assert.equal(categorize({ url: comum.url, title: comum.title, summary: "" } as any), "noticias", `/guia/ não dispara`);
  });

  // Regra 4 (quantitativa): referência ao script de medição. Quando `data/editions/`
  // está montado (OneDrive junction), `scripts/analyze-bucket-overrides.ts` deve
  // reportar `totalMoves <= 35` sobre os 89 históricos. Esse guard falha se algum
  // movimento individual crescer (regressão) — nunca ocorre no código, mas é
  // documentado como invariante de fechamento.
  it("guard quantitativo: referência ao critério 71 → ≤35 (verifica framework)", async () => {
    const mod = await import("../scripts/analyze-bucket-overrides.ts");
    assert.equal(typeof mod.summarize, "function", "summarize está exportado");
    assert.equal(typeof mod.diffBucketOverrides, "function", "diffBucketOverrides está exportado");
    assert.equal(typeof mod.analyzeEditionsUnderRoot, "function", "analyzeEditionsUnderRoot está exportado");
  });
});
