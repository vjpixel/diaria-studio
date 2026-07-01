#!/usr/bin/env node
/**
 * clarice-db-summary.ts — sumário agregado do store único de contatos (#2653).
 *
 * Lê o SQLite local (#2647) e grava um sumário SÓ-NÚMEROS (sem PII) no KV do
 * worker `clarice-dashboard` sob `contacts:summary`. O worker (aba nova) só lê e
 * renderiza. Mesmo padrão de `clarice-mv-status.ts` (KV `mv:status`) e
 * `clarice-engagement-cohorts.ts`.
 *
 * O store é local (OneDrive, inalcançável pelo worker) → este script é a ponte.
 *
 * Env (só p/ gravar no KV; --dry-run dispensa):
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_WORKERS_TOKEN
 *
 * Uso:
 *   npx tsx scripts/clarice-db-summary.ts [--db <path>] [--dry-run]
 *   --dry-run: computa e imprime o JSON, NÃO grava no KV.
 *
 * Stdout: o JSON do sumário. Stderr: progresso.
 */

import { DatabaseSync } from "node:sqlite";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, hasFlag } from "./lib/cli-args.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
// Namespace KV do dashboard: fonte única em clarice-mv-status.ts (já exportado) —
// reusar evita drift se o namespace for rotacionado.
import { DASHBOARD_KV_NAMESPACE_ID } from "./clarice-mv-status.ts";

export const CONTACTS_SUMMARY_KV_KEY = "contacts:summary";

export interface StoreSummary {
  total: number;
  brevo: { synced_rows: number; has_signal: boolean };
  by_tier: Record<string, number>;
  eligibility: {
    eligible: number;
    ineligible: number;
    by_reason: Record<string, number>;
  };
  priority_points: {
    lt0: number;
    eq0: number;
    p1_40: number;
    p41_80: number;
    gt80: number;
    optin: number;
  };
  // #2731: distribuição por VALOR EXATO de priority_points (não em faixas) —
  // Record<string, number> (chave = valor como string, "null" = sem pontuação
  // atribuída ainda). O render mostra isso como visão primária, ordenado
  // numérico DESC pelo valor (fila de re-envio: maior pontuação primeiro);
  // `priority_points` (faixas, acima) mantido pra contexto/fallback de KV
  // pré-#2731.
  priority_points_histogram: Record<string, number>;
  mv: Record<string, number>;
  engagement: { with_opens: number; with_clicks: number };
}

function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

function groupCounts(
  db: DatabaseSync,
  sql: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.prepare(sql).all() as Array<{ k: unknown; n: number }>) {
    out[r.k == null ? "null" : String(r.k)] = r.n;
  }
  return out;
}

/** Agrega o store em números (sem PII). Via SQL — não carrega 427k linhas em JS. */
export function computeStoreSummary(db: DatabaseSync): StoreSummary {
  return {
    total: count(db, "SELECT COUNT(*) n FROM clarice_users"),
    brevo: {
      synced_rows: count(
        db,
        "SELECT COUNT(*) n FROM clarice_users WHERE brevo_list_ids IS NOT NULL",
      ),
      has_signal:
        count(
          db,
          `SELECT COUNT(*) n FROM clarice_users
            WHERE opens_count>0 OR sends_count>0 OR email_blacklisted=1
               OR unsubscribed=1 OR hard_bounced=1 OR complained=1`,
        ) > 0,
    },
    // #2732: tier só governa a ordenação de 1º envio (segmentFromStore em
    // clarice-segment.ts) — uma vez que o contato JÁ recebeu ≥1 email
    // (sends_count>0), o preditor de reenvio vira priority_points (histórico
    // real de abertura), nunca mais tier (atributo estático do Stripe).
    // by_tier aqui espelha o universo `firstSend` de segmentFromStore: além
    // de sends_count=0, exige send_eligible=1 — sem isso, contato nunca-enviado
    // mas permanentemente bloqueado (dispute, mv_rejected, unsubscribed antes
    // do 1º envio) inflaria a contagem por tier mesmo nunca indo pra fila real
    // (segmentFromStore roteia esses pra `excluded`, não `firstSend`). tier
    // continua gravado no store pra auditoria, só não entra nesta contagem.
    by_tier: groupCounts(
      db,
      `SELECT tier AS k, COUNT(*) n FROM clarice_users
        WHERE send_eligible=1 AND COALESCE(sends_count,0)=0 GROUP BY tier`,
    ),
    eligibility: {
      eligible: count(
        db,
        "SELECT COUNT(*) n FROM clarice_users WHERE send_eligible=1",
      ),
      ineligible: count(
        db,
        "SELECT COUNT(*) n FROM clarice_users WHERE send_eligible=0",
      ),
      by_reason: groupCounts(
        db,
        `SELECT ineligible_reason AS k, COUNT(*) n FROM clarice_users
          WHERE send_eligible=0 GROUP BY ineligible_reason`,
      ),
    },
    priority_points: {
      lt0: count(db, "SELECT COUNT(*) n FROM clarice_users WHERE priority_points<0"),
      eq0: count(db, "SELECT COUNT(*) n FROM clarice_users WHERE priority_points=0"),
      p1_40: count(
        db,
        "SELECT COUNT(*) n FROM clarice_users WHERE priority_points BETWEEN 1 AND 40",
      ),
      p41_80: count(
        db,
        "SELECT COUNT(*) n FROM clarice_users WHERE priority_points BETWEEN 41 AND 80",
      ),
      gt80: count(db, "SELECT COUNT(*) n FROM clarice_users WHERE priority_points>80"),
      // priority_optin=1 NA clarice_users (quem de fato recebeu o +40 nesta
      // distribuição) — não a tabela priority_optin crua, que pode ter emails
      // ainda ausentes do store.
      optin: count(db, "SELECT COUNT(*) n FROM clarice_users WHERE priority_optin=1"),
    },
    // #2731: distribuição por valor exato — groupCounts já trata NULL como
    // chave "null" (mesmo padrão de `mv`/`by_reason`/`by_tier` acima).
    priority_points_histogram: groupCounts(
      db,
      "SELECT priority_points AS k, COUNT(*) n FROM clarice_users GROUP BY priority_points",
    ),
    mv: groupCounts(
      db,
      "SELECT COALESCE(mv_bucket,'none') AS k, COUNT(*) n FROM clarice_users GROUP BY COALESCE(mv_bucket,'none')",
    ),
    engagement: {
      with_opens: count(db, "SELECT COUNT(*) n FROM clarice_users WHERE opens_count>0"),
      with_clicks: count(db, "SELECT COUNT(*) n FROM clarice_users WHERE clicks_count>0"),
    },
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadProjectEnv();
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const dryRun = hasFlag(argv, "dry-run");

  const db = openClariceDb(dbPath);
  const summary = computeStoreSummary(db);
  db.close();

  const payload = { generated_at: new Date().toISOString(), ...summary };
  const json = JSON.stringify(payload, null, 2);
  console.log(json);

  if (dryRun) {
    console.error("[clarice-db-summary] --dry-run: KV NÃO atualizado.");
    return;
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_WORKERS_TOKEN ?? "";
  if (!accountId || !token) {
    console.error(
      "[clarice-db-summary] CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN ausentes — " +
        "use --dry-run ou configure as credenciais.",
    );
    process.exit(1);
  }

  await uploadTextToWorkerKV(json, CONTACTS_SUMMARY_KV_KEY, {
    kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
    accountId,
    token,
    contentType: "application/json",
  });
  console.error(`[clarice-db-summary] KV atualizado: ${CONTACTS_SUMMARY_KV_KEY}.`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((e) => {
    console.error("[clarice-db-summary]", e);
    process.exit(1);
  });
}
