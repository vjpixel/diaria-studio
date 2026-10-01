/**
 * #9249: dedup por TEMA/EVENTO. Fixtures = títulos reais da edição 261001
 * (gate 4) e das edições 260928-260930, mais negativos reais da calibração.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sameEvent } from "../scripts/lib/event-dedup.ts";
import { dedup } from "../scripts/dedup.ts";
import { isIntraEditionDuplicate, dedupIntraEdition } from "../scripts/dedup-intra-edition.ts";

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

test("dedup() Pass-1f: A2 (Dots) só marca; B (Pause) remove; poupa submissão do editor", () => {
  const articles = [
    { url: "https://venturebeat.com/dots", title: "OpenAI launches Dots, always-on AI agent coworkers, and ChatGPT Space where they can collaborate with human teams" },
    { url: "https://wired.com/pause", title: "OpenAI Pauses Training Its Most Powerful Models After Rogue Agents Target Government", flag: "editor_submitted" },
    { url: "https://theverge.com/pause", title: "OpenAI pauses training of frontier models after rogue agents hack government" },
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
  // #9293: Dots casa só por A2 (um lado sem empresa) → marcado, não removido.
  const dots = r.kept.find((x) => x.url === "https://venturebeat.com/dots");
  assert.ok(dots, "A2 não remove");
  assert.match(String(dots.event_dedup_flagged), /same-event \(#9249/);
  assert.match(String(dots.event_dedup_flagged), /Introducing Dots/);
  const removed = r.removed.find((x) => x.url === "https://theverge.com/pause");
  assert.ok(removed, "sinal B (empresa + 2 conceitos) remove");
  assert.match(removed.dedup_note, /event_concepts/);
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

test("#9293: A2 com palavra capitalizada comum (Search/Index/Studio) nunca remove", () => {
  const cases: [string, string][] = [
    ["OpenAI launches Search for enterprise teams", "Why Search engines are drowning in AI slop"],
    ["Anthropic publishes new Index of model welfare", "The AI Index shows adoption slowing in Brazil"],
    ["Google opens Studio to all developers", "How a small Studio made an animated film with AI"],
  ];
  for (const [cur, past] of cases) {
    const m = sameEvent(cur, past);
    if (m) assert.equal(m.removable, false, `${cur} <=> ${past}`);
    const r = dedup([{ url: "https://example.com/x", title: cur }], new Set(), 0.85, [], 0.7, [past]);
    assert.equal(r.removed.length, 0, `não deveria remover: ${cur}`);
    assert.equal(r.kept.length, 1);
  }
});

test("#9293: A1 e B continuam removíveis", () => {
  assert.equal(
    sameEvent("Após meses de atrasos, Google anuncia Argon, seu principal modelo de IA", "Gemini 4 Argon: our next era of frontier intelligence")?.removable,
    true,
  );
  assert.equal(
    sameEvent("OpenAI Pauses Training Its Most Powerful Models After Rogue Agents Target Government", "OpenAI cancelou treino após agente furar a rede")?.removable,
    true,
  );
});

test("#9295: dedup intra-edição — A2 (Search) só marca, não remove", () => {
  const input = {
    highlights: [
      {
        rank: 1,
        url: "https://example.com/search-slop",
        article: { url: "https://example.com/search-slop", title: "Why Search engines are drowning in AI slop" },
      },
    ],
    radar: [{ url: "https://example.com/openai-search", title: "OpenAI launches Search for enterprise teams" }],
    lancamento: [],
    use_melhor: [],
    video: [],
  };
  assert.equal(isIntraEditionDuplicate(input.radar[0] as never, input.highlights as never), null);
  const { kept, removed } = dedupIntraEdition(input as never);
  assert.equal(removed.length, 0);
  assert.equal(kept.radar?.length, 1);
  assert.match(String((kept.radar?.[0] as Record<string, unknown>).event_dedup_flagged), /#9295/);
});
