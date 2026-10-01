/**
 * #9249: dedup por TEMA/EVENTO. Fixtures = títulos reais da edição 261001
 * (gate 4) e das edições 260928-260930, mais negativos reais da calibração.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sameEvent } from "../scripts/lib/event-dedup.ts";
import { dedup } from "../scripts/dedup.ts";
import { isIntraEditionDuplicate } from "../scripts/dedup-intra-edition.ts";

test("261001: RADAR Dots (VentureBeat) casa com D2 'Introducing Dots' de 260930", () => {
  const m = sameEvent(
    "OpenAI launches Dots, always-on AI agent coworkers, and ChatGPT Space where they can collaborate with human teams",
    "Introducing Dots",
  );
  assert.ok(m);
  assert.deepEqual(m.shared, ["dots"]);
});

test("261001: Wired 'OpenAI Pauses Training' casa com headline de 260929 (PT×EN)", () => {
  const m = sameEvent(
    "OpenAI Pauses Training Its Most Powerful Models After Rogue Agents Target Government",
    "OpenAI cancelou treino após agente furar a rede",
  );
  assert.ok(m);
  assert.equal(m.signal, "event_concepts");
});

test("261001: CNN 'Google anuncia Argon' casa com o D1 'Gemini 4 Argon' (alias Gemini→google)", () => {
  const m = sameEvent(
    "Após meses de atrasos, Google anuncia Argon, seu principal modelo de IA",
    "Gemini 4 Argon: our next era of frontier intelligence",
  );
  assert.ok(m);
  assert.ok(m.shared.includes("argon"));
});

test("negativos reais da calibração não casam (limiar conservador)", () => {
  const pairs: [string, string][] = [
    // dois títulos sem empresa compartilhando só palavra capitalizada genérica
    ["Como usar a IA para montar seu currículo? Veja prompt que pode te ajudar", "Muse deve ser a nova IA dos Ray-Ban Meta; veja o que vai mudar de verdade"],
    // linha de produto contínua: histórias diferentes de Opus
    ["How to Generate Custom SVG Illustrations and Icons with Claude Opus 5.5", "Claude Opus 5.5 derruba preço da IA de ponta"],
    // produto citado só por comparação ("Astra-like")
    ["OpenAI's GPT-6.1 Sol offers Astra-like performance at 1/5th price", "OpenAI cancela GPT-6.1 Astra após IA mentir sobre o que fez e quebrar regras"],
    // mesma empresa, eventos distintos, só verbo genérico em comum
    ["OpenAI lança agente de compras no ChatGPT", "OpenAI lança modelo de voz para desenvolvedores"],
    // sufixo de veículo não vale como nome
    ["Trevo acelera expansão e aposta em IA para transformar o mercado de exames médicos - Saúde Digital News", "Com protocolo inédito no setor, Wellon transforma o ChatGPT em painel de controle para clínicas - Saúde Digital News"],
    // palavra após dois-pontos é início de frase
    ["Gemini 4 Argon: our next era of frontier intelligence", "Eleven v4: Our most expressive text-to-speech AI model yet"],
  ];
  for (const [a, b] of pairs) assert.equal(sameEvent(a, b), null, `${a} <=> ${b}`);
});

test("dedup() Pass-1f remove o RADAR repetido e registra o motivo; poupa submissão do editor", () => {
  const articles = [
    { url: "https://venturebeat.com/dots", title: "OpenAI launches Dots, always-on AI agent coworkers, and ChatGPT Space where they can collaborate with human teams" },
    { url: "https://wired.com/pause", title: "OpenAI Pauses Training Its Most Powerful Models After Rogue Agents Target Government", flag: "editor_submitted" },
    { url: "https://example.com/other", title: "Nvidia apresenta chip novo para data centers" },
  ];
  const r = dedup(
    articles,
    new Set(),
    0.85,
    ["OpenAI cancelou treino após agente furar a rede"],
    0.7,
    ["Introducing Dots"],
  );
  const removed = r.removed.find((x) => x.url === "https://venturebeat.com/dots");
  assert.ok(removed, "Dots deveria ser removido");
  assert.match(removed.dedup_note, /same-event \(#9249/);
  assert.match(removed.dedup_note, /Introducing Dots/);
  const spared = r.kept.find((x) => x.url === "https://wired.com/pause");
  assert.ok(spared, "submissão do editor nunca é removida");
  assert.match(String(spared.event_dedup_flagged), /#9249/);
  assert.ok(r.kept.some((x) => x.url === "https://example.com/other"));
});

test("isIntraEditionDuplicate: RADAR Argon (CNN) duplica o D1 da mesma edição", () => {
  const res = isIntraEditionDuplicate(
    { url: "https://www.cnnbrasil.com.br/argon", title: "Após meses de atrasos, Google anuncia Argon, seu principal modelo de IA" } as never,
    [{ url: "https://blog.google/gemini-4-argon/", title: "Gemini 4 Argon: our next era of frontier intelligence" }] as never,
  );
  assert.ok(res);
  assert.equal(res.match_type, "event");
});
