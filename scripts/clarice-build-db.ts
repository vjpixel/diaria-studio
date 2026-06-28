#!/usr/bin/env node
/**
 * clarice-build-db.ts — (re)constrói o store único de usuários da Clarice (#2647).
 *
 * Consolida num SQLite (keyed por email) o que hoje está fragmentado e lossy:
 *   1. Stripe  → base completa (T01–T10) + 5 campos mantidos + tier, via
 *      `buildUniverse()` do merge (preserva sinal que os CSVs de tier descartam).
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
// Stripe → upsert identidade + 5 campos + tier
// ---------------------------------------------------------------------------

function ingestStripe(
  db: ReturnType<typeof openClariceDb>,
  dataDir: string,
  now: Date,
): { kept: number; disputed: number; excluded_audit_only: number } {
  const { kept, excluded } = buildUniverse(dataDir, now);
  const upsert = db.prepare(
    `INSERT INTO clarice_users
       (email, name, stripe_ids, status, created, delinquent, dispute_losses, refunded_volume, tier, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name = excluded.name,
       stripe_ids = excluded.stripe_ids,
       status = excluded.status,
       created = excluded.created,
       delinquent = excluded.delinquent,
       dispute_losses = excluded.dispute_losses,
       refunded_volume = excluded.refunded_volume,
       tier = excluded.tier,
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
      m.tier,
      nowIso,
    );
  }
  // Disputados (chargeback) são clientes REAIS — entram no store marcados como
  // inelegíveis (recomputeDerived → ineligible_reason='dispute'), não somem
  // (#2647). tier=null: não recebem 1º envio, mas ficam visíveis e auditáveis.
  // Os demais excluídos (invalid/disposable/test/role) são lixo → só no audit
  // CSV, fora do store de usuários.
  const disputed = excluded.filter((e) => e.reason === "dispute_losses");
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
    excluded_audit_only: excluded.length - disputed.length,
  };
}

// ---------------------------------------------------------------------------
// MV → upsert colunas mv_* a partir dos mv-export-*.csv de cada ciclo
// ---------------------------------------------------------------------------

function ingestMv(
  db: ReturnType<typeof openClariceDb>,
  dataDir: string,
): { rows: number; files: number } {
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
      const verifiedAt = statSync(path).mtime.toISOString();
      const parsed = Papa.parse<Record<string, string>>(
        readFileSync(path, "utf8"),
        { header: true, skipEmptyLines: true },
      );
      for (const row of parsed.data) {
        const email = (row["email"] || row["Email"] || "").trim().toLowerCase();
        if (!email) continue;
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
  return { rows, files };
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
      `excluded_audit_only=${stripe.excluded_audit_only}`,
  );

  console.error(`🔎 ingerindo MV (mv-export-* por ciclo)…`);
  const mv = ingestMv(db, dataDir);
  console.error(`   ${mv.rows} emails de ${mv.files} arquivo(s)`);

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
      `⚠️  Brevo NÃO sincronizado (follow-up #2647): supressão de ` +
        `descadastro/bounce não está no store. \`send_eligible=1\` reflete só ` +
        `MV + dispute — NÃO é gate de envio suficiente até o sync ao vivo rodar.`,
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
