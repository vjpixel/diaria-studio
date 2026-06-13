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

// ---------------------------------------------------------------------------
// #2176 — path-mais-específico-vence no empate de host entre fontes
// ---------------------------------------------------------------------------

/**
 * Entrada do mapa de todas as fontes cadastradas.
 * `prefix` é o prefixo `host/path` normalizado (ver `sourcePrefix`).
 * `useMelhor` reflete a coluna `use_melhor` do CSV.
 * `index` é a posição original no CSV — usado como desempate estável
 * quando dois prefixos têm exatamente o mesmo comprimento e o mesmo
 * valor de useMelhor.
 */
export interface SourcePrefixEntry {
  prefix: string;
  useMelhor: boolean;
  index: number;
}

/**
 * Lê `seed/sources.csv` e retorna **todas** as fontes como `SourcePrefixEntry[]`,
 * ordenadas por comprimento de prefixo decrescente (mais específico primeiro),
 * com desempate estável por índice original no CSV.
 *
 * Inclui fontes sem `use_melhor` — necessário para o desempate por especificidade
 * de path entre fontes que compartilham o mesmo host (#2176).
 */
export function loadAllSourcePrefixMap(root: string = ROOT): SourcePrefixEntry[] {
  const csv = readFileSync(resolve(root, "seed", "sources.csv"), "utf8");
  const { data } = Papa.parse<SourceRow>(csv, { header: true, skipEmptyLines: true });
  const entries: SourcePrefixEntry[] = [];
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row.URL) continue;
    const p = sourcePrefix(row.URL);
    if (!p) continue;
    entries.push({ prefix: p, useMelhor: isUseMelhorSource(row), index: i });
  }
  // Ordenar por especificidade (prefixo mais longo primeiro), depois por índice
  // no CSV (posição original) pra desempate estável quando comprimentos iguais.
  entries.sort((a, b) => b.prefix.length - a.prefix.length || a.index - b.index);
  return entries;
}

/**
 * #2176 — path-mais-específico-vence.
 *
 * Dado o mapa completo de fontes (retornado por `loadAllSourcePrefixMap`),
 * retorna se a URL deve ser tratada como `use_melhor` conforme a fonte MAIS
 * ESPECÍFICA que casa o host/path do artigo.
 *
 * Regra de desempate (determinística, documentada):
 *   1. Prefixo MAIS LONGO que é prefixo da URL vence (path mais específico).
 *      Ex: `blog.google/intl/pt-br/novidades/tecnologia` (len=43) vence
 *      `blog.google` (len=11) para uma URL em `blog.google/intl/pt-br/...`.
 *   2. Empate de comprimento → fonte `use_melhor=1` vence (favorece tutoriais).
 *   3. Empate de comprimento e use_melhor igual → menor índice no CSV vence
 *      (ordem de declaração — determinístico e estável independente da ordem
 *      dos source-researchers).
 *
 * Boundary-safe: `github.com/anthropics` casa `.../anthropics/x` mas não
 * `.../anthropics-other` (mesmo guard de `matchesUseMelhorPrefix`).
 *
 * Retorna `null` se nenhuma fonte cadastrada casa o host/path (URL fora do
 * seed — o caller mantém o comportamento anterior: só inferência por tipo).
 */
export function resolveUseMelhorBySpecificity(
  url: string,
  allEntries: SourcePrefixEntry[],
): boolean | null {
  const target = sourcePrefix(url);
  if (!target) return null;

  // allEntries está ordenado por (comprimento desc, índice asc).
  // Precisamos: dentre todos os entries cujo prefix é prefixo do target,
  // pegar o grupo de comprimento máximo e aplicar os desempates 2 e 3.
  let bestLength = -1;
  let bestUseMelhor = false;
  let foundAny = false;

  for (const entry of allEntries) {
    const matches = target === entry.prefix || target.startsWith(entry.prefix + "/");
    if (!matches) continue;

    const len = entry.prefix.length;

    if (!foundAny) {
      // Primeiro match — inicializa.
      bestLength = len;
      bestUseMelhor = entry.useMelhor;
      foundAny = true;
    } else if (len === bestLength) {
      // Mesmo comprimento — desempate 2: use_melhor=1 vence.
      // Desempate 3 (índice) já implícito: allEntries é estável por índice
      // (sort com a.index - b.index), então o primeiro entry de índice menor
      // com o mesmo comprimento já foi processado. Só sobrescrevemos se o
      // novo entry é use_melhor=1 e o atual não — um entry use_melhor=0 de
      // índice menor NÃO vence um use_melhor=1 de índice maior no mesmo
      // comprimento (desempate 2 > desempate 3).
      if (entry.useMelhor && !bestUseMelhor) {
        bestUseMelhor = true;
      }
    } else {
      // len < bestLength — entries mais curtos (menos específicos).
      // Como a lista está ordenada desc, todos os próximos também serão
      // menores — podemos parar.
      break;
    }
  }

  return foundAny ? bestUseMelhor : null;
}
