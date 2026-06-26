/**
 * clarice-mv-status.ts (#2609)
 *
 * Pré-computa o status de verificação MillionVerifier por grupo de contatos e
 * grava no KV do worker `clarice-dashboard` sob `mv:status`. O worker só lê e
 * renderiza o JSON — nunca varre o filesystem em runtime.
 *
 * Semântica por grupo:
 *   - T01 (assinantes ativos, verify_risk 1): status="t01" — N/A, validado por
 *     pagamento Stripe. NUNCA "pending".
 *   - T02+ e cohorts mensais: "verified" quando existe mv-export-{grupo}-verified.csv
 *     no diretório do ciclo; "pending" quando não existe.
 *
 * O script varre data/clarice-subscribers/ por subdiretórios de ciclo ({YYMM}-{MM})
 * e por mv-export-*-verified.csv dentro de cada um. A contagem de linhas (excluindo
 * header) determina os contadores verified/rejected/unknown.
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID     obrigatório p/ upload KV
 *   CLOUDFLARE_WORKERS_TOKEN  obrigatório p/ upload KV (permissão Workers KV)
 *
 * Uso CLI:
 *   npx tsx scripts/clarice-mv-status.ts [--dry-run]
 *
 *   --dry-run     computa e imprime o JSON, mas NÃO grava no KV.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { CLARICE_BASE, isValidCycle } from "./lib/clarice-paths.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag } from "./lib/cli-args.ts";
import type { MvStatus, MvGroupStatus } from "../workers/brevo-dashboard/src/index.ts";

loadProjectEnv();

export const DASHBOARD_KV_NAMESPACE_ID = "2f87d65d735c499ab8f465774d0167e2";
export const MV_STATUS_KV_KEY = "mv:status";

/** Conta linhas de CSV excluindo o header (retorna 0 se arquivo não existe). */
function countCsvRows(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const lines = readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  return Math.max(0, lines.length - 1); // -1 para o header
}

/** Slug do grupo a partir do nome do arquivo mv-export-{grupo}-verified.csv. */
function groupFromVerifiedFile(fileName: string): string {
  // mv-export-t02-ex-assinantes-verified.csv → t02-ex-assinantes
  return fileName.replace(/^mv-export-/, "").replace(/-verified\.csv$/, "");
}

/**
 * Determina se o grupo é T01 (assinantes ativos — verify_risk 1).
 * Padrão: prefixo "t01" (ex: "t01-assinantes-ativos").
 */
function isT01Group(group: string): boolean {
  return group.startsWith("t01");
}

/** Computa o status MV a partir do filesystem local. Pura/testável. */
export function computeMvStatus(
  clariceBase: string = CLARICE_BASE,
  now: Date = new Date(),
): MvStatus {
  const groups: MvGroupStatus[] = [];

  if (!existsSync(clariceBase)) {
    return { generatedAt: now.toISOString(), groups };
  }

  const entries = readdirSync(clariceBase, { withFileTypes: true });

  // Pré-computar grupos T02+ a partir de stripe-export-t{02+}-*.csv no base dir.
  // Usado para emitir status "pending" quando ciclo existe mas verificação ainda não rodou.
  const t02PlusBaseGroups = entries
    .filter(
      (e) =>
        !e.isDirectory() &&
        e.name.startsWith("stripe-export-t") &&
        !e.name.startsWith("stripe-export-t01") &&
        e.name.endsWith(".csv"),
    )
    .map((e) => e.name.replace(/^stripe-export-/, "").replace(/\.csv$/, ""));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const cycle = entry.name;
    if (!isValidCycle(cycle)) continue;

    const cycleDir = resolve(clariceBase, cycle);
    const cycleEntries = readdirSync(cycleDir);

    // Encontrar todos os mv-export-*-verified.csv neste ciclo
    const verifiedFiles = cycleEntries.filter(
      (f) => f.startsWith("mv-export-") && f.endsWith("-verified.csv"),
    );

    if (verifiedFiles.length === 0) {
      // Ciclo existe mas verificação ainda não rodou — emitir "pending" para grupos T02+ conhecidos.
      for (const group of t02PlusBaseGroups) {
        groups.push({ group, cycle, status: "pending", verifiedAt: null, verified: 0, rejected: 0, unknown: 0 });
      }
      continue;
    }

    for (const vFile of verifiedFiles) {
      const group = groupFromVerifiedFile(vFile);
      const verifiedPath = resolve(cycleDir, vFile);
      const rejectedPath = resolve(cycleDir, `mv-export-${group}-rejected.csv`);
      const unknownPath = resolve(cycleDir, `mv-export-${group}-unknown.csv`);

      if (isT01Group(group)) {
        groups.push({ group, cycle, status: "t01", verifiedAt: null, verified: 0, rejected: 0, unknown: 0 });
      } else {
        const mtime = statSync(verifiedPath).mtime.toISOString();
        const verified = countCsvRows(verifiedPath);
        const rejected = countCsvRows(rejectedPath);
        const unknown = countCsvRows(unknownPath);
        groups.push({ group, cycle, status: "verified", verifiedAt: mtime, verified, rejected, unknown });
      }
    }
  }

  // Adicionar grupos T01 da base (stripe-export-t01-*.csv) que não têm entrada ainda.
  // Usa entries já lida (evita segundo readdirSync no mesmo diretório).
  for (const e of entries) {
    if (e.isDirectory() || !e.name.startsWith("stripe-export-t01") || !e.name.endsWith(".csv")) continue;
    const group = e.name.replace(/^stripe-export-/, "").replace(/\.csv$/, "");
    const alreadyPresent = groups.some((g) => g.group === group && g.status === "t01");
    if (!alreadyPresent) {
      groups.push({ group, cycle: "—", status: "t01", verifiedAt: null, verified: 0, rejected: 0, unknown: 0 });
    }
  }

  return { generatedAt: now.toISOString(), groups };
}

async function main(): Promise<void> {
  const isDryRun = hasFlag(process.argv, "dry-run");
  console.log(`[clarice-mv-status] scanning ${CLARICE_BASE}…`);

  const status = computeMvStatus();
  const json = JSON.stringify(status, null, 2);

  console.log(`[clarice-mv-status] ${status.groups.length} grupos encontrados.`);
  console.log(json);

  if (isDryRun) {
    console.log("[clarice-mv-status] --dry-run: não gravou no KV.");
    return;
  }

  await uploadTextToWorkerKV(json, MV_STATUS_KV_KEY, {
    kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_WORKERS_TOKEN ?? "",
  });
  console.log(`[clarice-mv-status] KV atualizado: ${MV_STATUS_KV_KEY}.`);
}

// CLI guard — não executar ao ser importado em testes
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((e) => {
    console.error("[clarice-mv-status] erro:", e);
    process.exit(1);
  });
}
