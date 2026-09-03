#!/usr/bin/env node
/**
 * scripts/task-never-armed-alarm.ts (#5607)
 *
 * Task periódica: cruza o registro declarativo (`scripts/lib/scheduled-tasks.ts
 * --json`) contra `systemctl --user list-timers --all` e alarma se qualquer
 * task deste repo estiver definida mas nunca armada — o caso que o sweep
 * genérico do #5563 (`systemd-failed-units-alarm.ts`, "disparou e falhou")
 * não cobre por desenho ("nunca disparou" não deixa rastro em `--state=failed`).
 * Também alarma (mais fraco) o inverso: timer `diaria-*` armado sem task
 * correspondente no registro.
 *
 * Lógica pura em `scripts/lib/task-never-armed-alarm.ts` — este arquivo é
 * só I/O: `systemctl --user list-timers --all` (SÓ LEITURA — ver guard
 * abaixo), envio de e-mail, dedup/criação de issue via `scripts/lib/alarm-issues.ts`.
 *
 * **GUARD (invariável):** este script NUNCA chama `systemctl` com
 * `enable`/`disable`/`start`/`stop`/`restart` — só `list-timers` (leitura).
 * Armar/desarmar é ação manual do editor.
 *
 * **Guard de máquina sem systemd `--user`** (sessão cloud, clone fresco, ou
 * qualquer máquina sem `systemctl`): a chamada falha com ENOENT — tratado
 * como "nada detectável nesta máquina", nunca como alarme (fail-soft
 * honesto, mesmo padrão de `systemd-failed-units-alarm.ts`).
 *
 * **Erro transitório ≠ "sem systemd" (#7039).** Qualquer falha do
 * `systemctl` que NÃO seja ENOENT (bus indisponível, timeout, permissão,
 * `systemctl` presente mas quebrado) é "não sei", não "nada armado" — o
 * script sai com `exit 1` e loga alto, nunca silenciosamente "nada a
 * checar". Ver `readArmedTimerUnitBaseNames`/`ReadArmedTimerUnitsResult`.
 *
 * Uso:
 *   npx tsx scripts/task-never-armed-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/task-never-armed-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/task-never-armed-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário pra
 * ENVIAR o alarme (mesmo requisito dos outros alarmes locais deste repo).
 *
 * Estado: `data/.task-never-armed-alarm-state.json` (dedup do e-mail) +
 * `data/.task-never-armed-alarm-issues.json` (tracking de issue por achado,
 * `alarm-issues.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { listScheduledTaskNames, listDisabledScheduledTaskNames } from "./lib/scheduled-tasks.ts";
import { unitBaseName } from "./lib/systemd-units.ts";
import { queryUnitState, type SystemdUnitState } from "./lib/systemd-unit-state.ts";
import {
  parseSystemctlListTimersOutput,
  evaluateTaskNeverArmed,
  shouldSendTaskNeverArmedAlarm,
  markTaskNeverArmedAlarmed,
  emptyTaskNeverArmedAlarmState,
  buildTaskNeverArmedAlarmEmail,
  isAlarmingVerdict,
  type TaskNeverArmedAlarmState,
  type TaskNeverArmedEvaluation,
} from "./lib/task-never-armed-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  saveAlarmIssuesState,
  saveState,
  type AlarmFinding,
  type AlarmIssuesState,
  type AlarmIssueResult,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const STATE_PATH = join(DATA_DIR, ".task-never-armed-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = join(DATA_DIR, ".task-never-armed-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[task-never-armed-alarm]";
/** Cadência recomendada: diária, mesmo espírito de
 * `Diaria-Edicao-Diaria-Staleness-Alarm` — este é um check de DRIFT lento
 * (registro vs. máquina só diverge quando alguém adiciona/remove task e
 * esquece de armar/desarmar), não um evento de alta frequência. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

/**
 * Resultado tri-estado de `readArmedTimerUnitBaseNames` (#7039). Distingue
 * "não existe systemd nesta máquina" (ENOENT — fail-soft honesto, mesmo
 * padrão de `systemd-failed-units-alarm.ts`) de "existe, mas a consulta
 * falhou por motivo transitório" (D-Bus indisponível, timeout, permissão)
 * — os dois colapsavam no mesmo `null` antes desta issue, e o caller tratava
 * ambos como "conjunto armado vazio, nada a reportar", o que é a MESMA
 * saída que "sei que não há nada armado" — exatamente o que o #7039 pede
 * pra nunca acontecer. `status: "check-failed"` precisa virar erro visível
 * pro caller, nunca "ok" silencioso.
 */
export type ReadArmedTimerUnitsResult =
  | { status: "ok"; unitBaseNames: string[] }
  | { status: "no-systemd" }
  | { status: "check-failed"; message: string };

export function readArmedTimerUnitBaseNames(
  execFn: typeof execFileSync = execFileSync,
): ReadArmedTimerUnitsResult {
  try {
    const out = execFn("systemctl", ["--user", "list-timers", "--all", "--plain", "--no-legend"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as string;
    return { status: "ok", unitBaseNames: parseSystemctlListTimersOutput(String(out ?? "")) };
  } catch (e: unknown) {
    const err = e as { code?: string; status?: number | null; stdout?: string; message?: string };
    // ENOENT é o único caso legítimo de "esta máquina não tem systemd --user"
    // (sessão cloud, clone fresco, container, Windows) — é o `.code` que o
    // Node atribui quando o binário `systemctl` nem existe no PATH.
    // Ancorado em `.code`, não em substring de mensagem (locale/versão do
    // systemd variam a mensagem, nunca o código estruturado do erro de
    // spawn do Node).
    if (err.code === "ENOENT") {
      return { status: "no-systemd" };
    }
    // Mesmo padrão de systemd-failed-units-alarm.ts: uma lista vazia pode
    // sair com status != 0 em algumas versões do systemd, mas ainda escreve
    // o (não-)resultado em stdout. Isso ainda conta como leitura bem-sucedida.
    if (typeof err.stdout === "string") {
      return { status: "ok", unitBaseNames: parseSystemctlListTimersOutput(err.stdout) };
    }
    // Qualquer outra falha (bus indisponível, timeout, permissão, systemctl
    // presente mas quebrado) é "não sei", nunca "sei que está vazio".
    return {
      status: "check-failed",
      message: typeof err.message === "string" ? err.message : String(e),
    };
  }
}

export function toNeverArmedFinding(taskName: string): AlarmFinding {
  return {
    check: "task-never-armed",
    fingerprint: taskName,
    title: `[diar.ia.br] task nunca armada: ${taskName}`,
    body: [
      "Achado automático do alarme `Diaria-Task-Never-Armed-Alarm`",
      "(`scripts/task-never-armed-alarm.ts`, #5607).",
      "",
      `A task \`${taskName}\` está no registro declarativo (\`scripts/lib/scheduled-tasks.ts\`)`,
      "mas não tem timer systemd --user armado nesta máquina.",
      "",
      "Armar: rodar `scripts/setup-systemd-timers.ts` (ou o passo manual equivalente) e " +
        "confirmar com `systemctl --user list-timers`. Este alarme nunca arma sozinho.",
      "",
      "Esta issue é criada automaticamente pelo alarme e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    // #6772 — label `alarm-acao`: a condição só normaliza por AÇÃO HUMANA/de
    // código (armar o timer), nunca sozinha — sem este sinal,
    // `classifyExecTrack` roteava `[alarm]` puro pra `fora-de-rodada`
    // (achado ao vivo: #6652-6658/#6729, presas indefinidamente, nenhuma
    // rodada as pegava). Ver `scripts/lib/issue-exec-track.ts`.
    labels: ["bug", "alarm-acao"],
    priority: "P1",
    family: "estado",
  };
}

/** (#7210) Achado pra task cujo timer EXISTE nesta máquina mas está
 * `ActiveState=inactive` — parada deliberadamente (`systemctl --user stop`
 * manual), não "nunca configurada". Prescrição é DECISÃO humana (religar ou
 * remover do registro), nunca a mesma ação mecânica de `toNeverArmedFinding`
 * — por isso é um `check`/finding separado, com prioridade mais baixa (mesmo
 * padrão de `toOrphanTimerFinding`: sinal de drift que precisa de leitura
 * humana, não de correção mecânica). */
export function toStoppedDeliberatelyFinding(taskName: string): AlarmFinding {
  return {
    check: "task-stopped-deliberately",
    fingerprint: taskName,
    title: `[diar.ia.br] task parada deliberadamente: ${taskName}`,
    body: [
      "Achado automático do alarme `Diaria-Task-Never-Armed-Alarm`",
      "(`scripts/task-never-armed-alarm.ts`, #7210).",
      "",
      `A task \`${taskName}\` está no registro declarativo (\`scripts/lib/scheduled-tasks.ts\`)`,
      "e o timer systemd --user JÁ EXISTIU nesta máquina, mas está `ActiveState=inactive` —",
      "sinal de `systemctl --user stop` manual, não de setup que nunca rodou.",
      "",
      "Decisão pendente do editor: religar (`systemctl --user enable --now <unit>.timer`, ou " +
        "`arm-systemd-timers.ts --rearm-stopped`) ou remover a task de `scheduled-tasks.ts` se ela não faz " +
        "mais sentido. Este alarme nunca religa/remove sozinho.",
      "",
      "Esta issue é criada automaticamente pelo alarme e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    // Mesmo racional do `alarm-acao` dos demais findings deste alarme: só
    // some com ação humana/de código, nunca sozinha.
    labels: ["enhancement", "alarm-acao"],
    priority: "P3",
    family: "estado",
  };
}

export function toOrphanTimerFinding(unitBaseName: string): AlarmFinding {
  return {
    check: "task-never-armed-orphan-timer",
    fingerprint: unitBaseName,
    title: `[diar.ia.br] timer órfão sem task no registro: ${unitBaseName}.timer`,
    body: [
      "Achado automático do alarme `Diaria-Task-Never-Armed-Alarm`",
      "(`scripts/task-never-armed-alarm.ts`, #5607).",
      "",
      `O timer \`${unitBaseName}.timer\` está armado nesta máquina mas não tem task`,
      "correspondente no registro declarativo (`scripts/lib/scheduled-tasks.ts`) —",
      "possível task renomeada ou removida sem desarmar o timer antigo.",
      "",
      `Investigar: \`systemctl --user status ${unitBaseName}.timer\`. Desarmar` +
        " (`systemctl --user disable --now`) é ação manual do editor.",
      "",
      "Esta issue é criada automaticamente pelo alarme e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    // #6772 — mesmo racional do `alarm-acao` de `toNeverArmedFinding` acima:
    // um timer órfão só some com ação manual do editor (desarmar) ou do
    // registro (readotar), nunca sozinho.
    labels: ["enhancement", "alarm-acao"],
    priority: "P3",
    family: "estado",
  };
}

function loadState(): TaskNeverArmedAlarmState {
  if (!existsSync(STATE_PATH)) return emptyTaskNeverArmedAlarmState();
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<TaskNeverArmedAlarmState>;
    if (
      raw.lastAlarmed &&
      Array.isArray(raw.lastAlarmed.neverArmed) &&
      Array.isArray(raw.lastAlarmed.orphanTimers)
    ) {
      return {
        lastAlarmed: {
          neverArmed: raw.lastAlarmed.neverArmed.filter((s): s is string => typeof s === "string"),
          orphanTimers: raw.lastAlarmed.orphanTimers.filter((s): s is string => typeof s === "string"),
        },
      };
    }
    return emptyTaskNeverArmedAlarmState();
  } catch {
    return emptyTaskNeverArmedAlarmState();
  }
}

// saveState/saveAlarmIssuesState: consolidados em scripts/lib/alarm-issues.ts
// (#7124) — importados acima (DATA_DIR === dirname(STATE_PATH) ===
// dirname(ALARM_ISSUES_STATE_PATH), então o helper genérico é equivalente).

// loadAlarmIssuesState continua LOCAL (#7124) — diverge do padrão comum ao
// logar o parse error via console.error, não só um catch silencioso; não
// forçado para o helper genérico pra não perder o diagnóstico.
function loadAlarmIssuesState(): AlarmIssuesState {
  if (!existsSync(ALARM_ISSUES_STATE_PATH)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(ALARM_ISSUES_STATE_PATH, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch (e) {
    console.error(
      `${LOG_PREFIX} estado de alarm-issues corrompido/ilegível em ${ALARM_ISSUES_STATE_PATH} — resetando pra vazio: ${(e as Error).message}`,
    );
    return emptyAlarmIssuesState();
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const armedResult = readArmedTimerUnitBaseNames();
  if (armedResult.status === "no-systemd") {
    console.log(`${LOG_PREFIX} systemctl indisponível nesta máquina (sessão cloud/sem systemd --user) — nada a checar.`);
    return;
  }
  if (armedResult.status === "check-failed") {
    // #7039: NUNCA tratar isto como "conjunto armado vazio, nada a
    // reportar" — é "não sei", e precisa parecer diferente de "sei que
    // está tudo ok" tanto no log quanto no exit code, pra não repetir o
    // padrão das 5 instâncias anteriores (ver tabela do PR).
    console.error(
      `${LOG_PREFIX} systemctl falhou ao consultar timers (motivo transitório, NÃO "sem systemd"): ` +
        `${armedResult.message} — não foi possível avaliar drift nesta execução; nenhum alarme de drift ` +
        "será enviado, mas isto não significa que está tudo armado.",
    );
    process.exitCode = 1;
    return;
  }
  const armedUnitBaseNames = armedResult.unitBaseNames;

  const registryTaskNames = listScheduledTaskNames();
  const disabledTaskNames = listDisabledScheduledTaskNames();

  // #7210: pra cada task do registro (habilitada) sem timer em
  // `armedUnitBaseNames`, consulta `systemctl --user show` — a MESMA
  // distinção LoadState/ActiveState que `arm-systemd-timers.ts` já usa pro
  // guard `--rearm-stopped` (#4828) — pra separar "nunca configurada"
  // (`LoadState=not-found`) de "parada deliberadamente" (unit existe,
  // `ActiveState=inactive`). Só consulta os candidatos (não o registro
  // inteiro) — o mesmo filtro que `evaluateTaskNeverArmed` aplicaria
  // internamente, replicado aqui só pra decidir QUEM consultar.
  const armedSet = new Set(armedUnitBaseNames);
  const disabledSet = new Set(disabledTaskNames);
  const neverArmedCandidates = registryTaskNames.filter(
    (name) => !disabledSet.has(name) && !armedSet.has(unitBaseName(name)),
  );
  const unitStates = new Map<string, SystemdUnitState | null>();
  for (const taskName of neverArmedCandidates) {
    const base = unitBaseName(taskName);
    const { state, error } = queryUnitState(`${base}.timer`);
    if (error) {
      console.error(`${LOG_PREFIX} não foi possível consultar o estado de '${base}.timer' (${error}) — tratando como nunca armada.`);
    }
    unitStates.set(base, state);
  }

  const evaluation: TaskNeverArmedEvaluation = evaluateTaskNeverArmed(
    registryTaskNames,
    armedUnitBaseNames,
    disabledTaskNames,
    unitStates,
  );
  console.log(
    `${LOG_PREFIX} verdict=${evaluation.verdict} neverArmed=[${evaluation.neverArmed.join(", ")}] ` +
      `stoppedDeliberately=[${evaluation.stoppedDeliberately.join(", ")}] ` +
      `orphanTimers=[${evaluation.orphanTimers.join(", ")}]`,
  );

  // #7210: neverArmed é superconjunto de stoppedDeliberately — as tasks
  // "nunca configuradas" (o resto) recebem o finding mecânico de sempre;
  // as "paradas deliberadamente" recebem o finding novo, com prescrição de
  // decisão humana em vez de "arme via script".
  const stoppedDeliberatelySet = new Set(evaluation.stoppedDeliberately);
  const neverSetupTaskNames = evaluation.neverArmed.filter((n) => !stoppedDeliberatelySet.has(n));

  const state = loadState();
  const alarmFindings: AlarmFinding[] = isAlarmingVerdict(evaluation.verdict)
    ? [
        ...neverSetupTaskNames.map(toNeverArmedFinding),
        ...evaluation.stoppedDeliberately.map(toStoppedDeliberatelyFinding),
        ...evaluation.orphanTimers.map(toOrphanTimerFinding),
      ]
    : [];
  const alarmState = loadAlarmIssuesState();
  const issueRefs: AlarmIssueResult[] = [];

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, estado NÃO gravado.`,
    );
  } else {
    const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
    for (const outcome of findingOutcomes) {
      const ref: AlarmIssueResult = {
        issueNumber: outcome.issueNumber,
        url: outcome.url,
        action: outcome.action,
        error: outcome.error,
      };
      issueRefs.push(ref);
      if (outcome.action === "failed") {
        console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
      } else {
        console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
      }
    }
  }

  if (!shouldSendTaskNeverArmedAlarm(evaluation, state)) {
    console.log(
      isAlarmingVerdict(evaluation.verdict)
        ? `${LOG_PREFIX} já alarmado pro mesmo conjunto nesta invocação anterior — não reenvia.`
        : `${LOG_PREFIX} nenhum drift registro↔systemd — nenhum alarme necessário.`,
    );
    return;
  }

  const issueLines = issueRefs.length
    ? "\n\nIssues:\n" +
      issueRefs
        .map((r) => (r.action === "failed" ? `  - falha ao criar/reusar (${r.error})` : `  - #${r.issueNumber} (${r.url})`))
        .join("\n")
    : "";
  const { subject, body } = buildTaskNeverArmedAlarmEmail(evaluation, issueLines);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markTaskNeverArmedAlarmed(evaluation), STATE_PATH);
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
