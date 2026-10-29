/**
 * scripts/lib/subscriber-hourly-confirmation.ts (#8552 b)
 *
 * Taxa de confirmação DOI em 1h/6h/24h, com resolução de HORAS — o que o
 * snapshot diário (`subscriber-state-snapshot.ts`) não consegue. O Kit não
 * expõe o instante da confirmação (só `created_at`, imutável; e o custom
 * field `confirmou_via` #8438 grava o VALOR, não o horário do clique), então
 * o único jeito de medir é observar: `scripts/subscriber-state-snapshot.ts
 * --recent` roda de hora em hora e grava só os assinantes criados nas
 * últimas 48h (poucas dezenas/centenas de linhas — barato, 1 chamada
 * paginada por rodada, muito abaixo do rate limit do Kit).
 *
 * ## Semântica (limite honesto)
 *
 * Membro = assinante cuja 1ª observação horária o mostra `inactive` E foi
 * feita até `MAX_FIRST_SEEN_LAG_HOURS` depois do `created_at` (senão o estado
 * de nascimento não é observável — pode ter confirmado antes). Uma janela de
 * W horas é "madura" pro membro quando existe observação em `created_at + W`
 * ou depois; "confirmado na janela" = o membro já estava `active` na ÚLTIMA
 * observação ≤ `created_at + W`. Como a observação é horária, isso é um PISO
 * (subestima em até 1 intervalo de polling): nunca superestima a taxa. Nunca é um número inventado; sem observações
 * maduras, `taxa: null`.
 *
 * Desde o #8548 a mesma conta sai também por canal pago (`utm_source` do Kit,
 * resolvido por `resolveCanalPago` com a precedência do relatório diário) e
 * por coorte de cadastro (dia BRT), além do total.
 *
 * @pure — recebe observações já carregadas.
 */

import type { SubscriberStateRecord } from "./subscriber-state-snapshot.ts";
import { brtDay, resolveCanalPago, type CanalPagoSources } from "./subscriber-confirmation-report.ts";

export const HOURLY_WINDOWS_HOURS = [1, 6, 24] as const;
export const MAX_FIRST_SEEN_LAG_HOURS = 2;
export const RECENT_LOOKBACK_HOURS = 48;

export interface HourlyObservation {
  /** Instante da captura. */
  at: Date;
  records: readonly SubscriberStateRecord[];
}

export interface HourlyWindowStats {
  horas: number;
  maduros: number;
  confirmados: number;
  taxa: number | null;
}

/** Janelas + horas até confirmar de um grupo de membros (#8548). */
export interface HourlyGroupStats {
  membros: number;
  janelas: HourlyWindowStats[];
  /** Horas (limite superior) até a 1ª observação `active`, só confirmados. */
  horas_ate_confirmar: { confirmados: number; p50: number | null; p90: number | null };
}

export interface HourlyConfirmationReport {
  observacoes: number;
  membros: number;
  /** Já `active` na 1ª observação, ou 1ª observação tardia demais. */
  fora_de_escopo: number;
  janelas: HourlyWindowStats[];
  /** Horas (limite superior) até a 1ª observação `active`, só confirmados. */
  horas_ate_confirmar: { confirmados: number; p50: number | null; p90: number | null };
  /** #8548 — por canal pago (`utm_source` do Kit), mesma precedência de
   *  fontes do relatório diário (`resolveCanalPago`). */
  por_canal_pago: Record<string, HourlyGroupStats>;
  /** #8548 — por coorte de cadastro (dia BRT do `created_at`). */
  por_coorte: Record<string, HourlyGroupStats>;
  avisos: string[];
}

const HOUR_MS = 3_600_000;

/** Nome de arquivo de 1 observação: `AAAA-MM-DDTHHMMZ.jsonl` (UTC). @pure */
export function hourlyObservationFileName(at: Date): string {
  const iso = at.toISOString(); // 2026-09-21T14:05:33.000Z
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z.jsonl`;
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z\.jsonl$/;

/** Inverso de `hourlyObservationFileName`; `null` se não casa. @pure */
export function parseHourlyObservationFileName(name: string): Date | null {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  return sortedAsc[Math.max(0, Math.min(sortedAsc.length - 1, Math.ceil(p * sortedAsc.length) - 1))];
}

/**
 * Retenção das observações horárias em `kit-recent/` (#11521). Com a task
 * horária armada, o diretório ganha ~24 arquivos/dia e o relatório lê todos
 * a cada execução. 35 dias cobrem com folga a maior janela medida (24h), o
 * lag de 1ª observação e uma coorte de cadastro de 30 dias.
 */
export const RECENT_RETENTION_DAYS = 35;

/**
 * Nomes de observação horária mais velhos que `retentionDays` em relação a
 * `now` (pelo instante no próprio nome). Arquivo cujo nome não casa o padrão
 * nunca entra (não é nosso, não se apaga). @pure
 */
export function expiredHourlyObservationFiles(
  names: readonly string[],
  now: Date,
  retentionDays = RECENT_RETENTION_DAYS,
): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error(`retentionDays inválido: ${retentionDays}`);
  }
  const min = now.getTime() - retentionDays * 24 * HOUR_MS;
  return names.filter((name) => {
    const at = parseHourlyObservationFileName(name);
    return at !== null && at.getTime() < min;
  });
}

/** Filtra os records de um dump ao que cabe na janela recente (`created_at`
 *  >= `now - lookbackHours`). @pure */
export function filterRecent(
  records: readonly SubscriberStateRecord[],
  now: Date,
  lookbackHours = RECENT_LOOKBACK_HOURS,
): SubscriberStateRecord[] {
  const min = now.getTime() - lookbackHours * HOUR_MS;
  return records.filter((r) => {
    const t = Date.parse(r.created_at);
    return !Number.isNaN(t) && t >= min;
  });
}

/** Opções do relatório horário (#8548). */
export interface HourlyConfirmationOptions {
  /** `utm_source` por id Kit, do store (mesma fonte do relatório diário). */
  utmSourceByKitId?: ReadonlyMap<number, string | null>;
}

/** Resultado de 1 membro: janelas maduras/confirmadas e horas até confirmar. */
interface HourlyMemberOutcome {
  canalPago: string;
  coorte: string;
  janelas: Array<{ horas: number; madura: boolean; confirmado: boolean }>;
  horasAteConfirmar: number | null;
}

function aggregateHourly(members: readonly HourlyMemberOutcome[]): HourlyGroupStats {
  const janelas: HourlyWindowStats[] = HOURLY_WINDOWS_HOURS.map((horas) => ({ horas, maduros: 0, confirmados: 0, taxa: null }));
  const horas: number[] = [];
  for (const m of members) {
    if (m.horasAteConfirmar !== null) horas.push(m.horasAteConfirmar);
    for (const w of janelas) {
      const mw = m.janelas.find((x) => x.horas === w.horas);
      if (!mw?.madura) continue;
      w.maduros++;
      if (mw.confirmado) w.confirmados++;
    }
  }
  for (const w of janelas) w.taxa = w.maduros > 0 ? w.confirmados / w.maduros : null;
  horas.sort((a, b) => a - b);
  return {
    membros: members.length,
    janelas,
    horas_ate_confirmar: { confirmados: horas.length, p50: percentile(horas, 0.5), p90: percentile(horas, 0.9) },
  };
}

function groupHourly(
  members: readonly HourlyMemberOutcome[],
  key: (m: HourlyMemberOutcome) => string,
): Record<string, HourlyGroupStats> {
  const by = new Map<string, HourlyMemberOutcome[]>();
  for (const m of members) {
    const k = key(m);
    const arr = by.get(k) ?? [];
    arr.push(m);
    by.set(k, arr);
  }
  const out: Record<string, HourlyGroupStats> = {};
  for (const k of [...by.keys()].sort()) out[k] = aggregateHourly(by.get(k)!);
  return out;
}

export function buildHourlyConfirmationReport(
  observations: readonly HourlyObservation[],
  opts: HourlyConfirmationOptions = {},
): HourlyConfirmationReport {
  const obs = [...observations].sort((a, b) => a.at.getTime() - b.at.getTime());
  const avisos: string[] = [];
  if (obs.length === 0) {
    avisos.push("nenhuma observação horária — rode scripts/subscriber-state-snapshot.ts --recent (task horária)");
  } else if (obs.length < 2) {
    avisos.push("só 1 observação — nenhuma confirmação pode ser observada ainda");
  }

  // id -> created_at, série (at, state) em ordem e fontes de utm_source.
  const tracks = new Map<
    number,
    { created: number; createdIso: string; series: Array<{ at: number; state: string }> } & CanalPagoSources
  >();
  for (const o of obs) {
    for (const r of o.records) {
      const created = Date.parse(r.created_at);
      if (Number.isNaN(created)) continue;
      let t = tracks.get(r.id);
      if (!t) {
        t = {
          created,
          createdIso: r.created_at,
          series: [],
          utmAtBirth: r.utm_source || null,
          utmBirthEmpty: r.utm_source === "",
          utmLater: null,
        };
        tracks.set(r.id, t);
      } else if (r.utm_source && t.utmLater === null) {
        t.utmLater = r.utm_source;
      }
      t.series.push({ at: o.at.getTime(), state: r.state });
    }
  }

  let foraDeEscopo = 0;
  const members: HourlyMemberOutcome[] = [];
  for (const [id, t] of tracks) {
    const first = t.series[0];
    if (first.state !== "inactive" || first.at - t.created > MAX_FIRST_SEEN_LAG_HOURS * HOUR_MS) {
      foraDeEscopo++;
      continue;
    }
    const firstActive = t.series.find((s) => s.state === "active");
    members.push({
      canalPago: resolveCanalPago(id, t, opts.utmSourceByKitId).canal,
      coorte: brtDay(t.createdIso) ?? "(created_at inválido)",
      horasAteConfirmar: firstActive ? (firstActive.at - t.created) / HOUR_MS : null,
      janelas: HOURLY_WINDOWS_HOURS.map((horas) => {
        const limite = t.created + horas * HOUR_MS;
        // Piso (nunca superestima): "confirmado" so se ja estava active na
        // ULTIMA observacao em/antes do fim da janela. Subestima em ate 1
        // intervalo de polling. Madura so quando existe observacao >= limite.
        if (!t.series.some((x) => x.at >= limite)) return { horas, madura: false, confirmado: false };
        const ate = [...t.series].reverse().find((x) => x.at <= limite);
        if (!ate) return { horas, madura: false, confirmado: false };
        return { horas, madura: true, confirmado: ate.state === "active" };
      }),
    });
  }
  if (foraDeEscopo > 0) {
    avisos.push(`${foraDeEscopo} assinante(s) já active na 1ª observação ou vistos tarde demais (>${MAX_FIRST_SEEN_LAG_HOURS}h após created_at) — fora das taxas`);
  }
  avisos.push("taxas horárias são PISO: só contam quem já estava active na última observação <= W h (subestima até ~1 intervalo); horas até confirmar é limite superior (até a 1ª observação active)");
  const total = aggregateHourly(members);
  return {
    observacoes: obs.length,
    membros: total.membros,
    fora_de_escopo: foraDeEscopo,
    janelas: total.janelas,
    horas_ate_confirmar: total.horas_ate_confirmar,
    por_canal_pago: groupHourly(members, (m) => m.canalPago),
    por_coorte: groupHourly(members, (m) => m.coorte),
    avisos,
  };
}

function fmtHourlyRate(w: HourlyWindowStats): string {
  return w.taxa === null ? "—" : `${(w.taxa * 100).toFixed(1)}% (${w.confirmados}/${w.maduros})`;
}

function renderHourlyGroupLine(label: string, g: HourlyGroupStats): string {
  const janelas = g.janelas.map((w) => `${w.horas}h ${fmtHourlyRate(w)}`).join(" | ");
  const h = g.horas_ate_confirmar;
  return (
    `  ${label.padEnd(26)} membros=${String(g.membros).padEnd(4)} ${janelas} | ` +
    `horas até confirmar p50=${h.p50?.toFixed(1) ?? "—"}h p90=${h.p90?.toFixed(1) ?? "—"}h`
  );
}

export function renderHourlyConfirmationText(r: HourlyConfirmationReport): string {
  const lines = [`Confirmação em horas (observação horária) — observações: ${r.observacoes}, membros: ${r.membros}`];
  for (const w of r.janelas) {
    lines.push(`  ${String(w.horas).padStart(2)}h: ${fmtHourlyRate(w)}`);
  }
  const h = r.horas_ate_confirmar;
  lines.push(`  horas até confirmar (confirmados=${h.confirmados}): p50=${h.p50?.toFixed(1) ?? "—"}h p90=${h.p90?.toFixed(1) ?? "—"}h`);
  const canais = Object.entries(r.por_canal_pago);
  if (canais.length > 0) {
    lines.push("  por canal pago (utm_source, #8548):");
    for (const [k, g] of canais) lines.push(renderHourlyGroupLine(k, g));
  }
  const coortes = Object.entries(r.por_coorte);
  if (coortes.length > 0) {
    lines.push("  por coorte de cadastro (dia BRT):");
    for (const [k, g] of coortes) lines.push(renderHourlyGroupLine(k, g));
  }
  for (const a of r.avisos) lines.push(`AVISO: ${a}`);
  return lines.join("\n") + "\n";
}
