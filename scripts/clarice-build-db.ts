#!/usr/bin/env node
/**
 * clarice-build-db.ts — (re)constrói o store único de usuários da Clarice (#2647).
 *
 * Consolida num SQLite (keyed por email) o que hoje está fragmentado e lossy:
 *   1. Stripe  → base completa (cohorts nomeados, #2857 fase C) + 5 campos
 *      mantidos + cohort, via `buildUniverse()` do merge (preserva sinal que
 *      os CSVs de cohort descartam; cohort escrito DIRETO — o merge tem o
 *      contexto completo do Stripe que este store não persiste).
 *   2. MV      → ingere os `mv-export-*-{verified,rejected,unknown}.csv` de cada
 *      ciclo `{conteúdo}-{envio}/` (result, code, quality, bucket, ciclo).
 *   3. Brevo   → engajamento/supressão (opens, clicks, bounces, unsub). Sync ao
 *      vivo é follow-up (rate-limited, MCP top-level) — ver nota abaixo.
 *   4. Optin   → flag manual da tabela `priority_optin` (CLI `clarice-optin.ts`).
 * Por fim recomputa `priority_points` + `send_eligible` + `ineligible_reason`.
 *
 * Idempotente: re-rodar refaz Stripe+MV e recomputa derivados; a tabela
 * `priority_optin` (manual) e as colunas Brevo já sincronizadas são preservadas
 * (upserts cirúrgicos por bloco de colunas, nunca um DELETE geral).
 *
 * Uso:
 *   npx tsx scripts/clarice-build-db.ts [--db <path>] [--data-dir <path>]
 *
 * Stdout: JSON summary. Stderr: progresso.
 */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { buildUniverse } from "./merge-clarice-subscribers.ts";
import { classifyResult } from "./verify-emails-mv.ts";
import { getArg } from "./lib/cli-args.ts";
import { isValidCycle } from "./lib/clarice-paths.ts";
import {
  openClariceDb,
  recomputeDerived,
  isTestAccount,
  DEFAULT_DB_PATH,
} from "./lib/clarice-db.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DATA_DIR = resolve(ROOT, "data/clarice-subscribers");

/** Forma de um diretório de ciclo (validação semântica via isValidCycle). */
const CYCLE_FORMAT_RE = /^\d{4}-\d{2}$/;
/** Bucket MV implícito no sufixo do arquivo. */
const MV_FILE_RE = /^mv-export-.*-(verified|rejected|unknown)\.csv$/;

function isoOrNull(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Stripe → upsert identidade + 5 campos + cohort (#2857 fase C — cutover)
// ---------------------------------------------------------------------------

function ingestStripe(
  db: ReturnType<typeof openClariceDb>,
  dataDir: string,
  now: Date,
): {
  kept: number;
  disputed: number;
  excluded_audit_only: number;
  test_accounts_excluded: number;
  skipped_files: string[];
} {
  const { kept: allKept, excluded, skippedFiles } = buildUniverse(dataDir, now);
  // #2895: conta de teste do editor (vjpixel+test*@gmail.com) — exclusão
  // PERMANENTE na ingestão, nunca inserida/mantida no store (mesmo vindo do
  // universo Stripe completo). Filtrado ANTES do upsert — diferente de
  // `excluded`/disputados (que entram no store marcados inelegíveis), test
  // account não entra de forma alguma.
  const kept = allKept.filter((m) => !isTestAccount(m.email));
  const testAccountsInKept = allKept.length - kept.length;
  // #2857 fase C: escreve `cohort` (não mais `tier` — a coluna vira legado
  // read-only, ver clarice-db.ts) DIRETO a partir do cohort que o merge já
  // computou com o contexto Stripe COMPLETO (status+payment_count+total_spend
  // +created — este store só persiste os 5 campos abaixo, sem payment_count/
  // total_spend, então só o merge pode distinguir payer/lead com segurança).
  // Sobrescrito em TODO rebuild — sempre fresco pra qualquer linha presente no
  // export Stripe atual; `recomputeDerived` só faz backfill quando ausente.
  const upsert = db.prepare(
    `INSERT INTO clarice_users
       (email, name, stripe_ids, status, created, delinquent, dispute_losses, refunded_volume, cohort, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name = excluded.name,
       stripe_ids = excluded.stripe_ids,
       status = excluded.status,
       created = excluded.created,
       delinquent = excluded.delinquent,
       dispute_losses = excluded.dispute_losses,
       refunded_volume = excluded.refunded_volume,
       cohort = excluded.cohort,
       updated_at = excluded.updated_at`,
  );
  const nowIso = now.toISOString();
  db.exec("BEGIN");
  for (const m of kept) {
    upsert.run(
      m.email,
      m.name,
      JSON.stringify(m.stripe_ids ?? []),
      m.status,
      isoOrNull(m.created),
      m.delinquent == null ? null : m.delinquent ? 1 : 0,
      m.dispute_losses,
      m.refunded_volume,
      m.cohort,
      nowIso,
    );
  }
  // Disputados (chargeback) são clientes REAIS — entram no store marcados como
  // inelegíveis (recomputeDerived → ineligible_reason='dispute'), não somem
  // (#2647). cohort=null: não recebem 1º envio classificado como payer/lead
  // direto (mesmo espírito do antigo tier=null) — `recomputeDerived` ainda
  // faz o backfill via `computeCohort` (fallback, deriva do `created` se
  // presente) pra ficarem visíveis/auditáveis num cohort informativo.
  // #2895: mesma exclusão de test account, aplicada aos disputados (chargeback
  // é improvável numa conta de teste, mas mantém a garantia total — nenhum
  // vjpixel+test* entra no store por NENHUM caminho de ingestStripe).
  const disputedCandidates = excluded.filter((e) => e.reason === "dispute_losses");
  const disputed = disputedCandidates.filter((e) => !isTestAccount(e.email));
  const testAccountsInDisputed = disputedCandidates.length - disputed.length;
  for (const m of disputed) {
    upsert.run(
      m.email,
      m.name,
      JSON.stringify(m.stripe_ids ?? []),
      m.status,
      isoOrNull(m.created),
      m.delinquent == null ? null : m.delinquent ? 1 : 0,
      m.dispute_losses,
      m.refunded_volume,
      null,
      nowIso,
    );
  }
  db.exec("COMMIT");
  // `excluded_audit_only` exclui os disputados (que ENTRAM no store como
  // inelegíveis) → conta só os realmente ausentes (invalid/low-quality/not_clrc_pt),
  // sem double-count com `disputed` (#2649 review).
  return {
    kept: kept.length,
    disputed: disputed.length,
    excluded_audit_only: excluded.length - disputed.length - testAccountsInDisputed,
    test_accounts_excluded: testAccountsInKept + testAccountsInDisputed,
    skipped_files: skippedFiles,
  };
}

// ---------------------------------------------------------------------------
// MV → upsert colunas mv_* a partir dos mv-export-*.csv de cada ciclo
// ---------------------------------------------------------------------------

export function ingestMv(
  db: ReturnType<typeof openClariceDb>,
  dataDir: string,
): { rows: number; files: number; skipped: string[] } {
  // INSERT OR IGNORE garante a linha (caso o email não tenha vindo do Stripe),
  // depois UPDATE só nas colunas mv_* — nunca toca Stripe/Brevo/derivados.
  // mv_subresult fica de fora: o verify-emails-mv só escreve RESULT/QUALITY/CODE
  // nos CSVs (não persiste subresult), então a coluna fica NULL até a fonte expor.
  const ensure = db.prepare(
    "INSERT OR IGNORE INTO clarice_users (email) VALUES (?)",
  );
  const update = db.prepare(
    `UPDATE clarice_users SET
       mv_result = ?, mv_resultcode = ?, mv_quality = ?, mv_bucket = ?,
       mv_last_verified_at = ?, mv_cycle = ?
     WHERE email = ?`,
  );

  let rows = 0;
  let files = 0;
  const skipped: string[] = [];
  const dirs = readdirSync(dataDir).filter((d) => {
    try {
      return statSync(resolve(dataDir, d)).isDirectory();
    } catch {
      return false;
    }
  });
  // isValidCycle valida forma + semântica (envio = conteúdo+1); um dir tipo
  // `2605-08` ou `2605-00` tem forma de ciclo mas é mislabel → ignorar com aviso,
  // não ingerir silenciosamente (#2649 review). Ordenado asc pra o ciclo
  // cronologicamente mais novo ser processado por último (UPDATE later wins) —
  // re-verificação recente sobrescreve a antiga.
  const cycles = dirs.filter((d) => isValidCycle(d)).sort();
  const mislabeled = dirs.filter(
    (d) => CYCLE_FORMAT_RE.test(d) && !isValidCycle(d),
  );
  if (mislabeled.length > 0) {
    console.error(
      `⚠️  ${mislabeled.length} dir(s) com forma de ciclo mas semântica inválida ` +
        `(ignorados — envio deve ser conteúdo+1): ${mislabeled.join(", ")}`,
    );
  }

  db.exec("BEGIN");
  for (const cycle of cycles) {
    const cycleDir = resolve(dataDir, cycle);
    // sort() pra ordem de aplicação determinística dentro do ciclo também.
    const mvFiles = readdirSync(cycleDir)
      .filter((f) => MV_FILE_RE.test(f))
      .sort();
    for (const f of mvFiles) {
      const path = resolve(cycleDir, f);
      // statSync E readFileSync no MESMO try: um placeholder OneDrive pode falhar
      // em qualquer um dos dois; nenhum pode escapar e abortar a transação aberta
      // (BEGIN acima) — senão TODO o MV já acumulado é descartado no rollback.
      let verifiedAt: string;
      let content: string;
      try {
        verifiedAt = statSync(path).mtime.toISOString();
        content = readFileSync(path, "utf8");
      } catch (e) {
        console.error(`⚠️  pulando MV ilegível ${cycle}/${f}: ${(e as Error).message}`);
        skipped.push(`${cycle}/${f}`);
        continue;
      }
      const parsed = Papa.parse<Record<string, string>>(content, {
        header: true,
        skipEmptyLines: true,
      });
      for (const row of parsed.data) {
        const email = (row["email"] || row["Email"] || "").trim().toLowerCase();
        if (!email) continue;
        // #2895: conta de teste do editor — nunca insere/mantém no store,
        // mesmo vinda de um CSV MV verificado.
        if (isTestAccount(email)) continue;
        const result = (row["MV_RESULT"] || "").trim().toLowerCase() || null;
        const codeRaw = (row["MV_CODE"] || "").trim();
        const code = codeRaw ? Number(codeRaw) : null;
        const quality = (row["MV_QUALITY"] || "").trim() || null;
        const bucket = classifyResult(result);
        ensure.run(email);
        update.run(
          result,
          code != null && Number.isFinite(code) ? code : null,
          quality,
          bucket,
          verifiedAt,
          cycle,
          email,
        );
        rows++;
      }
      files++;
    }
  }
  db.exec("COMMIT");
  return { rows, files, skipped };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function main(argv: string[] = process.argv.slice(2)): void {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const dataDir = getArg(argv, "data-dir") || DATA_DIR;
  const now = new Date();

  if (!existsSync(dataDir)) {
    console.error(`❌ data-dir não existe: ${dataDir}`);
    console.error(
      "   (data/ mora no OneDrive como junction — ver CLAUDE.md setup)",
    );
    process.exit(1);
  }

  const db = openClariceDb(dbPath);

  console.error(`📦 ingerindo Stripe (universo completo)…`);
  const stripe = ingestStripe(db, dataDir, now);
  console.error(
    `   kept=${stripe.kept} · disputed=${stripe.disputed} (inelegível no store) · ` +
      `excluded_audit_only=${stripe.excluded_audit_only} · ` +
      `test_accounts_excluded=${stripe.test_accounts_excluded} (#2895)`,
  );
  if (stripe.skipped_files.length > 0) {
    console.error(
      `⚠️  STORE PARCIAL: ${stripe.skipped_files.length} CSV(s) de fonte ilegíveis ` +
        `(${stripe.skipped_files.join(", ")}) — faltam os contatos desses arquivos. ` +
        `Hidrate-os (OneDrive) e re-rode pra completar.`,
    );
  }

  console.error(`🔎 ingerindo MV (mv-export-* por ciclo)…`);
  const mv = ingestMv(db, dataDir);
  console.error(`   ${mv.rows} emails de ${mv.files} arquivo(s)`);
  if (mv.skipped.length > 0) {
    console.error(
      `⚠️  MV PARCIAL: ${mv.skipped.length} arquivo(s) MV ilegíveis ` +
        `(${mv.skipped.join(", ")}) — verificação desses ciclos fora do store. ` +
        `Hidrate-os (OneDrive) e re-rode.`,
    );
  }

  // Brevo nunca sincronizado? (toda coluna de engajamento/supressão no default)
  const brevoSynced =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM clarice_users
            WHERE opens_count > 0 OR sends_count > 0
               OR email_blacklisted = 1 OR unsubscribed = 1
               OR hard_bounced = 1 OR complained = 1`,
        )
        .get() as { n: number }
    ).n > 0;

  if (!brevoSynced) {
    console.error(
      `⚠️  Brevo NÃO sincronizado: supressão de descadastro/bounce não está no ` +
        `store. \`send_eligible=1\` reflete só MV + dispute — NÃO é gate de envio ` +
        `suficiente. Rode \`npx tsx scripts/clarice-sync-brevo.ts\` pra completar.`,
    );
  }

  console.error(`⚙️  recomputando priority_points + send_eligible…`);
  const derived = recomputeDerived(db);

  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM clarice_users").get() as { n: number }
  ).n;
  const eligible = (
    db
      .prepare("SELECT COUNT(*) AS n FROM clarice_users WHERE send_eligible = 1")
      .get() as { n: number }
  ).n;
  const optin = (
    db.prepare("SELECT COUNT(*) AS n FROM priority_optin").get() as {
      n: number;
    }
  ).n;

  db.close();

  console.log(
    JSON.stringify(
      {
        db: dbPath,
        users_total: total,
        send_eligible: eligible,
        // send_eligible só é autoritativo após o sync do Brevo (#2647)
        send_eligible_authoritative: brevoSynced,
        brevo_synced: brevoSynced,
        priority_optin: optin,
        stripe,
        mv,
        derived_recomputed: derived,
      },
      null,
      2,
    ),
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
