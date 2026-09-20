/**
 * scripts/lib/subscriber-confirmation-report.ts (#8552, residual)
 *
 * Miolo PURO do relatório de taxa de confirmação (double opt-in) por coorte
 * de cadastro e por canal, em janelas de 1h/24h/7d/30d, mais a distribuição
 * do tempo até confirmar — separado por `confirmou_via` (Kit DOI vs botão da
 * reativação Brevo, #8438). Opera só sobre snapshots diários já carregados
 * (`loadAllSubscriberStateSnapshots`, `subscriber-state-snapshot.ts`); zero
 * I/O, zero rede.
 *
 * ## Definição de coorte (mesma de `buildDoiConfirmationCohort`)
 *
 * Coorte de cadastro do dia D = assinantes cujo `created_at` cai em D (BRT)
 * e cujo PRIMEIRO snapshot em que aparecem (dentro de D ou D+1) os mostra
 * `inactive` — a única forma de saber "nasceu inactive". Quem já aparece
 * `active` no primeiro snapshot é AMBÍGUO (nasceu ativo por single opt-in,
 * ou confirmou antes do snapshot tirado no fim do dia) e fica FORA da taxa,
 * contado à parte em `ambiguos` — nunca somado como confirmado nem como não
 * confirmado.
 *
 * ## Limites de resolução (honestos, não escondidos)
 *
 * - Granularidade DIÁRIA: o instante real da confirmação só é conhecido como
 *   "entre o snapshot anterior e o primeiro snapshot `active`". Por isso:
 *   janela `1h` NÃO é resolvível (`resolvivel: false`, com motivo) — nunca
 *   emite número inventado; `24h`/`7d`/`30d` valem como "confirmado até o
 *   snapshot de D+1/D+7/D+30" (dia-calendário, não horas exatas).
 * - Uma janela só conta um membro quando ELA JÁ MATUROU pra ele (existe
 *   snapshot >= D + janela). Coorte imatura não puxa a taxa pra baixo.
 * - Snapshot faltando num dia empurra a confirmação pro próximo snapshot
 *   disponível (superestima o tempo até confirmar, nunca subestima).
 * - Quem confirma antes do primeiro snapshot vira ambíguo (ver acima): a
 *   taxa medida é o piso dos confirmadores TARDIOS, e o tempo até confirmar
 *   começa em 1 dia. Reduzir isso exige snapshots mais frequentes — fora de
 *   escopo desta fatia.
 *
 * @pure
 */

import type { SubscriberStateRecord } from "./subscriber-state-snapshot.ts";

export const CONFIRMATION_WINDOWS = [
  { key: "1h", days: null },
  { key: "24h", days: 1 },
  { key: "7d", days: 7 },
  { key: "30d", days: 30 },
] as const;

export type ConfirmationWindowKey = (typeof CONFIRMATION_WINDOWS)[number]["key"];

/** Buckets do histograma de tempo até confirmar (em dias, inclusive). */
export const TIME_TO_CONFIRM_BUCKETS = [
  { key: "1d", min: 0, max: 1 },
  { key: "2d", min: 2, max: 2 },
  { key: "3-7d", min: 3, max: 7 },
  { key: "8-30d", min: 8, max: 30 },
  { key: ">30d", min: 31, max: Infinity },
] as const;

const NO_1H_REASON =
  "snapshots são diários — o instante da confirmação só é conhecido com resolução de dia; janela de 1h não é resolvível";

/** Rótulos legíveis de `confirmou_via` (#8438). Valor ausente = caminho DOI
 *  nativo do Kit (ninguém clicou no botão da reativação com token válido). */
export const CONFIRMOU_VIA_LABELS: Record<string, string> = {
  "brevo-reativar": "Brevo (botão reativar)",
};
export const CONFIRMOU_VIA_NONE_LABEL = "Kit (DOI, sem confirmou_via)";
export const CANAL_UNKNOWN_LABEL = "(sem origem_cadastro)";

export interface WindowStats {
  resolvivel: boolean;
  /** Presente quando `resolvivel === false`. */
  motivo?: string;
  /** Membros da coorte cuja janela já maturou. */
  maduros: number;
  confirmados: number;
  /** `confirmados / maduros`; `null` quando `maduros === 0` ou irresolvível. */
  taxa: number | null;
}

export interface TimeToConfirmStats {
  confirmados: number;
  buckets: Record<string, number>;
  p50_dias: number | null;
  p90_dias: number | null;
}

export interface GroupStats {
  /** Tamanho da coorte (inactive no nascimento). */
  n: number;
  janelas: Record<ConfirmationWindowKey, WindowStats>;
  tempo_ate_confirmar: TimeToConfirmStats;
}

export interface ConfirmationReport {
  /** Data do snapshot mais recente — o "agora" da maturação. */
  as_of: string | null;
  snapshots: number;
  /** Membros ambíguos (1º snapshot já `active`) — fora de toda taxa. */
  ambiguos: number;
  /** Ids cujo `created_at` não caiu no intervalo pedido / sem snapshot de
   *  nascimento utilizável — fora de tudo. */
  fora_de_escopo: number;
  total: GroupStats;
  por_coorte: Record<string, GroupStats>;
  por_canal: Record<string, GroupStats>;
  por_confirmou_via: Record<string, GroupStats>;
  avisos: string[];
}

export interface ConfirmationReportOptions {
  /** Só coortes com data >= since (AAAA-MM-DD, BRT). */
  since?: string;
  /** Só coortes com data <= until. */
  until?: string;
}

/** Dia BRT (AAAA-MM-DD) de um instante ISO; `null` se inválido. */
function brtDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Soma dias a uma chave AAAA-MM-DD (aritmética em UTC, sem fuso). */
export function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Diferença inteira em dias `b - a` entre duas chaves AAAA-MM-DD. */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

interface Member {
  id: number;
  cohortDay: string;
  /** Dias entre a coorte e o 1º snapshot `active`; `null` = nunca confirmou. */
  daysToConfirm: number | null;
  canal: string;
  via: string;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function computeGroupStats(members: readonly Member[], asOf: string): GroupStats {
  const janelas = {} as Record<ConfirmationWindowKey, WindowStats>;
  for (const w of CONFIRMATION_WINDOWS) {
    if (w.days === null) {
      janelas[w.key] = { resolvivel: false, motivo: NO_1H_REASON, maduros: 0, confirmados: 0, taxa: null };
      continue;
    }
    let maduros = 0;
    let confirmados = 0;
    for (const m of members) {
      if (addDays(m.cohortDay, w.days) > asOf) continue; // ainda não maturou
      maduros++;
      if (m.daysToConfirm !== null && m.daysToConfirm <= w.days) confirmados++;
    }
    janelas[w.key] = { resolvivel: true, maduros, confirmados, taxa: maduros > 0 ? confirmados / maduros : null };
  }
  const days = members
    .map((m) => m.daysToConfirm)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  const buckets: Record<string, number> = {};
  for (const b of TIME_TO_CONFIRM_BUCKETS) buckets[b.key] = 0;
  for (const d of days) {
    const b = TIME_TO_CONFIRM_BUCKETS.find((x) => d >= x.min && d <= x.max);
    if (b) buckets[b.key]++;
  }
  return {
    n: members.length,
    janelas,
    tempo_ate_confirmar: {
      confirmados: days.length,
      buckets,
      p50_dias: percentile(days, 0.5),
      p90_dias: percentile(days, 0.9),
    },
  };
}

function groupBy(members: readonly Member[], keyOf: (m: Member) => string): Map<string, Member[]> {
  const out = new Map<string, Member[]>();
  for (const m of members) {
    const k = keyOf(m);
    const arr = out.get(k);
    if (arr) arr.push(m);
    else out.set(k, [m]);
  }
  return out;
}

function statsMap(groups: Map<string, Member[]>, asOf: string): Record<string, GroupStats> {
  const out: Record<string, GroupStats> = {};
  for (const k of [...groups.keys()].sort()) out[k] = computeGroupStats(groups.get(k)!, asOf);
  return out;
}

interface Track {
  created_at: string;
  firstDate: string;
  firstState: string;
  firstActiveDate: string | null;
  origem: string | null;
  via: string | null;
}

/**
 * Constrói o relatório a partir de snapshots (`Map<AAAA-MM-DD, records>`,
 * como devolve `loadAllSubscriberStateSnapshots`). @pure
 */
export function buildConfirmationReport(
  snapshotsByDate: ReadonlyMap<string, readonly SubscriberStateRecord[]>,
  opts: ConfirmationReportOptions = {},
): ConfirmationReport {
  const dates = [...snapshotsByDate.keys()].sort();
  const avisos: string[] = [];
  if (dates.length === 0) {
    avisos.push("nenhum snapshot disponível — rode scripts/subscriber-state-snapshot.ts primeiro");
    return {
      as_of: null,
      snapshots: 0,
      ambiguos: 0,
      fora_de_escopo: 0,
      total: computeGroupStats([], "0000-00-00"),
      por_coorte: {},
      por_canal: {},
      por_confirmou_via: {},
      avisos,
    };
  }
  const asOf = dates[dates.length - 1];
  if (dates.length < 2) avisos.push("só 1 snapshot — nenhuma confirmação pode ser observada ainda");

  // id -> primeiro snapshot em que aparece, primeiro snapshot `active` depois
  // dele, e valores mais recentes não vazios de origem/confirmou_via.
  const tracks = new Map<number, Track>();
  for (const date of dates) {
    for (const r of snapshotsByDate.get(date)!) {
      let t = tracks.get(r.id);
      const isFirst = !t;
      if (!t) {
        t = { created_at: r.created_at, firstDate: date, firstState: r.state, firstActiveDate: null, origem: null, via: null };
        tracks.set(r.id, t);
      }
      if (!isFirst && r.state === "active" && t.firstActiveDate === null) t.firstActiveDate = date;
      if (r.origem) t.origem = r.origem;
      if (r.confirmou_via) t.via = r.confirmou_via;
    }
  }

  let ambiguos = 0;
  let foraDeEscopo = 0;
  const members: Member[] = [];
  for (const [id, t] of tracks) {
    const cohortDay = brtDay(t.created_at);
    if (!cohortDay || (opts.since && cohortDay < opts.since) || (opts.until && cohortDay > opts.until)) {
      foraDeEscopo++;
      continue;
    }
    // Sem snapshot de nascimento utilizável: o assinante já existia antes do
    // 1º snapshot da série (cadastro anterior à captura) ou o snapshot do
    // dia D/D+1 faltou — estado de criação inobservável.
    if (t.firstDate < cohortDay || t.firstDate > addDays(cohortDay, 1)) {
      foraDeEscopo++;
      continue;
    }
    if (t.firstState !== "inactive") {
      ambiguos++;
      continue;
    }
    members.push({
      id,
      cohortDay,
      daysToConfirm: t.firstActiveDate ? diffDays(cohortDay, t.firstActiveDate) : null,
      canal: t.origem ?? CANAL_UNKNOWN_LABEL,
      via: t.via ? (CONFIRMOU_VIA_LABELS[t.via] ?? t.via) : CONFIRMOU_VIA_NONE_LABEL,
    });
  }

  if (ambiguos > 0) {
    avisos.push(
      `${ambiguos} assinante(s) já aparecem active no 1º snapshot (single opt-in ou confirmaram antes da captura) — fora das taxas; a taxa medida é o piso dos confirmadores tardios`,
    );
  }

  return {
    as_of: asOf,
    snapshots: dates.length,
    ambiguos,
    fora_de_escopo: foraDeEscopo,
    total: computeGroupStats(members, asOf),
    por_coorte: statsMap(groupBy(members, (m) => m.cohortDay), asOf),
    por_canal: statsMap(groupBy(members, (m) => m.canal), asOf),
    por_confirmou_via: statsMap(groupBy(members, (m) => m.via), asOf),
    avisos,
  };
}

function fmtRate(w: WindowStats): string {
  if (!w.resolvivel) return "n/d";
  if (w.taxa === null) return "—";
  return `${(w.taxa * 100).toFixed(1)}% (${w.confirmados}/${w.maduros})`;
}

function renderGroupLine(label: string, g: GroupStats): string {
  const j = g.janelas;
  const t = g.tempo_ate_confirmar;
  const dist = TIME_TO_CONFIRM_BUCKETS.map((b) => `${b.key}:${t.buckets[b.key]}`).join(" ");
  return (
    `${label.padEnd(34)} n=${String(g.n).padEnd(5)} 1h ${fmtRate(j["1h"])} | ` +
    `24h ${fmtRate(j["24h"]).padEnd(16)} | 7d ${fmtRate(j["7d"]).padEnd(16)} | 30d ${fmtRate(j["30d"]).padEnd(16)} | ` +
    `tempo p50=${t.p50_dias ?? "—"}d p90=${t.p90_dias ?? "—"}d [${dist}]`
  );
}

/** Renderização texto do relatório (uma linha por grupo). @pure */
export function renderConfirmationReportText(report: ConfirmationReport): string {
  const lines: string[] = [];
  lines.push(`Confirmação de assinantes (DOI) — snapshots: ${report.snapshots}, as_of: ${report.as_of ?? "n/d"}`);
  lines.push(`Ambíguos (1º snapshot já active): ${report.ambiguos} | fora de escopo: ${report.fora_de_escopo}`);
  lines.push("");
  lines.push("TOTAL");
  lines.push(renderGroupLine("todos", report.total));
  const sections: Array<[string, Record<string, GroupStats>]> = [
    ["POR CONFIRMOU_VIA (Kit vs Brevo, #8438)", report.por_confirmou_via],
    ["POR CANAL (origem_cadastro)", report.por_canal],
    ["POR COORTE DE CADASTRO (dia BRT)", report.por_coorte],
  ];
  for (const [title, groups] of sections) {
    lines.push("");
    lines.push(title);
    for (const [k, g] of Object.entries(groups)) lines.push(renderGroupLine(k, g));
    if (Object.keys(groups).length === 0) lines.push("(vazio)");
  }
  if (report.avisos.length > 0) {
    lines.push("");
    for (const a of report.avisos) lines.push(`AVISO: ${a}`);
  }
  return lines.join("\n") + "\n";
}
