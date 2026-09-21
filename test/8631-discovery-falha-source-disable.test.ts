// Regressão #8631: fonte "Blog do Google Brasil (IA)" desativada temporariamente
// (3 falhas consecutivas de discovery 24-26/08; último ok 14/08; #8631).
// O parser real (Papa.parse sem comments:true) é exercido; uma linha
// comentada viraria fantasma — portanto só removemos a linha.
// A fonte NÃO relacionada "Google Codelabs (IA)" deve permanecer.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { loadAllSourcePrefixMap, loadUseMelhorPrefixes } from "../scripts/lib/use-melhor-sources.ts";

const { data } = Papa.parse<{ Nome: string; URL: string }>(
  readFileSync("seed/sources.csv", "utf8"),
  { header: true, skipEmptyLines: true },
);

function nome(r: { Nome?: string }): string {
  return r.Nome ?? "";
}

describe("#8631 discovery falha fonte Blog do Google Brasil", () => {
  it("fonte alvo 'Blog do Google Brasil (IA)' não aparece como ativa", () => {
    const active = data.filter((r) => nome(r).includes("Blog do Google Brasil"));
    assert.equal(active.length, 0, "Blog do Google Brasil ainda no CSV ativo");
  });

  it("fonte NÃO relacionada 'Google Codelabs (IA)' continua presente", () => {
    const present = data.filter((r) => nome(r).includes("Google Codelabs"));
    assert.equal(present.length, 1, "Google Codelabs removido indevidamente");
  });

  it("nenhuma linha-fantasma com '# DESATIVADO' sobrevive ao parser", () => {
    const ghosts = data.filter((r) => nome(r).includes("DESATIVADO"));
    assert.equal(ghosts.length, 0, "linha comentada virou fantasma");
  });

  it("prefixo da fonte alvo não entra no mapa de fontes", () => {
    const prefixes = loadAllSourcePrefixMap().map((e) => e.prefix);
    assert.ok(
      !prefixes.some((p) => p.includes("blog.google/intl/pt-br")),
      `blog.google ainda no mapa: ${prefixes.filter((p) => p.includes("blog.google"))}`,
    );
  });

  it("prefixo da fonte NÃO relacionada continua no mapa", () => {
    const prefixes = loadAllSourcePrefixMap().map((e) => e.prefix);
    assert.ok(
      prefixes.some((p) => p.includes("codelabs.developers.google.com")),
      "codelabs removido do mapa de fontes",
    );
  });

  it("prefixo da fonte alvo não entra na lista use_melhor", () => {
    const prefixes = loadUseMelhorPrefixes();
    assert.ok(
      !prefixes.some((p) => p.includes("blog.google/intl/pt-br")),
      `blog.google ainda em use_melhor: ${prefixes.filter((p) => p.includes("blog.google"))}`,
    );
  });

  it("prefixo da fonte NÃO relacionada continua em use_melhor", () => {
    const prefixes = loadUseMelhorPrefixes();
    assert.ok(
      prefixes.some((p) => p.includes("codelabs.developers.google.com")),
      "codelabs removido de use_melhor",
    );
  });

  it("o CSV permanece parseável e sem linhas vazias/inválidas", () => {
    assert.ok(data.length > 0);
    assert.ok(data.every((r) => nome(r).trim().length > 0));
  });
});
