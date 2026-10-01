/**
 * #9380 — título de item do pool chegava cru (sufixo de veículo, cauda de
 * clickbait, prefixo de newsletter) porque `normalizeItemTitle` só rodava no
 * inbox. Fixtures = títulos reais de data/editions/ (jul–set/2026).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeItemTitle } from "../scripts/lib/strip-publisher-suffix.ts";
import { categorizeArticles } from "../scripts/categorize.ts";

const CASES: Array<[string, string]> = [
  // sufixo de veículo
  [
    "A Gentle Introduction to Model Distillation - MachineLearningMastery.com",
    "A Gentle Introduction to Model Distillation",
  ],
  [
    "As preocupações que levaram a OpenAI, do ChatGPT, a abandonar lançamento de novo sistema de IA - BBC News Brasil",
    "As preocupações que levaram a OpenAI, do ChatGPT, a abandonar lançamento de novo sistema de IA",
  ],
  ["deepseek-ai/DeepSeek-V4-Flash-0731 · Hugging Face", "deepseek-ai/DeepSeek-V4-Flash-0731"],
  ["Building agents with the new Claude SDK / claude.dev", "Building agents with the new Claude SDK"],
  ["Introducing a new reasoning model for science | OpenAI", "Introducing a new reasoning model for science"],
  ["Como usar agentes de IA no seu dia a dia - MuahooLab", "Como usar agentes de IA no seu dia a dia"],
  // cauda de clickbait
  [
    "API do WhatsApp terá cobrança por mensagens de serviço; entenda",
    "API do WhatsApp terá cobrança por mensagens de serviço",
  ],
  [
    "China acusa Claude Code de coletar dados sem permissão e emite alerta; entenda",
    "China acusa Claude Code de coletar dados sem permissão e emite alerta",
  ],
  [
    "Como criar um agente de IA no ChatGPT: guia completo para configurar o recurso",
    "Como criar um agente de IA no ChatGPT",
  ],
  [
    "Acesso livre ao Fable 5 acaba amanhã; veja como aproveita a IA que assustou o governo dos EUA | Exame",
    "Acesso livre ao Fable 5 acaba amanhã",
  ],
  [
    "Como escolher um chatbot com IA para empresas: guia completo - Elevenmind -",
    "Como escolher um chatbot com IA para empresas",
  ],
  // prefixo de newsletter
  ["[AINews] AMD buys Taalas", "AINews: AMD buys Taalas"],
  ["[AINews] AI Cybersecurity becomes top of mind", "AINews: AI Cybersecurity becomes top of mind"],
];

for (const [raw, expected] of CASES) {
  test(`#9380 normalizeItemTitle: ${raw}`, () => {
    assert.equal(normalizeItemTitle(raw), expected);
    assert.equal(normalizeItemTitle(expected), expected, "idempotente");
  });
}

test("#9380 anti-falso-positivo: separadores/caudas legítimos ficam intactos", () => {
  for (const t of [
    "OpenAI lança GPT-5 - o maior modelo",
    "Input / output de modelos multimodais em produção",
    "Visão · áudio · texto: o novo modelo unificado",
    "IA; entenda", // prefixo curto demais
    "Como usar o Gemini: guia rápido",
  ]) {
    assert.equal(normalizeItemTitle(t), t);
  }
});

test("#9380 categorizeArticles normaliza título de item vindo de RSS/pesquisa (não-inbox)", () => {
  const out = categorizeArticles([
    {
      url: "https://www.bbc.com/portuguese/articles/abc123",
      title:
        "As preocupações que levaram a OpenAI a abandonar lançamento de novo sistema de IA - BBC News Brasil",
      summary: "Inteligência artificial: OpenAI abandona lançamento de modelo de IA.",
    } as any,
  ]);
  const all = [...out.lancamento, ...out.radar, ...out.use_melhor, ...out.video];
  assert.equal(all.length, 1);
  assert.equal(
    all[0].title,
    "As preocupações que levaram a OpenAI a abandonar lançamento de novo sistema de IA",
  );
});
