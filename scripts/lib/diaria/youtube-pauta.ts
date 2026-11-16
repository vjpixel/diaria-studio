/**
 * scripts/lib/diaria/youtube-pauta.ts (#13195, épica #12072)
 *
 * Medição por pauta dos horizontais do @diariabr: impressões e taxa de cliques
 * da capa (#13192) e retenção (% médio assistido), somadas por pauta. Decisão
 * do editor no briefing do overnight 261116: SÓ INSTRUMENTAR. Nada aqui muda o
 * fluxo diário nem adota o horizontal seletivo; é o insumo para o editor
 * decidir depois se a pauta (impacto humano, segurança, guia, lançamento
 * técnico...) pesa no clique.
 *
 * Pauta de um horizontal = a da edição dele, nesta ordem:
 *   1. `data/youtube-analytics/pautas.json` (`{ "AAMMDD": "rótulo" }`), a
 *      classificação do editor, que vence sempre;
 *   2. a seção do DESTAQUE 1 da edição (`DESTAQUE 1 | 🔐 SEGURANÇA` →
 *      `segurança`), lida de `02-reviewed.md` pelo script de I/O.
 * Sem nenhuma das duas, o vídeo entra como "sem pauta" e é listado, nunca
 * some da conta.
 *
 * Agregação: CTR por pauta = cliques ÷ impressões, com cliques = impressões ×
 * CTR de cada vídeo (média ponderada, nunca a média simples das taxas). %
 * médio assistido ponderado por views. Vídeo sem dado de alcance (`null`,
 * relatório ainda não cobre) fica fora da soma de impressões/CTR, mas conta
 * em views e retenção.
 *
 * Puro, sem I/O. Só tipos de `youtube-analytics.ts` (evita ciclo em runtime).
 */

import type { EditionVideoIndex, VideoSnapshotLine } from "./youtube-analytics.ts";
import { normalizeCategoryTag } from "./youtube-video.ts";

/** Arquivo da classificação do editor, relativo a `data/youtube-analytics/`. */
export const YOUTUBE_PAUTAS_FILE = "pautas.json";

/** Rótulo do grupo dos horizontais sem pauta resolvida. */
export const PAUTA_UNKNOWN = "sem pauta";

export type PautaSource = "editor" | "d1";

export interface EditionPauta {
  pauta: string;
  source: PautaSource;
}

export type EditionPautas = Map<string, EditionPauta>;

/** Rótulo comparável: sem emoji, espaços colapsados, minúsculo (mesma regra da tag do YouTube, #10798). */
export function normalizePauta(label: string): string {
  return normalizeCategoryTag(label);
}

/**
 * Lê `pautas.json`. Formato: objeto `{ "AAMMDD": "rótulo" }`. Chave fora de
 * AAMMDD ou rótulo vazio lança com o nome do arquivo: classificação errada
 * em silêncio misturaria pautas na conta.
 */
export function parsePautaOverrides(raw: unknown, where: string): Map<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where}: esperado objeto { "AAMMDD": "pauta" } (#13195)`);
  }
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.startsWith("_")) continue; // comentário/nota (`_nota`)
    if (!/^\d{6}$/.test(k)) throw new Error(`${where}: chave ${JSON.stringify(k)} não é AAMMDD (#13195)`);
    const pauta = typeof v === "string" ? normalizePauta(v) : "";
    if (!pauta) throw new Error(`${where}: pauta vazia ou não-texto em ${k} (#13195)`);
    out.set(k, pauta);
  }
  return out;
}

/** Pauta por edição: a do editor vence a seção do D1. */
export function resolveEditionPautas(input: { d1Categories: Map<string, string>; overrides: Map<string, string> }): EditionPautas {
  const out: EditionPautas = new Map();
  for (const [edition, category] of input.d1Categories) {
    const pauta = normalizePauta(category);
    if (pauta) out.set(edition, { pauta, source: "d1" });
  }
  for (const [edition, pauta] of input.overrides) out.set(edition, { pauta, source: "editor" });
  return out;
}

/** Edições dos horizontais do índice (para o script saber quais `02-reviewed.md` ler). */
export function horizontalEditions(index: EditionVideoIndex): string[] {
  return [...new Set([...index.values()].filter((v) => v.kind === "horizontal").map((v) => v.edition))].sort();
}

export interface PautaAggregate {
  pauta: string;
  videos: number;
  views: number;
  /** Soma das impressões dos vídeos com alcance; `null` se nenhum tem. */
  impressions: number | null;
  /** Cliques estimados (impressões × CTR por vídeo). */
  clicks: number | null;
  /** Fração 0..1; `null` sem impressão. */
  ctr: number | null;
  /** % médio assistido ponderado por views (0..100); `null` sem views. */
  averageViewPercentage: number | null;
  netSubscribers: number;
  /** Vídeos sem dado de alcance (fora da soma de impressões). */
  withoutReach: number;
}

export interface PautaVideoRow {
  edition: string | null;
  pauta: string;
  source: PautaSource | null;
  line: VideoSnapshotLine;
}

/** Linhas dos horizontais com a pauta resolvida (sem pauta = `PAUTA_UNKNOWN`). */
export function pautaRows(videos: VideoSnapshotLine[], pautas: EditionPautas): PautaVideoRow[] {
  return videos
    .filter((v) => v.kind === "horizontal")
    .map((line) => {
      const hit = line.edition ? pautas.get(line.edition) : undefined;
      return { edition: line.edition, pauta: hit?.pauta ?? PAUTA_UNKNOWN, source: hit?.source ?? null, line };
    });
}

export function aggregateByPauta(rows: PautaVideoRow[]): PautaAggregate[] {
  const acc = new Map<string, PautaAggregate & { watchedPctViews: number }>();
  for (const r of rows) {
    const a =
      acc.get(r.pauta) ??
      { pauta: r.pauta, videos: 0, views: 0, impressions: null, clicks: null, ctr: null, averageViewPercentage: null, netSubscribers: 0, withoutReach: 0, watchedPctViews: 0 };
    a.videos++;
    a.views += r.line.views;
    a.watchedPctViews += r.line.averageViewPercentage * r.line.views;
    a.netSubscribers += r.line.subscribersGained - r.line.subscribersLost;
    const imp = r.line.thumbnailImpressions;
    const ctr = r.line.thumbnailCtr;
    if (typeof imp === "number" && typeof ctr === "number") {
      a.impressions = (a.impressions ?? 0) + imp;
      a.clicks = (a.clicks ?? 0) + imp * ctr;
    } else {
      a.withoutReach++;
    }
    acc.set(r.pauta, a);
  }
  return [...acc.values()]
    .map(({ watchedPctViews, ...a }) => ({
      ...a,
      ctr: a.impressions ? (a.clicks ?? 0) / a.impressions : null,
      averageViewPercentage: a.views > 0 ? watchedPctViews / a.views : null,
    }))
    .sort((x, y) => (y.ctr ?? -1) - (x.ctr ?? -1) || y.views - x.views || x.pauta.localeCompare(y.pauta));
}

const fmtInt = (n: number): string => Math.round(n).toLocaleString("pt-BR");
const fmtPct1 = (n: number | null): string => (n == null ? "—" : `${n.toFixed(1).replace(".", ",")}%`);
const fmtCtr = (f: number | null | undefined): string => (f == null ? "—" : fmtPct1(f * 100));
const esc = (s: string): string => s.replace(/\|/g, "/");

/**
 * Seção "Horizontais por pauta" do `--report` (#13195): tabela agregada por
 * pauta e, embaixo, cada horizontal com a pauta e a origem dela. Recebe as
 * linhas do snapshot mais recente (já com a edição reatribuída pelo índice).
 */
export function renderPautaSection(videos: VideoSnapshotLine[], pautas: EditionPautas): string[] {
  const rows = pautaRows(videos, pautas);
  const out = ["## Horizontais por pauta (#13195)", ""];
  if (!rows.length) return [...out, "Sem horizontal no snapshot ainda.", ""];
  out.push(
    "Só medição: a decisão de gravar horizontal só para algumas pautas segue com o editor. Pauta = `data/youtube-analytics/pautas.json` (editor) ou a seção do DESTAQUE 1 da edição. CTR da pauta = cliques ÷ impressões somados; % médio ponderado por views.",
    "",
    "| Pauta | Vídeos | Views | Impressões da capa | CTR da capa | % médio assistido | Inscritos líquidos |",
    "|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const a of aggregateByPauta(rows)) {
    const imp = a.impressions == null ? "—" : `${fmtInt(a.impressions)}${a.withoutReach ? ` (${a.withoutReach} sem alcance)` : ""}`;
    out.push(`| ${esc(a.pauta)} | ${a.videos} | ${fmtInt(a.views)} | ${imp} | ${fmtCtr(a.ctr)} | ${fmtPct1(a.averageViewPercentage)} | ${fmtInt(a.netSubscribers)} |`);
  }
  out.push("", "### Por horizontal", "", "| Pauta | Origem | Edição | Vídeo | Views | Impressões da capa | CTR da capa | % médio assistido |", "|---|---|---|---|---:|---:|---:|---:|");
  const sorted = [...rows].sort((x, y) => x.pauta.localeCompare(y.pauta) || (y.line.thumbnailCtr ?? -1) - (x.line.thumbnailCtr ?? -1) || y.line.views - x.line.views);
  for (const r of sorted) {
    const l = r.line;
    out.push(
      `| ${esc(r.pauta)} | ${r.source ?? "—"} | ${r.edition ?? "?"} | ${esc(l.title ?? l.videoId)} (${l.videoId}) | ${fmtInt(l.views)} | ${l.thumbnailImpressions == null ? "—" : fmtInt(l.thumbnailImpressions)} | ${fmtCtr(l.thumbnailCtr)} | ${fmtPct1(l.averageViewPercentage)} |`,
    );
  }
  const unknown = rows.filter((r) => r.pauta === PAUTA_UNKNOWN);
  if (unknown.length) {
    out.push(
      "",
      `Sem pauta: ${unknown.map((r) => r.edition ?? r.line.videoId).join(", ")}. Classificar em \`data/youtube-analytics/pautas.json\` (\`{ "AAMMDD": "pauta" }\`).`,
    );
  }
  out.push("");
  return out;
}
