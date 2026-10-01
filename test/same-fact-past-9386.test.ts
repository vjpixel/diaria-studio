/**
 * #9386 — regressão: RADAR de 261002 "OpenAI cancela lançamento de novo
 * modelo de IA por problemas de segurança" (tribunadosertao) repetia o D1 de
 * 260930 "OpenAI cancela GPT-6.1 Astra..." — manchete SEM versão, resumo com
 * "GPT-6.1 Astra". Não era sinalizado; e em --no-gates nenhum aviso removia
 * o item do pool. Dados reais (data/editions/2610/261002, 2609/260930, 261001).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractProductVariants,
  findSameFactMatches,
  removeSameFactSecondary,
} from "../scripts/lib/same-fact-check.ts";

const ASTRA_ITEM = {
  kind: "radar",
  title: "OpenAI cancela lançamento de novo modelo de IA por problemas de segurança",
  url: "https://www.tribunadosertao.com.br/geral/2026/09/29/987196-openai-cancela-lancamento-de-novo-modelo-de-ia-por-problemas-de-seguranca",
  summary:
    "OpenAI cancelou o lançamento do GPT-6.1 Astra programado para outubro após pesquisadores identificarem falhas em testes internos.",
};

const PAST = [
  // 261001 D2 — produto "gpt 6.1" mas variante Sol: fato distinto.
  { aammdd: "261001", title: "Introducing GPT-6.1 Sol", url: "https://openai.com/index/introducing-gpt-6-1-sol/", bucket: "highlight" },
  { aammdd: "261001", title: "Anthropic launches Claude Sonnet 5.5 with 30% cost reduction per-task due to faster speeds and fewer tool calls", bucket: "radar" },
  { aammdd: "260930", title: "OpenAI cancela GPT-6.1 Astra após IA mentir sobre o que fez e quebrar regras", url: "https://canaltech.com.br/inteligencia-artificial/openai-cancela-gpt-61-astra-apos-ia-mentir-sobre-o-que-fez-e-quebrar-regras/", bucket: "highlight" },
];

test("#9386: resumo do item casa com destaque passado; variante diferente (Sol) não casa", () => {
  const w = findSameFactMatches([ASTRA_ITEM], PAST);
  assert.equal(w.length, 1);
  assert.equal(w[0].matched_edition, "260930");
  assert.equal(w[0].evidence, "summary");
  assert.equal(w[0].matched_bucket, "highlight");
  assert.deepEqual(w[0].shared_products, ["gpt 6.1"]);
});

test("#9386: item secundário passado (RADAR) também entra na comparação", () => {
  const w = findSameFactMatches(
    [{ kind: "radar", title: "Anthropic debuts Claude Sonnet 5.5 running 30% faster", url: "https://siliconangle.com/x" }],
    PAST,
  );
  assert.equal(w.length, 1);
  assert.equal(w[0].matched_bucket, "radar");
  assert.equal(w[0].evidence, "title");
});

test("#9386: sem resumo, comportamento antigo (manchete sem versão não casa)", () => {
  assert.equal(findSameFactMatches([{ ...ASTRA_ITEM, summary: undefined }], PAST).length, 0);
});

test("extractProductVariants ignora palavra comum após a versão", () => {
  assert.deepEqual([...extractProductVariants("GPT-6.1 Sol encosta no Astra")], [["gpt 6.1", "sol"]]);
  assert.deepEqual([...extractProductVariants("Claude Sonnet 5.5 On AWS")], []);
});

test("#9386: removeSameFactSecondary remove RADAR/LANÇAMENTOS, nunca destaque", () => {
  const approved = {
    highlights: [{ article: { url: "https://h.example/d1", title: "D1" } }],
    radar: [{ article: { url: ASTRA_ITEM.url, title: ASTRA_ITEM.title } }, { url: "https://keep.example/", title: "fica" }],
    lancamento: [],
  };
  const warnings = findSameFactMatches([ASTRA_ITEM], PAST);
  const hlWarning = { ...warnings[0], kind: "highlight", item_url: "https://h.example/d1" };
  const { approved: out, removed } = removeSameFactSecondary(approved, [...warnings, hlWarning]);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].bucket, "radar");
  assert.equal(removed[0].matched_edition, "260930");
  assert.equal((out.radar as unknown[]).length, 1);
  assert.equal((out.highlights as unknown[]).length, 1);
  assert.equal(approved.radar.length, 2, "não muta a entrada");
});
