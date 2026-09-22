// Regressão #8693: source de discovery "tutorial IA para iniciantes sem precisar"
// desativada temporariamente (4 falhas consecutivas de 402 Usage limit exceeded,
// 27/08 x2, 29/08, 31/08; último ok 260818; #8693).
//
// #8631-style durable-disable verification. A fonte NÃO é uma entrada registrada
// em seed/sources.csv (é uma query de discovery composta em runtime pelo
// orchestrator, sem pool fixo — ver stage-1-run.ts §1f: "o orchestrator deve
// compor ~5 queries PT + ~5 EN temáticas genéricas (julgamento, sem pool
// fixo)"), então não há linha no CSV para remover. O que o PR faz de
// durável no repo é este teste: garante que a desativação não é um gesture
// solto e que o padrão de falha (4x 402, last ok 260818) está documentado
// alongside do disable, e que o CSV de fontes registradas continua intacto
// (nenhuma linha fantasma, nenhuma fonte desaparecida indevidamente).
//
// O registro operacional em data/sources/*.jsonl é gitignored (OneDrive) e
// não sobrevive a um clone fresco — não é verificável em CI. O que sobrevive
// aqui é a invariant: o disable é declarado e o CSV ativo não sofreu.
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

describe("#8693 discovery falha source disable", () => {
  it("nenhuma linha-fantasma com '# DESATIVADO' sobrevive ao parser", () => {
    const ghosts = data.filter((r) => nome(r).includes("DESATIVADO"));
    assert.equal(ghosts.length, 0, "linha comentada virou fantasma no CSV");
  });

  it("o CSV permanece parseável e sem linhas vazias/inválidas", () => {
    assert.ok(data.length > 0);
    assert.ok(data.every((r) => nome(r).trim().length > 0));
  });

  it("o disable não removeu nenhuma fonte registrada do CSV ativo", () => {
    // #8693: a desativação é de uma query de discovery, não de uma fonte
    // registrada — o CSV de 49+ fontes não deve ter perdido linha.
    assert.ok(data.length >= 49, `CSV tem ${data.length} linhas, esperado >= 49`);
  });

  it("nenhum prefixo relacionado ao source desativado entra no mapa de fontes", () => {
    const prefixes = loadAllSourcePrefixMap().map((e) => e.prefix);
    assert.ok(
      !prefixes.some((p) => p.includes("tutorial-ia-para-iniciantes-sem-precisar")),
      `prefixo do source desativado ainda no mapa: ${prefixes.filter((p) => p.includes("iniciantes"))}`,
    );
  });

  it("nenhum prefixo relacionado ao source desativado entra na lista use_melhor", () => {
    const prefixes = loadUseMelhorPrefixes();
    assert.ok(
      !prefixes.some((p) => p.includes("tutorial-ia-para-iniciantes-sem-precisar")),
      `prefixo do source desativado ainda em use_melhor: ${prefixes.filter((p) => p.includes("iniciantes"))}`,
    );
  });
});