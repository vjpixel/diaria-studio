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
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { openClariceDb, DEFAULT_DB_PATH, INTERNAL_EMAILS } from "./lib/clarice-db.ts";
// #3081: importa direto de lib/dashboard-kv.ts (módulo sem side-effect) — antes
// vinha indireto via clarice-mv-status.ts (que só re-exporta a MESMA constante
// de lib/dashboard-kv.ts pra compat; sem motivo pra passar por esse hop extra).
import { DASHBOARD_KV_NAMESPACE_ID } from "./lib/dashboard-kv.ts";
// #3081: CohortStatsRow fonte única em lib/dashboard-kv-types.ts (dependency-free)
// — antes era uma cópia manualmente sincronizada com a interface homônima em
// workers/brevo-dashboard/src/types.ts.
import { isJuridicoEmail } from "./lib/clarice-sector.ts";
import { isFirstSend, isSendEligible } from "./lib/clarice-segment.ts";
import { COHORT_JURIDICO } from "./lib/cohorts.ts";
import type { CohortStatsRow } from "./lib/dashboard-kv-types.ts";
export type { CohortStatsRow };

export const CONTACTS_SUMMARY_KV_KEY = "contacts:summary";

// #3081 (review): `CohortStatsRow` importado é intencionalmente lenient
// (`eligible_never_sent`/`brevo` opcionais) pro READER (worker) tolerar
// payloads KV gravados por versões antigas deste script, antes desses campos
// existirem. Este script é o WRITER — `computeCohortStats` abaixo SEMPRE
// popula os 2 (nenhum caminho da query os omite). A duplicata local antiga
// (pré-#3081) tinha esses 2 campos como obrigatórios, então um refactor que
// removesse um deles por engano quebrava o typecheck; unificar com o tipo do
// reader perderia essa guarda silenciosamente. `Required<...>` local restaura
// a garantia sem afetar o tipo compartilhado (o reader continua lenient).
type WrittenCohortStatsRow = Required<CohortStatsRow>;

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
  // #2880: coluna "elegíveis" do histograma — por valor exato de priority_points,
  // quantos têm `send_eligible=1`. O histograma inteiro cobre a base (menos
  // internos, #2809) incluindo INELEGÍVEIS; esta coluna isola o subconjunto de
  // fato enviável. Mesma semântica esparsa/opcional das colunas verified/Brevo
  // (bucket sem elegível = chave AUSENTE, render trata como 0).
  priority_points_histogram_eligible: Record<string, number>;
  // #2865: coluna "Brevo" do histograma — por valor exato de priority_points,
  // quantos têm `brevo_list_ids IS NOT NULL` (mesmo predicado de
  // `brevo.synced_rows`). Padrão esparso/opcional como a coluna "verified"
  // (#2815): valor sem contato na Brevo = chave AUSENTE (render trata como 0).
  //
  // #2880: os pares `by_cohort`/`by_cohort_verified` (tabela "Por safra") e
  // `by_cohort_first_send`(`_verified`/`_brevo`) (sub-linhas "1º envio" da
  // linha 0) foram REMOVIDOS — ambas as tabelas saíram do dashboard,
  // consolidadas na tabela Cohorts (`cohort_stats`, agora com coluna Brevo).
  priority_points_histogram_brevo: Record<string, number>;
  // #2864 (pedido do editor 260702): comparativo de envio/engajamento por
  // cohort — insumo pra estratégia da rampa. Universo = store inteiro MENOS
  // internos (mesmo filtro do bloco priority_points, #2809 — engajamento de
  // ofício não deve poluir a leitura de "cohort X abre mais que cohort Y").
  // Chave "null" = sem cohort atribuído. Chave "juridico" (`COHORT_JURIDICO`,
  // #4406): contato detectado como jurídico entra AQUI em vez da safra real —
  // nunca nas duas (cada contato pertence a exatamente 1 chave, mesmo
  // invariante de partição de sempre).
  cohort_stats: Record<string, WrittenCohortStatsRow>;
  mv: Record<string, number>;
  engagement: { with_opens: number; with_clicks: number };
}

/**
 * #2864: 1 linha agregada por cohort pra aba "Cohorts" do dashboard. Contagens
 * brutas (não percentuais) — o render calcula as taxas (opened/received,
 * clicked/received, etc.) e trata denominador 0 como "—", nunca NaN/Infinity.
 */
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

const SEND_ELIGIBLE_CASE = "SUM(CASE WHEN send_eligible=1 THEN 1 ELSE 0 END)";

/**
 * #2865/#2880: N pares total+condicionais num ÚNICO scan (review #2815) —
 * generalizado no #2875 (a variante fixa de 2/3 mapas, `groupCountsWithVerified`/
 * `groupCountsWithVerifiedAndBrevo`, e os pares by_cohort saíram junto com as
 * tabelas "Por safra"/"1º envio", #2880). `extraCols` é a lista de nomes de
 * coluna condicional que o SQL do caller projeta ALÉM de `k`/`n` (COUNT) —
 * cada um um `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` com esse MESMO alias.
 * Cada mapa extra preserva a semântica esparsa (bucket sem essa condição =
 * chave AUSENTE, nunca 0 explícito) — o render trata ausente como 0.
 */
function groupCountsMulti<K extends string>(
  db: DatabaseSync,
  sql: string,
  extraCols: readonly K[],
  params: string[] = [],
): { total: Record<string, number> } & Record<K, Record<string, number>> {
  const total: Record<string, number> = {};
  // Indexado via Record<string, ...> (não K) só internamente — writes num tipo
  // genérico indexado por K não são permitidos pelo compilador (TS2862); o
  // retorno da função permanece tipado por K normalmente.
  const extras: Record<string, Record<string, number>> = Object.fromEntries(
    extraCols.map((col) => [col, {}]),
  );
  const rows = db.prepare(sql).all(...params) as Array<{ k: unknown; n: number } & Record<K, number>>;
  for (const r of rows) {
    const key = r.k == null ? "null" : String(r.k);
    total[key] = r.n;
    for (const col of extraCols) {
      if (r[col] > 0) extras[col][key] = r[col];
    }
  }
  return { total, ...extras } as { total: Record<string, number> } & Record<K, Record<string, number>>;
}

// #2809: fragmento SQL + params pra excluir os emails internos das agregações
// de priority_points (case-insensitive por segurança — o store normaliza, mas
// LOWER() protege contra variação de ingestão). SÓ exibição: nenhuma outra
// agregação (total, by_tier, mv, engagement, eligibility) filtra internos.
const NOT_INTERNAL_SQL = `LOWER(email) NOT IN (${INTERNAL_EMAILS.map(() => "?").join(",")})`;
const INTERNAL_PARAMS = INTERNAL_EMAILS.map((e) => e.toLowerCase());

/**
 * Agrega o store em números (sem PII). Via SQL — não carrega 427k linhas em JS
 * (exceto `computeCohortStats`, que precisa de um scan JS — ver docstring lá).
 */
export function computeStoreSummary(db: DatabaseSync): StoreSummary {
  // Pares total+verified em SCAN ÚNICO por universo (review #2815 — antes eram
  // 2 queries full-scan por par, diferindo só pelo AND mv_bucket='verified').
  // #2857 fase B: GROUP BY cohort (não mais tier) — mesmo predicado firstSend,
  // sucessor de by_tier/by_tier_verified (ver StoreSummary acima).
  // #2865: o histograma de priority_points ganha a coluna Brevo — variante
  // tripla (total+verified+brevo), mesmo scan único, 1 agregado condicional a
  // mais. #2880: os pares by_cohort/by_cohort_first_send foram removidos (as
  // tabelas "Por safra" e "1º envio" saíram do dashboard).
  const ppHistPair = groupCountsMulti(
    db,
    `SELECT priority_points AS k, COUNT(*) n, ${MV_VERIFIED_CASE} verified, ${BREVO_SYNCED_CASE} brevo, ${SEND_ELIGIBLE_CASE} eligible FROM clarice_users
      WHERE ${NOT_INTERNAL_SQL} GROUP BY priority_points`,
    ["verified", "brevo", "eligible"] as const,
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
    // #2880: coluna "elegíveis" — mesmo universo (sem internos, #2809),
    // restrito a send_eligible=1. Chave ausente = 0 elegíveis nesse bucket.
    priority_points_histogram_eligible: ppHistPair.eligible,
    // #2865: coluna Brevo do histograma de priority_points — mesmo universo
    // (sem internos, #2809) do histograma total/verified acima.
    priority_points_histogram_brevo: ppHistPair.brevo,
    cohort_stats: computeCohortStats(db),
    mv: groupCounts(
      db,
      "SELECT COALESCE(mv_bucket,'none') AS k, COUNT(*) n FROM clarice_users GROUP BY COALESCE(mv_bucket,'none')",
    ),
    // #4712: excluído internos (NOT_INTERNAL_SQL) — mesmo universo do
    // histograma de priority_points acima (`priority_points_histogram`),
    // pra que a nota "Aberturas/cliques acumulados" na mesma seção do
    // dashboard conte a MESMA população que o subtotal "Score positivo" do
    // histograma. Antes do #4712 este bloco era a ÚNICA agregação da seção
    // sem o filtro — comentário/teste em #2809 dizia explicitamente "demais
    // agregações seguem contando os internos (sem filtro)", o que ficou
    // desatualizado por este bloco a partir daqui. Mesmo assim os dois
    // conjuntos continuam se cruzando sem um conter o outro — não é
    // subconjunto (ver nota renderizada em sections-kv.ts): priority_points
    // decai por não-abertura (quem abriu 1 de 5 pode ter score negativo) e
    // opt-in sem abertura nenhuma já entra como score positivo.
    engagement: {
      with_opens: count(
        db,
        `SELECT COUNT(*) n FROM clarice_users WHERE opens_count>0 AND ${NOT_INTERNAL_SQL}`,
        INTERNAL_PARAMS,
      ),
      with_clicks: count(
        db,
        `SELECT COUNT(*) n FROM clarice_users WHERE clicks_count>0 AND ${NOT_INTERNAL_SQL}`,
        INTERNAL_PARAMS,
      ),
    },
  };
}

/**
 * #2864: agrega por cohort as métricas comparativas da aba "Cohorts": contatos,
 * elegíveis, quem já recebeu ≥1 envio, quem é elegível e NUNCA recebeu (fila
 * real de 1º envio — `isFirstSend`, mesmo predicado que a rampa usa pra montar
 * as waves, #4406), quem abriu/clicou/saiu dentre os que receberam, e quem
 * está na Brevo. Exclui INTERNAL_EMAILS (#2809) — engajamento de ofício não é
 * sinal de comportamento de audiência e distorceria a comparação entre
 * cohorts.
 *
 * Scan em JS (não SQL `GROUP BY cohort`) desde o #4406: a chave de agregação
 * não é mais só a coluna `cohort` — um contato jurídico (`isJuridicoEmail`,
 * clarice-sector.ts, classificação por regex sobre o e-mail) entra na linha
 * `COHORT_JURIDICO` EM VEZ DA sua safra real (decisão do editor: "cada
 * contato só pode estar em um cohort por vez" — a mesma partição de sempre,
 * sem caso especial de dupla-contagem). SQLite não expressa essa regex sem
 * duplicar os padrões dentro da query — trade-off aceito no #4406: a query
 * `GROUP BY cohort` que existia antes virou este scan em JS, único jeito de
 * aplicar `isJuridicoEmail` na chave de agregação sem duplicar a lógica de
 * classificação em SQL cru.
 */
function computeCohortStats(db: DatabaseSync): Record<string, WrittenCohortStatsRow> {
  const rows = db.prepare(`
    SELECT email, cohort, send_eligible, sends_count, opens_count, clicks_count,
           unsubscribed, hard_bounced, brevo_list_ids
    FROM clarice_users
    WHERE ${NOT_INTERNAL_SQL}
  `).all(...INTERNAL_PARAMS) as Array<{
    email: string;
    cohort: string | null;
    send_eligible: number;
    sends_count: number | null;
    opens_count: number | null;
    clicks_count: number | null;
    unsubscribed: number;
    hard_bounced: number;
    brevo_list_ids: string | null;
  }>;

  const out: Record<string, WrittenCohortStatsRow> = {};
  const blank = (): WrittenCohortStatsRow => ({
    contacts: 0, eligible: 0, received: 0, eligible_never_sent: 0,
    opened: 0, clicked: 0, unsub: 0, hard_bounce: 0, brevo: 0,
  });

  for (const r of rows) {
    const key = isJuridicoEmail(r.email)
      ? COHORT_JURIDICO
      : r.cohort == null ? "null" : String(r.cohort);
    const row = (out[key] ??= blank());
    const recebeu = (r.sends_count ?? 0) > 0;
    row.contacts++;
    if (isSendEligible(r)) row.eligible++;
    if (recebeu) row.received++;
    if (isFirstSend({ send_eligible: r.send_eligible, sends_count: r.sends_count ?? 0 })) {
      row.eligible_never_sent++;
    }
    if (recebeu && (r.opens_count ?? 0) > 0) row.opened++;
    if (recebeu && (r.clicks_count ?? 0) > 0) row.clicked++;
    if (recebeu && r.unsubscribed === 1) row.unsub++;
    if (recebeu && r.hard_bounced === 1) row.hard_bounce++;
    if (r.brevo_list_ids !== null) row.brevo++;
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

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[clarice-db-summary]", e);
    process.exit(1);
  });
}
