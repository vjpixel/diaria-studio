/**
 * clarice-mv-status.ts (#2609, migrado pra store em #2886 PR2)
 *
 * Pré-computa o status de verificação MillionVerifier por grupo de contatos e
 * grava no KV do worker `clarice-dashboard` sob `mv:status`. O worker só lê e
 * renderiza o JSON — nunca varre o filesystem em runtime.
 *
 * Semântica por grupo:
 *   - cohort `assinantes-ativos` (T01, verify_risk 1): status="t01" — N/A,
 *     validado por pagamento Stripe. NUNCA "pending".
 *   - Demais cohorts (`ex-assinantes`, `leads-*`, etc): "verified" quando
 *     existe pelo menos 1 contato do cohort com `mv_bucket` preenchido para o
 *     ciclo (`mv_cycle`); "pending" quando o ciclo existe (i.e. outro cohort
 *     já foi verificado nele) mas este cohort ainda não tem nenhum contato
 *     verificado nesse ciclo.
 *
 * MIGRAÇÃO (#2886 PR2 — SOURCE eliminada, fonte agora é o store):
 * Antes este script varria `data/clarice-subscribers/` por diretórios de
 * ciclo ({YYMM}-{MM}) e por `mv-export-*-verified.csv`/`-rejected.csv`/
 * `-unknown.csv` dentro de cada um (contagem de linhas = contadores). Agora
 * lê `clarice_users` (colunas `cohort`, `mv_cycle`, `mv_bucket` — já escritas
 * pelo builder do store, `scripts/clarice-build-db.ts`, a partir da MESMA
 * verificação MV) via `GROUP BY cohort, mv_cycle`. Os arquivos CSV continuam
 * existindo como TRANSPORT (import Brevo / auditoria), mas deixaram de ser a
 * fonte deste relatório.
 *
 * Mapeamento exato do predicado (CSV-scan antigo → store-query novo):
 *   - "t01"     : havia `stripe-export-t01-*.csv` na base
 *               → existe ≥1 linha em `clarice_users` com `cohort = 'assinantes-ativos'`.
 *   - "verified": existia `mv-export-{grupo}-verified.csv` no dir do ciclo;
 *                 verified/rejected/unknown = contagem de linhas (menos header)
 *                 de cada um dos 3 arquivos `mv-export-{grupo}-{estado}.csv`
 *               → existe ≥1 linha com `cohort = ? AND mv_cycle = ? AND
 *                 mv_bucket IN ('verified','rejected','unknown')`;
 *                 verified/rejected/unknown = `COUNT(*)` por valor de
 *                 `mv_bucket` no mesmo filtro. `verifiedAt` = `MAX(mv_last_verified_at)`
 *                 (antes era o `mtime` do arquivo `-verified.csv`).
 *   - "pending" : cohort T02+ conhecido (tinha `stripe-export-t{02+}-*.csv`
 *                 na base) SEM arquivo verificado no ciclo, mas o ciclo
 *                 (diretório) existia
 *               → cohort conhecido (∃ linha com esse `cohort` em algum lugar
 *                 do store) SEM nenhuma linha `cohort = ? AND mv_cycle = ?`
 *                 com `mv_bucket` preenchido, mas o `mv_cycle` em si é
 *                 conhecido (∃ ao menos 1 linha em QUALQUER cohort com esse
 *                 `mv_cycle`). Cruzamento é o mesmo: universo de cohorts ×
 *                 universo de ciclos, ambos derivados do próprio store (antes
 *                 vinham de "quais CSVs de base existem" × "quais dirs de
 *                 ciclo existem").
 *
 * Diferença de nomenclatura observável (não-comportamental pro relatório em
 * si, mas visível no JSON): o `group` antes era o slug derivado do NOME DO
 * ARQUIVO (`stripe-export-t02-ex-assinantes.csv` → `"t02-ex-assinantes"`,
 * prefixo de tier incluído). O store não persiste mais o prefixo de tier no
 * `cohort` (#2857 fase C — unificação de taxonomia) — `group` agora é o slug
 * canônico puro (`"ex-assinantes"`, `"leads-2026-06"`, etc). Consumidor
 * (worker `clarice-dashboard`) usa `group` só como rótulo de exibição, não
 * como chave de matching — não há impacto funcional.
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID     obrigatório p/ upload KV
 *   CLOUDFLARE_WORKERS_TOKEN  obrigatório p/ upload KV (permissão Workers KV)
 *
 * Uso CLI:
 *   npx tsx scripts/clarice-mv-status.ts [--dry-run] [--db PATH]
 *
 *   --dry-run     computa e imprime o JSON, mas NÃO grava no KV.
 *   --db PATH     path alternativo do store SQLite (default: DEFAULT_DB_PATH).
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg } from "./lib/cli-args.ts";
import { DASHBOARD_KV_NAMESPACE_ID } from "./lib/dashboard-kv.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { COHORT_ASSINANTES_ATIVOS } from "./lib/cohorts.ts";

loadProjectEnv();

// NOTA: tipos e KV key são DUPLICADOS do worker (workers/brevo-dashboard/src/index.ts),
// NÃO importados. Importar do worker arrastaria index.ts (que usa KVNamespace/CacheStorage de
// @cloudflare/workers-types) pro programa tsc deste bundle — cujo tsconfig só inclui
// scripts/**/*.ts e não carrega os types do Worker —, quebrando o typecheck do CI. Mesmo padrão
// de scripts/clarice-engagement-cohorts.ts: bundles separados não compartilham tipos. O worker
// (reader) mantém as defs canônicas; aqui (writer) é cópia sincronizada à mão.
export interface MvGroupStatus {
  group: string;
  cycle: string;
  status: "verified" | "t01" | "pending";
  verifiedAt: string | null;
  verified: number;
  rejected: number;
  unknown: number;
}

export interface MvStatus {
  generatedAt: string;
  groups: MvGroupStatus[];
}

// Re-export p/ compat: DASHBOARD_KV_NAMESPACE_ID mora agora em lib/dashboard-kv.ts
// (módulo sem side-effect), pra que importar a constante não dispare o
// loadProjectEnv() do topo deste arquivo (#2743). Consumidores que já importavam
// daqui seguem funcionando.
export { DASHBOARD_KV_NAMESPACE_ID };
export const MV_STATUS_KV_KEY = "mv:status";

interface CohortRow {
  cohort: string;
}
interface CycleRow {
  mv_cycle: string;
}
interface AggRow {
  verified: number | null;
  rejected: number | null;
  unknown: number | null;
  verifiedAt: string | null;
}

/**
 * Computa o status MV a partir do store (`clarice_users`). Pura/testável —
 * recebe uma `DatabaseSync` já aberta (produção usa `openClariceDb()`, testes
 * usam `openClariceDb(":memory:")` seeded via INSERT direto).
 */
export function computeMvStatusFromStore(db: DatabaseSync, now: Date = new Date()): MvStatus {
  const groups: MvGroupStatus[] = [];

  // T01 (assinantes-ativos): status fixo "t01", nunca pending. Emite só se
  // existir ao menos 1 contato desse cohort no store (equivalente a "existia
  // stripe-export-t01-*.csv na base").
  const t01Count = (
    db
      .prepare(`SELECT COUNT(*) as n FROM clarice_users WHERE cohort = ?`)
      .get(COHORT_ASSINANTES_ATIVOS) as { n: number }
  ).n;
  if (t01Count > 0) {
    groups.push({
      group: COHORT_ASSINANTES_ATIVOS,
      cycle: "—",
      status: "t01",
      verifiedAt: null,
      verified: 0,
      rejected: 0,
      unknown: 0,
    });
  }

  // Universo de cohorts T02+ conhecidos (equivalente aos stripe-export-t{02+}-*.csv da base).
  const cohorts = (
    db
      .prepare(
        `SELECT DISTINCT cohort FROM clarice_users WHERE cohort IS NOT NULL AND cohort != ?`,
      )
      .all(COHORT_ASSINANTES_ATIVOS) as unknown as CohortRow[]
  ).map((r) => r.cohort);

  // Universo de ciclos conhecidos (equivalente aos diretórios {YYMM}-{MM} existentes).
  const cycles = (
    db.prepare(`SELECT DISTINCT mv_cycle FROM clarice_users WHERE mv_cycle IS NOT NULL`).all() as unknown as CycleRow[]
  ).map((r) => r.mv_cycle);

  const aggStmt = db.prepare(`
    SELECT
      SUM(CASE WHEN mv_bucket = 'verified' THEN 1 ELSE 0 END) as verified,
      SUM(CASE WHEN mv_bucket = 'rejected' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN mv_bucket = 'unknown' THEN 1 ELSE 0 END) as unknown,
      MAX(mv_last_verified_at) as verifiedAt
    FROM clarice_users
    WHERE cohort = ? AND mv_cycle = ?
  `);

  for (const cycle of cycles) {
    for (const cohort of cohorts) {
      const row = aggStmt.get(cohort, cycle) as unknown as AggRow;
      const verified = row.verified ?? 0;
      const rejected = row.rejected ?? 0;
      const unknown = row.unknown ?? 0;

      if (verified + rejected + unknown > 0) {
        groups.push({
          group: cohort,
          cycle,
          status: "verified",
          verifiedAt: row.verifiedAt ?? null,
          verified,
          rejected,
          unknown,
        });
      } else {
        groups.push({
          group: cohort,
          cycle,
          status: "pending",
          verifiedAt: null,
          verified: 0,
          rejected: 0,
          unknown: 0,
        });
      }
    }
  }

  return { generatedAt: now.toISOString(), groups };
}

async function main(): Promise<void> {
  const isDryRun = hasFlag(process.argv, "dry-run");
  const dbPath = getArg(process.argv, "db") || DEFAULT_DB_PATH;
  console.log(`[clarice-mv-status] lendo store ${dbPath}…`);

  // Guard: nunca sobrescrever o KV de produção com payload vazio. Em máquina sem
  // a junction OneDrive (store ausente), abortar cedo com a mesma mensagem de
  // sempre em vez de deixar openClariceDb criar um .db vazio no lugar errado.
  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    console.error(
      `[clarice-mv-status] store não encontrado em ${dbPath}. ` +
        `Abortando para não sobrescrever KV de produção. Use --dry-run para inspecionar ou --db para apontar outro path.`,
    );
    process.exit(1);
  }

  const db = openClariceDb(dbPath);
  let status: MvStatus;
  try {
    status = computeMvStatusFromStore(db);
  } finally {
    db.close();
  }
  const json = JSON.stringify(status, null, 2);

  console.log(`[clarice-mv-status] ${status.groups.length} grupos encontrados.`);
  console.log(json);

  if (isDryRun) {
    console.log("[clarice-mv-status] --dry-run: não gravou no KV.");
    return;
  }

  if (status.groups.length === 0) {
    console.error(
      `[clarice-mv-status] 0 grupos computados no store (${dbPath}). ` +
        `Abortando upload para não sobrescrever KV de produção. Use --dry-run para inspecionar.`,
    );
    process.exit(1);
  }

  await uploadTextToWorkerKV(json, MV_STATUS_KV_KEY, {
    kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_WORKERS_TOKEN ?? "",
  });
  console.log(`[clarice-mv-status] KV atualizado: ${MV_STATUS_KV_KEY}.`);
}

// CLI guard — não executar ao ser importado em testes.
// Usa pathToFileURL para compatibilidade com Windows (endsWith sem file:/// pode falhar via npx tsx).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[clarice-mv-status] erro:", e);
    process.exit(1);
  });
}
