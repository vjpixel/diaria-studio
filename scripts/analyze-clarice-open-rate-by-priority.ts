#!/usr/bin/env node
/**
 * analyze-clarice-open-rate-by-priority.ts (#4705 — checklist item 1: "compare
 * a taxa de abertura por FAIXA de priority_points, não por dia")
 *
 * Junta um snapshot de `priority_points` (`{group}-priority-snapshot.csv`,
 * escrito por `buildPrioritySnapshotCsv` em clarice-build-segment.ts, #4763)
 * contra o cache local de destinatários por campanha
 * (`data/clarice-subscribers/cohorts/campaign-cache/{campaignId}.json`,
 * produzido por `clarice-engagement-cohorts-v2.ts`) e reporta open rate
 * (opened/delivered) por faixa de `priority_points` — em vez de por dia, que
 * é o eixo que a issue original queria separar de "entregabilidade" vs.
 * "gradiente de temperatura de lista".
 *
 * LIMITAÇÃO CONHECIDA, CONFIRMADA EMPIRICAMENTE (achado 260810, ver #4705):
 * o snapshot de `priority_points` de um grupo é SOBRESCRITO a cada rebuild
 * daquele grupo (`writeFileSync` incondicional em `clarice-build-segment.ts`)
 * — não existe 1 snapshot por dia de envio, só o mais recente. Como o
 * rebuild do `ramp-warm` roda ~diariamente pra cortar a fila do dia seguinte,
 * o snapshot de HOJE quase sempre já perdeu os contatos de campanhas ENVIADAS
 * (removidos do pool pelo dedup por `last_sent_at`). Testado ao vivo contra
 * as campanhas `d1-sab01-{A,B,C}` (01/08) e `novos-260805..260808`: 0% de
 * overlap com o snapshot de `ramp-warm`/`novos` mais recente disponível em
 * 260809/10 nos dois casos — não é acidente, é o comportamento esperado do
 * mecanismo tal como implementado.
 *
 * Ou seja: este script NÃO responde retroativamente "julho vs. agosto" (esse
 * dado está perdido — não havia snapshot antes do #4763). Ele fica útil daqui
 * pra frente SE E SÓ SE alguém capturar uma cópia de
 * `{group}-priority-snapshot.csv` logo após `clarice-build-segment.ts` cortar
 * a onda do dia — ANTES do próximo rebuild sobrescrever o arquivo — e rodar
 * este script alguns dias depois (tempo pras aberturas acumularem) contra
 * essa cópia arquivada + o(s) `campaignId` daquele dia. Automatizar essa
 * captura (arquivar `{group}-priority-snapshot.csv` como
 * `{group}-{waveId}-priority-snapshot.csv` no momento do corte) é trabalho
 * NOVO, fora do escopo desta unidade — registrado como follow-up na issue.
 *
 * Cobertura baixa (`coveragePct` no report) é o sinal de que o snapshot
 * passado está estruturalmente desalinhado com a(s) campanha(s) — o script
 * avisa explicitamente em vez de reportar uma taxa por faixa enganosa
 * calculada sobre poucos contatos.
 *
 * Uso:
 *   npx tsx scripts/analyze-clarice-open-rate-by-priority.ts \
 *     --snapshot data/clarice-subscribers/2607-08/segments/ramp-warm-priority-snapshot.csv \
 *     --campaign-ids 102,103,104 \
 *     [--cache-dir data/clarice-subscribers/cohorts/campaign-cache] \
 *     [--buckets 0,2,5,10] [--json]
 *
 * Sem escrita em nenhum lugar (nem KV, nem Brevo, nem o próprio arquivo de
 * snapshot) — 100% leitura local, sem credencial nenhuma.
 */

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import Papa from "papaparse";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_CACHE_DIR = resolve(ROOT, "data/clarice-subscribers/cohorts/campaign-cache");

export interface PriorityRow {
  email: string;
  priority_points: number;
  cohort: string;
  priority_optin: boolean;
}

export interface CampaignRecipient {
  delivered: boolean;
  opened: boolean;
  bounced: boolean;
  unsubscribed: boolean;
}

export interface CampaignCache {
  campaignId: number | string;
  campaignName?: string;
  exportedAt?: string;
  recipients: Record<string, CampaignRecipient>;
}

export interface BucketDef {
  label: string;
  min: number;
  max: number;
}

export interface BucketResult {
  label: string;
  delivered: number;
  opened: number;
  /** null quando delivered=0 na faixa (nada pra dividir). */
  openRatePct: number | null;
}

export interface OpenRateByPriorityReport {
  buckets: BucketResult[];
  totalSnapshotContacts: number;
  /** Soma de destinatários across todas as campanhas passadas (pode ter overlap entre campanhas). */
  totalCampaignRecipients: number;
  /** Contatos do snapshot que aparecem em pelo menos 1 campanha com delivered=true. */
  matchedContacts: number;
  /** matchedContacts / totalSnapshotContacts × 100 (0 se snapshot vazio). */
  coveragePct: number;
}

/** Espelha as colunas escritas por `buildPrioritySnapshotCsv` (clarice-build-segment.ts, #4763). */
export function parsePrioritySnapshotCsv(csv: string): PriorityRow[] {
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  return parsed.data
    .filter((r) => r.email)
    .map((r) => ({
      email: r.email.trim().toLowerCase(),
      priority_points: Number(r.priority_points) || 0,
      cohort: r.cohort ?? "",
      priority_optin: r.priority_optin === "1" || r.priority_optin === "true",
    }));
}

export function loadCampaignCacheFile(path: string): CampaignCache {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Faixas default espelham a distribuição observada em produção (260810):
 * a maioria dos contatos do ramp/novos tem priority_points=0 (zero
 * engajamento capturado ainda), então o primeiro corte isola "sem sinal"
 * do resto antes de fatiar o restante em faixas crescentes.
 */
export const DEFAULT_BUCKET_THRESHOLDS = [0, 2, 5, 10];

/** Constrói faixas [-inf,t0], (t0,t1], ..., (tN,+inf) a partir de thresholds ordenados. */
export function buildBuckets(thresholds: number[]): BucketDef[] {
  const sorted = [...new Set(thresholds)].sort((a, b) => a - b);
  const buckets: BucketDef[] = [];
  let prevMax = -Infinity;
  for (const t of sorted) {
    const min = prevMax === -Infinity ? -Infinity : prevMax + 1;
    buckets.push({
      label: min === -Infinity ? `≤${t}` : `${min}-${t}`,
      min,
      max: t,
    });
    prevMax = t;
  }
  buckets.push({ label: `${prevMax + 1}+`, min: prevMax + 1, max: Infinity });
  return buckets;
}

/**
 * Pura: junta snapshot × campanha(s) por email, buckets por priority_points,
 * soma delivered/opened por faixa. `campaigns` é mesclado (union) — um email
 * presente em mais de 1 campanha conta delivered/opened se QUALQUER uma
 * confirmar (raro no uso real, onde os `campaignIds` passados são as células
 * A/B/C do MESMO dia, mutuamente exclusivas por desenho do split).
 */
export function computeOpenRateByPriority(
  snapshot: PriorityRow[],
  campaigns: CampaignCache[],
  bucketThresholds: number[] = DEFAULT_BUCKET_THRESHOLDS,
): OpenRateByPriorityReport {
  const buckets = buildBuckets(bucketThresholds);
  const byEmail = new Map(snapshot.map((r) => [r.email, r]));

  const recipients = new Map<string, CampaignRecipient>();
  let totalCampaignRecipients = 0;
  for (const camp of campaigns) {
    for (const [rawEmail, r] of Object.entries(camp.recipients)) {
      totalCampaignRecipients++;
      const email = rawEmail.trim().toLowerCase();
      const existing = recipients.get(email);
      if (!existing) {
        recipients.set(email, { ...r });
      } else {
        existing.delivered = existing.delivered || r.delivered;
        existing.opened = existing.opened || r.opened;
        existing.bounced = existing.bounced || r.bounced;
        existing.unsubscribed = existing.unsubscribed || r.unsubscribed;
      }
    }
  }

  const counts = buckets.map(() => ({ delivered: 0, opened: 0 }));
  let matchedContacts = 0;

  for (const [email, recipient] of recipients) {
    const snap = byEmail.get(email);
    if (!snap) continue;
    if (!recipient.delivered) continue; // open rate só faz sentido sobre quem recebeu
    matchedContacts++;
    let idx = buckets.findIndex((b) => snap.priority_points >= b.min && snap.priority_points <= b.max);
    if (idx === -1) idx = buckets.length - 1;
    counts[idx].delivered++;
    if (recipient.opened) counts[idx].opened++;
  }

  const bucketResults: BucketResult[] = buckets.map((b, i) => ({
    label: b.label,
    delivered: counts[i].delivered,
    opened: counts[i].opened,
    openRatePct: counts[i].delivered > 0 ? (100 * counts[i].opened) / counts[i].delivered : null,
  }));

  return {
    buckets: bucketResults,
    totalSnapshotContacts: snapshot.length,
    totalCampaignRecipients,
    matchedContacts,
    coveragePct: snapshot.length > 0 ? (100 * matchedContacts) / snapshot.length : 0,
  };
}

const LOW_COVERAGE_THRESHOLD_PCT = 5;

export function formatReport(
  report: OpenRateByPriorityReport,
  meta: { snapshotPath: string; campaignIds: (string | number)[] },
): string {
  const lines: string[] = [];
  lines.push("Open rate por faixa de priority_points (#4705)");
  lines.push(`Snapshot: ${meta.snapshotPath} (${report.totalSnapshotContacts} contato(s))`);
  lines.push(
    `Campanha(s): ${meta.campaignIds.join(", ")} (${report.totalCampaignRecipients} destinatário(s) no total — pode ter overlap entre campanhas)`,
  );
  lines.push(
    `Cobertura (contatos do snapshot que aparecem em alguma campanha com delivered=true): ` +
      `${report.matchedContacts}/${report.totalSnapshotContacts} (${report.coveragePct.toFixed(1)}%)`,
  );
  lines.push("");
  lines.push("faixa       | delivered | opened | taxa");
  lines.push("------------|-----------|--------|-------");
  for (const b of report.buckets) {
    const rate = b.openRatePct === null ? "—" : `${b.openRatePct.toFixed(1)}%`;
    lines.push(`${b.label.padEnd(11)} | ${String(b.delivered).padEnd(9)} | ${String(b.opened).padEnd(6)} | ${rate}`);
  }
  if (report.coveragePct < LOW_COVERAGE_THRESHOLD_PCT) {
    lines.push("");
    lines.push(
      `⚠️  Cobertura abaixo de ${LOW_COVERAGE_THRESHOLD_PCT}% — resultado provavelmente NÃO é confiável (poucos contatos por faixa). ` +
        `Causa mais comum: o snapshot de priority_points (#4763) é sobrescrito a cada rebuild do grupo, então um ` +
        `snapshot "atual" costuma já ter perdido os contatos de campanhas já enviadas (ver #4705, achado 260810). ` +
        `Pra este script ser útil, capture uma cópia de {group}-priority-snapshot.csv logo após montar a onda, ` +
        `antes do próximo rebuild sobrescrever o arquivo.`,
    );
  }
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const snapshotArg = getStringArg(argv, "snapshot", { example: "data/.../ramp-warm-priority-snapshot.csv" });
  const campaignIdsArg = getStringArg(argv, "campaign-ids", { example: "102,103,104" });
  const cacheDirArg = getStringArg(argv, "cache-dir", { example: DEFAULT_CACHE_DIR });
  const bucketsArg = getStringArg(argv, "buckets", { example: "0,2,5,10" });

  if (!snapshotArg || !campaignIdsArg) {
    console.error(
      "Uso: npx tsx scripts/analyze-clarice-open-rate-by-priority.ts --snapshot <path> --campaign-ids <id,id,...> " +
        "[--cache-dir <dir>] [--buckets 0,2,5,10] [--json]",
    );
    process.exitCode = 2;
    return;
  }

  const campaignIds = campaignIdsArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cacheDir = cacheDirArg ?? DEFAULT_CACHE_DIR;
  const thresholds = bucketsArg
    ? bucketsArg
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
    : DEFAULT_BUCKET_THRESHOLDS;

  const snapshot = parsePrioritySnapshotCsv(readFileSync(resolve(snapshotArg), "utf8"));
  const campaigns = campaignIds.map((id) => loadCampaignCacheFile(join(resolve(cacheDir), `${id}.json`)));

  const report = computeOpenRateByPriority(snapshot, campaigns, thresholds);
  console.log(formatReport(report, { snapshotPath: snapshotArg, campaignIds }));

  if (hasFlag(argv, "json")) {
    console.log("");
    console.log(JSON.stringify(report, null, 2));
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
