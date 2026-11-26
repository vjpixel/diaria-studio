/**
 * scripts/lib/brevo-stage5-background.ts (#14037)
 *
 * Registro em disco do dispatch Brevo diária da Etapa 5 quando ele roda em
 * BACKGROUND. Antes do #14037 o `brevo-diaria-stage5-dispatch.ts` rodava no
 * mesmo turno do dispatch social e segurava a sessão por 300 a 450 s; agora
 * o orchestrator o lança com `run_in_background` logo depois do §5c-pre e
 * junta o resultado (`brevo-diaria-stage5-join.ts`) antes do sentinel do §5h.
 *
 * Um arquivo POR LANÇAMENTO (`_internal/05-brevo-stage5/{launch_id}.json`),
 * nunca sobrescrito por outro lançamento: o processo grava `running` (pid +
 * host) ao começar e `done` (exit code + o mesmo JSON do stdout) ao terminar.
 * Os sub-scripts que fazem o trabalho (`brevo-diaria-run.ts`,
 * `publish-daily-brevo.ts`) gravam o próprio pid em
 * `{launch_id}.worker.json` (preload `record-worker-pid.mjs`), e "processo
 * morto" só vale quando nem o dispatch nem o worker estão vivos.
 *
 * O resultado gravado é o JSON do dispatch, sem reinterpretar: a semântica de
 * falha do canal (fail-soft, `ok`/`already_done`/`skipped`/`failed`) segue
 * a mesma do §5c-3 item 5 do playbook.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { lockHostId } from "./file-lock.ts";

/** Pasta dos registros, relativa à pasta da edição. */
export const BREVO_STAGE5_RECORD_DIR = "_internal/05-brevo-stage5";

/** Teto total do Brevo em background, contado do `started_at` do registro (#14037). */
export const DEFAULT_MAX_TOTAL_MS = 30 * 60_000;

/** Exit dedicado do dispatch que recusa iniciar porque outro lançamento está ativo. */
export const BUSY_EXIT_CODE = 5;

/**
 * Exit do join quando o registro deste lançamento não existe e há exatamente
 * um outro lançamento `running` na edição: juntar o `active_launch_id`.
 */
export const OTHER_ACTIVE_EXIT_CODE = 6;

/** Nome de arquivo seguro (Windows recusa `:`) para um launch id. */
export function launchFileStem(launchId: string): string {
  return launchId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function brevoStage5RecordDir(editionDir: string): string {
  return resolve(editionDir, ...BREVO_STAGE5_RECORD_DIR.split("/"));
}

export function brevoStage5RecordPath(editionDir: string, launchId: string): string {
  return resolve(brevoStage5RecordDir(editionDir), `${launchFileStem(launchId)}.json`);
}

/** Arquivo onde cada sub-script do dispatch grava o próprio pid (preload). */
export function brevoStage5WorkerPidPath(editionDir: string, launchId: string): string {
  return resolve(brevoStage5RecordDir(editionDir), `${launchFileStem(launchId)}.worker.json`);
}

interface RecordBase {
  /**
   * Id do lançamento, passado pelo orchestrator (`--launch-id`) ao dispatch e
   * ao join. O join só aceita o registro deste lançamento.
   */
  launch_id: string;
  pid: number;
  host: string;
  started_at: string;
}

export type BrevoStage5Record =
  | (RecordBase & { state: "running" })
  | (RecordBase & {
      state: "done";
      finished_at: string;
      exit_code: number;
      /** JSON que o dispatch imprimiu no stdout (`Stage5BrevoResult`), sem reinterpretação. */
      result: { status: string; [k: string]: unknown };
    });

export function writeBrevoStage5Record(editionDir: string, record: BrevoStage5Record): void {
  mkdirSync(brevoStage5RecordDir(editionDir), { recursive: true });
  writeFileAtomic(brevoStage5RecordPath(editionDir, record.launch_id), JSON.stringify(record, null, 2) + "\n");
}

export type ReadRecordOutcome =
  | { kind: "missing" }
  | { kind: "invalid"; error: string }
  | { kind: "ok"; record: BrevoStage5Record };

/** Pura sobre o texto lido: valida o shape mínimo que o join usa. */
export function parseBrevoStage5Record(raw: string): ReadRecordOutcome {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { kind: "invalid", error: `JSON ilegível: ${(e as Error).message}` };
  }
  if (!data || typeof data !== "object") return { kind: "invalid", error: "registro não é objeto" };
  const r = data as Record<string, unknown>;
  if (typeof r.pid !== "number" || typeof r.host !== "string" || typeof r.started_at !== "string" || typeof r.launch_id !== "string") {
    return { kind: "invalid", error: "registro sem pid/host/started_at/launch_id" };
  }
  if (r.state === "running") return { kind: "ok", record: r as unknown as BrevoStage5Record };
  if (r.state === "done") {
    const result = r.result as Record<string, unknown> | undefined;
    if (typeof r.exit_code !== "number" || !result || typeof result.status !== "string") {
      return { kind: "invalid", error: "registro done sem exit_code/result.status" };
    }
    return { kind: "ok", record: r as unknown as BrevoStage5Record };
  }
  return { kind: "invalid", error: `state desconhecido: ${JSON.stringify(r.state)}` };
}

export function readBrevoStage5Record(editionDir: string, launchId: string): ReadRecordOutcome {
  const path = brevoStage5RecordPath(editionDir, launchId);
  if (!existsSync(path)) return { kind: "missing" };
  try {
    return parseBrevoStage5Record(readFileSync(path, "utf8"));
  } catch (e) {
    return { kind: "invalid", error: (e as Error).message };
  }
}

/** Todos os registros legíveis da edição (outros lançamentos inclusive). */
export function listBrevoStage5Records(editionDir: string): BrevoStage5Record[] {
  const dir = brevoStage5RecordDir(editionDir);
  if (!existsSync(dir)) return [];
  const out: BrevoStage5Record[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.endsWith(".worker.json")) continue;
    try {
      const parsed = parseBrevoStage5Record(readFileSync(resolve(dir, name), "utf8"));
      if (parsed.kind === "ok") out.push(parsed.record);
    } catch {
      // arquivo sumiu/está sendo trocado: ignorar nesta leitura
    }
  }
  return out;
}

/** Pid gravado pelo sub-script em execução (preload), ou `undefined`. */
export function readWorkerPid(editionDir: string, launchId: string): number | undefined {
  const path = brevoStage5WorkerPidPath(editionDir, launchId);
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof data.pid === "number" ? data.pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Identidade do host para conferir pid: `lockHostId()` de `file-lock.ts`
 * (hostname + namespace de PID no Linux). No `300` o sandbox tem outro
 * namespace de PID com o mesmo hostname; comparar só o hostname faria um pid
 * de outro namespace parecer morto (ou vivo) daqui.
 */
export function currentHost(): string {
  return lockHostId();
}

/** Remove o pid do worker ao fim do lançamento (#14037): pid reciclado não pode manter o lançamento "vivo". */
export function removeWorkerPidFile(editionDir: string, launchId: string): void {
  rmSync(brevoStage5WorkerPidPath(editionDir, launchId), { force: true });
}

/** `process.kill(pid, 0)`: ESRCH = morto; EPERM = existe (outro usuário). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LivenessContext {
  host: string;
  isPidAlive: (pid: number) => boolean;
  /** Pid do sub-script em execução daquele lançamento, quando gravado. */
  workerPidOf: (launchId: string) => number | undefined;
  nowEpochMs: number;
  maxTotalMs: number;
}

/**
 * Scripts cujo processo conta como "o dispatch Brevo desta edição" ao
 * conferir um pid vivo depois do teto (#14096): o próprio dispatch e os dois
 * sub-scripts que ele roda (os que gravam o `.worker.json`).
 */
export const BREVO_STAGE5_PROCESS_MARKERS = [
  "brevo-diaria-stage5-dispatch",
  "brevo-diaria-run",
  "publish-daily-brevo",
] as const;

/**
 * Linha de comando de um pid NESTE host, ou `undefined` quando não dá para
 * ler (fora do Linux, `/proc` ausente, processo sumiu). Só Linux: é onde o
 * `/proc/{pid}/cmdline` existe; no Windows `undefined` mantém o fail-closed
 * do `findActiveLaunch` (#14096).
 */
export function readProcessCommand(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return raw.replace(/\0/g, " ").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pura: o comando do processo bate com o dispatch Brevo? `undefined` =
 * comando ilegível (não dá para provar nem refutar).
 */
export function commandMatchesBrevoStage5(command: string | undefined): boolean | undefined {
  if (command === undefined) return undefined;
  return BREVO_STAGE5_PROCESS_MARKERS.some((m) => command.includes(m));
}

export interface ActiveLaunchContext extends LivenessContext {
  /** Comando de um pid neste host (injetável; produção: `readProcessCommand`). */
  processCommandOf?: (pid: number) => string | undefined;
  /**
   * `--force` do dispatch (#14096): o operador conferiu que o lançamento
   * antigo morreu (ou o matou por PID). Só desarma registros ACIMA do teto
   * que não deu para verificar; `running` dentro do teto com processo vivo
   * continua barrando.
   */
  force?: boolean;
}

/** Lançamento que barra outro de iniciar, com o porquê (vai no JSON `busy`). */
export interface ActiveLaunch {
  record: BrevoStage5Record;
  reason: string;
}

/**
 * Pura (#14096): decide se UM registro `running` barra outro lançamento.
 *
 * Dentro do teto (`maxTotalMs` desde o `started_at`): igual ao #14037, barra
 * se for de outro host (pid de outra máquina não se confere daqui) ou se o
 * dispatch/worker estiver vivo neste host.
 *
 * Acima do teto, fail-closed: só deixa passar quando dá para PROVAR que o
 * lançamento acabou. Neste host com dispatch e worker mortos → passa. Pid vivo
 * cujo comando não é do dispatch Brevo → pid reciclado (o motivo do teto no
 * Windows), passa. Pid vivo com o comando do dispatch → barra sempre, nem
 * `--force` desarma (é o 2º rascunho que o #14096 descreve). Pid vivo com
 * comando ilegível, ou registro de outro host → barra, salvo `--force`.
 */
export function activeLaunchReason(r: BrevoStage5Record, ctx: ActiveLaunchContext): string | null {
  if (r.state !== "running") return null;
  const startedMs = Date.parse(r.started_at);
  const pastCap = !Number.isFinite(startedMs) || ctx.nowEpochMs - startedMs >= ctx.maxTotalMs;
  if (!pastCap) {
    if (r.host !== ctx.host) return `running em outro host (${r.host}) dentro do teto`;
    return launchProcessAlive(r, ctx) ? "dispatch ou worker vivo neste host dentro do teto" : null;
  }
  const capMin = Math.round(ctx.maxTotalMs / 60_000);
  if (r.host !== ctx.host) {
    return ctx.force
      ? null
      : `running em outro host (${r.host}) acima do teto de ${capMin} min: daqui não dá para provar que terminou; ` +
          `conferir naquela máquina e no painel Brevo, e só então re-rodar com --force`;
  }
  const worker = ctx.workerPidOf(r.launch_id);
  const alive = [r.pid, ...(worker !== undefined ? [worker] : [])].filter((p) => ctx.isPidAlive(p));
  if (alive.length === 0) return null;
  const readCmd = ctx.processCommandOf ?? (() => undefined);
  const matches = alive.map((p) => ({ pid: p, match: commandMatchesBrevoStage5(readCmd(p)) }));
  const running = matches.find((m) => m.match === true);
  if (running) {
    return (
      `pid ${running.pid} ainda roda o dispatch Brevo acima do teto de ${capMin} min (Brevo lento/429): ` +
      `não iniciar outro (sairia um 2º rascunho); esperar ou matar esse pid (por PID, nunca por nome)`
    );
  }
  const unknown = matches.filter((m) => m.match === undefined);
  if (unknown.length === 0) return null; // todos os vivos são outro programa: pid reciclado
  return ctx.force
    ? null
    : `pid ${unknown.map((m) => m.pid).join(", ")} vivo acima do teto de ${capMin} min e o comando não pôde ser lido ` +
        `(pid reciclado ou o dispatch ainda rodando): conferir o processo e só então re-rodar com --force`;
}

/** Primeiro registro que barra outro lançamento, com o porquê (#14096). */
export function findActiveLaunchWithReason(
  records: readonly BrevoStage5Record[],
  ctx: ActiveLaunchContext,
): ActiveLaunch | null {
  for (const r of records) {
    const reason = activeLaunchReason(r, ctx);
    if (reason !== null) return { record: r, reason };
  }
  return null;
}

/** Algum processo do lançamento (dispatch ou worker) está vivo neste host. */
export function launchProcessAlive(record: BrevoStage5Record, ctx: Pick<LivenessContext, "isPidAlive" | "workerPidOf">): boolean {
  if (ctx.isPidAlive(record.pid)) return true;
  const worker = ctx.workerPidOf(record.launch_id);
  return worker !== undefined && ctx.isPidAlive(worker);
}

/**
 * Pura: lançamento ATIVO que impede outro de iniciar (#14037, #14096). Regra
 * completa em `activeLaunchReason`: dentro do teto, `running` de outro host ou
 * com processo vivo neste host; acima do teto, fail-closed (só passa o que se
 * prova terminado ou pid reciclado).
 */
export function findActiveLaunch(records: readonly BrevoStage5Record[], ctx: ActiveLaunchContext): BrevoStage5Record | null {
  return findActiveLaunchWithReason(records, ctx)?.record ?? null;
}

export type JoinDecision =
  | { kind: "done"; record: Extract<BrevoStage5Record, { state: "done" }> }
  | { kind: "wait" }
  | { kind: "process_died"; record: BrevoStage5Record; workerPid?: number }
  | { kind: "not_launched"; others?: Array<{ launch_id: string; state: string }> }
  | { kind: "other_active"; active: BrevoStage5Record }
  | { kind: "timeout"; record: BrevoStage5Record; totalMs: number }
  | { kind: "invalid"; error: string };

export interface JoinContext extends LivenessContext {
  /** Milissegundos desde que o join começou a esperar. */
  elapsedMs: number;
  /** Tolerância para o arquivo ainda não existir (o processo acabou de ser lançado). */
  missingGraceMs: number;
  /** Só o registro deste lançamento conta. */
  launchId: string;
  /** Registros de OUTROS lançamentos, só para relatar (nunca viram resultado). */
  others: readonly BrevoStage5Record[];
}

/**
 * Pura: decide o próximo passo do join a partir do registro DESTE lançamento.
 * - ausente → `wait` dentro da tolerância, depois `not_launched` (com a lista
 *   dos outros lançamentos da edição, que nunca contam como resultado).
 * - `done` → acabou (o status do canal está em `record.result`).
 * - `running` do MESMO host com dispatch e worker mortos → `process_died`.
 * - `running` há mais de `maxTotalMs` desde o `started_at` → `timeout`
 *   (falha explícita, mesmo com o processo vivo: nunca loop infinito).
 * - `running` de outro host → `wait` dentro do teto.
 */
export function decideJoin(outcome: ReadRecordOutcome, ctx: JoinContext): JoinDecision {
  if (outcome.kind === "invalid") return { kind: "invalid", error: outcome.error };
  if (outcome.kind === "missing" || outcome.record.launch_id !== ctx.launchId) {
    if (ctx.elapsedMs < ctx.missingGraceMs) return { kind: "wait" };
    const otherRecords = ctx.others.filter((r) => r.launch_id !== ctx.launchId);
    // Exatamente um outro lançamento rodando: é o Brevo desta edição (o deste
    // lançamento saiu busy). Juntar aquele, nunca seguir com ele rodando.
    const otherRunning = otherRecords.filter((r) => r.state === "running");
    if (otherRunning.length === 1) return { kind: "other_active", active: otherRunning[0] };
    const others = otherRecords.map((r) => ({ launch_id: r.launch_id, state: r.state }));
    return others.length > 0 ? { kind: "not_launched", others } : { kind: "not_launched" };
  }
  const { record } = outcome;
  if (record.state === "done") return { kind: "done", record };
  if (record.host === ctx.host && !launchProcessAlive(record, ctx)) {
    const workerPid = ctx.workerPidOf(record.launch_id);
    return workerPid !== undefined ? { kind: "process_died", record, workerPid } : { kind: "process_died", record };
  }
  const startedMs = Date.parse(record.started_at);
  const totalMs = Number.isFinite(startedMs) ? ctx.nowEpochMs - startedMs : ctx.elapsedMs;
  if (totalMs >= ctx.maxTotalMs) return { kind: "timeout", record, totalMs };
  return { kind: "wait" };
}

/**
 * Exit code do join, alinhado ao do dispatch (#5772): 0 = `ok`/`already_done`/
 * `skipped`; 1 = `failed`, processo morto, registro ilegível ou teto total
 * estourado (`timeout`); 3 = registro deste lançamento ausente; 4 = ainda
 * rodando quando a espera desta chamada acabou, dentro do teto total;
 * 6 = registro deste lançamento ausente e um outro lançamento rodando
 * (`active_launch_id`: juntar aquele).
 */
export function joinExitCode(decision: JoinDecision | { kind: "still_running" }): number {
  switch (decision.kind) {
    case "done":
      return decision.record.result.status === "failed" ? 1 : 0;
    case "process_died":
    case "invalid":
    case "timeout":
      return 1;
    case "not_launched":
      return 3;
    case "other_active":
      return OTHER_ACTIVE_EXIT_CODE;
    case "still_running":
    case "wait":
      return 4;
  }
}
