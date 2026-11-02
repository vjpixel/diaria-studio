/**
 * Regressão #11798 — Clarice MCP devolveu só ruído num texto multi-parágrafo
 * (edição 261103): `\n\n` inserido antes da 1ª palavra de cada parágrafo e
 * `.` → `."}]}]);\n}`. Aplicar isso mecanicamente corrompia o texto.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyClariceNoise } from "../scripts/lib/clarice-suggestion-guard.ts";
import { applyClariceSuggestions } from "../scripts/clarice-apply.ts";
import { applyChunkSuggestions } from "../scripts/lib/clarice-chunk.ts";

const TEXT = [
  "A OpenAI lançou um modelo novo nesta semana.",
  "",
  "Pesquisadores dizem que o ganho é pequeno.",
  "",
  "Empresas brasileiras ainda testam a ferramenta, e os resultado variam.",
].join("\n");

// Reproduz o formato devolvido pelo servidor na edição 261103.
const NOISE = [
  { from: "A OpenAI", to: "\n\nA OpenAI", rule: "", explanation: "" },
  { from: "Pesquisadores", to: "\n\nPesquisadores", rule: "Parágrafo", explanation: "" },
  { from: "Empresas", to: "\n\nEmpresas" },
  { from: "ferramenta, e", to: 'ferramenta."}]}]);\n}', explanation: "ponto final dentro das aspas" },
];
const REAL = { from: "os resultado", to: "os resultados", rule: "Concordância" };

test("#11798: whitespace-only é ruído", () => {
  assert.equal(classifyClariceNoise("Pesquisadores", "\n\nPesquisadores"), "whitespace_only");
  // `"a  b"→"a b"` deixou de ser ruído no #11867 (espaço no meio da linha é
  // correção); a diferença na borda do trecho continua ruído.
  assert.equal(classifyClariceNoise("palavra", " palavra "), "whitespace_only");
});

test("#11798: to com resto de JSON/código é ruído", () => {
  assert.equal(classifyClariceNoise(".", '."}]}]);\n}'), "structural_injection");
  assert.equal(classifyClariceNoise("texto", "texto}"), "structural_injection");
  assert.equal(classifyClariceNoise("palavra", "<b>palavra"), "structural_injection");
});

test("#11798: quebra de linha nova com mudança de conteúdo é ruído", () => {
  assert.equal(classifyClariceNoise("fim, começo", "fim.\nComeço"), "structural_injection");
});

test("#11798: correções legítimas passam", () => {
  assert.equal(classifyClariceNoise("os resultado", "os resultados"), null);
  assert.equal(classifyClariceNoise("manter", "manter a"), null);
  assert.equal(classifyClariceNoise("disse,", "disse:"), null);
  assert.equal(classifyClariceNoise('"fim".', '"fim."'), null);
  // colchete que já existia em `from` (link markdown) não conta como injeção
  assert.equal(classifyClariceNoise("[o link](u) dise", "[o link](u) disse"), null);
  assert.equal(classifyClariceNoise("igual", "igual"), null);
});

test("#11798: clarice-apply recusa o ruído e aplica só a correção real", () => {
  const r = applyClariceSuggestions(TEXT, [...NOISE, REAL]);
  assert.deepEqual(r.applied.map((s) => s.from), ["os resultado"]);
  assert.equal(r.patched, TEXT.replace("os resultado", "os resultados"));
  assert.deepEqual(
    r.skipped.map((s) => s.reason),
    ["whitespace_only", "whitespace_only", "whitespace_only", "structural_injection"],
  );
  assert.ok(!r.patched.includes("}"));
});

test("#11798: caminho REST chunked (applyChunkSuggestions) recusa o mesmo ruído", () => {
  const chunk = { text: TEXT, startOffset: 0, endOffset: TEXT.length, index: 0 };
  const r = applyChunkSuggestions(chunk as Parameters<typeof applyChunkSuggestions>[0], [...NOISE, REAL], () => {});
  assert.equal(r.text, TEXT.replace("os resultado", "os resultados"));
  assert.equal(r.applied.length, 1);
  assert.deepEqual(
    r.skipped.map((s) => s.reason),
    ["whitespace_only", "whitespace_only", "whitespace_only", "structural_injection"],
  );
});
