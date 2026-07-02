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
  // #2857 fase B: sucessor de `by_tier`/`by_tier_verified` (removidos deste
  // payload — o render em sections-kv.ts degrada pro código antigo quando lê
  // um KV cacheado ANTES desta migração, mesmo padrão de opcionalidade das
  // demais migrações de KV, ver #2817/#2731 acima). Mesmo universo firstSend
  // (send_eligible=1 AND sends_count<=0, `FIRST_SEND_SQL_PREDICATE`) e mesma
  // semântica de "sub-linhas da linha 0 do histograma" — só a dimensão de
  // agrupamento muda de `tier` pra `cohort` (GROUP BY cohort em vez de tier).
  by_cohort_first_send: Record<string, number>;
  by_cohort_first_send_verified: Record<string, number>;
  // #2817: agregado por safra mensal (`cohort`, derivado de `created`). Ao
  // contrário do by_tier, universo é o STORE INTEIRO (não só firstSend) — a
  // pergunta do editor é "quantos contatos são de junho", não "quantos de
  // junho ainda não receberam o 1º envio". Chave "null" = created ausente OU
  // anterior a 2026-05 (sem safra rotulada).
  by_cohort: Record<string, number>;
  by_cohort_verified: Record<string, number>;
  // #2865 (pedido do editor 260702): coluna "Brevo" — quantos contatos de cada
  // bucket têm `brevo_list_ids IS NOT NULL` (mesmo predicado de `brevo.synced_rows`
  // acima). Mesmo padrão esparso/opcionalidade da coluna "verified" (#2815):
  // bucket sem contato na Brevo = chave AUSENTE (render trata como 0). Só nos
  // 2 pares que a issue pediu (histograma + breakdown de 1º envio) — o par
  // `by_cohort` (safra) NÃO ganha a coluna Brevo (fora do escopo do #2865).
  priority_points_histogram_brevo: Record<string, number>;
  by_cohort_first_send_brevo: Record<string, number>;
  // #2864 (pedido do editor 260702): comparativo de envio/engajamento por
  // cohort — insumo pra estratégia da rampa. Universo = store inteiro MENOS
  // internos (mesmo filtro do bloco priority_points, #2809 — engajamento de
  // ofício não deve poluir a leitura de "cohort X abre mais que cohort Y").
  // Chave "null" = sem cohort atribuído.
  cohort_stats: Record<string, CohortStatsRow>;
  mv: Record<string, number>;
  engagement: { with_opens: number; with_clicks: number };
}

/**
 * #2864: 1 linha agregada por cohort pra aba "Cohorts" do dashboard. Contagens
 * brutas (não percentuais) — o render calcula as taxas (opened/received,
 * clicked/received, etc.) e trata denominador 0 como "—", nunca NaN/Infinity.
 */
export interface CohortStatsRow {
  /** COUNT(*) do cohort (menos internos). */
  contacts: number;
  /** send_eligible=1. */
  eligible: number;
  /** sends_count>0 — "já recebeu ao menos 1 envio". */
  received: number;
  /** SUM(sends_count) — total de eventos de envio do cohort. */
  sends_sum: number;
  /** sends_count>0 AND opens_count>0 — abriu ≥1, dentre quem recebeu. */
  opened: number;
  /** sends_count>0 AND clicks_count>0 — clicou ≥1, dentre quem recebeu. */
  clicked: number;
  /** sends_count>0 AND (unsubscribed=1 OR hard_bounced=1) — saiu, dentre quem recebeu. */
  unsub_bounce: number;
  /** mv_bucket='verified' — sobre o TOTAL de contatos do cohort (não só quem recebeu). */
  mv_verified: number;
  /** SUM(priority_points) restrito a quem recebeu (sends_count>0) — numerador da média.
   * null só em payload de KV antigo (pré-COALESCE do #2874); escrita nova nunca emite null. */
  priority_points_sum: number | null;
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
// #2865: SQL do subset "está na Brevo" — mesmo predicado de `brevo.synced_rows`
// acima (brevo_list_ids IS NOT NULL = contato já visto/sincronizado numa lista).
const BREVO_SYNCED_CASE = "SUM(CASE WHEN brevo_list_ids IS NOT NULL THEN 1 ELSE 0 END)";

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

/**
 * #2865: variante de `groupCountsWithVerified` com um 3º agregado condicional
 * ("está na Brevo", `BREVO_SYNCED_CASE`) no MESMO scan — a query deve projetar
 * `k`, `n`, `nv` (MV_VERIFIED_CASE) e `nb` (BREVO_SYNCED_CASE). Mesma semântica
 * esparsa dos outros dois mapas (ausência = 0, nunca 0 explícito). Só os 2
 * consumidores que a issue #2865 pede (histograma de priority_points +
 * breakdown de 1º envio por cohort) usam esta variante — `by_cohort` (safra,
 * #2817) fica com o par de 2 (fora do escopo do #2865).
 */
function groupCountsWithVerifiedAndBrevo(
  db: DatabaseSync,
  sql: string,
  params: string[] = [],
): { total: Record<string, number>; verified: Record<string, number>; brevo: Record<string, number> } {
  const total: Record<string, number> = {};
  const verified: Record<string, number> = {};
  const brevo: Record<string, number> = {};
  for (const r of db.prepare(sql).all(...params) as Array<{ k: unknown; n: number; nv: number; nb: number }>) {
    const key = r.k == null ? "null" : String(r.k);
    total[key] = r.n;
    if (r.nv > 0) verified[key] = r.nv;
    if (r.nb > 0) brevo[key] = r.nb;
  }
  return { total, verified, brevo };
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
  // #2857 fase B: GROUP BY cohort (não mais tier) — mesmo predicado firstSend,
  // sucessor de by_tier/by_tier_verified (ver StoreSummary acima).
  // #2865: os 2 pares que ganham a coluna Brevo usam a variante tripla
  // (total+verified+brevo) — mesmo scan único, 1 agregado condicional a mais.
  const byCohortFirstSendPair = groupCountsWithVerifiedAndBrevo(
    db,
    `SELECT cohort AS k, COUNT(*) n, ${MV_VERIFIED_CASE} nv, ${BREVO_SYNCED_CASE} nb FROM clarice_users
      WHERE ${FIRST_SEND_SQL_PREDICATE} GROUP BY cohort`,
  );
  const ppHistPair = groupCountsWithVerifiedAndBrevo(
    db,
    `SELECT priority_points AS k, COUNT(*) n, ${MV_VERIFIED_CASE} nv, ${BREVO_SYNCED_CASE} nb FROM clarice_users
      WHERE ${NOT_INTERNAL_SQL} GROUP BY priority_points`,
    INTERNAL_PARAMS,
  );
  // #2817: por safra (cohort), universo = store inteiro (sem filtro firstSend
  // nem de internos — mesmo padrão de `mv`/`by_tier`, que também não filtram).
  const byCohortPair = groupCountsWithVerified(
    db,
    `SELECT cohort AS k, COUNT(*) n, ${MV_VERIFIED_CASE} nv FROM clarice_users GROUP BY cohort`,
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
    // #2857 fase B: sucessor de by_tier/by_tier_verified — universo firstSend
    // (#2782, #2732: tier/cohort só governam a ordenação/agrupamento de 1º
    // envio; uma vez enviado, sends_count>0 tira o contato daqui) agrupado por
    // cohort. NÃO filtra internos (mesmo padrão do by_tier antigo — a exclusão
    // #2809 é exclusiva do bloco priority_points).
    by_cohort_first_send: byCohortFirstSendPair.total,
    by_cohort_first_send_verified: byCohortFirstSendPair.verified,
    // #2865: coluna Brevo do breakdown de 1º envio — mesmo universo firstSend.
    by_cohort_first_send_brevo: byCohortFirstSendPair.brevo,
    by_cohort: byCohortPair.total,
    by_cohort_verified: byCohortPair.verified,
    // #2865: coluna Brevo do histograma de priority_points — mesmo universo
    // (sem internos, #2809) do histograma total/verified acima.
    priority_points_histogram_brevo: ppHistPair.brevo,
    cohort_stats: computeCohortStats(db),
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

/**
 * #2864: agrega por cohort num scan único (mesmo padrão de
 * `groupCountsWithVerified` acima) as métricas comparativas da aba "Cohorts":
 * contatos, elegíveis, quem já recebeu ≥1 envio, soma de envios, quem abriu/
 * clicou/saiu dentre os que receberam, quem está MV-verificado (sobre o total
 * do cohort) e a soma de priority_points de quem recebeu (pro cálculo da
 * média no render). Exclui INTERNAL_EMAILS (#2809) — mesmo racional do bloco
 * priority_points: engajamento de ofício não é sinal de comportamento de
 * audiência e distorceria a comparação entre cohorts.
 */
function computeCohortStats(db: DatabaseSync): Record<string, CohortStatsRow> {
  const sql = `
    SELECT
      cohort AS k,
      COUNT(*) AS contacts,
      SUM(CASE WHEN send_eligible=1 THEN 1 ELSE 0 END) AS eligible,
      SUM(CASE WHEN sends_count>0 THEN 1 ELSE 0 END) AS received,
      SUM(COALESCE(sends_count,0)) AS sends_sum,
      SUM(CASE WHEN sends_count>0 AND opens_count>0 THEN 1 ELSE 0 END) AS opened,
      SUM(CASE WHEN sends_count>0 AND clicks_count>0 THEN 1 ELSE 0 END) AS clicked,
      SUM(CASE WHEN sends_count>0 AND (unsubscribed=1 OR hard_bounced=1) THEN 1 ELSE 0 END) AS unsub_bounce,
      ${MV_VERIFIED_CASE} AS mv_verified,
      SUM(CASE WHEN sends_count>0 THEN COALESCE(priority_points,0) ELSE 0 END) AS pp_sum
    FROM clarice_users
    WHERE ${NOT_INTERNAL_SQL}
    GROUP BY cohort
  `;
  const out: Record<string, CohortStatsRow> = {};
  const rows = db.prepare(sql).all(...INTERNAL_PARAMS) as Array<{
    k: unknown;
    contacts: number;
    eligible: number;
    received: number;
    sends_sum: number;
    opened: number;
    clicked: number;
    unsub_bounce: number;
    mv_verified: number;
    pp_sum: number;
  }>;
  for (const r of rows) {
    const key = r.k == null ? "null" : String(r.k);
    out[key] = {
      contacts: r.contacts,
      eligible: r.eligible,
      received: r.received,
      sends_sum: r.sends_sum,
      opened: r.opened,
      clicked: r.clicked,
      unsub_bounce: r.unsub_bounce,
      mv_verified: r.mv_verified,
      priority_points_sum: r.pp_sum,
    };
  }
  return out;
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
