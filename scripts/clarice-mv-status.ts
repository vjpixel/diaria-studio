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
import { pathToFileURL } from "node:url";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { CLARICE_BASE, isValidCycle } from "./lib/clarice-paths.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag } from "./lib/cli-args.ts";
import { DASHBOARD_KV_NAMESPACE_ID } from "./lib/dashboard-kv.ts";

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

    const verifiedGroups = new Set<string>();
    for (const vFile of verifiedFiles) {
      const group = groupFromVerifiedFile(vFile);
      verifiedGroups.add(group);
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

    // Emitir "pending" para grupos T02+ conhecidos (da base) que NÃO têm arquivo verificado
    // neste ciclo. Cobre tanto o caso de ciclo sem nenhum verificado quanto o de verificação
    // parcial (ex: t02 verificado mas t03 ainda não) — senão grupos não-verificados sumiam.
    for (const group of t02PlusBaseGroups) {
      if (verifiedGroups.has(group)) continue;
      groups.push({ group, cycle, status: "pending", verifiedAt: null, verified: 0, rejected: 0, unknown: 0 });
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

  // Guard: nunca sobrescrever o KV de produção com payload vazio. Em máquina sem a junction
  // OneDrive (CLARICE_BASE ausente), computeMvStatus retorna groups:[] — gravar isso apagaria
  // os dados válidos e todo visitante do dashboard veria a tabela vazia. Abortar com erro.
  if (status.groups.length === 0) {
    console.error(
      `[clarice-mv-status] 0 grupos computados (CLARICE_BASE existe? ${CLARICE_BASE}). ` +
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
