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

/**
 * Pure: prefixo `host/path` normalizado de uma URL (lowercase, sem `www.`, sem
 * trailing slash; path "/" vira só o host). "" se inválida.
 *
 * #1927 review: host nu over-matcharia hosts multi-uso (github.com, aws.amazon.com).
 * O prefixo path-aware casa o site inteiro pra hosts dedicados (`fast.ai`) E só a
 * subárvore pra hosts largos (`github.com/anthropics/anthropic-cookbook`).
 */
export function sourcePrefix(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return path && path !== "" ? `${host}${path}` : host;
  } catch {
    return "";
  }
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
 * Lê `seed/sources.csv` e retorna os **prefixos `host/path`** das fontes
 * flagueadas `use_melhor` (path-aware — ver `sourcePrefix`). Usado pelo
 * roteamento do categorizer (follow-up) pra dar override de bucket `use_melhor`
 * a artigos cujo `host/path` comece com um desses prefixos (respeitando o
 * de-classificador de não-tutorial existente).
 */
export function loadUseMelhorPrefixes(root: string = ROOT): string[] {
  const csv = readFileSync(resolve(root, "seed", "sources.csv"), "utf8");
  const { data } = Papa.parse<SourceRow>(csv, { header: true, skipEmptyLines: true });
  const prefixes = new Set<string>();
  for (const row of data) {
    if (!row.URL || !isUseMelhorSource(row)) continue;
    const p = sourcePrefix(row.URL);
    if (p) prefixes.add(p);
  }
  return [...prefixes].sort();
}

/**
 * Pure: true se a URL de um artigo cai sob algum prefixo de fonte Use Melhor
 * (boundary-safe: `github.com/anthropics` casa `.../anthropics/x` mas não
 * `.../anthropics-other`). O caller (categorizer) ainda aplica o de-classificador
 * de não-tutorial por cima.
 */
export function matchesUseMelhorPrefix(url: string, prefixes: string[]): boolean {
  const target = sourcePrefix(url);
  if (!target) return false;
  return prefixes.some((p) => target === p || target.startsWith(p + "/"));
}
