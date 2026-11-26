/**
 * scripts/lib/brevo-stage5-background.ts (#14037)
 *
 * Registro em disco do dispatch Brevo diária da Etapa 5 quando ele roda em
 * BACKGROUND. Antes do #14037 o `brevo-diaria-stage5-dispatch.ts` rodava no
 * mesmo turno do dispatch social e segurava a sessão por 300 a 450 s; agora
 * o orchestrator o lança com `run_in_background` logo depois do §5c-pre e
 * junta o resultado (`brevo-diaria-stage5-join.ts`) antes do sentinel do §5h.
 *
 * O registro existe para o join não depender da notificação do harness nem da
 * memória da sessão: o processo grava `running` (pid + host) ao começar e
 * `done` (exit code + o mesmo JSON que imprime no stdout) ao terminar. O join
 * relê o arquivo até ver `done`; processo morto com `running` no disco vira
 * falha explícita, nunca espera infinita nem sucesso presumido.
 *
 * O resultado gravado é o JSON do dispatch, sem reinterpretar: a semântica de
 * falha do canal (fail-soft, `ok`/`already_done`/`skipped`/`failed`) segue
 * a mesma do §5c-3 item 5 do playbook.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hostname } from "node:os";
import { writeFileAtomic } from "./atomic-write.ts";

/** Caminho relativo à pasta da edição. */
export const BREVO_STAGE5_RECORD_FILE = "_internal/05-brevo-stage5-dispatch.json";

export function brevoStage5RecordPath(editionDir: string): string {
  return resolve(editionDir, BREVO_STAGE5_RECORD_FILE);
}

interface RecordBase {
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
  const path = brevoStage5RecordPath(editionDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(record, null, 2) + "\n");
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
  if (typeof r.pid !== "number" || typeof r.host !== "string" || typeof r.started_at !== "string") {
    return { kind: "invalid", error: "registro sem pid/host/started_at" };
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

export function readBrevoStage5Record(editionDir: string): ReadRecordOutcome {
  const path = brevoStage5RecordPath(editionDir);
  if (!existsSync(path)) return { kind: "missing" };
  try {
    return parseBrevoStage5Record(readFileSync(path, "utf8"));
  } catch (e) {
    return { kind: "invalid", error: (e as Error).message };
  }
}

export function currentHost(): string {
  return hostname();
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

export type JoinDecision =
  | { kind: "done"; record: Extract<BrevoStage5Record, { state: "done" }> }
  | { kind: "wait" }
  | { kind: "process_died"; record: BrevoStage5Record }
  | { kind: "not_launched" }
  | { kind: "invalid"; error: string };

export interface JoinContext {
  /** Milissegundos desde que o join começou a esperar. */
  elapsedMs: number;
  /** Tolerância para o arquivo ainda não existir (o processo acabou de ser lançado). */
  missingGraceMs: number;
  host: string;
  isPidAlive: (pid: number) => boolean;
}

/**
 * Pura: decide o próximo passo do join a partir do que está em disco.
 * - `done` → acabou (o status do canal está em `record.result`).
 * - `running` do MESMO host com pid morto → `process_died` (falha explícita).
 * - `running` de outro host → `wait`: pid de outra máquina não se confere daqui.
 * - arquivo ausente → `wait` dentro da tolerância, depois `not_launched`.
 */
export function decideJoin(outcome: ReadRecordOutcome, ctx: JoinContext): JoinDecision {
  if (outcome.kind === "missing") {
    return ctx.elapsedMs < ctx.missingGraceMs ? { kind: "wait" } : { kind: "not_launched" };
  }
  if (outcome.kind === "invalid") return { kind: "invalid", error: outcome.error };
  const { record } = outcome;
  if (record.state === "done") return { kind: "done", record };
  if (record.host === ctx.host && !ctx.isPidAlive(record.pid)) return { kind: "process_died", record };
  return { kind: "wait" };
}

/**
 * Exit code do join, alinhado ao do dispatch (#5772): 0 = `ok`/`already_done`/
 * `skipped`; 1 = `failed`, processo morto ou registro ilegível; 3 = não lançado;
 * 4 = ainda rodando quando o tempo de espera acabou (re-rodar o join).
 * Todos são fail-soft para o Stage 5: o orchestrator lê o JSON e loga warn.
 */
export function joinExitCode(decision: JoinDecision | { kind: "still_running" }): number {
  switch (decision.kind) {
    case "done":
      return decision.record.result.status === "failed" ? 1 : 0;
    case "process_died":
    case "invalid":
      return 1;
    case "not_launched":
      return 3;
    case "still_running":
    case "wait":
      return 4;
  }
}
