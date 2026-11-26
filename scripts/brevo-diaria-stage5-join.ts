#!/usr/bin/env node
/**
 * scripts/brevo-diaria-stage5-join.ts (#14037)
 *
 * Junta o resultado do dispatch Brevo diária que a Etapa 5 lançou em
 * background (`brevo-diaria-stage5-dispatch.ts` com `run_in_background`, logo
 * depois do §5c-pre). Roda antes do sentinel do §5h: lê
 * `_internal/05-brevo-stage5-dispatch.json` até o registro virar `done`.
 *
 * Saída (stdout, 1 linha JSON): o mesmo JSON do dispatch
 * (`{status: "ok"|"already_done"|"skipped"|"failed", ...}`) acrescido de
 * `join` (`done`, `process_died`, `still_running`, `not_launched`, `invalid`)
 * e `exit_code` do dispatch quando houver. Nos casos sem resultado do
 * dispatch, `status: "failed"` com `step` e `reason`, nunca um sucesso
 * presumido.
 *
 * Exit: 0 = `ok`/`already_done`/`skipped`; 1 = `failed`, processo morto ou
 * registro ilegível; 3 = registro ausente (dispatch não lançado);
 * 4 = ainda rodando quando `--wait-seconds` acabou (re-rodar o join: o
 * processo está vivo). Todos fail-soft para o Stage 5, como o dispatch.
 *
 * Uso:
 *   npx tsx scripts/brevo-diaria-stage5-join.ts --edition-dir <dir> [--wait-seconds 540] [--poll-seconds 5]
 */
import { getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { tryResolveEditionDirArg } from "./lib/resolve-edition-dir-arg.ts";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentHost,
  decideJoin,
  isPidAlive,
  joinExitCode,
  readBrevoStage5Record,
  type JoinDecision,
  type ReadRecordOutcome,
} from "./lib/brevo-stage5-background.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Tolerância para o registro ainda não existir logo depois do lançamento. */
export const MISSING_GRACE_MS = 30_000;

export interface JoinDeps {
  read: () => ReadRecordOutcome;
  host: string;
  isPidAlive: (pid: number) => boolean;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type JoinOutput = { join: string; status: string; [k: string]: unknown };

/** Pura: monta a saída do join a partir da decisão final. */
export function buildJoinOutput(decision: JoinDecision | { kind: "still_running"; startedAt?: string }): JoinOutput {
  switch (decision.kind) {
    case "done":
      return { ...decision.record.result, join: "done", exit_code: decision.record.exit_code, finished_at: decision.record.finished_at };
    case "process_died":
      return {
        join: "process_died",
        status: "failed",
        step: "background",
        reason: `processo do dispatch (pid ${decision.record.pid}, iniciado ${decision.record.started_at}) morreu sem gravar o resultado — conferir no painel Brevo se o rascunho foi criado antes de re-rodar o dispatch.`,
      };
    case "still_running":
      return {
        join: "still_running",
        status: "running",
        reason: `dispatch ainda rodando${decision.startedAt ? ` (iniciado ${decision.startedAt})` : ""} — re-rodar o join.`,
      };
    case "not_launched":
      return {
        join: "not_launched",
        status: "failed",
        step: "background",
        reason: "registro _internal/05-brevo-stage5-dispatch.json ausente — o dispatch Brevo não foi lançado ou não chegou a iniciar.",
      };
    case "invalid":
      return { join: "invalid", status: "failed", step: "background", reason: `registro ilegível: ${decision.error}` };
    case "wait":
      return { join: "still_running", status: "running", reason: "dispatch ainda rodando — re-rodar o join." };
  }
}

export async function runJoin(
  deps: JoinDeps,
  opts: { waitMs: number; pollMs: number },
): Promise<{ output: JoinOutput; exitCode: number }> {
  const start = deps.nowMs();
  for (;;) {
    const outcome = deps.read();
    const elapsedMs = deps.nowMs() - start;
    const decision = decideJoin(outcome, {
      elapsedMs,
      missingGraceMs: Math.min(MISSING_GRACE_MS, opts.waitMs),
      host: deps.host,
      isPidAlive: deps.isPidAlive,
    });
    if (decision.kind !== "wait") return { output: buildJoinOutput(decision), exitCode: joinExitCode(decision) };
    if (elapsedMs >= opts.waitMs) {
      const startedAt = outcome.kind === "ok" ? outcome.record.started_at : undefined;
      const final = { kind: "still_running" as const, startedAt };
      return { output: buildJoinOutput(final), exitCode: joinExitCode(final) };
    }
    await deps.sleep(opts.pollMs);
  }
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const editionDirArg = getStringArg(argv, "edition-dir");
  if (!editionDirArg) {
    process.stderr.write("uso: npx tsx scripts/brevo-diaria-stage5-join.ts --edition-dir <dir> [--wait-seconds 540] [--poll-seconds 5]\n");
    process.exit(2);
  }
  const resolvedArg = tryResolveEditionDirArg(editionDirArg, { root: ROOT });
  if (!resolvedArg.ok) {
    console.log(JSON.stringify({ join: "invalid", status: "failed", step: "args", reason: resolvedArg.error }));
    process.exitCode = 1;
  } else {
    const editionDir = resolvedArg.editionDir;
    const waitSeconds = getIntArg(argv, "wait-seconds", { min: 0 }) ?? 540;
    const pollSeconds = getIntArg(argv, "poll-seconds", { min: 1 }) ?? 5;
    const { output, exitCode } = await runJoin(
      {
        read: () => readBrevoStage5Record(editionDir),
        host: currentHost(),
        isPidAlive,
        nowMs: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      { waitMs: waitSeconds * 1000, pollMs: pollSeconds * 1000 },
    );
    if (output.join === "still_running") process.stderr.write(`[brevo-diaria join] ${output.reason}\n`);
    console.log(JSON.stringify(output));
    process.exitCode = exitCode;
  }
}
