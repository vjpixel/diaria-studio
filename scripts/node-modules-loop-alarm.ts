#!/usr/bin/env node
/**
 * scripts/node-modules-loop-alarm.ts (#5571)
 *
 * Alarme de sanity LEVE: checa se `node_modules` do checkout PRINCIPAL
 * (raiz do repo, nunca um worktree) virou um symlink AUTO-REFERENTE — o
 * sintoma exato do achado ao vivo na overnight 260817c (dois processos
 * `npm install`/`npm ci` concorrentes escrevendo no MESMO `node_modules`
 * corromperam ele num symlink apontando pra si mesmo, quebrando todo
 * `npx tsx` com `FilesystemLoop`/"Too many levels of symbolic links").
 *
 * Lógica pura em `scripts/lib/node-modules-loop-alarm.ts` — este arquivo é
 * só I/O (lstat/readlink + estado + e-mail), mesmo molde dos demais alarmes
 * "estado" do repo (ver `scripts/robots-txt-drift-check.ts`,
 * `scripts/worker-drift-check.ts`).
 *
 * Uso:
 *   npx tsx scripts/node-modules-loop-alarm.ts               # avalia + persiste + alarma se NOVO loop
 *   npx tsx scripts/node-modules-loop-alarm.ts --dry-run      # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/node-modules-loop-alarm.ts --to email@x   # override do destinatário do alarme
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário
 * quando há loop pra de fato enviar o e-mail; a checagem em si (lstat +
 * readlink) não depende de nenhuma credencial. Persistir o estado de
 * idempotência precisa do junction `data/`.
 *
 * Escopo (#5571 proposta, item 2 — item 1 é a regra documental em
 * CLAUDE.md/`context/overnight-dispatch-rules.md` §3; item 3, guard/restart
 * do `Diaria-Studio-Server`, ficou de fora — maior escopo, follow-up
 * separado). Esta task ainda NÃO tem timer registrado — fora do que dá pra
 * fazer numa sessão de código (#5571 item 2, explícito); rodar manualmente
 * até alguém adicionar uma entry em `scripts/lib/scheduled-tasks.ts`
 * (achado do self-review deste PR: a via de execução real pós-#5115,
 * 260812, é EXCLUSIVAMENTE o par `.service`/`.timer` systemd gerado por
 * `scripts/setup-systemd-timers.ts` — os `.ps1`/Task Scheduler do Windows
 * foram removidos do repo nesse cutover, não é mais a via viva).
 *
 * Estado (idempotência): `data/node-modules-loop-alarm/state.json`.
 *
 * Como os outros alarmes locais deste repo (#4320/#4382/#4490/#4534), a 1ª
 * execução ao vivo nunca rodou nesta unidade (worktree isolado, com o
 * próprio `node_modules` — nunca um symlink auto-referente — e sem
 * `data/.credentials.json` real) — validado só via testes com a lógica pura
 * (`test/node-modules-loop-alarm.test.ts`).
 */
import { existsSync, lstatSync, readlinkSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  evaluateNodeModulesSymlink,
  shouldAlarmNodeModulesLoop,
  advanceNodeModulesLoopAlarmState,
  emptyNodeModulesLoopAlarmState,
  buildNodeModulesLoopAlarmEmail,
  nodeModulesLoopFindingKey,
  isNodeModulesLoopPending,
  type SymlinkLoopInput,
  type SymlinkLoopEvaluation,
  type NodeModulesLoopAlarmState,
} from "./lib/node-modules-loop-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
  type AlarmIssueResult,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES_PATH = join(ROOT, "node_modules");
const STATE_PATH = resolve(ROOT, "data", "node-modules-loop-alarm", "state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "node-modules-loop-alarm", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[node-modules-loop-alarm]";
/** #5339: mesmo valor default do lote de alarmes "estado" recentes — 2
 * execuções limpas consecutivas sem o achado antes de fechar a issue
 * automaticamente. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Estado (idempotência) — mesmo padrão I/O de robots-txt-drift-check.ts ─

export function loadState(statePath: string = STATE_PATH): NodeModulesLoopAlarmState {
  if (!existsSync(statePath)) return emptyNodeModulesLoopAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<NodeModulesLoopAlarmState>;
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint
        : null;
    const checkedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    return { lastAlarmedFingerprint: fingerprint ?? null, lastCheckedAt: checkedAt ?? null };
  } catch {
    return emptyNodeModulesLoopAlarmState();
  }
}

export function saveState(state: NodeModulesLoopAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

// ─── Estado (dedup/reconciliação de ISSUE por achado, #5339) ──────────────
// Arquivo separado de STATE_PATH de propósito — mesmo racional dos demais
// alarmes deste repo: idempotência do E-MAIL (acima) e tracking de ISSUE
// por achado são preocupações independentes.

export function loadAlarmIssuesState(statePath: string = ALARM_ISSUES_STATE_PATH): AlarmIssuesState {
  if (!existsSync(statePath)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch {
    return emptyAlarmIssuesState();
  }
}

export function saveAlarmIssuesState(state: AlarmIssuesState, statePath: string = ALARM_ISSUES_STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/** Converte a avaliação de loop pendente no `AlarmFinding` genérico que
 * `scripts/lib/alarm-issues.ts` consome (#5339). `check` é fixo (só existe
 * 1 `node_modules` de checkout principal por repo). Nasce `P2` — mesma
 * prioridade da issue original #5571 (bug com workaround manual: `rm
 * node_modules && npm ci`). */
export function toAlarmFinding(evaluation: SymlinkLoopEvaluation): AlarmFinding {
  const isLoop = evaluation.status === "loop";
  return {
    check: "node-modules-loop",
    fingerprint: nodeModulesLoopFindingKey(evaluation),
    // #5553 — condição RE-CHECÁVEL (lstat+readlink a cada execução);
    // resolve sozinha assim que alguém rodar rm node_modules && npm ci.
    family: "estado",
    title: isLoop
      ? "[diar.ia.br] node_modules virou symlink auto-referente no checkout principal"
      : "[diar.ia.br] node_modules é um symlink com alvo ilegível no checkout principal",
    body: [
      "Achado automático do alarme `Diaria-Node-Modules-Loop-Alarm`",
      "(`scripts/node-modules-loop-alarm.ts`).",
      "",
      `Path: ${NODE_MODULES_PATH}`,
      `Detalhe: ${evaluation.message}`,
      "",
      `Recuperação: rm ${NODE_MODULES_PATH} && npm ci (dentro do checkout principal).`,
      "",
      "Contexto (#5571): causa provável é dois processos npm install/ci",
      "concorrentes escrevendo no MESMO node_modules do checkout principal —",
      "rodar npm ci/install SEMPRE em worktree isolado, nunca no checkout",
      "principal compartilhado (CLAUDE.md / context/overnight-dispatch-rules.md §3).",
      "",
      "Esta issue é criada automaticamente pelo alarme (#5339) e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

// ─── Checagem do filesystem (I/O) ──────────────────────────────────────────

/** Injeção de `lstatSync`/`readlinkSync` — só pra testabilidade determinística
 * (simular ENOENT vs. outros errno sem depender de permissão real do SO,
 * mesmo racional de `fetchFn` injetável nos alarmes de rede deste repo). */
export interface NodeModulesFsOps {
  lstatSync: typeof lstatSync;
  readlinkSync: typeof readlinkSync;
}

const defaultFsOps: NodeModulesFsOps = { lstatSync, readlinkSync };

/**
 * Inspeciona `nodeModulesPath` via `lstat` (NUNCA segue o link — seguro
 * mesmo se já for um loop) + `readlink` (lê só o alvo cru, também não
 * segue). `node_modules` ausente (clone fresco, antes do 1º `npm ci`) conta
 * como "não é symlink" — nada a alarmar.
 *
 * #5571 self-review (silent-failure-hunter): o catch do `lstat` é ESTREITO
 * a `ENOENT` de propósito — qualquer outro erro (`EACCES`, `ENOTDIR`,
 * `EIO`, ...) é, ele mesmo, uma anomalia no checkout digna de investigação
 * (inclusive a MESMA classe de corrida concorrente que este alarme existe
 * pra pegar) e PROPAGA pro catch de `main()` (log + `exitCode = 1`) em vez
 * de ser silenciosamente relatado como "node_modules ok".
 */
export function inspectNodeModules(
  nodeModulesPath: string = NODE_MODULES_PATH,
  fsOps: NodeModulesFsOps = defaultFsOps,
): SymlinkLoopInput {
  let isSymlink = false;
  try {
    isSymlink = fsOps.lstatSync(nodeModulesPath).isSymbolicLink();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { nodeModulesPath, isSymlink: false, linkTarget: null };
    }
    throw e;
  }

  let linkTarget: string | null = null;
  if (isSymlink) {
    try {
      linkTarget = fsOps.readlinkSync(nodeModulesPath);
    } catch (e) {
      linkTarget = null;
      console.warn(`${LOG_PREFIX} readlink falhou em ${nodeModulesPath}: ${(e as Error).message}`);
    }
  }

  return { nodeModulesPath, isSymlink, linkTarget };
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getStringArg(argv, "to");

  const input = inspectNodeModules();
  const evaluation = evaluateNodeModulesSymlink(input);
  console.log(`${LOG_PREFIX} ${evaluation.message}`);

  const state = loadState();

  // #5339 — reconcilia issue ANTES de montar o e-mail (o e-mail cita a
  // issue do achado), mesmo padrão dos demais alarmes deste repo. Roda toda
  // execução não-dry-run, independente de um e-mail novo disparar nesta
  // rodada.
  const alarmFindings: AlarmFinding[] = isNodeModulesLoopPending(evaluation) ? [toAlarmFinding(evaluation)] : [];
  const alarmState = loadAlarmIssuesState();
  let issueRef: AlarmIssueResult | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
  } else {
    const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextState);
    const outcome = findingOutcomes[0];
    if (outcome) {
      issueRef = { issueNumber: outcome.issueNumber, url: outcome.url, action: outcome.action, error: outcome.error };
      if (outcome.action === "failed") {
        console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
      } else {
        console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
      }
    }
  }

  if (shouldAlarmNodeModulesLoop(state, evaluation)) {
    const { subject, body } = buildNodeModulesLoopAlarmEmail(evaluation, NODE_MODULES_PATH, new Date(), issueRef);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // Sem try/catch — mesmo racional de robots-txt-drift-check.ts/
      // worker-drift-check.ts: se o envio falhar, o cursor abaixo não
      // avança (aborta antes do saveState), então a próxima execução tenta
      // alarmar de novo em vez de marcar este loop como "já avisado" sem o
      // editor ter recebido nada.
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (sem loop pendente, ou o mesmo loop já foi alarmado antes).`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: cursor NÃO avançado.`);
    return;
  }

  saveState(advanceNodeModulesLoopAlarmState(evaluation, new Date()));
}

if (isMainModule(import.meta.url)) {
  // process.exitCode em vez de process.exit() — este catch roda DEPOIS de
  // um await de rede (sendGmailMessage), mesmo cenário UV_HANDLE_CLOSING
  // documentado em worker-drift-check.ts/robots-txt-drift-check.ts.
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
