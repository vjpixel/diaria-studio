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
import { openClariceDb, DEFAULT_DB_PATH, INTERNAL_EMAILS } from "./lib/clarice-db.ts";
import { FIRST_SEND_SQL_PREDICATE } from "./lib/clarice-segment.ts";
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
    // #2809: quantos emails internos (INTERNAL_EMAILS) existem no store e foram
    // EXCLUÍDOS destas agregações + do histograma abaixo (só exibição — eles
    // seguem no store e na fila de envio). Com internos presentes, as faixas e
    // o histograma particionam `total - internal_excluded`, não `total`.
    internal_excluded: number;
  };
  // #2731: distribuição por VALOR EXATO de priority_points (não em faixas) —
  // Record<string, number> (chave = valor como string, "null" = sem pontuação
  // atribuída ainda). O render mostra isso como visão primária, ordenado
  // numérico DESC pelo valor (fila de re-envio: maior pontuação primeiro);
  // `priority_points` (faixas, acima) mantido pra contexto/fallback de KV
  // pré-#2731.
  priority_points_histogram: Record<string, number>;
  // Coluna "verified" da tabela de priority_points (pedido do editor 260702):
  // por valor exato de priority_points, quantos têm mv_bucket='verified'.
  // Mesma exclusão de internos do histograma (#2809).
  priority_points_histogram_verified: Record<string, number>;
  // Idem para as sub-linhas de tier (universo firstSend do by_tier + verified).
  by_tier_verified: Record<string, number>;
  mv: Record<string, number>;
  engagement: { with_opens: number; with_clicks: number };
}

function count(db: DatabaseSync, sql: string, params: string[] = []): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

function groupCounts(
  db: DatabaseSync,
  sql: string,
  params: string[] = [],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.prepare(sql).all(...params) as Array<{ k: unknown; n: number }>) {
    out[r.k == null ? "null" : String(r.k)] = r.n;
  }
  return out;
}

// SQL do subset MV-verificado — fonte única das agregações condicionais abaixo.
const MV_VERIFIED_CASE = "SUM(CASE WHEN mv_bucket='verified' THEN 1 ELSE 0 END)";

/**
 * Variante do groupCounts pra par total+verified num ÚNICO scan (review #2815):
 * a query deve projetar `k`, `n` (COUNT) e `nv` (MV_VERIFIED_CASE). O mapa
 * `verified` preserva a semântica esparsa da query separada (bucket sem
 * verificado = chave AUSENTE, não 0) — o render trata ausente como 0.
 */
function groupCountsWithVerified(
  db: DatabaseSync,
  sql: string,
  params: string[] = [],
): { total: Record<string, number>; verified: Record<string, number> } {
  const total: Record<string, number> = {};
  const verified: Record<string, number> = {};
  for (const r of db.prepare(sql).all(...params) as Array<{ k: unknown; n: number; nv: number }>) {
    const key = r.k == null ? "null" : String(r.k);
    total[key] = r.n;
    if (r.nv > 0) verified[key] = r.nv;
  }
  return { total, verified };
}

// #2809: fragmento SQL + params pra excluir os emails internos das agregações
// de priority_points (case-insensitive por segurança — o store normaliza, mas
// LOWER() protege contra variação de ingestão). SÓ exibição: nenhuma outra
// agregação (total, by_tier, mv, engagement, eligibility) filtra internos.
const NOT_INTERNAL_SQL = `LOWER(email) NOT IN (${INTERNAL_EMAILS.map(() => "?").join(",")})`;
const INTERNAL_PARAMS = INTERNAL_EMAILS.map((e) => e.toLowerCase());

/** Agrega o store em números (sem PII). Via SQL — não carrega 427k linhas em JS. */
export function computeStoreSummary(db: DatabaseSync): StoreSummary {
  // Pares total+verified em SCAN ÚNICO por universo (review #2815 — antes eram
  // 2 queries full-scan por par, diferindo só pelo AND mv_bucket='verified').
  const byTierPair = groupCountsWithVerified(
    db,
    `SELECT tier AS k, COUNT(*) n, ${MV_VERIFIED_CASE} nv FROM clarice_users
      WHERE ${FIRST_SEND_SQL_PREDICATE} GROUP BY tier`,
  );
  const ppHistPair = groupCountsWithVerified(
    db,
    `SELECT priority_points AS k, COUNT(*) n, ${MV_VERIFIED_CASE} nv FROM clarice_users
      WHERE ${NOT_INTERNAL_SQL} GROUP BY priority_points`,
    INTERNAL_PARAMS,
  );
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
    // #2782: o predicado vem da MESMA fonte que segmentFromStore usa — não
    // reimplementar em SQL cru aqui (era 2 cópias que divergiam em silêncio).
    by_tier: byTierPair.total,
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
    // #2809: TODO o bloco priority_points (faixas + optin + histograma) exclui
    // os INTERNAL_EMAILS — engajamento de ofício não é sinal de audiência.
    priority_points: {
      lt0: count(
        db,
        `SELECT COUNT(*) n FROM clarice_users WHERE priority_points<0 AND ${NOT_INTERNAL_SQL}`,
        INTERNAL_PARAMS,
      ),
      eq0: count(
        db,
        `SELECT COUNT(*) n FROM clarice_users WHERE priority_points=0 AND ${NOT_INTERNAL_SQL}`,
        INTERNAL_PARAMS,
      ),
      p1_40: count(
        db,
        `SELECT COUNT(*) n FROM clarice_users WHERE priority_points BETWEEN 1 AND 40 AND ${NOT_INTERNAL_SQL}`,
        INTERNAL_PARAMS,
      ),
      p41_80: count(
        db,
        `SELECT COUNT(*) n FROM clarice_users WHERE priority_points BETWEEN 41 AND 80 AND ${NOT_INTERNAL_SQL}`,
        INTERNAL_PARAMS,
      ),
      gt80: count(
        db,
        `SELECT COUNT(*) n FROM clarice_users WHERE priority_points>80 AND ${NOT_INTERNAL_SQL}`,
        INTERNAL_PARAMS,
      ),
      // priority_optin=1 NA clarice_users (quem de fato recebeu o +40 nesta
      // distribuição) — não a tabela priority_optin crua, que pode ter emails
      // ainda ausentes do store.
      optin: count(
        db,
        `SELECT COUNT(*) n FROM clarice_users WHERE priority_optin=1 AND ${NOT_INTERNAL_SQL}`,
        INTERNAL_PARAMS,
      ),
      internal_excluded: count(
        db,
        `SELECT COUNT(*) n FROM clarice_users WHERE NOT (${NOT_INTERNAL_SQL})`,
        INTERNAL_PARAMS,
      ),
    },
    // #2731: distribuição por valor exato — groupCounts já trata NULL como
    // chave "null" (mesmo padrão de `mv`/`by_reason`/`by_tier` acima).
    // #2809: internos excluídos (mesmo filtro do bloco acima).
    priority_points_histogram: ppHistPair.total,
    // Coluna "verified" (260702): mesmo universo do histograma (sem internos,
    // #2809), restrito a mv_bucket='verified'. Chave ausente = 0 verificados.
    priority_points_histogram_verified: ppHistPair.verified,
    // Verified das sub-linhas de tier: universo firstSend (#2782, mesma fonte
    // do by_tier — que, como o by_tier, NÃO filtra internos; a exclusão #2809
    // é exclusiva do bloco priority_points) ∩ mv_bucket='verified'. T1 tende a
    // 0/baixo — assinante ativo é validado por pagamento, não passa pelo MV
    // (#1297).
    by_tier_verified: byTierPair.verified,
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
