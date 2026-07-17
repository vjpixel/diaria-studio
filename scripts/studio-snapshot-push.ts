#!/usr/bin/env node
/**
 * studio-snapshot-push.ts (#3565)
 *
 * Espelho READ-ONLY do Studio UI local: monta um snapshot COMPACTO do
 * estado essencial (edição corrente + stage + contagem de gates pendentes +
 * resumo da última rodada overnight/develop + timestamp) a partir de
 * `studio-state.ts` (`buildStudioState` — o MESMO agregador que já alimenta
 * `GET /api/state` do studio-server, reusado aqui, não reimplementado) e faz
 * push pra chave `studio:snapshot` do MESMO KV namespace já bindado ao
 * worker `diaria-dashboard` (binding `DASHBOARD_DATA`, ver
 * `workers/diaria-dashboard/wrangler.toml`) — evita um 8º worker/namespace
 * (a issue #3565 pede explicitamente reusar o dashboard existente em vez de
 * criar infraestrutura nova).
 *
 * Mesma disciplina "sem PII" de `clarice-db-summary.ts` (chave
 * `contacts:summary`): o snapshot é só números/enums/rótulos de data —
 * nenhum email, token, nem o texto de uma pergunta `AskUserQuestion` (só a
 * CONTAGEM de gates pendentes). Ver `buildStudioSnapshot` abaixo e o teste
 * dedicado em `test/studio-snapshot-push.test.ts` ("Snapshot sem PII",
 * aceite da issue).
 *
 * Fail-soft total: `pushStudioSnapshot` NUNCA lança — toda falha (rede,
 * Cloudflare, credenciais ausentes) vira `result.error`/`result.skippedReason`.
 * Isso é o que permite `studio-ui/studio-snapshot-watcher.ts` chamar esta
 * função periodicamente de dentro do studio-server sem risco de uma falha de
 * push derrubar a sessão local do editor.
 *
 * Uso (CLI):
 *   npx tsx scripts/studio-snapshot-push.ts [--root-dir <dir>] [--dry-run] [--kv-namespace-id ID]
 *   --dry-run: monta e imprime o snapshot, NÃO grava no KV.
 *
 * Env (só p/ gravar no KV; --dry-run dispensa):
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_WORKERS_TOKEN,
 *   DASHBOARD_KV_NAMESPACE_ID — MESMO env var já usado por
 *   `build-diaria-dashboard-data.ts --push` (mesmo worker, mesmo namespace;
 *   ver `workers/diaria-dashboard/wrangler.toml` pro ID de produção).
 *
 * Stdout: o JSON do snapshot. Stderr: progresso/erros.
 */

import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { parseArgs as parseCliArgs, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { buildStudioState, type StudioState } from "./studio-ui/studio-state.ts";
import type {
  StudioSnapshot,
  StudioSnapshotPlanSummary,
} from "../workers/diaria-dashboard/src/types.ts";

export type { StudioSnapshot, StudioSnapshotPlanSummary };

export const STUDIO_SNAPSHOT_KV_KEY = "studio:snapshot";

function summarizePlan(
  plan: StudioState["overnight"] | StudioState["develop"],
): StudioSnapshotPlanSummary | null {
  if (!plan) return null;
  return { sessionId: plan.sessionId, totalIssues: plan.totalIssues, counts: plan.counts };
}

/**
 * Monta o snapshot compacto a partir de um `StudioState` já calculado —
 * função PURA (sem I/O), testável sem tocar disco/rede. É a ÚNICA superfície
 * que decide o que entra/fica de fora do payload exposto ao mundo — todo
 * campo aqui é número/enum/rótulo de data, nunca PII (ver header do
 * arquivo). Em particular: NÃO inclui `state.rootDir` (path absoluto local,
 * pode vazar username da máquina do editor) nem `state.chatPermissionsPending`
 * completo (que carrega `firstQuestion` — só a CONTAGEM (`.length`) sai
 * daqui).
 */
export function buildStudioSnapshot(state: StudioState, now: Date = new Date()): StudioSnapshot {
  const currentEditionSummary =
    state.editions.find((e) => e.edition === state.currentEdition) ?? null;
  return {
    generated_at: now.toISOString(),
    current_edition: state.currentEdition,
    current_stage: currentEditionSummary?.currentStage ?? "unknown",
    stage_label: currentEditionSummary?.stageLabel ?? "Desconhecido",
    gates_pending_count: state.gatesPending.length,
    chat_gates_pending_count: state.chatPermissionsPending.length,
    overnight: summarizePlan(state.overnight),
    develop: summarizePlan(state.develop),
  };
}

export interface PushStudioSnapshotResult {
  snapshot: StudioSnapshot;
  pushed: boolean;
  /** Definido quando `pushed=false` por uma falha REAL (rede/Cloudflare) —
   * ausente quando `pushed=false` só por credenciais faltando (caso comum
   * em dev local sem CLOUDFLARE_* configurado, ou por --dry-run). */
  error?: string;
  /** Motivo de não ter tentado o push. */
  skippedReason?: "missing-credentials" | "dry-run";
}

/**
 * Monta + (opcionalmente) faz push do snapshot. NUNCA lança — todo erro vira
 * `result.error` (ver header do arquivo: chamado também pelo watcher
 * periódico do studio-server, onde uma exceção não tratada derrubaria a
 * sessão local do editor — fail-soft é invariante, não best-effort).
 */
export async function pushStudioSnapshot(
  rootDir: string,
  opts: {
    now?: () => Date;
    dryRun?: boolean;
    accountId?: string;
    token?: string;
    kvNamespaceId?: string;
  } = {},
): Promise<PushStudioSnapshotResult> {
  const state = buildStudioState(rootDir);
  const snapshot = buildStudioSnapshot(state, opts.now ? opts.now() : new Date());

  if (opts.dryRun) {
    return { snapshot, pushed: false, skippedReason: "dry-run" };
  }

  const accountId = opts.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = opts.token ?? process.env.CLOUDFLARE_WORKERS_TOKEN;
  const kvNamespaceId = opts.kvNamespaceId ?? process.env.DASHBOARD_KV_NAMESPACE_ID;

  if (!accountId || !token || !kvNamespaceId) {
    return { snapshot, pushed: false, skippedReason: "missing-credentials" };
  }

  try {
    await uploadTextToWorkerKV(JSON.stringify(snapshot), STUDIO_SNAPSHOT_KV_KEY, {
      kvNamespaceId,
      accountId,
      token,
      contentType: "application/json",
    });
    return { snapshot, pushed: true };
  } catch (err) {
    return { snapshot, pushed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadProjectEnv();
  const { values } = parseCliArgs(argv);
  const rootDir = values["root-dir"] ? resolve(values["root-dir"]) : process.cwd();
  const dryRun = hasFlag(argv, "dry-run");
  const kvNamespaceId = values["kv-namespace-id"];

  const result = await pushStudioSnapshot(rootDir, { dryRun, kvNamespaceId });
  console.log(JSON.stringify(result.snapshot, null, 2));

  if (result.pushed) {
    console.error(`[studio-snapshot-push] KV atualizado: ${STUDIO_SNAPSHOT_KV_KEY}.`);
    return;
  }
  if (result.skippedReason === "dry-run") {
    console.error("[studio-snapshot-push] --dry-run: KV não atualizado.");
    return;
  }
  if (result.skippedReason === "missing-credentials") {
    console.error(
      "[studio-snapshot-push] CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN/DASHBOARD_KV_NAMESPACE_ID " +
        "ausentes — use --dry-run ou configure as credenciais (env ou --kv-namespace-id).",
    );
    process.exit(1);
  }
  console.error(`[studio-snapshot-push] erro ao fazer push: ${result.error}`);
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[studio-snapshot-push]", e);
    process.exit(1);
  });
}
