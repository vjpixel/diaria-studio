/**
 * analyze-vote-timing.ts (#1657)
 *
 * Analisa o log de votos do É IA? (capturado pelo Worker `poll` em
 * `vote-log:{month}:{edition}:{email_hash}`) pra entender o COMPORTAMENTO dos
 * assinantes: latência envio→voto, distribuição por hora-do-dia (BRT), curva
 * cumulativa, recorrência por coorte e acerto×latência.
 *
 * Privacidade: o log usa `email_hash` (HMAC), não o email cru. Esta análise é
 * sobre coortes anônimas, nunca identifica assinante.
 *
 * Como obter o log (KV do Worker → arquivo local):
 *   # listar as keys do mês e baixar os valores num JSON array:
 *   MONTH=2026-06
 *   wrangler kv key list --binding POLL --prefix "vote-log:$MONTH:" --remote \
 *     | jq -r '.[].name' \
 *     | while read k; do wrangler kv key get "$k" --binding POLL --remote; done \
 *     | jq -s '.' > vote-log-$MONTH.json
 *
 * `sent-at` (âncora de envio por edição) pra computar latência — JSON map
 * `{ "260531": "2026-05-31T09:00:00-03:00", ... }`. Pode vir do publish_date
 * do Beehiiv. Edições sem sent_at correspondente são excluídas das métricas de
 * latência (a cobertura é surfaçada no relatório), mas seguem contando em
 * hora-do-dia e recorrência (que não dependem do sent_at).
 *
 * Uso:
 *   npx tsx scripts/analyze-vote-timing.ts --log vote-log-2026-06.json [--sent-at sent.json] [--out report.md]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";

export interface VoteLogEntry {
  ts: string;
  edition: string;
  month_slug: string;
  email_hash: string;
  choice: "A" | "B";
  correct: boolean | null;
}

/** Buckets de latência envio→voto (em minutos). Última é catch-all (Infinity). */
export const LATENCY_BUCKETS: Array<{ label: string; maxMinutes: number }> = [
  { label: "<15min", maxMinutes: 15 },
  { label: "15-60min", maxMinutes: 60 },
  { label: "1-6h", maxMinutes: 360 },
  { label: "6-24h", maxMinutes: 1440 },
  { label: "1-3d", maxMinutes: 4320 },
  { label: ">3d", maxMinutes: Infinity },
];

/** Pure: rótulo do bucket pra uma latência em minutos. <0 → "anomalia". */
export function bucketForLatency(minutes: number): string {
  if (minutes < 0) return "anomalia(<0)";
  for (const b of LATENCY_BUCKETS) {
    if (minutes < b.maxMinutes) return b.label;
  }
  return LATENCY_BUCKETS[LATENCY_BUCKETS.length - 1].label;
}

/** Pure: hora-do-dia (0-23) em BRT (UTC-3) a partir de um ISO timestamp. */
export function hourOfDayBrt(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (d.getUTCHours() - 3 + 24) % 24;
}

export interface LatencyStats {
  histogram: Record<string, number>;
  /** entries com sent_at correspondente (base das métricas de latência). */
  matched: number;
  /** entries sem sent_at correspondente (excluídas da latência). */
  unmatched: number;
  total: number;
  /** cobertura = matched / total (0-1); null se total 0. */
  coverage: number | null;
}

/**
 * Pure (#1657): histograma de latência envio→voto. `sentAt` mapeia edition →
 * ISO do envio. Entries sem sent_at (ou com ts/sent_at inválido) contam como
 * unmatched (não enviesam o histograma — coverage surfaça o buraco).
 */
export function computeLatencyStats(
  entries: VoteLogEntry[],
  sentAt: Record<string, string>,
): LatencyStats {
  const histogram: Record<string, number> = {};
  let matched = 0;
  let unmatched = 0;
  for (const e of entries) {
    const sent = sentAt[e.edition];
    const voteMs = Date.parse(e.ts);
    const sentMs = sent ? Date.parse(sent) : NaN;
    if (!sent || Number.isNaN(sentMs) || Number.isNaN(voteMs)) {
      unmatched++;
      continue;
    }
    matched++;
    const minutes = (voteMs - sentMs) / 60000;
    const label = bucketForLatency(minutes);
    histogram[label] = (histogram[label] ?? 0) + 1;
  }
  const total = entries.length;
  return {
    histogram,
    matched,
    unmatched,
    total,
    coverage: total === 0 ? null : matched / total,
  };
}

/** Pure (#1657): distribuição de votos por hora-do-dia BRT (array de 24). */
export function computeHourOfDayBrt(entries: VoteLogEntry[]): number[] {
  const hours = new Array(24).fill(0);
  for (const e of entries) {
    const h = hourOfDayBrt(e.ts);
    if (h !== null) hours[h]++;
  }
  return hours;
}

export interface RecurrenceStats {
  /** distribuição: quantos email_hash votaram em N edições distintas. */
  distribution: Record<string, number>;
  uniqueVoters: number;
  /** votantes que apareceram em ≥2 edições / total (0-1); null se 0 votantes. */
  repeatRate: number | null;
}

/**
 * Pure (#1657): recorrência por coorte. Conta edições DISTINTAS por email_hash
 * (não votos — voto duplicado na mesma edição é bloqueado upstream, mas defende
 * contra dupes no dump). Bucketiza em "1","2","3","4+".
 */
export function computeRecurrence(entries: VoteLogEntry[]): RecurrenceStats {
  const byVoter = new Map<string, Set<string>>();
  for (const e of entries) {
    if (!byVoter.has(e.email_hash)) byVoter.set(e.email_hash, new Set());
    byVoter.get(e.email_hash)!.add(e.edition);
  }
  const distribution: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4+": 0 };
  let repeat = 0;
  for (const editions of byVoter.values()) {
    const n = editions.size;
    if (n >= 4) distribution["4+"]++;
    else distribution[String(n)]++;
    if (n >= 2) repeat++;
  }
  const uniqueVoters = byVoter.size;
  return {
    distribution,
    uniqueVoters,
    repeatRate: uniqueVoters === 0 ? null : repeat / uniqueVoters,
  };
}

export interface AccuracyByLatencyRow {
  bucket: string;
  total: number;
  correct: number;
  /** acurácia (0-1); null se total 0. */
  accuracy: number | null;
}

/**
 * Pure (#1657): acerto × latência. Só considera entries matched (com sent_at) e
 * com `correct` não-null (gabarito definido). Responde "voto mais rápido acerta
 * mais ou menos?" — proxy de leitura atenta vs chute.
 */
export function computeAccuracyByLatency(
  entries: VoteLogEntry[],
  sentAt: Record<string, string>,
): AccuracyByLatencyRow[] {
  const agg = new Map<string, { total: number; correct: number }>();
  for (const e of entries) {
    if (e.correct === null) continue;
    const sent = sentAt[e.edition];
    const voteMs = Date.parse(e.ts);
    const sentMs = sent ? Date.parse(sent) : NaN;
    if (!sent || Number.isNaN(sentMs) || Number.isNaN(voteMs)) continue;
    const label = bucketForLatency((voteMs - sentMs) / 60000);
    if (!agg.has(label)) agg.set(label, { total: 0, correct: 0 });
    const row = agg.get(label)!;
    row.total++;
    if (e.correct === true) row.correct++;
  }
  // Ordem fixa dos buckets (+ anomalia no fim se presente).
  const order = [...LATENCY_BUCKETS.map((b) => b.label), "anomalia(<0)"];
  return order
    .filter((label) => agg.has(label))
    .map((bucket) => {
      const { total, correct } = agg.get(bucket)!;
      return { bucket, total, correct, accuracy: total === 0 ? null : correct / total };
    });
}

/** Pure: renderiza o relatório markdown a partir das métricas computadas. */
export function renderReport(
  entries: VoteLogEntry[],
  sentAt: Record<string, string>,
): string {
  const latency = computeLatencyStats(entries, sentAt);
  const hours = computeHourOfDayBrt(entries);
  const recurrence = computeRecurrence(entries);
  const accuracy = computeAccuracyByLatency(entries, sentAt);
  const editions = new Set(entries.map((e) => e.edition));
  const pct = (n: number | null): string =>
    n === null ? "—" : `${(n * 100).toFixed(1)}%`;

  const lines: string[] = [];
  lines.push(`# Análise de timing de votos (#1657)`);
  lines.push("");
  lines.push(`Votos: ${entries.length} · Edições: ${editions.size} · Votantes únicos: ${recurrence.uniqueVoters}`);
  lines.push("");

  lines.push(`## Latência envio→voto`);
  lines.push(`Cobertura (votos com sent_at): ${latency.matched}/${latency.total} (${pct(latency.coverage)})`);
  if (latency.unmatched > 0) {
    lines.push(`⚠️ ${latency.unmatched} voto(s) sem sent_at — excluídos da latência. Complete o --sent-at pra cobertura total.`);
  }
  lines.push("");
  lines.push(`| Bucket | Votos |`);
  lines.push(`|---|---|`);
  for (const b of LATENCY_BUCKETS) {
    lines.push(`| ${b.label} | ${latency.histogram[b.label] ?? 0} |`);
  }
  if (latency.histogram["anomalia(<0)"]) {
    lines.push(`| anomalia(<0) | ${latency.histogram["anomalia(<0)"]} |`);
  }
  lines.push("");

  lines.push(`## Distribuição por hora-do-dia (BRT)`);
  lines.push(`| Hora | Votos |`);
  lines.push(`|---|---|`);
  for (let h = 0; h < 24; h++) {
    if (hours[h] > 0) lines.push(`| ${String(h).padStart(2, "0")}h | ${hours[h]} |`);
  }
  lines.push("");

  lines.push(`## Recorrência por coorte`);
  lines.push(`Repeat rate (votaram ≥2 edições): ${pct(recurrence.repeatRate)}`);
  lines.push(`| Edições votadas | Votantes |`);
  lines.push(`|---|---|`);
  for (const k of ["1", "2", "3", "4+"]) {
    lines.push(`| ${k} | ${recurrence.distribution[k]} |`);
  }
  lines.push("");

  lines.push(`## Acerto × latência`);
  if (accuracy.length === 0) {
    lines.push(`(sem dados — requer sent_at + gabarito definido)`);
  } else {
    lines.push(`| Bucket | Votos | Acertos | Acurácia |`);
    lines.push(`|---|---|---|---|`);
    for (const r of accuracy) {
      lines.push(`| ${r.bucket} | ${r.total} | ${r.correct} | ${pct(r.accuracy)} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Pure: parseia + valida o array de VoteLogEntry de um JSON cru. */
export function parseVoteLog(raw: string): VoteLogEntry[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("vote-log deve ser um JSON array de entradas");
  }
  return parsed.filter(
    (e): e is VoteLogEntry =>
      e && typeof e.ts === "string" && typeof e.edition === "string" && typeof e.email_hash === "string",
  );
}

function main(): void {
  const { values } = parseCliArgs(process.argv.slice(2));
  const logPath = values["log"];
  if (!logPath) {
    console.error(
      "Uso: analyze-vote-timing.ts --log <vote-log.json> [--sent-at <sent.json>] [--out <report.md>]",
    );
    process.exit(2);
  }
  const entries = parseVoteLog(readFileSync(resolve(logPath), "utf8"));
  const sentAt: Record<string, string> = values["sent-at"]
    ? JSON.parse(readFileSync(resolve(values["sent-at"]), "utf8"))
    : {};
  const report = renderReport(entries, sentAt);
  if (values["out"]) {
    writeFileSync(resolve(values["out"]), report);
    console.error(`[analyze-vote-timing] relatório escrito em ${values["out"]}`);
  } else {
    console.log(report);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
