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
 * ## Definição de coorte (PARENTE de `buildDoiConfirmationCohort`, não igual)
 *
 * Diferenças em relação a `buildDoiConfirmationCohort`: (1) o nascimento é
 * o 1º snapshot em que o id aparece, aceito em D OU D+1 (lá exige o
 * snapshot do próprio D); (2) "confirmado" = QUALQUER snapshot posterior
 * `active` até a janela pedida (lá é o estado no 1º snapshot >= D+48h), então
 * quem confirma e depois muda de estado ainda conta como confirmado aqui.
 *
 * Coorte de cadastro do dia D = assinantes cujo `created_at` cai em D (BRT)
 * e cujo PRIMEIRO snapshot em que aparecem (dentro de D ou D+1) os mostra
 * `inactive` — a única forma de saber "nasceu inactive". Quem já aparece
 * `active` no primeiro snapshot é AMBÍGUO (nasceu ativo por single opt-in,
 * ou confirmou antes do snapshot tirado no fim do dia) e fica FORA da taxa,
 * contado à parte em `ambiguos_active` (por grupo, ao lado de cada taxa) —
 * nunca somado como confirmado nem como não confirmado. Quem já aparece em
 * outro estado (bounced/cancelled/complained…) vai pra `ambiguos_outros`,
 * sem a leitura de "single opt-in".
 *
 * ## `por_confirmou_via` NÃO é taxa
 *
 * `confirmou_via` só é preenchido DEPOIS da confirmação: o grupo Brevo contém
 * só confirmados (taxa ~100% por construção) e o grupo Kit mistura não
 * confirmados com confirmados sem via. Por isso este agrupamento reporta só
 * a distribuição de tempo até confirmar dentro dos confirmados
 * (`ViaStats`), nunca taxa.
 *
 * ## Tempo até confirmar é censurado à direita
 *
 * Só entram no tempo até confirmar (p50/p90/buckets) membros cuja janela de
 * 30d já maturou; senão, coortes recentes só contribuiriam com confirmações
 * rápidas e enviesariam a distribuição pra baixo.
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
  "snapshots diários têm resolução de dia; a janela de 1h vem da observação horária (subscriber-state-snapshot.ts --recent, seção 'Confirmação em horas')";

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
  /** Confirmados entre os membros com janela de 30d já madura. */
  confirmados: number;
  /** Membros com 30d maturado (base da distribuição). */
  base_maduros_30d: number;
  buckets: Record<string, number>;
  p50_dias: number | null;
  p90_dias: number | null;
}

export interface GroupStats {
  /** Tamanho da coorte (inactive no nascimento). */
  n: number;
  /** Ambíguos `active` no 1º snapshot deste grupo — fora das taxas abaixo;
   *  24h/7d são, na prática, "confirmou APÓS o dia do cadastro". */
  ambiguos_active: number;
  janelas: Record<ConfirmationWindowKey, WindowStats>;
  tempo_ate_confirmar: TimeToConfirmStats;
}

/** Grupo por `confirmou_via`: SEM taxa (ver docstring do topo). */
export interface ViaStats {
  /** Confirmados no grupo (todos, maduros ou não). */
  confirmados: number;
  tempo_ate_confirmar: TimeToConfirmStats;
  nota: string;
}

const VIA_NOTE =
  "NÃO é taxa: confirmou_via só é gravado após a confirmação (viés de seleção); só distribuição de tempo entre confirmados";

export interface ConfirmationReport {
  /** Data do snapshot mais recente — o "agora" da maturação. */
  as_of: string | null;
  snapshots: number;
  /** Membros ambíguos (1º snapshot já `active`) — fora de toda taxa. */
  ambiguos: number;
  /** Idem, mas com 1º snapshot em estado não-active/não-inactive. */
  ambiguos_outros: number;
  /** `created_at` inválido/ausente — fora de tudo, com aviso. */
  created_at_invalido: number;
  /** Ids cujo `created_at` não caiu no intervalo pedido / sem snapshot de
   *  nascimento utilizável — fora de tudo. */
  fora_de_escopo: number;
  total: GroupStats;
  por_coorte: Record<string, GroupStats>;
  por_canal: Record<string, GroupStats>;
  por_confirmou_via: Record<string, ViaStats>;
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

function timeToConfirm(members: readonly Member[], asOf: string): TimeToConfirmStats {
  const maduros = members.filter((m) => addDays(m.cohortDay, 30) <= asOf);
  const days = maduros
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
    confirmados: days.length,
    base_maduros_30d: maduros.length,
    buckets,
    p50_dias: percentile(days, 0.5),
    p90_dias: percentile(days, 0.9),
  };
}

function computeGroupStats(members: readonly Member[], asOf: string, ambiguosActive = 0): GroupStats {
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
  return { n: members.length, ambiguos_active: ambiguosActive, janelas, tempo_ate_confirmar: timeToConfirm(members, asOf) };
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

function statsMap(
  groups: Map<string, Member[]>,
  asOf: string,
  amb: Map<string, number>,
): Record<string, GroupStats> {
  const out: Record<string, GroupStats> = {};
  const keys = new Set([...groups.keys(), ...amb.keys()]);
  for (const k of [...keys].sort()) out[k] = computeGroupStats(groups.get(k) ?? [], asOf, amb.get(k) ?? 0);
  return out;
}

function viaStatsMap(groups: Map<string, Member[]>, asOf: string): Record<string, ViaStats> {
  const out: Record<string, ViaStats> = {};
  for (const k of [...groups.keys()].sort()) {
    const confirmed = groups.get(k)!.filter((m) => m.daysToConfirm !== null);
    out[k] = { confirmados: confirmed.length, tempo_ate_confirmar: timeToConfirm(confirmed, asOf), nota: VIA_NOTE };
  }
  return out;
}

function countBy(items: readonly { key: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of items) out.set(i.key, (out.get(i.key) ?? 0) + 1);
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
      ambiguos_outros: 0,
      created_at_invalido: 0,
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

  let ambiguosOutros = 0;
  let foraDeEscopo = 0;
  let invalido = 0;
  const members: Member[] = [];
  const ambActive: Array<{ dia: string; canal: string }> = [];
  for (const [id, t] of tracks) {
    const cohortDay = brtDay(t.created_at);
    if (!cohortDay) {
      invalido++;
      continue;
    }
    if ((opts.since && cohortDay < opts.since) || (opts.until && cohortDay > opts.until)) {
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
    if (t.firstState === "active") {
      ambActive.push({ dia: cohortDay, canal: t.origem ?? CANAL_UNKNOWN_LABEL });
      continue;
    }
    if (t.firstState !== "inactive") {
      ambiguosOutros++;
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

  if (ambActive.length > 0) {
    avisos.push(
      `${ambActive.length} assinante(s) já aparecem active no 1º snapshot (single opt-in ou confirmaram antes da captura) — fora das taxas; 24h/7d medem só "confirmou APÓS o dia do cadastro", piso dos confirmadores`,
    );
  }
  if (ambiguosOutros > 0) {
    avisos.push(
      `${ambiguosOutros} assinante(s) já aparecem em estado não-active/não-inactive (bounced/cancelled/complained…) no 1º snapshot — fora das taxas, sem leitura de single opt-in`,
    );
  }
  if (invalido > 0) avisos.push(`${invalido} assinante(s) com created_at inválido/ausente ignorados`);
  avisos.push(
    "tempo até confirmar considera só coortes com 30d maturados (censura à direita); 'por confirmou_via' não é taxa",
  );

  return {
    as_of: asOf,
    snapshots: dates.length,
    ambiguos: ambActive.length,
    ambiguos_outros: ambiguosOutros,
    created_at_invalido: invalido,
    fora_de_escopo: foraDeEscopo,
    total: computeGroupStats(members, asOf, ambActive.length),
    por_coorte: statsMap(groupBy(members, (m) => m.cohortDay), asOf, countBy(ambActive.map((a) => ({ key: a.dia })))),
    por_canal: statsMap(groupBy(members, (m) => m.canal), asOf, countBy(ambActive.map((a) => ({ key: a.canal })))),
    por_confirmou_via: viaStatsMap(groupBy(members, (m) => m.via), asOf),
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
    `${label.padEnd(34)} n=${String(g.n).padEnd(5)} amb=${String(g.ambiguos_active).padEnd(4)} 1h ${fmtRate(j["1h"])} | ` +
    `24h ${fmtRate(j["24h"]).padEnd(16)} | 7d ${fmtRate(j["7d"]).padEnd(16)} | 30d ${fmtRate(j["30d"]).padEnd(16)} | ` +
    `tempo(30d maduros, base=${t.base_maduros_30d}) p50=${t.p50_dias ?? "—"}d p90=${t.p90_dias ?? "—"}d [${dist}]`
  );
}

function renderViaLine(label: string, g: ViaStats): string {
  const t = g.tempo_ate_confirmar;
  const dist = TIME_TO_CONFIRM_BUCKETS.map((b) => `${b.key}:${t.buckets[b.key]}`).join(" ");
  return (
    `${label.padEnd(34)} confirmados=${String(g.confirmados).padEnd(5)} (sem taxa) ` +
    `tempo(30d maduros, base=${t.base_maduros_30d}) p50=${t.p50_dias ?? "—"}d p90=${t.p90_dias ?? "—"}d [${dist}]`
  );
}

/** Renderização texto do relatório (uma linha por grupo). @pure */
export function renderConfirmationReportText(report: ConfirmationReport): string {
  const lines: string[] = [];
  lines.push(`Confirmação de assinantes (DOI) — snapshots: ${report.snapshots}, as_of: ${report.as_of ?? "n/d"}`);
  lines.push(`Ambíguos active: ${report.ambiguos} | outros estados: ${report.ambiguos_outros} | created_at inválido: ${report.created_at_invalido} | fora de escopo: ${report.fora_de_escopo}`);
  lines.push("");
  lines.push("TOTAL");
  lines.push(renderGroupLine("todos", report.total));
  const sections: Array<[string, Record<string, GroupStats>]> = [
    ["POR CANAL (origem_cadastro)", report.por_canal],
    ["POR COORTE DE CADASTRO (dia BRT)", report.por_coorte],
  ];
  lines.push("");
  lines.push("POR CONFIRMOU_VIA (Kit vs Brevo, #8438) — NÃO é taxa: só tempo até confirmar entre confirmados");
  for (const [k, g] of Object.entries(report.por_confirmou_via)) lines.push(renderViaLine(k, g));
  if (Object.keys(report.por_confirmou_via).length === 0) lines.push("(vazio)");
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
