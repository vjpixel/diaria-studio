/**
 * Regressão #11875 e #11876 — o guard do #11867 deixou de recusar toda
 * diferença de espaço (pra aceitar `afim de`→`a fim de`), mas passou a aceitar
 * também:
 *   - #11875: espaço dentro de URL/domínio/link e de markup markdown
 *     (`openai. com`, `** negrito**`, `-item`, `##Título`) — corrompe link e
 *     formatação publicados;
 *   - #11876: quebra de linha que muda de lugar sem mudar a contagem
 *     (`a b\nc`→`a\nb c`) — desloca a fronteira de parágrafo.
 * Os 5 pares legítimos do #11867 e o anti-ruído do #11798 continuam valendo
 * (ver os testes vizinhos `clarice-suggestion-guard-11798/11867`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyClariceNoise } from "../scripts/lib/clarice-suggestion-guard.ts";
import { applyClariceSuggestions } from "../scripts/clarice-apply.ts";
import { applyChunkSuggestions } from "../scripts/lib/clarice-chunk.ts";

// Os 5 casos da issue #11875.
const URL_MARKUP_CASES: Array<[string, string]> = [
  ["openai.com hoje", "openai. com hoje"],
  ["[link](https://x.com/a,b)", "[link](https://x.com/a, b)"],
  ["**negrito** aqui", "** negrito** aqui"],
  ["- item", "-item"],
  ["## Título", "##Título"],
];

// Os 2 casos da issue #11876.
const SHIFTED_BREAK_CASES: Array<[string, string]> = [
  ["a b\nc", "a\nb c"],
  ["fim. Começo\n\nX", "fim.\n\nComeço X"],
];

// Os 5 pares legítimos do #11867.
const LEGIT_PAIRS: Array<[string, string]> = [
  ["afim de", "a fim de"],
  ["Porque a IA", "Por que a IA"],
  ["se não", "senão"],
  ["a cerca de", "acerca de"],
  ["texto,outro", "texto, outro"],
];

test("#11875: espaço dentro de URL/markup é ruído (os 5 casos da issue)", () => {
  for (const [from, to] of URL_MARKUP_CASES) {
    assert.equal(classifyClariceNoise(from, to), "whitespace_only", `${from} → ${to}`);
  }
});

test("#11875: variações do mesmo defeito também são recusadas", () => {
  // remoção de espaço no marcador (sentido inverso)
  assert.equal(classifyClariceNoise("-item", "- item"), "whitespace_only");
  assert.equal(classifyClariceNoise("1. passo", "1.passo"), "whitespace_only");
  assert.equal(classifyClariceNoise("> citação", ">citação"), "whitespace_only");
  // itálico e domínio .br
  assert.equal(classifyClariceNoise("_itálico_ aqui", "_ itálico_ aqui"), "whitespace_only");
  assert.equal(classifyClariceNoise("veja diar.ia.br agora", "veja diar. ia.br agora"), "whitespace_only");
  // marcador no começo de uma linha que não é a primeira do trecho
  assert.equal(classifyClariceNoise("texto\n- item", "texto\n-item"), "whitespace_only");
});

test("#11876: quebra que muda de lugar com a mesma contagem é ruído", () => {
  for (const [from, to] of SHIFTED_BREAK_CASES) {
    assert.equal(classifyClariceNoise(from, to), "whitespace_only", JSON.stringify([from, to]));
  }
});

test("#11875/#11876: os 5 pares legítimos do #11867 continuam passando", () => {
  for (const [from, to] of LEGIT_PAIRS) {
    assert.equal(classifyClariceNoise(from, to), null, `${from} → ${to}`);
  }
  assert.equal(classifyClariceNoise("a  b", "a b"), null);
  // falta de espaço depois do ponto antes de maiúscula não é domínio
  assert.equal(classifyClariceNoise("fim.Começo", "fim. Começo"), null);
  // correção real no mesmo trecho que um link, longe do link
  assert.equal(
    classifyClariceNoise("veja [o site](https://x.com) com texto,outro", "veja [o site](https://x.com) com texto, outro"),
    null,
  );
  // hífen no meio da palavra não é marcador de lista
  assert.equal(classifyClariceNoise("o bem -vindo", "o bem-vindo"), null);
  // mesmas quebras no mesmo lugar, espaço no meio da linha: passa
  assert.equal(classifyClariceNoise("afim de\nfalar", "a fim de\nfalar"), null);
});

const TEXT = [
  "A OpenAI publicou em openai.com hoje o relatório.",
  "",
  "**negrito** aqui, e ele estudou afim de passar.",
  "",
  "- item",
  "## Título",
].join("\n");

const SUGGESTIONS = [
  { from: "openai.com hoje", to: "openai. com hoje", rule: "Pontuação" },
  { from: "**negrito** aqui", to: "** negrito** aqui" },
  { from: "- item", to: "-item" },
  { from: "## Título", to: "##Título" },
  { from: "afim de", to: "a fim de", rule: "Ortografia" },
];

const EXPECTED = TEXT.replace("afim de", "a fim de");

test("#11875: clarice-apply recusa URL/markup e aplica a correção real", () => {
  const r = applyClariceSuggestions(TEXT, SUGGESTIONS);
  assert.deepEqual(r.applied.map((s) => s.from), ["afim de"]);
  assert.equal(r.patched, EXPECTED);
  assert.deepEqual(r.skipped.map((s) => s.reason), Array(4).fill("whitespace_only"));
});

test("#11875: caminho REST chunked recusa o mesmo", () => {
  const chunk = { text: TEXT, startOffset: 0, endOffset: TEXT.length, index: 0 };
  const r = applyChunkSuggestions(
    chunk as Parameters<typeof applyChunkSuggestions>[0],
    SUGGESTIONS,
    () => {},
  );
  assert.equal(r.text, EXPECTED);
  assert.equal(r.applied.length, 1);
  assert.deepEqual(r.skipped.map((s) => s.reason), Array(4).fill("whitespace_only"));
});
