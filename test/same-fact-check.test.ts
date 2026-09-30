/**
 * #9100 — regressão: destaque/RADAR com o MESMO fato de um destaque da
 * edição anterior via outlet diferente (Sonnet 5.5, 260929 → 260930).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVersionedProducts, findSameFactMatches } from "../scripts/lib/same-fact-check.ts";

// Destaques reais de 260929 (títulos de 01-approved.json).
const PAST_260929 = [
  { aammdd: "260929", title: "An agent used DNS to reach an external chatbot", url: "https://alignment.openai.com/misalignment-reports/an-agent-used-dns-to-reach-an-external-chatbot/" },
  { aammdd: "260929", title: "Claude Sonnet 5.5", url: "https://www.anthropic.com/claude-sonnet-5-5" },
  { aammdd: "260929", title: "Novo recurso do Gemini faz ligações por você para marcar compromissos", url: "https://canaltech.com.br/inteligencia-artificial/novo-recurso-do-gemini-faz-ligacoes-por-voce-para-marcar-compromissos/" },
];

test("#9100: D3 canaltech Sonnet 5.5 e RADAR VentureBeat casam o D2 de 260929", () => {
  const items = [
    { kind: "highlight", rank: 3, title: "Quase um Opus por uma fração do preço: novo Claude Sonnet 5.5 chega 30% mais barato", url: "https://canaltech.com.br/inteligencia-artificial/quase-um-opus-por-uma-fracao-do-preco-novo-claude-sonnet-55-chega-30-mais-barato/" },
    { kind: "radar", title: "Anthropic launches Claude Sonnet 5.5 with 30% cost reduction per-task due to faster speeds and fewer tool calls", url: "https://venturebeat.com/technology/anthropic-launches-claude-sonnet-5-5-with-30-cost-reduction-per-task-due-to-faster-speeds-and-fewer-tool-calls" },
    // Não relacionados — não podem disparar.
    { kind: "highlight", rank: 2, title: "OpenAI lança Dots", url: "https://openai.com/index/introducing-dots/" },
    { kind: "radar", title: "Gemma 4 — Google DeepMind", url: "https://deepmind.google/models/gemma/gemma-4/" },
  ];
  const w = findSameFactMatches(items, PAST_260929);
  assert.equal(w.length, 2);
  assert.equal(w[0].kind, "highlight");
  assert.equal(w[0].rank, 3);
  assert.equal(w[0].matched_edition, "260929");
  assert.deepEqual(w[0].shared_products, ["sonnet 5.5"]);
  assert.equal(w[1].kind, "radar");
  assert.deepEqual(w[1].shared_products, ["sonnet 5.5"]);
});

test("#9100: mesma URL canônica não gera warning (é trabalho do dedup por URL)", () => {
  const w = findSameFactMatches(
    [{ kind: "highlight", rank: 1, title: "Claude Sonnet 5.5", url: "https://www.anthropic.com/claude-sonnet-5-5/" }],
    PAST_260929,
  );
  assert.equal(w.length, 0);
});

test("#9100: versão diferente do mesmo produto não casa", () => {
  const w = findSameFactMatches(
    [{ kind: "highlight", rank: 1, title: "Anthropic lança Claude Sonnet 6", url: "https://x.com/a" }],
    PAST_260929,
  );
  assert.equal(w.length, 0);
});

test("extractVersionedProducts: produto+versão sim; porcentagem, ano, cifra e 'Top N' não", () => {
  assert.deepEqual([...extractVersionedProducts("OpenAI cancela GPT-6.1 Astra")], ["gpt 6.1"]);
  assert.deepEqual([...extractVersionedProducts("Gemma 4 — Google DeepMind")], ["gemma 4"]);
  assert.deepEqual([...extractVersionedProducts("Top 10 ferramentas de IA em 2026")], []);
  assert.deepEqual([...extractVersionedProducts("Nvidia cresce 30% e fatura US$ 50 bi")], []);
  assert.deepEqual([...extractVersionedProducts("Startup levanta 12 milhões")], []);
});
