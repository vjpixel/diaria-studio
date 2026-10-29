/**
 * fact-check-extra-sources.ts (#11531)
 *
 * Fontes ADICIONAIS de cada destaque para o fact-checker, além da fonte do
 * link do título (`fact-check-sources/d{N}.txt`, #8595).
 *
 * Problema (edição 261029): o D1 (CNN) citava o Plano Brasileiro de IA
 * (R$ 23 bilhões, 2024 a 2028), fato que está no Poder360 de 11/08/2026 e não
 * na CNN. O fact-checker só lia `d1.txt`, o claim saiu `NOT_FOUND_IN_SOURCE` e
 * o `--check-blocking` do gate deu exit 2 (#4361). O contorno foi anexar o
 * texto do Poder360 ao `d1.txt` à mão.
 *
 * Três origens de fonte adicional, todas da MESMA história do destaque:
 *   - `cluster`   — `cluster_sources[]` do destaque em `01-approved.json`
 *                   (perdedores do dedup same-story, #3920);
 *   - `aprofunde` — URLs do bloco "Aprofunde:" do destaque em `02-reviewed.md`
 *                   (o editor pode ter acrescentado/trocado links ali);
 *   - `editor`    — fonte indicada pelo editor no chat, gravada por
 *                   `scripts/add-destaque-source.ts`.
 *
 * Layout em `_internal/fact-check-sources/`:
 *   - `extras.json`        — manifest das fontes adicionais (`ExtraSourceEntry[]`);
 *   - `d{N}-extra-{k}.txt` — texto bruto de cada uma (k começa em 1 por destaque).
 *
 * O manifest principal (`manifest.json` + `d{N}.txt`) NÃO muda: o critério de
 * frescor dele (`isHighlightSourcesCacheFresh`) e o `--check` do
 * `refresh-destaque-sources.ts` seguem olhando só a fonte primária.
 *
 * Invalidação: cada entrada guarda `primary_url` (a URL do destaque no momento
 * do download). Se o destaque N trocar de URL (troca/promoção no gate 4), as
 * entradas daquele slot são descartadas — inclusive as do editor, que eram
 * sobre a história antiga. Nunca servir ao fact-checker texto de outra história.
 *
 * Fail-soft: download falho vira entrada `status: blocked|error`, nunca lança.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchSourceText } from "../fetch-source-text.ts";
import { parseDestaques } from "../extract-destaques.ts";

export type ExtraSourceOrigin = "cluster" | "aprofunde" | "editor";

export interface ExtraSourceEntry {
  destaque: number;
  /** Índice 1-based dentro do destaque — nome do arquivo `d{N}-extra-{k}.txt`. */
  k: number;
  url: string;
  origin: ExtraSourceOrigin;
  /** URL primária do destaque quando esta fonte foi baixada (chave de invalidação). */
  primary_url: string;
  status: "ok" | "blocked" | "error";
  erro: string | null;
  bytes: number;
  fetched_at: string;
}

export interface ExtraSourceCandidate {
  destaque: number;
  url: string;
  origin: ExtraSourceOrigin;
}

/** Teto de fontes AUTOMÁTICAS (cluster + aprofunde) por destaque — limita rede no Stage 4. */
export const MAX_AUTO_EXTRAS_PER_DESTAQUE = 4;

export const EXTRAS_MANIFEST = "extras.json";

export function extraSourceFileName(destaque: number, k: number): string {
  return `d${destaque}-extra-${k}.txt`;
}

/** Normaliza URL só para comparar (sem fragmento, sem barra final, host minúsculo). */
export function urlKey(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    const s = `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
    return s;
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

function clusterUrlsOf(h: unknown): string[] {
  const obj = (h ?? {}) as { cluster_sources?: unknown; article?: { cluster_sources?: unknown } };
  const list = Array.isArray(obj.article?.cluster_sources)
    ? obj.article!.cluster_sources
    : Array.isArray(obj.cluster_sources)
      ? obj.cluster_sources
      : [];
  return (list as Array<{ url?: unknown }>)
    .map((c) => (typeof c?.url === "string" ? c.url : ""))
    .filter((u) => /^https?:\/\//i.test(u));
}

/**
 * Candidatas automáticas por destaque: `cluster_sources[]` do approved + itens
 * do "Aprofunde:" do `02-reviewed.md` (quando passado). Puro. Exclui a URL
 * primária do próprio destaque, deduplica por URL e corta em
 * `MAX_AUTO_EXTRAS_PER_DESTAQUE` (Aprofunde antes do cluster: é o que o leitor
 * vê e o que o editor curou).
 */
export function collectAutoExtraCandidates(
  approved: unknown,
  primaryUrls: Array<string | undefined>,
  reviewedMd?: string,
): ExtraSourceCandidate[] {
  const highlights = ((approved as { highlights?: unknown[] } | null)?.highlights ?? []).slice(0, 3);
  let aprofundeByN = new Map<number, string[]>();
  if (reviewedMd) {
    try {
      aprofundeByN = new Map(parseDestaques(reviewedMd).map((d) => [d.n, (d.aprofunde ?? []).map((a) => a.url)]));
    } catch {
      // parse defensivo — MD malformado só tira o Aprofunde da conta
    }
  }
  const out: ExtraSourceCandidate[] = [];
  for (let i = 0; i < primaryUrls.length; i++) {
    const primary = primaryUrls[i];
    if (!primary) continue;
    const n = i + 1;
    const seen = new Set<string>([urlKey(primary)]);
    const tagged: ExtraSourceCandidate[] = [
      ...(aprofundeByN.get(n) ?? []).map((url) => ({ destaque: n, url, origin: "aprofunde" as const })),
      ...clusterUrlsOf(highlights[i]).map((url) => ({ destaque: n, url, origin: "cluster" as const })),
    ];
    let count = 0;
    for (const c of tagged) {
      const key = urlKey(c.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
      if (++count >= MAX_AUTO_EXTRAS_PER_DESTAQUE) break;
    }
  }
  return out;
}

/** Lê `extras.json`; `[]` se ausente ou ilegível (fail-soft). */
export function readExtrasManifest(sourcesDir: string): ExtraSourceEntry[] {
  const p = join(sourcesDir, EXTRAS_MANIFEST);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as ExtraSourceEntry[]) : [];
  } catch {
    return [];
  }
}

function writeExtrasManifest(sourcesDir: string, entries: ExtraSourceEntry[]): void {
  const sorted = [...entries].sort((a, b) => a.destaque - b.destaque || a.k - b.k);
  writeFileSync(join(sourcesDir, EXTRAS_MANIFEST), JSON.stringify(sorted, null, 2), "utf8");
}

function nextK(entries: ExtraSourceEntry[], destaque: number): number {
  return entries.filter((e) => e.destaque === destaque).reduce((m, e) => Math.max(m, e.k), 0) + 1;
}

async function fetchInto(
  sourcesDir: string,
  cand: ExtraSourceCandidate,
  k: number,
  primaryUrl: string,
  fetchImpl: typeof fetch,
): Promise<ExtraSourceEntry> {
  const fetched_at = new Date().toISOString();
  const r = await fetchSourceText(cand.url, fetchImpl);
  const base = { destaque: cand.destaque, k, url: cand.url, origin: cand.origin, primary_url: primaryUrl, fetched_at };
  if (r.ok) {
    writeFileSync(join(sourcesDir, extraSourceFileName(cand.destaque, k)), r.text, "utf8");
    return { ...base, status: "ok", erro: null, bytes: r.bytes };
  }
  return { ...base, status: r.kind === "blocked" ? "blocked" : "error", erro: r.message, bytes: 0 };
}

function isReusable(e: ExtraSourceEntry, sourcesDir: string): boolean {
  return e.status === "ok" && existsSync(join(sourcesDir, extraSourceFileName(e.destaque, e.k)));
}

/**
 * Sincroniza `extras.json` + `d{N}-extra-{k}.txt` com os destaques atuais:
 *   1. descarta entradas de slot cuja URL primária mudou (e os `.txt` delas);
 *   2. descarta entradas automáticas que não são mais candidatas;
 *   3. reusa as `ok` ainda válidas (sem rede); re-tenta as falhas;
 *   4. baixa as candidatas novas.
 * Entradas `editor` sobrevivem enquanto o destaque mantiver a URL primária.
 */
export async function syncExtraSources(
  approved: unknown,
  primaryUrls: Array<string | undefined>,
  internalDir: string,
  opts: { reviewedMd?: string; fetchImpl?: typeof fetch } = {},
): Promise<ExtraSourceEntry[]> {
  const sourcesDir = join(internalDir, "fact-check-sources");
  mkdirSync(sourcesDir, { recursive: true });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const candidates = collectAutoExtraCandidates(approved, primaryUrls, opts.reviewedMd);
  const candKeys = new Set(candidates.map((c) => `${c.destaque}|${urlKey(c.url)}`));

  const existing = readExtrasManifest(sourcesDir);
  const kept: ExtraSourceEntry[] = [];
  for (const e of existing) {
    const primary = primaryUrls[e.destaque - 1];
    const sameStory = !!primary && urlKey(primary) === urlKey(e.primary_url);
    const stillWanted = e.origin === "editor" || candKeys.has(`${e.destaque}|${urlKey(e.url)}`);
    if (sameStory && stillWanted) kept.push(e);
    else rmSync(join(sourcesDir, extraSourceFileName(e.destaque, e.k)), { force: true });
  }

  const result: ExtraSourceEntry[] = [];
  // Re-tenta falhas anteriores (podem ter sido transitórias) mantendo o k.
  for (const e of kept) {
    if (isReusable(e, sourcesDir)) {
      result.push(e);
      continue;
    }
    result.push(await fetchInto(sourcesDir, e, e.k, e.primary_url, fetchImpl));
  }
  for (const c of candidates) {
    const key = urlKey(c.url);
    if (result.some((e) => e.destaque === c.destaque && urlKey(e.url) === key)) continue;
    const primary = primaryUrls[c.destaque - 1]!;
    result.push(await fetchInto(sourcesDir, c, nextK(result, c.destaque), primary, fetchImpl));
  }
  writeExtrasManifest(sourcesDir, result);
  return result;
}

/**
 * Acrescenta (ou re-baixa) uma fonte indicada pelo editor para o destaque N.
 * Lança se o destaque não existir ou se a URL for a própria primária — os
 * erros de uso viram exit 1 no CLI. Download falho NÃO lança: volta a entrada
 * com `status` != ok (o CLI sai 2).
 */
export async function addEditorExtraSource(
  primaryUrls: Array<string | undefined>,
  internalDir: string,
  destaque: number,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExtraSourceEntry> {
  const primary = primaryUrls[destaque - 1];
  if (!primary) throw new Error(`destaque ${destaque} não existe (ou não tem URL) em 01-approved.json`);
  if (urlKey(primary) === urlKey(url)) {
    throw new Error(`a URL já é a fonte primária do D${destaque} (fact-check-sources/d${destaque}.txt)`);
  }
  const sourcesDir = join(internalDir, "fact-check-sources");
  mkdirSync(sourcesDir, { recursive: true });
  const entries = readExtrasManifest(sourcesDir);
  const key = urlKey(url);
  const prev = entries.find((e) => e.destaque === destaque && urlKey(e.url) === key);
  const rest = entries.filter((e) => e !== prev);
  const k = prev?.k ?? nextK(entries, destaque);
  // Fonte que já existia como automática passa a contar como do editor: ele a
  // indicou, então não deve sumir se o Aprofunde mudar depois.
  const entry = await fetchInto(sourcesDir, { destaque, url, origin: "editor" }, k, primary, fetchImpl);
  writeExtrasManifest(sourcesDir, [...rest, entry]);
  return entry;
}
