#!/usr/bin/env node
/**
 * scripts/brevo-diaria-stage5-join.ts (#14037)
 *
 * Junta o resultado do dispatch Brevo diária que a Etapa 5 lançou em
 * background (`brevo-diaria-stage5-dispatch.ts` com `run_in_background`, logo
 * depois do §5c-pre). Roda antes do sentinel do §5h e antes de QUALQUER halt
 * posterior ao lançamento: lê `_internal/05-brevo-stage5/{launch_id}.json` até
 * o registro deste lançamento virar `done`.
 *
 * Saída (stdout, 1 linha JSON): o mesmo JSON do dispatch
 * (`{status: "ok"|"already_done"|"skipped"|"failed", ...}`) acrescido de
 * `join` (`done`, `process_died`, `still_running`, `timeout`, `not_launched`,
 * `invalid`) e `exit_code` do dispatch quando houver. Nos casos sem resultado
 * do dispatch, `status: "failed"` com `step` e `reason`, nunca um sucesso
 * presumido. Registros de OUTROS lançamentos da edição só aparecem em
 * `other_launches`, nunca como resultado.
 *
 * Exit: 0 = `ok`/`already_done`/`skipped`; 1 = `failed`, processo morto
 * (dispatch E worker), registro ilegível ou teto total estourado
 * (`join: "timeout"`, padrão 30 min desde o `started_at` gravado,
 * `--max-total-minutes`); 3 = registro deste lançamento ausente; 4 = ainda
 * rodando quando `--wait-seconds` acabou e dentro do teto (re-rodar o join).
 * Com o teto, re-rodar nunca vira loop. Registro ausente sempre ganha a
 * tolerância mínima de 30 s, mesmo com `--wait-seconds 0`.
 *
 * Uso:
 *   npx tsx scripts/brevo-diaria-stage5-join.ts --edition-dir <dir> --launch-id <id> [--wait-seconds 540] [--poll-seconds 5] [--max-total-minutes 30]
 */
import { getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { tryResolveEditionDirArg } from "./lib/resolve-edition-dir-arg.ts";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_TOTAL_MS,
  currentHost,
  decideJoin,
  isPidAlive,
  joinExitCode,
  listBrevoStage5Records,
  readBrevoStage5Record,
  readWorkerPid,
  type BrevoStage5Record,
  type JoinDecision,
  type ReadRecordOutcome,
} from "./lib/brevo-stage5-background.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Tolerância para o registro ainda não existir logo depois do lançamento. */
export const MISSING_GRACE_MS = 30_000;

/** Leituras ilegíveis seguidas antes de o join desistir (as anteriores podem ser transitórias). */
export const INVALID_STREAK_LIMIT = 3;

export interface JoinDeps {
  /** Registro DESTE lançamento. */
  read: () => ReadRecordOutcome;
  /** Todos os registros da edição (para relatar os outros lançamentos). */
  listAll: () => BrevoStage5Record[];
  workerPidOf: (launchId: string) => number | undefined;
  host: string;
  isPidAlive: (pid: number) => boolean;
  /** Relógio de parede (epoch ms): mede a espera e o teto total desde o `started_at`. */
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  launchId: string;
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
        reason:
          `processo do dispatch (pid ${decision.record.pid}${decision.workerPid !== undefined ? `, worker pid ${decision.workerPid}` : ""}, ` +
          `iniciado ${decision.record.started_at}) morreu sem gravar o resultado — conferir no painel Brevo se o rascunho foi criado antes de re-rodar o dispatch.`,
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
        reason: decision.others
          ? `registro deste lançamento ausente; a edição tem outros lançamentos (${decision.others.map((o) => `${o.launch_id}: ${o.state}`).join(", ")}), que não contam como resultado deste — o dispatch deste lançamento não iniciou (ver busy no stdout dele).`
          : "registro deste lançamento ausente — o dispatch Brevo não foi lançado ou não chegou a iniciar.",
        ...(decision.others ? { other_launches: decision.others } : {}),
      };
    case "timeout":
      return {
        join: "timeout",
        status: "failed",
        step: "background",
        pid: decision.record.pid,
        reason: `dispatch Brevo rodando há ${Math.round(decision.totalMs / 60_000)} min (pid ${decision.record.pid}, iniciado ${decision.record.started_at}), acima do teto — falha do canal Brevo; conferir o processo (matar por PID) e o painel Brevo antes de re-rodar.`,
      };
    case "invalid":
      return { join: "invalid", status: "failed", step: "background", reason: `registro ilegível: ${decision.error}` };
    case "wait":
      return { join: "still_running", status: "running", reason: "dispatch ainda rodando — re-rodar o join." };
  }
}

export async function runJoin(
  deps: JoinDeps,
  opts: { waitMs: number; pollMs: number; maxTotalMs?: number },
): Promise<{ output: JoinOutput; exitCode: number }> {
  const start = deps.nowMs();
  let invalidStreak = 0;
  for (;;) {
    const outcome = deps.read();
    const elapsedMs = deps.nowMs() - start;
    const decision = decideJoin(outcome, {
      elapsedMs,
      // #14037: a tolerância de registro ausente nunca encolhe com --wait-seconds.
      missingGraceMs: MISSING_GRACE_MS,
      host: deps.host,
      isPidAlive: deps.isPidAlive,
      workerPidOf: deps.workerPidOf,
      launchId: deps.launchId,
      nowEpochMs: deps.nowMs(),
      maxTotalMs: opts.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS,
      others: outcome.kind === "ok" ? [] : deps.listAll(),
    });
    // Leitura ilegível pode ser transitória (no Windows o rename atômico do
    // gravador pode colidir com a leitura): só vira falha depois de
    // INVALID_STREAK_LIMIT leituras seguidas.
    invalidStreak = decision.kind === "invalid" ? invalidStreak + 1 : 0;
    const transientInvalid = decision.kind === "invalid" && invalidStreak < INVALID_STREAK_LIMIT && elapsedMs < opts.waitMs;
    if (decision.kind !== "wait" && !transientInvalid) {
      return { output: buildJoinOutput(decision), exitCode: joinExitCode(decision) };
    }
    // Registro ausente: espera pelo menos a tolerância, mesmo com wait menor.
    const inMissingGrace = outcome.kind === "missing" && elapsedMs < MISSING_GRACE_MS;
    if (elapsedMs >= opts.waitMs && !inMissingGrace) {
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
  const launchId = getStringArg(argv, "launch-id");
  if (!editionDirArg || !launchId) {
    process.stderr.write("uso: npx tsx scripts/brevo-diaria-stage5-join.ts --edition-dir <dir> --launch-id <id> [--wait-seconds 540] [--poll-seconds 5] [--max-total-minutes 30]\n");
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
    const maxTotalMinutes = getIntArg(argv, "max-total-minutes", { min: 1 }) ?? DEFAULT_MAX_TOTAL_MS / 60_000;
    const { output, exitCode } = await runJoin(
      {
        read: () => readBrevoStage5Record(editionDir, launchId),
        listAll: () => listBrevoStage5Records(editionDir),
        workerPidOf: (id) => readWorkerPid(editionDir, id),
        host: currentHost(),
        isPidAlive,
        nowMs: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        launchId,
      },
      { waitMs: waitSeconds * 1000, pollMs: pollSeconds * 1000, maxTotalMs: maxTotalMinutes * 60_000 },
    );
    if (output.join === "still_running") process.stderr.write(`[brevo-diaria join] ${output.reason}\n`);
    console.log(JSON.stringify(output));
    process.exitCode = exitCode;
  }
}
