#!/usr/bin/env node
/**
 * scripts/subscriber-confirmation-report.ts (#8552, residual)
 *
 * CLI READ-ONLY sobre os snapshots locais de `subscriber-state-snapshot.ts`:
 * taxa de confirmação DOI por coorte de cadastro e por canal (1h/24h/7d/30d)
 * + distribuição do tempo até confirmar, separado por `confirmou_via` (Kit vs
 * Brevo, #8438). Sem rede, sem escrita — só lê `data/subscriber-state-snapshots/kit/`.
 *
 * #8548: seção POR CANAL PAGO (`utm_source` do Kit: google-ads/meta-ads/
 * microsoft-ads/orgânico) com a métrica primária = tempo até confirmar
 * (p50/p90) em coorte fechada de 7d+. O `utm_source` vem dos snapshots
 * (gravado a partir do #8548) e, para snapshots anteriores, do store de
 * assinantes aberto SÓ PARA LEITURA (`--subscribers-db`, default
 * `<root>/../../diaria-subscribers/diaria-subscribers.db`, i.e.
 * `data/diaria-subscribers/` ao lado de `data/subscriber-state-snapshots/`).
 * Store ausente não quebra: o canal pago degrada pra "(utm_source
 * desconhecido)" com aviso.
 * Limites de resolução (granularidade diária, 1h irresolvível, ambíguos):
 * docstring de `scripts/lib/subscriber-confirmation-report.ts`.
 *
 * Uso:
 *   npx tsx scripts/subscriber-confirmation-report.ts [--root <path>] [--since AAAA-MM-DD] [--until AAAA-MM-DD] [--recent-root <path>] [--subscribers-db <path>] [--format text|json]
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import {
  loadAllSubscriberStateSnapshots,
  snapshotRootDefault,
  parseSubscriberStateJsonl,
} from "./lib/subscriber-state-snapshot.ts";
import {
  buildHourlyConfirmationReport,
  renderHourlyConfirmationText,
  parseHourlyObservationFileName,
  type HourlyObservation,
} from "./lib/subscriber-hourly-confirmation.ts";
import { buildConfirmationReport, renderConfirmationReportText } from "./lib/subscriber-confirmation-report.ts";
import { openFunnelStoreReadOnly } from "./lib/metrics/channel-cohort-funnel-store.ts";
import type { DatabaseSync } from "node:sqlite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Carrega as observacoes horarias (kit-recent/*.jsonl); dir ausente = []. */
export function loadHourlyObservations(recentRoot: string): HourlyObservation[] {
  if (!existsSync(recentRoot)) return [];
  const out: HourlyObservation[] = [];
  for (const name of readdirSync(recentRoot)) {
    const at = parseHourlyObservationFileName(name);
    if (!at) continue;
    out.push({ at, records: parseSubscriberStateJsonl(readFileSync(resolve(recentRoot, name), "utf8")) });
  }
  return out;
}

/**
 * #8548 — `utm_source` do Kit por id de assinante, lido do store
 * (`identity_alias.external_id` = id Kit → `subscription.utm_source` da
 * plataforma `kit`). Id com `utm_source` nulo/vazio entra com `null`
 * (orgânico conhecido); id fora do store fica ausente (desconhecido).
 */
export function readKitUtmSourceMap(db: DatabaseSync): Map<number, string | null> {
  const rows = db
    .prepare(
      `SELECT ia.external_id AS external_id, s.utm_source AS utm_source
       FROM identity_alias ia
       JOIN subscription s ON s.subscriber_id = ia.subscriber_id AND s.platform = 'kit'
       WHERE ia.platform = 'kit' AND ia.external_id IS NOT NULL`,
    )
    .all() as Array<{ external_id: string; utm_source: string | null }>;
  const out = new Map<number, string | null>();
  for (const r of rows) {
    const id = Number(r.external_id);
    if (!Number.isInteger(id)) continue;
    const utm = r.utm_source && r.utm_source.trim() ? r.utm_source : null;
    // Mais de um alias pro mesmo id (e-mails diferentes): valor não nulo vence.
    if (!out.has(id) || (out.get(id) === null && utm !== null)) out.set(id, utm);
  }
  return out;
}

/** Abre o store só pra leitura e devolve o mapa; ausente/ilegível → `null`
 *  + motivo (o relatório segue, com aviso). */
export function loadKitUtmSourceMap(dbPath: string): { map: Map<number, string | null> | null; aviso?: string } {
  if (!existsSync(dbPath)) {
    return {
      map: null,
      aviso: `store de assinantes ausente (${dbPath}) — canal pago só pelo utm_source dos snapshots (gravado a partir do #8548)`,
    };
  }
  let db: DatabaseSync | null = null;
  try {
    db = openFunnelStoreReadOnly(dbPath);
    return { map: readKitUtmSourceMap(db) };
  } catch (e) {
    return { map: null, aviso: `store de assinantes ilegível (${dbPath}): ${(e as Error).message} — canal pago só pelos snapshots` };
  } finally {
    db?.close();
  }
}

/** Default do store: irmão de `data/subscriber-state-snapshots/` (deriva do
 *  `--root`, então um `--root` temporário nunca lê o store real). */
export function defaultSubscribersDbPath(root: string): string {
  return resolve(root, "..", "..", "diaria-subscribers", "diaria-subscribers.db");
}

/** Monta a saida completa (diario + horario). Exportado pra teste. */
export function buildReportOutput(
  root: string,
  recentRoot: string,
  opts: { since?: string; until?: string; format: "text" | "json"; subscribersDb?: string },
): string {
  const utm = loadKitUtmSourceMap(opts.subscribersDb ?? defaultSubscribersDbPath(root));
  const report = buildConfirmationReport(loadAllSubscriberStateSnapshots(root), {
    since: opts.since,
    until: opts.until,
    utmSourceByKitId: utm.map ?? undefined,
  });
  if (utm.aviso) report.avisos.push(utm.aviso);
  const hourly = buildHourlyConfirmationReport(loadHourlyObservations(recentRoot));
  return opts.format === "json"
    ? JSON.stringify({ ...report, horario: hourly }, null, 2) + "\n"
    : renderConfirmationReportText(report) + "\n" + renderHourlyConfirmationText(hourly);
}

function main(): void {
  const argv = process.argv.slice(2);
  const root = getArg(argv, "root") || snapshotRootDefault(resolve(ROOT, "data"));
  const since = getArg(argv, "since");
  const until = getArg(argv, "until");
  const format = getArg(argv, "format") || "text";
  for (const [name, v] of [["since", since], ["until", until]] as const) {
    if (v && !DATE_RE.test(v)) {
      console.error(`--${name} deve ser AAAA-MM-DD (recebido "${v}")`);
      process.exitCode = 2;
      return;
    }
  }
  if (format !== "text" && format !== "json") {
    console.error(`--format deve ser text|json (recebido "${format}")`);
    process.exitCode = 2;
    return;
  }
  if (!existsSync(root)) {
    console.error(
      `--root não existe: ${root} — os snapshots vivem em data/ (junction OneDrive, ausente em worktree/clone fresco); ` +
        `rode no checkout com data/ ou passe --root`,
    );
    process.exitCode = 2;
    return;
  }
  const recentRoot = getArg(argv, "recent-root") || resolve(root, "..", "kit-recent");
  const subscribersDb = getArg(argv, "subscribers-db") || undefined;
  process.stdout.write(buildReportOutput(root, recentRoot, { since, until, format, subscribersDb }));
}

if (isMainModule(import.meta.url)) main();
