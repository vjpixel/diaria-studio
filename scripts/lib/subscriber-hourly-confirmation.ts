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
 * ou depois; "confirmado na janela" = o membro já estava `active` na 1ª
 * observação ≥ `created_at + W`. Como a observação é horária, isso é um
 * LIMITE SUPERIOR com folga de até 1 intervalo de polling: "confirmou em até
 * W h (+ ≤1 h de resolução)". Nunca é um número inventado; sem observações
 * maduras, `taxa: null`.
 *
 * @pure — recebe observações já carregadas.
 */

import type { SubscriberStateRecord } from "./subscriber-state-snapshot.ts";

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

export interface HourlyConfirmationReport {
  observacoes: number;
  membros: number;
  /** Já `active` na 1ª observação, ou 1ª observação tardia demais. */
  fora_de_escopo: number;
  janelas: HourlyWindowStats[];
  /** Horas (limite superior) até a 1ª observação `active`, só confirmados. */
  horas_ate_confirmar: { confirmados: number; p50: number | null; p90: number | null };
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

export function buildHourlyConfirmationReport(
  observations: readonly HourlyObservation[],
): HourlyConfirmationReport {
  const obs = [...observations].sort((a, b) => a.at.getTime() - b.at.getTime());
  const avisos: string[] = [];
  if (obs.length === 0) {
    avisos.push("nenhuma observação horária — rode scripts/subscriber-state-snapshot.ts --recent (task horária)");
  } else if (obs.length < 2) {
    avisos.push("só 1 observação — nenhuma confirmação pode ser observada ainda");
  }

  // id -> created_at + 1ª observação + série (at, state) em ordem.
  const tracks = new Map<number, { created: number; series: Array<{ at: number; state: string }> }>();
  for (const o of obs) {
    for (const r of o.records) {
      const created = Date.parse(r.created_at);
      if (Number.isNaN(created)) continue;
      let t = tracks.get(r.id);
      if (!t) {
        t = { created, series: [] };
        tracks.set(r.id, t);
      }
      t.series.push({ at: o.at.getTime(), state: r.state });
    }
  }

  let foraDeEscopo = 0;
  const janelas: HourlyWindowStats[] = HOURLY_WINDOWS_HOURS.map((horas) => ({ horas, maduros: 0, confirmados: 0, taxa: null }));
  const horasConfirmar: number[] = [];
  let membros = 0;
  for (const t of tracks.values()) {
    const first = t.series[0];
    if (first.state !== "inactive" || first.at - t.created > MAX_FIRST_SEEN_LAG_HOURS * HOUR_MS) {
      foraDeEscopo++;
      continue;
    }
    membros++;
    const firstActive = t.series.find((s) => s.state === "active");
    if (firstActive) horasConfirmar.push((firstActive.at - t.created) / HOUR_MS);
    for (const w of janelas) {
      const limite = t.created + w.horas * HOUR_MS;
      // 1ª observação em/após o fim da janela: se já era active nela (ou antes), confirmou na janela.
      const ref = t.series.find((s) => s.at >= limite);
      // Sem observação em/após o fim da janela: ainda não maturou (ou o id saiu do lookback) — não conta.
      if (!ref) continue;
      w.maduros++;
      const activeBy = firstActive !== undefined && firstActive.at <= ref.at;
      if (activeBy) w.confirmados++;
    }
  }
  for (const w of janelas) w.taxa = w.maduros > 0 ? w.confirmados / w.maduros : null;
  horasConfirmar.sort((a, b) => a - b);
  if (foraDeEscopo > 0) {
    avisos.push(`${foraDeEscopo} assinante(s) já active na 1ª observação ou vistos tarde demais (>${MAX_FIRST_SEEN_LAG_HOURS}h após created_at) — fora das taxas`);
  }
  avisos.push("resolução = 1 intervalo de polling: 'em até W h' é limite superior com folga de até ~1h");
  return {
    observacoes: obs.length,
    membros,
    fora_de_escopo: foraDeEscopo,
    janelas,
    horas_ate_confirmar: { confirmados: horasConfirmar.length, p50: percentile(horasConfirmar, 0.5), p90: percentile(horasConfirmar, 0.9) },
    avisos,
  };
}

export function renderHourlyConfirmationText(r: HourlyConfirmationReport): string {
  const lines = [`Confirmação em horas (observação horária) — observações: ${r.observacoes}, membros: ${r.membros}`];
  for (const w of r.janelas) {
    lines.push(`  ${String(w.horas).padStart(2)}h: ${w.taxa === null ? "—" : `${(w.taxa * 100).toFixed(1)}% (${w.confirmados}/${w.maduros})`}`);
  }
  const h = r.horas_ate_confirmar;
  lines.push(`  horas até confirmar (confirmados=${h.confirmados}): p50=${h.p50?.toFixed(1) ?? "—"}h p90=${h.p90?.toFixed(1) ?? "—"}h`);
  for (const a of r.avisos) lines.push(`AVISO: ${a}`);
  return lines.join("\n") + "\n";
}
