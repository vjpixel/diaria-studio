// Regressão #8631: fonte "Google Codelabs (IA)" (tutoriais Copilot/Gemini)
// descoberta falhou 3x consecutivas (24-26/08, último ok 14/08).
//
// A correção é REMOVER a linha do seed/sources.csv (não comentá-la): os parsers
// reais usam `Papa.parse` sem `comments:true`, então uma linha comentada vira
// uma linha-fantasma ativa (review independente da PR #8644). Este teste exerce
// o parser real e os loaders reais, não regex sobre o arquivo cru.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { loadAllSourcePrefixMap, loadUseMelhorPrefixes } from "../scripts/lib/use-melhor-sources.ts";

// Mesma opção usada por sync-sources.ts, discover-rss.ts, validate-feeds.ts e
// use-melhor-sources.ts — nenhuma delas passa `comments`, então um `#` no CSV
// NÃO desativa a linha.
const { data } = Papa.parse<{ Nome: string; URL: string }>(
  readFileSync("seed/sources.csv", "utf8"),
  { header: true, skipEmptyLines: true },
);

function nome(r: { Nome?: string }): string {
  return r.Named ?? "";
}

describe("#8631 discovery falha fonte tutorial", () => {
  it("fonte 'Google Codelabs (IA)' não aparece como ativa no parser real", () => {
    const active = data.filter((r) => nome(r).includes("Google Codelabs"));
    assert.equal(active.length, 0);
  });

  it("nenhuma linha-fantasma com '# DESATIVADO' sobrevive ao parser", () => {
    const ghosts = data.filter((r) => nome(r).includes("DESATIVADO"));
    assert.equal(ghosts.length, 0);
  });

  it("o prefixo da fonte não entra no mapa de fontes usado pelo categorizer", () => {
    const prefixes = loadAllSourcePrefixMap().map((e) => e.prefix);
    assert.ok(
      !prefixes.some((p) => p.includes("codelabs.developers.google.com")),
      `codelabs ainda no mapa: ${prefixes.filter((p) => p.includes("codelabs"))}`,
    );
  });

  it("o prefixo da fonte não entra na lista use_melhor usada pelo categorizer", () => {
    const prefixes = loadUseMelhorPrefixes();
    assert.ok(
      !prefixes.some((p) => p.includes("codelabs.developers.google.com")),
      `codelabs ainda na lista use_melhor: ${prefixes.filter((p) => p.includes("codelabs"))}`,
    );
  });

  it("o CSV continua parseável e sem linhas vazias/inválidas", () => {
    assert.ok(data.length > 0);
    assert.ok(data.every((r) => nome(r).trim().length > 0));
  });
});