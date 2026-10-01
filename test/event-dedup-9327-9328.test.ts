/**
 * #9327: A1 não casa matérias diferentes que só compartilham lugar/plataforma.
 * #9328: findSameEvent prefere match removível a um A2 fraco anterior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sameEvent, findSameEvent } from "../scripts/lib/event-dedup.ts";
import { dedup } from "../scripts/dedup.ts";

test("#9327: A1 não casa matérias diferentes que só compartilham lugar/plataforma", () => {
  const pairs: [string, string][] = [
    ["Nvidia amplia produção em Taiwan", "Nvidia investe em Taiwan"],
    ["Google abre centro em São Paulo", "Google leva Gemini a escolas de São Paulo"],
    ["Google muda recomendações do YouTube com IA", "Google lança dublagem automática no YouTube"],
    ["Microsoft coloca agente no Excel", "Microsoft corta preço do Copilot no Excel"],
    ["Google traz IA ao Android Auto", "Google anuncia recurso de IA no Android"],
    ["Samsung abre fábrica de chips na Coreia do Sul", "Samsung investe em data center na Coreia"],
  ];
  for (const [a, b] of pairs) {
    assert.equal(sameEvent(a, b), null, `${a} <=> ${b}`);
    const r = dedup([{ url: "https://example.com/x", title: a }], new Set(), 0.85, [], 0.7, [b]);
    assert.equal(r.removed.length, 0, `não deveria remover: ${a}`);
  }
});

test("#9327: casos que o A1 pega corretamente continuam removíveis", () => {
  assert.equal(
    sameEvent("Após meses de atrasos, Google anuncia Argon, seu principal modelo de IA", "Gemini 4 Argon: our next era of frontier intelligence")?.removable,
    true,
  );
  assert.equal(sameEvent("OpenAI apresenta Dots, agentes colegas de trabalho", "OpenAI launches Dots, always-on AI agent coworkers")?.removable, true);
  // Nome distintivo + lugar: o nome ainda casa.
  assert.equal(sameEvent("Nvidia anuncia Rubin em Taiwan", "Nvidia lança chip Rubin na Computex")?.removable, true);
});

test("#9328: findSameEvent prefere match removível (A1) a um A2 anterior", () => {
  const cur = "OpenAI launches Dots, always-on AI agent coworkers, and ChatGPT Space where they can collaborate";
  const past = ["Introducing Dots", "OpenAI apresenta Dots, colegas agentes para equipes"];
  assert.equal(sameEvent(cur, past[0])?.removable, false, "pré-condição: 1º é A2");
  const hit = findSameEvent(cur, past);
  assert.ok(hit);
  assert.equal(hit.title, past[1]);
  assert.equal(hit.match.removable, true);
  // Sem removível, cai no fraco.
  assert.equal(findSameEvent(cur, [past[0]])?.match.removable, false);

  // Pass-1f: A2 em pastTitles antes do A1 em pastArticleTitles → remove.
  const r = dedup([{ url: "https://venturebeat.com/dots", title: cur }], new Set(), 0.85, [past[0]], 0.7, [past[1]]);
  assert.equal(r.kept.length, 0);
  assert.equal(r.removed.length, 1);
});
