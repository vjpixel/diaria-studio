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
 *               (em processo, sem `--force`, uma vez só), depois — só dentro
 *               da janela e com aprovação válida, qualquer que seja o
 *               resultado do Circle — o e-mail do post aos apoiadores Núcleo
 *               pelo Kit (#12538, `publish-circle-stack-email-kit.ts --send`,
 *               que reaplica as travas de conteúdo do Circle), e manda e-mail ao
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
import { runCircleStackEmail, type StackEmailResult } from "./publish-circle-stack-email-kit.ts";
import { StackEmailGuardError, StackEmailIncidentError } from "./lib/circle-stack-email-channel.ts";
import { formatStackEmailBrt } from "./lib/circle-stack-email-render.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * #12538: desfecho do e-mail aos apoiadores Núcleo na execução da task.
 * Tipos distintos porque a instrução ao editor é oposta entre eles: `recusado`
 * e `cancelado` = nada saiu, corrigir e rodar de novo; `incidente` = um
 * broadcast pode estar agendado, conferir o Kit ANTES de qualquer reexecução.
 * `nao-tentado` = o Circle não saiu (sem aprovação, fora da janela), então o
 * e-mail também não.
 */
export type StackEmailOutcome =
  | { kind: "enviado"; broadcastId: number; sendAt: string }
  | { kind: "ja-enviado"; broadcastId: number; sendAt: string }
  | { kind: "recusado"; reason: string }
  | { kind: "cancelado"; reason: string }
  | { kind: "incidente"; reason: string }
  | { kind: "nao-tentado" };

const STACK_EMAIL_FAILED: ReadonlySet<StackEmailOutcome["kind"]> = new Set(["recusado", "cancelado", "incidente"]);

/** Pure: o desfecho do e-mail pede ação do editor (exit 1, assunto marcado). */
export function stackEmailNeedsAction(o: StackEmailOutcome | null): boolean {
  return o !== null && STACK_EMAIL_FAILED.has(o.kind);
}

/** Converte a execução do publicador do e-mail no desfecho tipado. Nunca lança. */
export async function classifyStackEmailRun(run: () => Promise<StackEmailResult>): Promise<StackEmailOutcome> {
  try {
    const r = await run();
    if (r.kind === "enviado" || r.kind === "ja-enviado") {
      return { kind: r.kind, broadcastId: r.record.broadcastId, sendAt: r.record.sendAt };
    }
    return { kind: "incidente", reason: `resultado inesperado do publicador do e-mail: ${r.kind}` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof StackEmailGuardError) return { kind: "recusado", reason };
    if (err instanceof StackEmailIncidentError && err.cancelled) return { kind: "cancelado", reason };
    return { kind: "incidente", reason };
  }
}

/** Pure (#12538): põe no e-mail do editor o desfecho do canal e-mail (no topo quando pede ação). */
export function appendStackEmailOutcome(
  message: { subject: string; body: string },
  stackEmail: StackEmailOutcome,
  publishMonday: string,
): { subject: string; body: string } {
  const send = `  npx tsx scripts/publish-circle-stack-email-kit.ts --publish-monday ${publishMonday} --send`;
  let lines: string[];
  switch (stackEmail.kind) {
    case "enviado":
      lines = [
        `E-mail aos apoiadores Núcleo (Kit): agendado para ${formatStackEmailBrt(stackEmail.sendAt)} (broadcast ${stackEmail.broadcastId}).`,
        "Até esse horário dá para cancelar no painel do Kit (Broadcasts → Scheduled).",
      ];
      break;
    case "ja-enviado":
      lines = [
        `E-mail aos apoiadores Núcleo (Kit): já tinha saído antes (broadcast ${stackEmail.broadcastId}, ${formatStackEmailBrt(stackEmail.sendAt)}). Nada a fazer.`,
      ];
      break;
    case "nao-tentado":
      lines = [
        "E-mail aos apoiadores Núcleo (Kit): também não saiu. Se a semana deve sair, depois de publicar no Circle:",
        send,
      ];
      break;
    case "recusado":
    case "cancelado":
      lines = [
        `E-mail aos apoiadores Núcleo (Kit): NÃO SAIU${stackEmail.kind === "cancelado" ? " (cancelado antes do envio)" : ""}.`,
        stackEmail.reason,
        "",
        "Nenhum e-mail chegou aos apoiadores. O que fazer: corrigir a causa e enviar à mão:",
        send,
      ];
      break;
    case "incidente":
      lines = [
        "E-mail aos apoiadores Núcleo (Kit): INCIDENTE, conferir o Kit agora.",
        stackEmail.reason,
        "",
        "Não reexecute antes de conferir Broadcasts → Scheduled e Sent no Kit. Só use --force depois de confirmar",
        "que nenhum broadcast deste ciclo saiu nem está agendado (o --force cria um broadcast novo).",
      ];
      break;
  }
  if (!stackEmailNeedsAction(stackEmail)) {
    return { subject: message.subject, body: [message.body, "", "---", ...lines].join("\n") };
  }
  const tag = stackEmail.kind === "incidente" ? "e-mail Núcleo: INCIDENTE" : "e-mail Núcleo: não saiu";
  return { subject: `${message.subject} · ${tag}`, body: [...lines, "", "---", "", message.body].join("\n") };
}

export interface ScheduledCircleStackDeps {
  rootDir: string;
  platformConfig: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Publicador; default `runCircleStack` em processo. Recebe só os args do envio. */
  runPublish?: (argv: string[]) => Promise<void>;
  /** E-mail ao editor; default `sendPushNotification` (fail-soft, nunca lança). */
  sendEmail?: (message: PushMessage) => Promise<PushNotifyResult>;
  /**
   * #12538: e-mail do post aos apoiadores Núcleo (Kit), rodado depois do
   * Circle e só com o ciclo aprovado. Ausente = canal desligado (é o `main()`
   * que liga, com `runCircleStackEmail`); lança em falha/guard.
   */
  runStackEmail?: (paths: CyclePaths) => Promise<StackEmailOutcome>;
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
): Promise<{
  outcome: CircleStackScheduledOutcome;
  stackEmail: StackEmailOutcome | null;
  emailOk: boolean;
  emailError?: string;
  exitCode: number;
}> {
  const now = deps.now ?? (() => new Date());
  const runStartedAt = now();
  const runPublish =
    deps.runPublish ??
    ((argv: string[]) => runCircleStack(argv, { rootDir: deps.rootDir, platformConfig: deps.platformConfig, env: deps.env }));
  const sendEmail =
    deps.sendEmail ?? ((m: PushMessage) => sendPushNotification(m, { platformConfigPath: join(deps.rootDir, "platform.config.json") }));

  let outcome: CircleStackScheduledOutcome;
  let stackEmail: StackEmailOutcome | null = null;
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
      // #12538: canal independente do Circle — a aprovação do ciclo é o que
      // autoriza os dois, então o e-mail sai mesmo se o Circle falhou.
      if (deps.runStackEmail) stackEmail = await deps.runStackEmail(paths);
    }
  }

  const email = buildCircleStackOutcomeEmail(outcome, {
    cycle: paths.cycle,
    publishMonday: paths.publishMonday,
    statePath: relative(deps.rootDir, paths.statePath) || paths.statePath,
  });
  if (deps.runStackEmail && stackEmail === null) stackEmail = { kind: "nao-tentado" };
  const finalEmail = stackEmail ? appendStackEmailOutcome(email, stackEmail, paths.publishMonday) : email;
  const sent = await sendEmail(finalEmail);
  const exitCode = !sent.ok || stackEmailNeedsAction(stackEmail) ? 1 : circleStackScheduledExitCode(outcome);
  return { outcome, stackEmail, emailOk: sent.ok, emailError: sent.ok ? undefined : sent.error, exitCode };
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
  console.log(JSON.stringify({ cycle: paths.cycle, outcome: res.outcome, stackEmail: res.stackEmail, emailOk: res.emailOk }));
  if (!res.emailOk) console.error(`E-mail ao editor NÃO saiu: ${res.emailError ?? "erro desconhecido"}`);
  return res.exitCode;
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const code = await runScheduledCircleStack(process.argv.slice(2), {
    rootDir: ROOT,
    platformConfig: JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")),
    env: process.env,
    runStackEmail: (paths) =>
      classifyStackEmailRun(() =>
        runCircleStackEmail({
          rootDir: ROOT,
          dataRoot: paths.dataRoot,
          publishMonday: paths.publishMonday,
          mode: { kind: "send", force: false },
          log: (m) => console.error(`[stack-email] ${m}`),
        }),
      ),
  });
  process.exit(code);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
