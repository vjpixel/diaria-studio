/**
 * use-melhor-tempo-refresh.ts (#10765 itens 1/4/6)
 *
 * Refresh de medição do tempo dos itens USE MELHOR ANTES do gate do Stage 4.
 * Cobre o que o stitch não alcança: item inserido/movido à mão em 02-reviewed.md
 * (sem entrada no artifact) ou cujo "(N min)" o editor mudou depois da medição.
 *
 * Por padrão só registra a medição. Com write, sincroniza o tempo no Markdown
 * apenas quando há fonte medida (nunca title-heuristic), preservando a prosa.
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

/** Altera só o tempo da descrição dos itens medidos, mantendo quebras e seções. */
export function writeMeasuredTempos(md: string, measured: Map<string, number>): string {
  const lines = md.split(/(?<=\n)/);
  let inSection = false;
  let url: string | null = null;
  let body: number[] = [];
  const flush = () => {
    const minutes = url ? measured.get(url) : undefined;
    if (minutes !== undefined && body.length > 0) {
      const index = body.find((i) => TEMPO_IN_TEXT_RE.test(lines[i]));
      if (index !== undefined) {
        lines[index] = lines[index].replace(
          /(\(\s*~?\s*)\d+(\s*min\b)|([–—]\s*~?\s*)\d+(\s*min\b)|(~\s*)\d+(\s*min\b)/,
          (_match, a, b, c, d, e, f) => `${a ?? c ?? e}${minutes}${b ?? d ?? f}`,
        );
      } else {
        const last = body[body.length - 1];
        lines[last] = lines[last].replace(/([ \t]*)(\r?\n)?$/, ` (${minutes} min)$1$2`);
      }
    }
    body = [];
    url = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^\*\*.*USE\s+MELHOR.*\*\*$/u.test(t)) {
      flush();
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (t === "---" || /^\*\*[^[\]]+\*\*$/u.test(t)) {
      flush();
      inSection = false;
      continue;
    }
    const item = t.match(/^\*\*\[([^\]]+)\]\((\S+?)\)\*\*/);
    if (item) {
      flush();
      url = item[2];
    } else if (url && t) body.push(i);
  }
  flush();
  return lines.join("");
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
  options: { write?: boolean } = {},
): Promise<RefreshResult> {
  const reviewed = resolve(editionDir, "02-reviewed.md");
  const result: RefreshResult = { refreshed: [], skipped: [] };
  if (!existsSync(reviewed)) return result;
  const originalMd = readFileSync(reviewed, "utf8");
  const items = parseUseMelhorItems(originalMd);
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
  if (options.write) {
    const measured = new Map<string, number>();
    for (const item of items) {
      const entry = entries.find((e) => e.url === item.url);
      const minutes = estimateMinutes(entry?.estimate);
      if (entry?.source && entry.source !== "title-heuristic" && minutes !== null) {
        measured.set(item.url, minutes);
      }
    }
    const updatedMd = writeMeasuredTempos(originalMd, measured);
    // O fetch é assíncrono: nunca sobrescrever uma edição feita durante a medição.
    if (readFileSync(reviewed, "utf8") !== originalMd) {
      throw new Error("02-reviewed.md mudou durante a medição; rode o refresh novamente.");
    }
    if (updatedMd !== originalMd) writeFileSync(reviewed, updatedMd, "utf8");
    for (const item of parseUseMelhorItems(updatedMd)) {
      const entry = entries.find((e) => e.url === item.url);
      if (entry && measured.has(item.url) && entry.md_tempo !== item.mdTempo) {
        entry.md_tempo = item.mdTempo;
        dirty = true;
      }
    }
  }
  if (dirty) writeTempoArtifact(editionDir, entries);
  return result;
}
