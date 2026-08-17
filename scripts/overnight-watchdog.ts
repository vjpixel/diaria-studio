#!/usr/bin/env npx tsx
/**
 * overnight-watchdog.ts (#2688)
 *
 * Watchdog EXTERNO para rodadas overnight. Detecta stall por tempo,
 * independente do coordenador (event-driven — não cobre silêncio total).
 *
 * Detecta rodada ativa:
 *   data/overnight/{AAMMDD}/plan.json existe E report.md ausente.
 *
 * Mede "última atividade" como max(mtime plan.json, último evento run-log
 * com agent:"overnight" para a edição desta rodada).
 *
 * Stall = "última atividade" > STALL_THRESHOLD_MIN (default 60) min atrás.
 *
 * Ação em caso de stall:
 *   (a) Append em stall_events no plan.json (com dedup por janela de 30 min)
 *   (b) Emite evento no run-log via scripts/log-event.ts
 *   (c) Renderiza halt banner via scripts/render-halt-banner.ts
 *   (d) Push por e-mail (#5341 — via `scripts/lib/push-notify.ts`, reusa a
 *       credencial OAuth do Gmail).
 *
 * #2958: a task Task Scheduler roda com `ExecutionTimeLimit` de 5 min
 * (`setup-watchdog-schedule.ps1`) — se estourado, o Task Scheduler força o
 * término e grava `Last Result: 267014` (0x41306 SCHED_S_TASK_TERMINATED),
 * exatamente o sintoma reportado no incidente 260704 (task presente e
 * habilitada, mas a execução não completa). Este módulo tinha DOIS pontos de
 * I/O sem timeout que podiam bloquear indefinidamente e nunca devolver o
 * controle ao processo: os `execFileSync` para `render-halt-banner.ts`/
 * `log-event.ts` (default do Node = sem timeout) e o `fetch` do alerta
 * push (sem `AbortSignal` na época; #5341 migrou pro Gmail, com timeout
 * explícito via `withTimeout`). Qualquer hang em um
 * desses (rede lenta, ou um dos scripts filhos travando em I/O) fazia o
 * watchdog inteiro ficar pendurado até o Task Scheduler matá-lo aos 5 min —
 * causa raiz plausível do 267014. Fix: timeout explícito nos dois pontos —
 * se estourar, a chamada lança, o `catch` já existente trata como falha
 * suave, e o processo SEGUE e SAI normalmente em vez de travar (diagnóstico
 * ao vivo em 260706: task saudável, `Last Result: 0` — o sintoma não
 * reproduziu nesta checagem pontual, mas os dois hangs sem timeout eram bugs
 * reais e válidos de corrigir preventivamente independente da causa exata do
 * incidente histórico). De quebra, um terceiro bug adjacente encontrado ao
 * escrever o teste de regressão: `main()` rodava incondicionalmente ao
 * IMPORTAR o módulo (sem guard de CLI) — `test/overnight-watchdog.test.ts`
 * importa as funções puras exportadas aqui e, como efeito colateral,
 * disparava a lógica real do watchdog contra o `data/overnight/` de verdade
 * a cada `npm test`. Fix: mesmo guard de CLI já usado em
 * `scripts/lib/check-watchdog-armed.ts`.
 *
 * #3353: este módulo tinha o MESMO bug de leitura truncada que o #3264
 * corrigiu em `readPlanFromDir` (scripts/overnight-statusline.ts) — mas num
 * SEGUNDO leitor independente do mesmo `plan.json`, que nunca foi atualizado.
 * O `JSON.parse(readFileSync(...))` cru aqui tratava "arquivo ausente" e
 * "arquivo existe mas foi lido no meio de uma escrita não-atômica (JSON
 * truncado)" de forma idêntica: ambos caíam no mesmo `catch` e retornavam de
 * `main()` ANTES de gravar `stall_events`, emitir o evento no run-log,
 * renderizar o halt banner ou disparar o alerta push — a notificação de
 * stall inteira era pulada silenciosamente (só stderr, sem `process.exit(1)`,
 * sem crash reportável no Task Scheduler). Pior: este mesmo módulo grava
 * `plan.json` de volta (bloco STALL abaixo) via `writeFileSync` cru — ele
 * podia ser a própria ORIGEM da janela de truncamento que afeta a leitura
 * seguinte (sua ou a de `overnight-statusline.ts`). Fix (2 partes): (a) a
 * leitura agora delega para `readPlanFromDir` (retry síncrono imediato
 * quando o arquivo existe mas o parse falha — mesma função já usada e
 * testada pela statusline, evita duas implementações divergentes do mesmo
 * retry); (b) a escrita agora usa `writeFileAtomic`
 * (scripts/lib/atomic-write.ts — write-to-temp + fsync + rename atômico),
 * eliminando esta fonte de truncamento.
 *
 * Flags:
 *   --dry-run          Apenas diagnóstico; sem writes nem alertas.
 *   --threshold <min>  Override do limiar (default: 60 ou OVERNIGHT_WATCHDOG_STALL_MIN).
 *
 * GUARD DE PUBLICAÇÃO: este script é só observabilidade/alerta.
 * NUNCA toca Beehiiv/LinkedIn/Facebook/Brevo, PRs, nem merge.
 *
 * #5293 item 3 introduziu suporte a DOIS kinds na mesma invocação —
 * `data/overnight/{AAMMDD}/` e `data/continuo/{AAMMDD}/`. **#5390
 * (15/08/2026) voltou `WATCHED_KINDS` a vigiar só `"overnight"`** — o wake
 * ocioso de `/diaria-continuo` passou de 20-30min pra 4h, e não existe
 * limiar de stall abaixo de 4h que não dispare em toda janela ociosa
 * saudável dessa skill (ver `WATCHED_KINDS` mais abaixo pro rationale
 * completo). O maquinário multi-kind (`WatchableKind`, o ramo
 * `kind === "continuo"` de `findActiveRun` — que por desenho nunca escreve
 * `report.md`, "ativa" ali é só "existe plan.json" no diretório mais
 * recente —, `hasHealthyIdleSession`/`HEALTHY_IDLE_PHASES`) continua no
 * arquivo, só não é mais exercitado em produção: uma sessão contínua
 * parada de propósito (aguardando resposta do editor, ou pausada pelo
 * guard de colisão com a edição diária) sinalizava isso via
 * `hasHealthyIdleSession` pra este watchdog nunca disparar alerta nela —
 * mecanismo preservado, caso o kind volte a ser vigiado no futuro.
 *
 * Deve ser agendado externamente (Windows Task Scheduler, cron) para rodar
 * a cada 10–15 min. Ver docs/overnight-watchdog-setup.md.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveRunLogPath } from "./lib/run-log.ts";
import { mtimeMs } from "./lib/mtime.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { listActiveSessions } from "./lib/session-registry.ts";
import { readPlanFromDir, type PlanFileReaders } from "./overnight-statusline.ts";
import { PUSH_IO_TIMEOUT_MS, sendPushNotification } from "./lib/push-notify.ts";

// ---------------------------------------------------------------------------
// Pure / injectable helpers (exported for tests — #633)
// ---------------------------------------------------------------------------

export interface StallEvent {
  at: string;
  reason: string;
  resumed_at: string | null;
}

export interface PlanJson {
  started_at: string;
  stall_events: StallEvent[];
  [key: string]: unknown;
}

/**
 * Pure: detecta se houve stall dado os timestamps.
 * Injetar `nowMs` para testes determinísticos (sem depender de Date.now()).
 */
export function detectStall(
  lastActivityMs: number,
  nowMs: number,
  thresholdMin: number = 60,
): boolean {
  return nowMs - lastActivityMs >= thresholdMin * 60_000;
}

/**
 * Pure: dado mtime do plan.json e o último timestamp do run-log, retorna
 * a fonte-de-verdade canônica de "última atividade" (max de ambos).
 * null = fonte indisponível; trata como 0 (mais antigo possível).
 */
export function computeLastActivity(
  planMtimeMs: number | null,
  runLogLastTs: number | null,
): { ts: number; source: string } {
  const planMs = planMtimeMs ?? 0;
  const logMs = runLogLastTs ?? 0;

  if (planMs === 0 && logMs === 0) {
    return { ts: 0, source: "nenhuma" };
  }
  if (planMs >= logMs) {
    return { ts: planMs, source: "plan.json mtime" };
  }
  return { ts: logMs, source: "run-log" };
}

/**
 * Diretórios de rodada reconhecidos por `findActiveRun` (#5520).
 *
 * `AAMMDD` com sufixo opcional de letra: a 2ª rodada de um mesmo dia é
 * `260816b`, a 3ª `260816c`, e assim por diante. O padrão anterior
 * (`/^\d{6}$/`) só casava a PRIMEIRA rodada do dia — e como rodada com sufixo
 * virou o caso dominante (16/08/2026 teve 6 rodadas, 5 delas sufixadas), o
 * watchdog não enxergava nenhuma rodada real: sobravam só diretórios antigos
 * de 6 dígitos puros que morreram sem escrever `report.md`, e o mais recente
 * deles (`260707`, de 7 de julho) era eleito "ativo" indefinidamente.
 *
 * A ordenação lexicográfica de `sort()` continua correta com o sufixo:
 * `260816` < `260816b` < `260816f`, e `260816f` < `260817`.
 */
export const RUN_DIR_PATTERN = /^\d{6}[a-z]?$/;

/**
 * Idade máxima de atividade real antes de uma rodada deixar de contar como
 * "ativa" (#5520).
 *
 * `findActiveRun` elege como ativa a rodada mais recente com `plan.json` e sem
 * `report.md` — mas uma rodada que morreu sem escrever o relatório (crash,
 * sessão morta por fora) casa esse critério PARA SEMPRE. Sem expiração, assim
 * que a rodada legítima do dia termina e escreve `report.md`, o scan cai de
 * volta na carcaça mais recente e recomeça a alarmar. Foi exatamente o que
 * manteve `260707` como "rodada ativa" por 5 semanas.
 *
 * 24h é folgado de propósito: uma rodada overnight real jamais fica um dia
 * inteiro sem NENHUM evento no run-log e sem tocar `plan.json` — se ficou, ou
 * está morta, ou o stall já foi reportado muitas vezes e o alerta perdeu
 * utilidade.
 */
export const ABANDONED_RUN_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Tolerância para reconhecer o mtime de `plan.json` como escrita do PRÓPRIO
 * watchdog (#5520).
 *
 * O bloco STALL grava `stall_events` de volta no `plan.json` — o que refresca
 * o mtime que `computeLastActivity` lê como "última atividade" na execução
 * seguinte. Numa rodada sem atividade genuína, o watchdog vira a única fonte
 * de "atividade" da rodada que ele mesmo vigia: `elapsed_min` nunca cresce,
 * nunca converge, e o alarme se repete a cada ciclo indefinidamente.
 *
 * A escrita acontece a milissegundos do `stall_event.at` registrado, então 2
 * min cobre folgadamente qualquer lentidão de FS. Uma escrita GENUÍNA do
 * coordenador dentro dessa janela seria mascarada, mas só até o próximo tick
 * (10-15 min depois), quando o mtime já não casa com nenhum `stall_event`.
 */
export const SELF_WRITE_TOLERANCE_MS = 2 * 60_000;

/**
 * Pure: o mtime de `plan.json` veio de uma escrita do próprio watchdog?
 *
 * Compara contra os `stall_events` que ele mesmo gravou — cada um carrega o
 * instante exato (`at`) em que a escrita ocorreu.
 */
export function isSelfInflictedPlanMtime(
  planMtimeMs: number | null,
  stallEvents: StallEvent[] | undefined,
  toleranceMs: number = SELF_WRITE_TOLERANCE_MS,
): boolean {
  if (planMtimeMs === null) return false;
  if (!stallEvents || stallEvents.length === 0) return false;

  return stallEvents.some((ev) => {
    const at = new Date(ev.at).getTime();
    if (isNaN(at)) return false;
    return Math.abs(planMtimeMs - at) <= toleranceMs;
  });
}

/**
 * Pure: verifica se já existe uma entrada de stall não-resolvida recente
 * (dentro da janela de dedup) para evitar spam de entradas repetidas.
 */
export function isDeduped(
  stallEvents: StallEvent[],
  dedupWindowMs: number,
  nowMs: number,
): boolean {
  if (!stallEvents || stallEvents.length === 0) return false;
  const last = stallEvents[stallEvents.length - 1];
  // Se o último stall já foi retomado, não é duplicata
  if (last.resumed_at) return false;
  const lastStallMs = new Date(last.at).getTime();
  return nowMs - lastStallMs < dedupWindowMs;
}

/**
 * Lê plan.json no branch de tratamento de stall de `main()`, delegando pra
 * `readPlanFromDir` (scripts/overnight-statusline.ts) em vez de um
 * `JSON.parse(readFileSync(...))` cru (#3353 — mesmo bug de leitura truncada
 * que o #3264 corrigiu no OUTRO leitor do mesmo arquivo).
 *
 * `readPlanFromDir` já cobre a distinção entre "arquivo genuinamente
 * ausente" (null imediato, sem retry) e "arquivo existe mas o parse falhou"
 * (1 retry síncrono imediato — cobre a janela sub-ms de uma escrita
 * não-atômica concorrente). Reusar essa função (em vez de reimplementar o
 * mesmo retry aqui) evita duas versões divergentes da mesma lógica.
 *
 * `readers` é injetável (mesmo padrão de `PlanFileReaders` da statusline)
 * pra permitir testes determinísticos de JSON truncado sem depender de
 * timing real de I/O concorrente — ver test/overnight-watchdog.test.ts.
 *
 * Retorna `PlanJson | null`; o cast é seguro porque `Plan` (statusline) e
 * `PlanJson` (watchdog) são ambos supersets abertos (`[key: string]:
 * unknown`) do mesmo documento em disco — só os campos obrigatórios
 * declarados em cada interface diferem (uso local de cada consumidor).
 */
export function readPlanForStallHandling(
  planPath: string,
  readers?: PlanFileReaders,
): PlanJson | null {
  const plan = readPlanFromDir(planPath, readers);
  return plan === null ? null : (plan as unknown as PlanJson);
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

/** Kinds de rodada que este watchdog sabe vigiar (#5293 item 3 — antes só "overnight"). */
export type WatchableKind = "overnight" | "continuo";

/**
 * Varre `data/{kind}/` e retorna a rodada ativa mais recente.
 *
 * Semântica de "ativa" difere por kind:
 *   - `overnight`: diretório com `plan.json` mas SEM `report.md` — `report.md`
 *     é o marcador de fim de rodada (a rodada encerra e escreve o relatório).
 *   - `continuo` (#5293): a skill **nunca** escreve `report.md` — por desenho,
 *     ela não termina (ver `.claude/skills/diaria-continuo/SKILL.md`, "Loop
 *     invariável"). "Ativa" aqui é simplesmente "existe `plan.json`" no
 *     diretório `{AAMMDD}` mais recente — a rotação diária de
 *     `scripts/lib/continuo-plan-rotation.ts` (item 5) garante que o mais
 *     recente lexicograficamente é sempre o dia corrente da sessão viva (ou
 *     o último dia antes de a sessão ter sido morta externamente — mesmo
 *     "risco" que `overnight` já aceita pra uma rodada crashada sem
 *     `report.md`: o watchdog trata como ativa até expirar por outro motivo,
 *     ex: fila de issues genuinamente parada, que É o cenário que o stall
 *     detection existe pra pegar).
 */
export function findActiveRun(
  rootDir: string,
  kind: WatchableKind = "overnight",
  opts: {
    /** Instante de referência para a expiração (injetável em teste). */
    nowMs?: number;
    /** Idade máxima de atividade real — ver `ABANDONED_RUN_MAX_AGE_MS`. */
    maxAgeMs?: number;
    /**
     * Resolve a última atividade REAL de uma rodada candidata. Injetável em
     * teste; em produção é `resolveRunActivity` (mtime de `plan.json` sem as
     * escritas do próprio watchdog + run-log sem os eventos próprios).
     */
    lastActivityOf?: (aammdd: string, planPath: string) => { ts: number; source: string };
  } = {},
): {
  aammdd: string;
  planPath: string;
  reportPath: string;
} | null {
  const kindDir = join(rootDir, "data", kind);
  if (!existsSync(kindDir)) return null;

  const {
    nowMs = Date.now(),
    maxAgeMs = ABANDONED_RUN_MAX_AGE_MS,
    lastActivityOf = (aammdd, planPath) => resolveRunActivity(rootDir, kind, aammdd, planPath),
  } = opts;

  let entries: string[];
  try {
    entries = readdirSync(kindDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && RUN_DIR_PATTERN.test(d.name))
      .map((d) => d.name)
      .sort(); // lexicographic = cronológico para YYMMDD[a-z]
  } catch {
    return null;
  }

  // Mais recente primeiro
  for (let i = entries.length - 1; i >= 0; i--) {
    const aammdd = entries[i];
    const dir = join(kindDir, aammdd);
    const planPath = join(dir, "plan.json");
    const reportPath = join(dir, "report.md");

    const isActive = kind === "continuo" ? existsSync(planPath) : existsSync(planPath) && !existsSync(reportPath);
    if (!isActive) continue;

    // #5520: rodada que casa o critério estrutural mas está sem atividade real
    // há mais de `maxAgeMs` é carcaça, não rodada ativa — segue procurando.
    // `ts === 0` (atividade desconhecida) NÃO expira: esse caso já tem
    // tratamento próprio a jusante (`skip_unknown_activity`).
    const { ts } = lastActivityOf(aammdd, planPath);
    if (ts > 0 && nowMs - ts > maxAgeMs) {
      console.log(
        `[watchdog] Rodada ${aammdd} (${kind}) sem atividade há ` +
          `${Math.round((nowMs - ts) / 3_600_000)}h — tratada como abandonada, não vigiada.`,
      );
      continue;
    }

    return { aammdd, planPath, reportPath };
  }
  return null;
}

/**
 * Última atividade REAL de uma rodada — `max(mtime de plan.json, último evento
 * do run-log)`, descontando em ambas as vias as escritas do próprio watchdog
 * (#5520).
 *
 * Fonte única para os dois consumidores que precisam desse número: a
 * expiração de rodada abandonada em `findActiveRun` e o diagnóstico de stall
 * em `runWatchdogForKind`. Antes do #5520 só o segundo existia, e computava o
 * mtime cru — o que fazia o watchdog contar as próprias escritas de
 * `stall_events` como atividade da rodada que ele vigia.
 */
export function resolveRunActivity(
  rootDir: string,
  kind: WatchableKind,
  aammdd: string,
  planPath: string,
): { ts: number; source: string } {
  const rawPlanMtime = mtimeMs(planPath);
  const plan = readPlanForStallHandling(planPath);
  const planMtime = isSelfInflictedPlanMtime(rawPlanMtime, plan?.stall_events)
    ? null
    : rawPlanMtime;

  return computeLastActivity(planMtime, getLastRunLogActivity(rootDir, aammdd, kind));
}

/**
 * Pure: o evento do run-log foi emitido pelo PRÓPRIO watchdog? (#5520)
 *
 * `emitRunLogEvent` grava `stall_detected` com `agent: kind` e
 * `edition: aammdd` — exatamente os campos que `getLastRunLogActivity` usa
 * pra reconhecer atividade da rodada. Numa rodada sem atividade genuína, o
 * alarme anterior do watchdog vira a "última atividade" do alarme seguinte,
 * fechando o mesmo loop descrito em `SELF_WRITE_TOLERANCE_MS` pela via do
 * run-log em vez do `plan.json`.
 *
 * O discriminador é `details.source` (`"overnight-watchdog"` /
 * `"continuo-watchdog"`), gravado por `emitRunLogEvent` — e não o
 * `message: "stall_detected"` sozinho, porque o COORDENADOR também emite
 * `stall_detected` (ex: subagente travado, #2768) e esse é sinal legítimo de
 * que a rodada está viva.
 */
export function isOwnWatchdogEvent(
  event: { message?: string; details?: { source?: string } | null },
  kind: WatchableKind,
): boolean {
  return (
    event.message === "stall_detected" &&
    event.details?.source === `${kind}-watchdog`
  );
}

/**
 * Extrai o timestamp mais recente do run-log para a edição/agente dado
 * (`agent`, default `"overnight"` — #5293 item 3 generaliza pra `"continuo"`).
 *
 * #5520: eventos emitidos pelo próprio watchdog são ignorados — ver
 * `isOwnWatchdogEvent`.
 */
export function getLastRunLogActivity(
  rootDir: string,
  aammdd: string,
  agent: WatchableKind = "overnight",
): number | null {
  const logPath = resolveRunLogPath(rootDir);
  if (!existsSync(logPath)) return null;

  let content: string;
  try {
    content = readFileSync(logPath, "utf-8");
  } catch {
    return null;
  }

  let lastTs: number | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as {
        agent?: string;
        edition?: string;
        timestamp?: string;
        message?: string;
        details?: { source?: string } | null;
      };
      if (isOwnWatchdogEvent(event, agent)) continue;
      if (
        event.agent === agent &&
        event.edition === aammdd &&
        event.timestamp
      ) {
        const ts = new Date(event.timestamp).getTime();
        if (!isNaN(ts) && (lastTs === null || ts > lastTs)) {
          lastTs = ts;
        }
      }
    } catch {
      // linha malformada — ignorar
    }
  }
  return lastTs;
}

/**
 * Fases de `session-registry.ts` (`heartbeat --phase X`) que o watchdog trata
 * como "parada de propósito" — não stall (#5293 item 3).
 *
 *   - `"aguardando-resposta"`: `/diaria-continuo` parada no passo 4/6 do loop
 *     ("Loop invariável", `.claude/skills/diaria-continuo/SKILL.md`) —
 *     `AskUserQuestion` bloqueante pendente, ou dormindo entre re-varreduras
 *     sem resposta ainda.
 *   - `"pausado-edicao"`: `/diaria-continuo` pausada pelo guard de colisão
 *     com `Diaria-Edicao-Diaria` (ver "Item 4" no SKILL.md) — diferente do
 *     overnight, que ENCERRA a rodada nesse guard (`preempted_by:
 *     "edicao_editorial"`), a sessão contínua só PAUSA e retoma depois.
 *
 * `/diaria-overnight` nunca grava nenhuma destas fases (Regra 1: zero
 * `AskUserQuestion` pós-briefing, e o guard de colisão editorial dele
 * ENCERRA a rodada em vez de pausar) — a checagem abaixo roda pros dois
 * kinds por uniformidade, mas só tem efeito prático em `continuo`.
 */
export const HEALTHY_IDLE_PHASES = ["aguardando-resposta", "pausado-edicao"] as const;

/**
 * `true` se existe, em `session-registry.ts`, uma sessão ATIVA (não-stale —
 * mesma janela de 24h de `listActiveSessions`) do `kind` dado com `phase`
 * num dos `HEALTHY_IDLE_PHASES`. Fail-soft: `session-registry.ts` ausente ou
 * corrompido nunca lança aqui — `listActiveSessions` já é fail-soft por
 * contrato (array vazio em qualquer falha de leitura), então esta função só
 * precisa filtrar, nunca precisa de try/catch próprio.
 */
export function hasHealthyIdleSession(rootDir: string, kind: WatchableKind, nowMs: number): boolean {
  return listActiveSessions(rootDir, nowMs).some(
    (s) => s.kind === kind && s.phase !== undefined && (HEALTHY_IDLE_PHASES as readonly string[]).includes(s.phase),
  );
}

// ---------------------------------------------------------------------------
// Alert channels
// ---------------------------------------------------------------------------

// #3564/#5341: a implementação de request/timeout foi extraída pra
// scripts/lib/push-notify.ts (reusada agora também pelo Studio UI — gate
// pendente/halt banner). `WATCHDOG_IO_TIMEOUT_MS` fica de pé como alias
// local só pra não quebrar `test/overnight-watchdog.test.ts` (#633 —
// regressão de import) e qualquer outro consumidor externo que já dependa
// dele; a lógica em si não é mais duplicada aqui.
export const WATCHDOG_IO_TIMEOUT_MS = PUSH_IO_TIMEOUT_MS;

async function sendPushAlert(subject: string, body: string): Promise<void> {
  const result = await sendPushNotification({ subject, body });
  if (!result.ok && !result.skipped) {
    process.stderr.write(`[watchdog] Notificação push falhou: ${result.error}\n`);
  }
}

function renderHaltBanner(
  rootDir: string,
  kind: WatchableKind,
  aammdd: string,
  elapsedMin: number,
  thresholdMin: number,
): void {
  const haltScript = resolve(rootDir, "scripts", "render-halt-banner.ts");
  if (!existsSync(haltScript)) {
    process.stdout.write(
      `\n=== ${kind.toUpperCase()} WATCHDOG: STALL DETECTADO ===\n` +
        `Rodada ${aammdd} sem atividade há ${elapsedMin} min (limiar: ${thresholdMin} min).\n` +
        `Verifique a sessão ${kind} e responda 'retry' pra retomar ou 'abort' pra encerrar.\n` +
        `=========================================\n`,
    );
    return;
  }

  try {
    const out = execFileSync(
      "npx",
      [
        "tsx",
        haltScript,
        "--stage",
        `${kind} — rodada ${aammdd}`,
        "--reason",
        `stall detectado pelo watchdog externo: ${elapsedMin} min sem atividade (limiar ${thresholdMin} min)`,
        "--action",
        `verifique a sessão ${kind} no terminal; responda 'retry' pra retomar ou 'abort' pra encerrar`,
      ],
      {
        cwd: rootDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: WATCHDOG_IO_TIMEOUT_MS,
      },
    );
    process.stdout.write(out);
  } catch (e: unknown) {
    // Se render-halt-banner falhou, mostra fallback inline
    const err = e as { stdout?: string };
    process.stdout.write(
      err.stdout ??
        `[watchdog] STALL: rodada ${aammdd}, ${elapsedMin} min sem atividade.\n`,
    );
  }
}

function emitRunLogEvent(
  rootDir: string,
  kind: WatchableKind,
  aammdd: string,
  elapsedMin: number,
  lastSource: string,
): void {
  const logScript = resolve(rootDir, "scripts", "log-event.ts");
  if (!existsSync(logScript)) return;

  try {
    execFileSync(
      "npx",
      [
        "tsx",
        logScript,
        "--edition",
        aammdd,
        "--agent",
        kind,
        "--level",
        "warn",
        "--message",
        "stall_detected",
        "--details",
        JSON.stringify({
          reason: "unknown",
          source: `${kind}-watchdog`,
          elapsed_min: elapsedMin,
          last_activity_source: lastSource,
        }),
      ],
      { cwd: rootDir, stdio: "pipe", timeout: WATCHDOG_IO_TIMEOUT_MS },
    );
  } catch {
    process.stderr.write("[watchdog] Aviso: falha ao emitir evento no run-log.\n");
  }
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  dryRun: boolean;
  thresholdMin: number;
} {
  const dryRun = argv.includes("--dry-run");
  let thresholdMin = parseInt(process.env.OVERNIGHT_WATCHDOG_STALL_MIN ?? "60", 10);
  if (isNaN(thresholdMin) || thresholdMin < 1) thresholdMin = 60;

  const tIdx = argv.indexOf("--threshold");
  if (tIdx !== -1 && argv[tIdx + 1]) {
    const v = parseInt(argv[tIdx + 1], 10);
    if (!isNaN(v) && v > 0) thresholdMin = v;
  }

  return { dryRun, thresholdMin };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export type WatchdogDiagnosisAction = "skip_unknown_activity" | "dry_run" | "no_stall" | "healthy_idle" | "stall";

export interface WatchdogDiagnosis {
  action: WatchdogDiagnosisAction;
  lines: string[];
  /**
   * #2781: `elapsedMin` era recomputado de forma duplicada aqui dentro E em
   * `main()` (mesma fórmula, 2 lugares) — risco de re-divergir se um dos dois
   * mudar sem o outro (o mesmo padrão que motivou a extração original de
   * `diagnoseWatchdogActivity`, ver docstring acima). Agora `main()` reusa
   * este valor em vez de recalcular.
   */
  elapsedMin: number;
}

/**
 * #2715 item 5: decisão pura de diagnóstico, extraída de `main()` pra ser
 * testável sem depender de filesystem/subprocess.
 *
 * A ordem dos guards importa: `lastActivityMs === 0` (mtime indisponível —
 * ex: race de write/stat no Windows) tem que ser checado ANTES do ramo
 * `dryRun`, não depois. Antes do fix, o caminho `--dry-run` em `main()`
 * retornava cedo demais (era o PRIMEIRO branch) sem nunca passar pelo guard
 * de `lastActivityMs === 0` — então `detectStall(0, nowMs, ...)` calculava
 * "inatividade" a partir de epoch 1970 e SEMPRE reportava "STALL detectado"
 * com elapsed absurdo, mesmo numa rodada recém-iniciada sem timestamp ainda
 * disponível. O caminho normal (não-dry-run) já pulava esse falso positivo —
 * dry-run precisa do MESMO guard (não uma cópia divergente que pode
 * re-regredir), daí a extração para uma única função compartilhada.
 */
export function diagnoseWatchdogActivity(params: {
  aammdd: string;
  dryRun: boolean;
  lastActivityMs: number;
  lastSource: string;
  nowMs: number;
  thresholdMin: number;
  /**
   * #5293 item 3: `true` quando `hasHealthyIdleSession` encontrou uma sessão
   * registrada (`session-registry.ts`) do mesmo kind com `phase` num dos
   * `HEALTHY_IDLE_PHASES` (ex: `/diaria-continuo` parada no passo 4/6 do loop
   * — esperando resposta do editor, ou pausada pelo guard de colisão
   * editorial). Distingue "parada de propósito, saudável" de "travada" — sem
   * isso, uma sessão contínua saudável dispara o MESMO alerta de stall que
   * este mecanismo existe pra evitar (mesmo princípio do incidente 260706/07,
   * #3037/#3038, registrado em `.claude/skills/diaria-continuo/SKILL.md`
   * §"Risco aceito" — não confundir com #2768, que é o guard de subagente
   * travado do coordenador overnight, um mecanismo diferente).
   */
  isHealthyIdle: boolean;
}): WatchdogDiagnosis {
  const { aammdd, dryRun, lastActivityMs, lastSource, nowMs, thresholdMin, isHealthyIdle } = params;
  const elapsedMin = Math.round((nowMs - lastActivityMs) / 60_000);

  if (lastActivityMs === 0) {
    const prefix = dryRun ? "[watchdog] DRY-RUN — " : "[watchdog] ";
    const suffix = dryRun ? " (sem writes/alertas de qualquer forma em dry-run)" : "";
    return {
      action: "skip_unknown_activity",
      lines: [`${prefix}Rodada ativa ${aammdd} mas sem timestamp de atividade. Skipping${suffix}.`],
      elapsedMin,
    };
  }

  const isStall = detectStall(lastActivityMs, nowMs, thresholdMin);

  if (dryRun) {
    return {
      action: "dry_run",
      lines: [
        `[watchdog] DRY-RUN — rodada ativa: ${aammdd}`,
        `[watchdog] Última atividade: ${new Date(lastActivityMs).toISOString()} (fonte: ${lastSource})`,
        `[watchdog] Inatividade: ${elapsedMin} min (limiar: ${thresholdMin} min)`,
        `[watchdog] → ${isStall ? "STALL detectado" : "sem stall"}${
          isStall && isHealthyIdle ? " — mas sessão registrada como aguardando-resposta/pausada, seria tratado como healthy_idle fora de dry-run" : ""
        } (dry-run, sem writes/alertas)`,
      ],
      elapsedMin,
    };
  }

  if (!isStall) {
    return {
      action: "no_stall",
      lines: [`[watchdog] Rodada ${aammdd} ativa, sem stall (${elapsedMin}/${thresholdMin} min).`],
      elapsedMin,
    };
  }

  if (isHealthyIdle) {
    return {
      action: "healthy_idle",
      lines: [
        `[watchdog] Rodada ${aammdd} sem atividade há ${elapsedMin} min, mas sessão registrada como ` +
          `aguardando-resposta/pausada (session-registry.ts) — não é stall. Skipping.`,
      ],
      elapsedMin,
    };
  }

  return { action: "stall", lines: [], elapsedMin };
}

/**
 * Roda o diagnóstico/ação de stall para UM kind (`overnight` ou `continuo`,
 * #5293 item 3). Extraído de `main()` pra permitir rodar múltiplos kinds na
 * mesma invocação do watchdog sem duplicar a lógica — `data/overnight/` e
 * `data/continuo/` podem ter rodadas ativas SIMULTANEAMENTE (máquinas/sessões
 * diferentes), e cada uma precisaria do próprio diagnóstico independente.
 * Continua aceitando `"continuo"` (parâmetro tipado, não hardcoded pra
 * `"overnight"`), mas desde #5390 `WATCHED_KINDS` (abaixo) não inclui mais
 * esse kind em produção — ver o rationale lá.
 */
async function runWatchdogForKind(
  ROOT: string,
  kind: WatchableKind,
  dryRun: boolean,
  thresholdMin: number,
): Promise<void> {
  const active = findActiveRun(ROOT, kind);

  if (!active) {
    console.log(`[watchdog] Nenhuma rodada ${kind} ativa detectada.`);
    return;
  }

  const { aammdd, planPath } = active;
  const nowMs = Date.now();
  const thresholdMs = thresholdMin * 60_000;

  // #5520: fonte única com `findActiveRun` — desconta as escritas do próprio
  // watchdog (`stall_events` no plan.json, eventos `stall_detected` no
  // run-log), que antes realimentavam o alarme indefinidamente.
  const { ts: lastActivityMs, source: lastSource } = resolveRunActivity(
    ROOT,
    kind,
    aammdd,
    planPath,
  );
  const isHealthyIdle = hasHealthyIdleSession(ROOT, kind, nowMs);

  const diagnosis = diagnoseWatchdogActivity({
    aammdd,
    dryRun,
    lastActivityMs,
    lastSource,
    nowMs,
    thresholdMin,
    isHealthyIdle,
  });

  for (const line of diagnosis.lines) console.log(line);

  if (diagnosis.action !== "stall") return;

  // #2781: `elapsedMin` usado no bloco STALL abaixo (emitRunLogEvent,
  // renderHaltBanner, alerta push) vem de `diagnosis.elapsedMin` — não é
  // recomputado aqui. Antes essa mesma fórmula existia duplicada em
  // `diagnoseWatchdogActivity` E em `main()`, com risco de os 2 valores
  // divergirem se um fosse alterado sem o outro.
  const { elapsedMin } = diagnosis;

  // --- STALL DETECTADO ---

  const plan = readPlanForStallHandling(planPath);
  if (plan === null) {
    process.stderr.write(`[watchdog] Erro ao ler plan.json: ${planPath}\n`);
    return;
  }

  // Dedup: janela = metade do threshold (nunca menos de 15 min)
  const dedupWindowMs = Math.max(Math.floor(thresholdMs / 2), 15 * 60_000);
  if (isDeduped(plan.stall_events ?? [], dedupWindowMs, nowMs)) {
    console.log(
      `[watchdog] Stall já registrado recentemente (dedup ${
        dedupWindowMs / 60_000
      } min). Skipping.`,
    );
    return;
  }

  const stallEvent: StallEvent = {
    at: new Date(nowMs).toISOString(),
    reason: "unknown",
    resumed_at: null,
  };

  // (a) Append stall_events no plan.json
  // #3353: writeFileAtomic (write-to-temp + fsync + rename) em vez de
  // writeFileSync cru — este módulo era, ele próprio, uma fonte adicional da
  // race de truncamento que afeta os leitores de plan.json (esta função e
  // readPlanFromDir/overnight-statusline.ts).
  plan.stall_events = [...(plan.stall_events ?? []), stallEvent];
  try {
    writeFileAtomic(planPath, JSON.stringify(plan, null, 2) + "\n");
  } catch {
    process.stderr.write(`[watchdog] Erro ao gravar stall_event em plan.json.\n`);
  }

  // (b) Emite evento no run-log
  emitRunLogEvent(ROOT, kind, aammdd, elapsedMin, lastSource);

  // (c) Renderiza halt banner
  renderHaltBanner(ROOT, kind, aammdd, elapsedMin, thresholdMin);

  // (d) Push por e-mail (#5341, fail-soft TOTAL)
  await sendPushAlert(
    `[diar.ia.br ${kind}] STALL detectado — rodada ${aammdd}`,
    [
      `Rodada ${aammdd} sem atividade há ${elapsedMin} min (limiar: ${thresholdMin} min).`,
      `Fonte: ${lastSource}.`,
      `Verifique a sessão ${kind} e responda 'retry' pra retomar ou 'abort' pra encerrar.`,
    ].join("\n"),
  );

  console.log(
    `[watchdog] Stall registrado: rodada ${aammdd} (${kind}) — ${elapsedMin} min sem atividade.`,
  );
}

/**
 * Kinds vigiados por esta invocação do watchdog. `continuo` foi removido
 * daqui em #5390 (15/08/2026): com o wake ocioso de `/diaria-continuo`
 * alongado pra 4h (`.claude/skills/diaria-continuo/SKILL.md`, seção
 * "Cadência do wake em modo ocioso"), o limiar de stall de 60 min
 * (`STALL_THRESHOLD_MIN`) passou a disparar em TODA sessão contínua ociosa
 * — o alarme virava ruído garantido, não sinal, porque não existe limiar
 * <4h que distinga "ociosa de propósito" de "travada de verdade" sem
 * disparar em toda janela ociosa saudável. O maquinário que o kind
 * `"continuo"` precisa (`WatchableKind`, o ramo `kind === "continuo"` de
 * `findActiveRun`, `HEALTHY_IDLE_PHASES`, `hasHealthyIdleSession`)
 * **continua no arquivo, intacto** — custo de manter é ~zero, e reverter
 * esta decisão vira só devolver `"continuo"` a este array. Efeito colateral
 * aceito (documentado na issue de origem): uma sessão `continuo`
 * genuinamente travada não gera mais halt banner/push automático deste
 * watchdog — só o editor notando por fora.
 */
export const WATCHED_KINDS: readonly WatchableKind[] = ["overnight"];

/**
 * Pure-ish orquestração do loop multi-kind (#5293 fleet review, achado 3),
 * extraída de `main()` pra ser testável sem I/O real — `runOne` é
 * injetável (produção: `runWatchdogForKind`; teste: um fake que lança pra
 * simular um kind quebrado). Cada `kind` roda no PRÓPRIO try/catch: uma
 * exceção ao processar um kind NUNCA impede os demais de serem tentados —
 * sem isso, um bug isolado num helper (shape inesperado de `plan.json`,
 * etc) abortava o loop inteiro antes de sequer tentar o kind seguinte,
 * contradizendo a premissa deste item ("vigia todos os kinds vigiados na
 * mesma invocação"). Retorna `true` se ALGUM kind falhou — `main()` usa
 * isso pra decidir o exit code, sem deixar essa decisão short-circuitar o
 * loop em si.
 */
export async function runAllWatchedKinds(
  kinds: readonly WatchableKind[],
  runOne: (kind: WatchableKind) => Promise<void>,
  onError: (kind: WatchableKind, error: unknown) => void = (kind, e) =>
    process.stderr.write(`[watchdog] Erro ao processar kind=${kind}: ${String(e)}\n`),
): Promise<boolean> {
  let anyFailed = false;
  for (const kind of kinds) {
    try {
      await runOne(kind);
    } catch (e) {
      anyFailed = true;
      onError(kind, e);
    }
  }
  return anyFailed;
}

async function main(): Promise<void> {
  loadProjectEnv();

  const ROOT = resolve(process.cwd());
  const { dryRun, thresholdMin } = parseArgs(process.argv.slice(2));

  const anyFailed = await runAllWatchedKinds(WATCHED_KINDS, (kind) =>
    runWatchdogForKind(ROOT, kind, dryRun, thresholdMin),
  );
  if (anyFailed) process.exitCode = 1;
}

// #2958: sem este guard, importar o módulo (ex: test/overnight-watchdog.test.ts
// importando as funções puras exportadas acima) também disparava main() como
// efeito colateral do import — rodando a lógica real do watchdog (leitura de
// data/overnight/, e potencialmente emitRunLogEvent/renderHaltBanner/push
// se uma rodada real estivesse em stall) durante `npm test`. Mesmo padrão de
// guard já usado em scripts/lib/check-watchdog-armed.ts.
if (isMainModule(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`[watchdog] Erro fatal: ${String(e)}\n`);
    process.exit(1);
  });
}
