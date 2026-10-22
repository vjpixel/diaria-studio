/**
 * use-melhor-tempo-refresh.ts (#10765 itens 1/4/6)
 *
 * Refresh de medição do tempo dos itens USE MELHOR ANTES do gate do Stage 4.
 * Cobre o que o stitch não alcança: item inserido/movido à mão em 02-reviewed.md
 * (sem entrada no artifact) ou cujo "(N min)" o editor mudou depois da medição.
 *
 * Nunca reescreve 02-reviewed.md: o "(N min)" do texto é escolha editorial e
 * permanece. O refresh só registra a MEDIÇÃO em
 * `_internal/use-melhor-tempo-source.json` (`estimate`/`source` = medido,
 * `md_tempo` = o que o texto dizia na hora) — o check
 * `use-melhor-tempo-item-sem-medicao` (puro, síncrono) compara os dois.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { estimateUseMelhorTempoDetailed } from "./use-melhor-curation.ts";
import { loadCachedBody } from "./url-body-cache.ts";

export interface UseMelhorMdItem {
  title: string;
  url: string;
  /** minutos do "(N min)" no texto, ou null se ausente */
  mdTempo: number | null;
}

export interface TempoArtifactEntry {
  url: string;
  title?: string;
  estimate?: string;
  source?: string;
  /** tempo que o TEXTO dizia quando a medição foi registrada */
  md_tempo?: number | null;
}

const TEMPO_IN_TEXT_RE = /\(\s*~?\s*(\d+)\s*min\b|[–—]\s*~?\s*(\d+)\s*min\b|~\s*(\d+)\s*min\b/;

export function estimateMinutes(estimate: string | undefined): number | null {
  const m = estimate?.match(/\d+/);
  return m ? Number(m[0]) : null;
}

/** Itens da seção USE MELHOR de um 02-reviewed.md. Puro. */
export function parseUseMelhorItems(md: string): UseMelhorMdItem[] {
  const items: UseMelhorMdItem[] = [];
  let inSection = false;
  let cur: { title: string; url: string; text: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const m = cur.text.join(" ").match(TEMPO_IN_TEXT_RE);
    items.push({ title: cur.title, url: cur.url, mdTempo: m ? Number(m[1] ?? m[2] ?? m[3]) : null });
    cur = null;
  };
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const t = raw.trim();
    if (/^\*\*.*USE\s+MELHOR.*\*\*$/u.test(t)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (t === "---" || /^\*\*[^[\]]+\*\*$/u.test(t)) {
      flush();
      inSection = false;
      continue;
    }
    const m = t.match(/^\*\*\[([^\]]+)\]\((\S+?)\)\*\*/);
    if (m) {
      flush();
      cur = { title: m[1], url: m[2], text: [] };
    } else if (cur && t) {
      cur.text.push(t);
    }
  }
  flush();
  return items;
}

export function readTempoArtifact(editionDir: string): TempoArtifactEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(resolve(editionDir, "_internal", "use-melhor-tempo-source.json"), "utf8"));
    return Array.isArray(parsed) ? (parsed as TempoArtifactEntry[]) : [];
  } catch {
    return [];
  }
}

export function writeTempoArtifact(editionDir: string, entries: TempoArtifactEntry[]): void {
  mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
  writeFileSync(resolve(editionDir, "_internal", "use-melhor-tempo-source.json"), JSON.stringify(entries, null, 2), "utf8");
}

/** Entrada ainda vale? Medida (não título) e consistente com o texto atual. */
export function isEntryFresh(entry: TempoArtifactEntry | undefined, mdTempo: number | null): boolean {
  if (!entry || !entry.source || entry.source === "title-heuristic") return false;
  if (entry.md_tempo !== undefined) return entry.md_tempo === mdTempo;
  return estimateMinutes(entry.estimate) === mdTempo;
}

export interface RefreshResult {
  refreshed: { url: string; source: string; estimate: string; md_tempo: number | null }[];
  skipped: string[];
}

/**
 * Mede (corpo do cache ou fetch) cada item USE MELHOR sem medição fresca e
 * registra no artifact. Fail-soft por item: sem corpo → `title-heuristic`.
 */
export async function refreshUseMelhorTempo(
  editionDir: string,
  fetchBody: (bodiesDir: string, url: string) => Promise<string | null>,
): Promise<RefreshResult> {
  const reviewed = resolve(editionDir, "02-reviewed.md");
  const result: RefreshResult = { refreshed: [], skipped: [] };
  if (!existsSync(reviewed)) return result;
  const items = parseUseMelhorItems(readFileSync(reviewed, "utf8"));
  if (items.length === 0) return result;
  const entries = readTempoArtifact(editionDir);
  const bodiesDir = resolve(editionDir, "_internal", "_forensic", "link-verify-bodies");
  let dirty = false;
  for (const it of items) {
    const prev = entries.find((e) => e.url === it.url);
    if (isEntryFresh(prev, it.mdTempo)) {
      result.skipped.push(it.url);
      continue;
    }
    const body = loadCachedBody(bodiesDir, it.url) ?? (await fetchBody(bodiesDir, it.url));
    const { estimate, source } = estimateUseMelhorTempoDetailed(it.title, it.url, body);
    const entry: TempoArtifactEntry = { url: it.url, title: it.title, estimate, source, md_tempo: it.mdTempo };
    const idx = entries.findIndex((e) => e.url === it.url);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    result.refreshed.push({ url: it.url, source, estimate, md_tempo: it.mdTempo });
    dirty = true;
  }
  if (dirty) writeTempoArtifact(editionDir, entries);
  return result;
}
