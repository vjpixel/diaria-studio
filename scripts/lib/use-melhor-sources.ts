/**
 * use-melhor-sources.ts (#1899)
 *
 * Fonte de verdade da elegibilidade de uma fonte pra seção **Use Melhor**
 * (tutoriais/how-to). A coluna `use_melhor` em `seed/sources.csv` marca as
 * fontes dedicadas; este módulo é o helper compartilhado (sync-sources, e o
 * roteamento do categorizer no follow-up).
 *
 * Decisão do editor (#1899, 2026-06-06): híbrido **lista (esta flag) + tipo**
 * (detecção how-to no categorizer). A flag é a "lista-semente" de fontes
 * confiáveis; o filtro de tipo captura bons tutoriais fora da lista.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";

export interface SourceRow {
  Nome: string;
  Tipo: string;
  URL: string;
  RSS?: string;
  topic_filter?: string;
  use_melhor?: string;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Pure: fonte elegível pra Use Melhor (coluna `use_melhor` == "1"). */
export function isUseMelhorSource(s: { use_melhor?: string }): boolean {
  return (s.use_melhor ?? "").trim() === "1";
}

/** Pure: host de uma URL (lowercase, sem `www.`). "" se inválida. */
export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Lê `seed/sources.csv` e retorna os hosts das fontes flagueadas `use_melhor`.
 * Usado pelo roteamento do categorizer (follow-up) pra dar override de bucket
 * `use_melhor` a artigos vindos dessas fontes (respeitando o de-classificador
 * de não-tutorial existente).
 */
export function loadUseMelhorHosts(root: string = ROOT): string[] {
  const csv = readFileSync(resolve(root, "seed", "sources.csv"), "utf8");
  const { data } = Papa.parse<SourceRow>(csv, { header: true, skipEmptyLines: true });
  const hosts = new Set<string>();
  for (const row of data) {
    if (!row.URL || !isUseMelhorSource(row)) continue;
    const h = sourceHost(row.URL);
    if (h) hosts.add(h);
  }
  return [...hosts].sort();
}
