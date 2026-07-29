#!/usr/bin/env node
/**
 * clarice-mailbox-dryrun.ts (#4249) — CLI do dry-run de coerência por caixa
 * canônica (supressão propagada + cohort corrigido + dedup de duplicata).
 *
 * READ-ONLY: só SELECT no store local, NUNCA escreve, NUNCA toca Brevo/
 * Beehiiv. Gate humano obrigatório antes do merge do fix #4249 (ver corpo da
 * issue) — cole a saída deste script no PR pro editor revisar antes de
 * autorizar.
 *
 * Uso: npx tsx scripts/clarice-mailbox-dryrun.ts [--db <path>]
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import {
  openClariceDb,
  DEFAULT_DB_PATH,
  computeCohort,
  computePriorityPoints,
  type MailboxRow,
} from "./lib/clarice-db.ts";
import { isKnownCohortSlug } from "./lib/cohorts.ts";
import {
  computeMailboxDryrunReport,
  renderMailboxDryrunMarkdown,
} from "./lib/clarice-mailbox-dryrun.ts";

interface RawRow {
  email: string;
  cohort: string | null;
  tier: number | null;
  created: string | null;
  opens_count: number;
  sends_count: number;
  soft_bounce_count: number;
  dispute_losses: number;
  mv_bucket: string | null;
  email_blacklisted: number;
  unsubscribed: number;
  hard_bounced: number;
  complained: number;
  priority_optin: number;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadProjectEnv();
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  console.error(`[clarice-mailbox-dryrun] lendo ${dbPath} (read-only, nenhuma escrita)`);

  const db = openClariceDb(dbPath);
  const raw = db
    .prepare(
      `SELECT email, cohort, tier, created, opens_count, sends_count,
              soft_bounce_count, dispute_losses, mv_bucket, email_blacklisted,
              unsubscribed, hard_bounced, complained, priority_optin
         FROM clarice_users`,
    )
    .all() as unknown as RawRow[];
  db.close();

  // Mesmo preserve-then-backfill de `recomputeDerived` (sem `csvIndex` — o
  // dry-run local não depende dos CSVs Stripe do root; linhas ainda sem
  // `stripe_ids` ficam com o cohort já persistido, mesmo comportamento de
  // `recomputeDerived` quando chamado sem `csvIndex`, ex: testes).
  // `priority_points` recomputado FRESCO a partir de opens/sends (não lido
  // da coluna, que pode estar stale se o último recompute não rodou —
  // opens_count/sends_count são atualizados direto pelo sync Brevo,
  // independente de recompute).
  const rows: MailboxRow[] = raw.map((r) => ({
    email: r.email,
    cohort:
      r.cohort != null && isKnownCohortSlug(r.cohort)
        ? r.cohort
        : computeCohort(r.tier, r.created),
    priority_points: computePriorityPoints({
      priority_optin: !!r.priority_optin,
      opens_count: r.opens_count ?? 0,
      sends_count: r.sends_count ?? 0,
    }),
    opens_count: r.opens_count ?? 0,
    sends_count: r.sends_count ?? 0,
    created: r.created,
    email_blacklisted: !!r.email_blacklisted,
    unsubscribed: !!r.unsubscribed,
    hard_bounced: !!r.hard_bounced,
    complained: !!r.complained,
    mv_bucket: r.mv_bucket,
    dispute_losses: r.dispute_losses ?? 0,
    soft_bounce_count: r.soft_bounce_count ?? 0,
  }));

  const report = computeMailboxDryrunReport(rows);
  console.log(renderMailboxDryrunMarkdown(report));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[clarice-mailbox-dryrun]", e);
    process.exit(1);
  });
}
