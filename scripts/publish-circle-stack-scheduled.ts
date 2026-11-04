#!/usr/bin/env tsx
/**
 * publish-circle-stack-scheduled.ts (#11778)
 *
 * Envio AGENDADO do post semanal do Radar de Notícias Stack: task
 * `Diaria-Circle-Stack-Weekly-Publish` (segunda 06:00 BRT, servidor `300`,
 * `scripts/lib/scheduled-tasks.ts`). Lógica pura em `scripts/lib/circle-stack-schedule.ts`.
 *
 * Modos:
 *   (padrão)    execução da task: confere janela + aprovação, roda
 *               `publish-circle-stack.ts --publish-monday {AAMMDD} --publish`
 *               (em processo, sem `--force`, uma vez só) e manda e-mail ao
 *               editor com o resultado em TODOS os casos — Publicado, Ambíguo,
 *               Falhou ou Não enviado.
 *   --approve   grava a aprovação do ciclo (sha256 da seleção atual). Roda no
 *               fim do `/diaria-stack`, com o editor presente. Recusa seleção
 *               fora das regras do canal ou com título não revisado.
 *   --revoke    apaga a aprovação do ciclo (a task de segunda não envia).
 *
 * `--publish-monday AAMMDD` opcional. Sem ele: `--approve`/`--revoke` miram a
 * próxima segunda (a própria data, se hoje é segunda; `--approve` recusa a
 * segunda de hoje a partir das 06:00, #11877); a execução da task mira
 * a segunda de hoje ou a anterior e só envia se hoje FOR essa segunda.
 *
 * E-mail: `sendPushNotification` (`lib/push-notify.ts`) direto, não o
 * `notifyEditor`: a política de e-mail do portão (`urgent_only`) não manda
 * `info`/`acao`, e o editor pediu o aviso também no sucesso.
 *
 * Uso:
 *   npx tsx scripts/publish-circle-stack-scheduled.ts                       (task de segunda)
 *   npx tsx scripts/publish-circle-stack-scheduled.ts --approve --publish-monday 261109
 *   npx tsx scripts/publish-circle-stack-scheduled.ts --revoke --publish-monday 261109
 *   (opcional: --data-root <dir>)
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import {
  currentOrPreviousMondayAAMMDD,
  nextMondayAAMMDD,
  resolveWeeklyLinkedinCycle,
  weeklyLinkedinRelDir,
} from "./lib/weekly-linkedin-cycle.ts";
import { resolveCircleStackState } from "./lib/publish-state.ts";
import { sendPushNotification, type PushMessage, type PushNotifyResult } from "./lib/push-notify.ts";
import { circleStackSelectionViolations, circleStackUnreviewedTitles } from "./lib/circle-stack-select.ts";
import {
  buildCircleStackApproval,
  buildCircleStackOutcomeEmail,
  checkCircleStackApproval,
  circleStackScheduledExitCode,
  classifyCircleStackRun,
  CIRCLE_STACK_APPROVAL_FILE,
  CIRCLE_STACK_PUBLISH_HOUR,
  circleStackBrtDay,
  circleStackWallClock,
  isCircleStackPublishWindow,
  isCircleStackScheduledRunPast,
  type CircleStackScheduledOutcome,
} from "./lib/circle-stack-schedule.ts";
import {
  CircleStackPublishRefusal,
  parseStoredCircleStackSelection,
  readCircleStackPublishedState,
  runCircleStack,
} from "./publish-circle-stack.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ScheduledCircleStackDeps {
  rootDir: string;
  platformConfig: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Publicador; default `runCircleStack` em processo. Recebe só os args do envio. */
  runPublish?: (argv: string[]) => Promise<void>;
  /** E-mail ao editor; default `sendPushNotification` (fail-soft, nunca lança). */
  sendEmail?: (message: PushMessage) => Promise<PushNotifyResult>;
}

export interface CyclePaths {
  dataRoot: string;
  publishMonday: string;
  cycle: string;
  selectionPath: string;
  approvalPath: string;
  statePath: string;
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function resolveCyclePaths(dataRoot: string, publishMonday: string): CyclePaths {
  const r = resolveWeeklyLinkedinCycle(publishMonday);
  if (!r) throw new Error(`--publish-monday inválido: ${publishMonday} (esperado AAMMDD)`);
  const internal = join(dataRoot, weeklyLinkedinRelDir(r.cycle), "_internal");
  return {
    dataRoot,
    publishMonday,
    cycle: r.cycle,
    selectionPath: join(internal, "circle-stack-selection.json"),
    approvalPath: join(internal, CIRCLE_STACK_APPROVAL_FILE),
    statePath: join(internal, "circle-stack-published.json"),
  };
}

/** `--approve`: grava a aprovação do ciclo sobre a seleção atual. Lança se a seleção não pode sair. */
export function approveCircleStackCycle(paths: CyclePaths, now: Date): { approvalPath: string; sha256: string } {
  // #11868: a task só envia o ciclo da própria segunda; aprovar uma segunda já
  // passada grava uma aprovação que nada consome e o editor acha que o post sai.
  // #12110: "hoje" em BRT (fuso do timer), não no relógio do processo.
  const earliest = nextMondayAAMMDD(circleStackBrtDay(now));
  if (paths.publishMonday < earliest) {
    throw new Error(
      `Segunda ${paths.publishMonday} (ciclo ${paths.cycle}) já passou — a task de segunda 06:00 só envia o ciclo da própria segunda, ` +
        `então esta aprovação nunca seria usada. Aprove a próxima segunda (${earliest}) ou publique o ciclo atrasado à mão ` +
        `(publish-circle-stack.ts --publish-monday ${paths.publishMonday} --publish).`,
    );
  }
  // #11877: na própria segunda, depois das 06:00, a execução do dia já saiu
  // (Publicado ou "Não enviado") e o timer não roda de novo — mesma aprovação
  // sem consumidor que o #11868 fechou para a segunda vencida.
  if (isCircleStackScheduledRunPast(now, paths.publishMonday)) {
    throw new Error(
      `O envio agendado de ${paths.publishMonday} às ${String(CIRCLE_STACK_PUBLISH_HOUR).padStart(2, "0")}:00 (ciclo ${paths.cycle}) já rodou hoje ` +
        `e o timer não roda de novo, então esta aprovação nunca seria usada. Publique à mão ` +
        `(publish-circle-stack.ts --publish-monday ${paths.publishMonday} --publish, ou /diaria-stack ${paths.publishMonday} --publish).`,
    );
  }
  const raw = readIfExists(paths.selectionPath);
  if (raw === null) {
    throw new Error(`Seleção do ciclo ${paths.cycle} não existe (${paths.selectionPath}) — rode /diaria-stack antes de aprovar.`);
  }
  const { selection } = parseStoredCircleStackSelection(raw, paths.selectionPath, paths.cycle);
  const problems = [...circleStackSelectionViolations(selection), ...circleStackUnreviewedTitles(selection)];
  if (problems.length > 0) {
    throw new Error(
      `Seleção ${paths.selectionPath} não pode ser aprovada — corrija e aprove de novo:\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
  const state = resolveCircleStackState(readCircleStackPublishedState(paths.statePath), paths.cycle);
  if (state === "published") throw new Error(`Ciclo ${paths.cycle} já publicado na Stack — nada a aprovar.`);
  if (state === "unknown") {
    console.warn(
      `⚠ State do ciclo ${paths.cycle} é ambíguo (${paths.statePath}): a task de segunda vai recusar o envio até alguém conferir o Radar.`,
    );
  }
  const approval = buildCircleStackApproval(paths.cycle, raw, now);
  writeFileAtomic(paths.approvalPath, JSON.stringify(approval, null, 2));
  return { approvalPath: paths.approvalPath, sha256: approval.selection_sha256 };
}

/**
 * Execução da task: decide, envia no máximo uma vez, manda o e-mail e devolve
 * o desfecho + exit code. Nunca lança por erro do publicador (vira desfecho).
 */
export async function runScheduledCircleStackPublish(
  paths: CyclePaths,
  deps: ScheduledCircleStackDeps,
): Promise<{ outcome: CircleStackScheduledOutcome; emailOk: boolean; emailError?: string; exitCode: number }> {
  const now = deps.now ?? (() => new Date());
  const runStartedAt = now();
  const runPublish =
    deps.runPublish ??
    ((argv: string[]) => runCircleStack(argv, { rootDir: deps.rootDir, platformConfig: deps.platformConfig, env: deps.env }));
  const sendEmail =
    deps.sendEmail ?? ((m: PushMessage) => sendPushNotification(m, { platformConfigPath: join(deps.rootDir, "platform.config.json") }));

  let outcome: CircleStackScheduledOutcome;
  // #12110: a janela é a segunda em BRT (o timer usa America/Sao_Paulo), não no
  // fuso do processo — no `300` (Etc/UTC) um catch-up às 22:00 BRT de segunda já
  // seria terça.
  const today = circleStackWallClock(runStartedAt).aammdd;
  if (!isCircleStackPublishWindow(today, paths.publishMonday)) {
    outcome = {
      kind: "nao-enviado",
      reason: `execução em ${today}, fora da segunda de publicação ${paths.publishMonday} (catch-up do timer) — envio atrasado só à mão`,
    };
  } else {
    const approval = checkCircleStackApproval(readIfExists(paths.approvalPath), readIfExists(paths.selectionPath), paths.cycle);
    if (!approval.ok) {
      outcome = { kind: "nao-enviado", reason: approval.reason };
    } else {
      // Uma chamada só, sem --force (#11778 item 3): a falha pode ter publicado o post.
      let error: unknown;
      try {
        await runPublish(["--publish-monday", paths.publishMonday, "--publish", "--data-root", paths.dataRoot]);
      } catch (err) {
        error = err;
      }
      outcome = classifyCircleStackRun({
        cycle: paths.cycle,
        runStartedAt,
        stateAfter: readCircleStackPublishedState(paths.statePath),
        error,
        errorIsRefusal: error instanceof CircleStackPublishRefusal,
      });
    }
  }

  const email = buildCircleStackOutcomeEmail(outcome, {
    cycle: paths.cycle,
    publishMonday: paths.publishMonday,
    statePath: relative(deps.rootDir, paths.statePath) || paths.statePath,
  });
  const sent = await sendEmail(email);
  const exitCode = sent.ok ? circleStackScheduledExitCode(outcome) : 1;
  return { outcome, emailOk: sent.ok, emailError: sent.ok ? undefined : sent.error, exitCode };
}

export async function runScheduledCircleStack(argv: string[], deps: ScheduledCircleStackDeps): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const dataRoot = resolve(getStringArg(argv, "data-root") ?? deps.rootDir);
  const explicit = getStringArg(argv, "publish-monday", { example: "261109" });
  const approveMode = hasFlag(argv, "approve") || hasFlag(argv, "revoke");
  const brtToday = circleStackBrtDay(now());
  const publishMonday = explicit ?? (approveMode ? nextMondayAAMMDD(brtToday) : currentOrPreviousMondayAAMMDD(brtToday));
  if (!explicit) console.log(`--publish-monday não informado — assumindo ${publishMonday}.`);
  const paths = resolveCyclePaths(dataRoot, publishMonday);

  if (hasFlag(argv, "revoke")) {
    const had = existsSync(paths.approvalPath);
    rmSync(paths.approvalPath, { force: true });
    console.log(had ? `Aprovação do ciclo ${paths.cycle} removida.` : `Ciclo ${paths.cycle} não tinha aprovação.`);
    return 0;
  }
  if (hasFlag(argv, "approve")) {
    const res = approveCircleStackCycle(paths, now());
    console.log(`Ciclo ${paths.cycle} aprovado para o envio de ${publishMonday} às 06:00 BRT: ${res.approvalPath} (sha256 ${res.sha256.slice(0, 12)}).`);
    console.log("Editar a seleção depois daqui invalida a aprovação; aprove de novo.");
    return 0;
  }

  const res = await runScheduledCircleStackPublish(paths, { ...deps, now });
  console.log(JSON.stringify({ cycle: paths.cycle, outcome: res.outcome, emailOk: res.emailOk }));
  if (!res.emailOk) console.error(`E-mail ao editor NÃO saiu: ${res.emailError ?? "erro desconhecido"}`);
  return res.exitCode;
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const code = await runScheduledCircleStack(process.argv.slice(2), {
    rootDir: ROOT,
    platformConfig: JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")),
    env: process.env,
  });
  process.exit(code);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
