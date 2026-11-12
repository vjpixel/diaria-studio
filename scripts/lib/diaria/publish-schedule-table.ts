/**
 * scripts/lib/diaria/publish-schedule-table.ts (#12748)
 *
 * Tabela de horários que fecha o `/diaria-publica`: Rede × Use Melhor/D1/D2/
 * D3/Vertical. Antes do #12748 o relato listava só os posts das Etapas 5/6, e
 * o vertical (Parte B), que sai nas mesmas contas, ficava de fora — a colisão
 * D1 11:00 × vertical 12:00 só aparecia como `[aviso]` no plano do
 * `publish-shorts.ts`.
 *
 * Fontes: `_internal/06-social-published.json` (horário real de cada post
 * social) e o registro do vertical (`_internal/06-shorts-published*.json`,
 * principal + timers do 300, unidos por `readShortsRegistry`, #12893: horário
 * real de cada destino). Destino do vertical ainda sem registro (a Parte B roda depois
 * do Stage 5, #12591) entra com o horário CONFIGURADO (`publishing.shorts.schedule`,
 * #12250), marcado `previsto`; o repost da página do LinkedIn, planejado só na
 * Parte B, sai `Parte B`. Rede sem post daquele tipo: `—`.
 *
 * Também acusa, por conta, os pares a menos de 2 h (espaçamento mínimo do
 * #10819), contando o vertical e o 4º post do perfil pessoal do LinkedIn
 * (`_internal/06-linkedin-personal.json`, #9568), que não tem coluna própria e
 * sai numa linha abaixo da tabela.
 *
 * Só a entrada principal de cada post social preenche a célula (`subtype`
 * ausente ou `main`): comentário e post auxiliar do mesmo destaque têm horário
 * próprio e não são o post da grade. No vertical, só destino com status vivo
 * conta.
 *
 * Puro: sem I/O.
 */

import { DEFAULT_MIN_GAP_MINUTES, gridFromLinkedInPersonalIntent, socialAccountKey } from "../social-slot-planner.ts";
import { ROTATION_POST_TYPES, type RotationPostType } from "../social-schedule-rotation.ts";
import { verticalDestinationTimes } from "./vertical-social-clearance.ts";
import { loadShortsConfig } from "./short-video.ts";

export type ScheduleColumn = RotationPostType | "vertical";

export interface ScheduleCell {
  /** HH:MM BRT, ou o texto da célula (`—`, `Parte B`, `falhou`). */
  text: string;
  /** Instante (ms) quando a célula é um horário; usado no espaçamento. */
  at: number | null;
  /** `true` = horário da config, o destino ainda não foi registrado. */
  planned?: boolean;
}

export interface ScheduleRow {
  label: string;
  account: string;
  cells: Record<ScheduleColumn, ScheduleCell>;
  /** Posts da conta fora das colunas (o 4º post do perfil pessoal do LinkedIn, #9568). */
  extras?: Array<{ label: string; at: number }>;
}

export interface ScheduleTable {
  rows: ScheduleRow[];
  warnings: string[];
}

const COLUMNS: readonly ScheduleColumn[] = [...ROTATION_POST_TYPES, "vertical"];
const COLUMN_LABEL: Record<ScheduleColumn, string> = { um: "Use Melhor", d1: "D1", d2: "D2", d3: "D3", vertical: "Vertical" };
const EMPTY: ScheduleCell = Object.freeze({ text: "—", at: null }) as ScheduleCell;
const LIVE = new Set(["scheduled", "published", "send_unknown"]);

const brtHHMM = (ms: number) => new Date(ms - 3 * 3_600_000).toISOString().slice(11, 16);

function brtInstant(aammdd: string, hhmm: string): number {
  return Date.parse(`20${aammdd.slice(0, 2)}-${aammdd.slice(2, 4)}-${aammdd.slice(4, 6)}T${hhmm}:00-03:00`);
}

/** Rótulo da linha por conta da grade. */
export function accountLabel(account: string): string {
  const [platform, page] = account.split(":");
  const named: Record<string, string> = {
    "linkedin:diaria": "LinkedIn",
    "facebook:diaria": "Facebook",
    "instagram:diaria": "Instagram",
    "threads:diaria": "Threads",
    "twitter:diaria": "X",
    "youtube:diaria": "YouTube Shorts",
    "tiktok:diaria": "TikTok",
    "linkedin:pessoal": "LinkedIn (perfil pessoal)",
    "threads:pessoal": "Threads (perfil pessoal)",
    "facebook:perfil-pessoal": "Facebook (perfil pessoal)",
  };
  if (named[account]) return named[account];
  const p = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", threads: "Threads", twitter: "X" }[platform] ?? platform;
  return `${p} (${page})`;
}

/** Linha da tabela de cada destino do vertical. */
function verticalRowAccount(destination: string, instagramAuthor: string | null): string {
  if (destination === "youtube_shorts") return socialAccountKey("youtube", "diaria");
  if (destination === "facebook_profile") return socialAccountKey("facebook", "perfil-pessoal");
  if (destination === "linkedin_profile") return socialAccountKey("linkedin", "pessoal");
  if (destination === "linkedin_page_repost") return socialAccountKey("linkedin", "diaria");
  if (destination === "threads_profile") return socialAccountKey("threads", "pessoal");
  if (destination === "x") return socialAccountKey("twitter", "diaria");
  if (destination === "tiktok") return socialAccountKey("tiktok", "diaria");
  if (destination === "instagram") return socialAccountKey("instagram", instagramAuthor ?? "diaria");
  if (destination.startsWith("facebook:")) return socialAccountKey("facebook", destination.slice("facebook:".length));
  return destination.toLowerCase();
}

/** Ordem fixa das linhas: as 5 redes das Etapas 5/6, depois as que só recebem o vertical. */
const ROW_ORDER = [
  "linkedin:diaria",
  "facebook:diaria",
  "instagram:diaria",
  "threads:diaria",
  "twitter:diaria",
  "youtube:diaria",
  "tiktok:diaria",
  "linkedin:pessoal",
  "threads:pessoal",
  "facebook:perfil-pessoal",
];

function isoOf(e: Record<string, unknown>): string | null {
  for (const k of ["scheduled_at", "published_at", "at"]) {
    const v = e[k];
    if (typeof v === "string" && v && !Number.isNaN(Date.parse(v))) return v;
  }
  return null;
}

export function buildScheduleTable(input: {
  aammdd: string;
  config: unknown;
  /** Conteúdo de `_internal/06-social-published.json` (ou `null`). */
  social: unknown;
  /** Registro do vertical: a visão unida de `readShortsRegistry` (principal + timers, #12893), o `06-shorts-published.json` legado, ou `null`. */
  shorts: unknown;
  /** Conteúdo de `_internal/06-linkedin-personal.json` (ou `null`/ausente). */
  linkedinPersonal?: unknown;
  minGapMinutes?: number;
}): ScheduleTable {
  const gap = (input.minGapMinutes ?? DEFAULT_MIN_GAP_MINUTES) * 60_000;
  const rows = new Map<string, ScheduleRow>();
  const row = (account: string) => {
    let r = rows.get(account);
    if (!r) {
      r = { label: accountLabel(account), account, cells: Object.fromEntries(COLUMNS.map((c) => [c, EMPTY])) as Record<ScheduleColumn, ScheduleCell> };
      rows.set(account, r);
    }
    return r;
  };
  for (const a of ROW_ORDER.slice(0, 5)) row(a);

  const posts = (input.social as { posts?: unknown })?.posts;
  for (const p of Array.isArray(posts) ? (posts as Array<Record<string, unknown>>) : []) {
    if (typeof p?.platform !== "string" || typeof p.destaque !== "string") continue;
    const col = p.destaque as ScheduleColumn;
    if (!(ROTATION_POST_TYPES as readonly string[]).includes(col)) continue;
    if (p.subtype !== undefined && p.subtype !== null && p.subtype !== "main") continue;
    const r = row(socialAccountKey(p.platform, typeof p.page === "string" ? p.page : null));
    const iso = isoOf(p);
    if (typeof p.status === "string" && LIVE.has(p.status) && iso) {
      if (r.cells[col].at === null) r.cells[col] = { text: brtHHMM(Date.parse(iso)), at: Date.parse(iso) };
    } else if (r.cells[col] === EMPTY && p.status === "failed") {
      r.cells[col] = { text: "falhou", at: null };
    }
  }

  const shortsCfg = loadShortsConfig(input.config);
  const entries = (input.shorts as { entries?: unknown })?.entries;
  const recorded = new Map<string, number>();
  for (const e of Array.isArray(entries) ? (entries as Array<Record<string, unknown>>) : []) {
    if (typeof e?.destination !== "string") continue;
    if (typeof e.status !== "string" || !LIVE.has(e.status)) continue;
    const iso = isoOf(e);
    if (iso) recorded.set(e.destination, Date.parse(iso));
  }
  for (const v of verticalDestinationTimes(input.config, input.aammdd)) {
    const r = row(verticalRowAccount(v.destination, shortsCfg.instagramAuthorPage));
    const real = recorded.get(v.destination);
    if (real !== undefined) r.cells.vertical = { text: brtHHMM(real), at: real };
    else if (v.hhmm) {
      const at = brtInstant(input.aammdd, v.hhmm);
      r.cells.vertical = { text: `${v.hhmm} (previsto)`, at, planned: true };
    } else r.cells.vertical = { text: "Parte B", at: null };
  }

  for (const slot of gridFromLinkedInPersonalIntent(input.linkedinPersonal ?? null)) {
    const r = row(slot.account);
    (r.extras ??= []).push({ label: "4º post", at: Date.parse(slot.at) });
  }

  const ordered = [...rows.values()].sort((a, b) => {
    const ia = ROW_ORDER.indexOf(a.account);
    const ib = ROW_ORDER.indexOf(b.account);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.label.localeCompare(b.label);
  });

  const warnings: string[] = [];
  for (const r of ordered) {
    const timed = [
      ...COLUMNS.filter((c) => r.cells[c].at !== null).map((c) => ({ name: COLUMN_LABEL[c], at: r.cells[c].at as number })),
      ...(r.extras ?? []).map((x) => ({ name: x.label, at: x.at })),
    ];
    for (let i = 0; i < timed.length; i++) {
      for (let j = i + 1; j < timed.length; j++) {
        const diff = Math.abs(timed[i].at - timed[j].at);
        if (diff < gap) {
          warnings.push(
            `${r.label}: ${timed[i].name} ${brtHHMM(timed[i].at)} e ${timed[j].name} ${brtHHMM(timed[j].at)} BRT ` +
              `a ${Math.round(diff / 60_000)} min (mínimo ${gap / 60_000} min, #10819)`,
          );
        }
      }
    }
  }
  return { rows: ordered, warnings };
}

/** Markdown da tabela + avisos de espaçamento abaixo dela. */
export function renderScheduleTableMarkdown(table: ScheduleTable): string {
  const head = `| Rede | ${COLUMNS.map((c) => COLUMN_LABEL[c]).join(" | ")} |`;
  const sep = `|---|${COLUMNS.map(() => "---").join("|")}|`;
  const body = table.rows.map((r) => `| ${r.label} | ${COLUMNS.map((c) => r.cells[c].text).join(" | ")} |`);
  const lines = [head, sep, ...body];
  const extras = table.rows.flatMap((r) => (r.extras ?? []).map((x) => `${r.label}: ${x.label} ${brtHHMM(x.at)}`));
  if (extras.length) lines.push("", ...extras);
  if (table.warnings.length) {
    lines.push("", ...table.warnings.map((w) => `Aviso: ${w}`));
  }
  return lines.join("\n");
}
