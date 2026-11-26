/**
 * scripts/lib/diaria/video-montagem-job.ts (#14118) — registro em disco de um
 * subcomando longo do `video-montagem.ts` rodando em BACKGROUND.
 *
 * Em `/diaria-video-montagem`, `build`, `preview`, `review` e `face` (e o
 * `retranscribe`) passavam do teto de 600 s do Bash em primeiro plano (três
 * vezes nas sessões b2d3fdd8 e 41bb24b8; `face` levou 378 s, o retranscribe
 * 884 s) e o corte obrigava retry. A skill passa a lançá-los pelo wrapper
 * `scripts/video-montagem-job.ts run` com `run_in_background`, e espera pela
 * notificação do harness ou pelo `status`.
 *
 * Um registro por JOB, que é o subcomando + a sequência (`--seq`), na pasta
 * temporária da máquina (como o lock da GPU, #13741): o pid só vale na
 * máquina que o gravou. O wrapper grava `running` (pid dele + do filho) antes
 * de lançar e `done` (exit code) ao terminar. Rodar `run` de novo com o job
 * vivo NUNCA lança um segundo: com os mesmos argumentos ele se junta ao job
 * em andamento (espera e devolve o exit code dele); com outros, recusa (exit
 * `JOB_BUSY_EXIT_CODE`). Job morto sem `done` (sessão caiu, máquina
 * reiniciou) é `stale` e o próximo `run` lança de novo.
 *
 * Só orquestração: o wrapper chama o `video-montagem.ts` com os argumentos
 * recebidos, sem mudar nada do que ele faz (#13999).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";

/** Subcomandos que a skill roda pelo wrapper (os longos, que usam a GPU). */
export const BACKGROUND_COMMANDS: readonly string[] = [
  "build",
  "preview",
  "review",
  "face",
  "face-compare",
  "gaze",
  "retranscribe",
  "transcribe",
  "srt",
];

/** `run` recusado: outro job do mesmo subcomando e sequência está vivo, com outros argumentos. */
export const JOB_BUSY_EXIT_CODE = 5;
/** `status`: o job ainda está rodando (o laço do Monitor espera enquanto sair isto). */
export const JOB_RUNNING_EXIT_CODE = 3;
/** `status`: nenhum registro para o job pedido. */
export const JOB_NONE_EXIT_CODE = 4;

/** Registro de outra máquina (pasta temporária compartilhada) vale como vivo por até 3 h. */
export const FOREIGN_RUNNING_MAX_MS = 3 * 3600_000;

export type JobState = "running" | "done";

export interface JobRecord {
  job: string;
  cmd: string;
  edition: string;
  /** Argumentos repassados ao `video-montagem.ts`, a partir do subcomando. */
  argv: string[];
  pid: number;
  child_pid?: number;
  host: string;
  started_at: string;
  state: JobState;
  finished_at?: string;
  exit_code?: number;
  log_path: string;
}

/** O que o registro diz agora, com a liveness do processo. */
export type JobStatus = "running" | "stale" | "done-ok" | "done-fail";

export interface LivenessContext {
  host: string;
  isPidAlive: (pid: number) => boolean;
  nowMs: number;
}

/** O valor de `--seq` em `argv` (`--seq X` ou `--seq=X`), se houver. */
export function seqOf(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seq") return argv[i + 1];
    if (a.startsWith("--seq=")) return a.slice("--seq=".length);
  }
  return undefined;
}

/** Nome do job: o subcomando, mais a sequência quando há `--seq` (prévia do horizontal ≠ prévia padrão). */
export function jobName(cmd: string, argv: readonly string[]): string {
  const seq = seqOf(argv);
  const raw = seq ? `${cmd}-${seq}` : cmd;
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function jobsDir(edition: string, base: string = tmpdir()): string {
  return join(base, "diaria-video-montagem-jobs", edition);
}

export function jobRecordPath(edition: string, job: string, base?: string): string {
  return join(jobsDir(edition, base), `${job}.json`);
}

export function jobLogPath(edition: string, job: string, base?: string): string {
  return join(jobsDir(edition, base), `${job}.log`);
}

/** Lê um registro; conteúdo ilegível ou sem os campos mínimos = `null` (tratado como ausente, nunca como vivo). */
export function parseJobRecord(raw: string): JobRecord | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Partial<JobRecord>;
  if (typeof r.job !== "string" || typeof r.cmd !== "string" || typeof r.edition !== "string") return null;
  if (!Array.isArray(r.argv) || !r.argv.every((a) => typeof a === "string")) return null;
  if (typeof r.pid !== "number" || typeof r.host !== "string" || typeof r.started_at !== "string") return null;
  if (r.state !== "running" && r.state !== "done") return null;
  if (r.state === "done" && typeof r.exit_code !== "number") return null;
  if (typeof r.log_path !== "string") return null;
  return r as JobRecord;
}

export function readJobRecord(path: string): JobRecord | null {
  if (!existsSync(path)) return null;
  try {
    return parseJobRecord(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeJobRecord(path: string, rec: JobRecord): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileAtomic(path, JSON.stringify(rec, null, 2) + "\n");
}

/** Registros de todos os jobs da edição, por nome. */
export function listJobRecords(edition: string, base?: string): JobRecord[] {
  const dir = jobsDir(edition, base);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJobRecord(join(dir, f)))
    .filter((r): r is JobRecord => r !== null);
}

/**
 * Estado do job. `running` só enquanto o wrapper OU o filho estão vivos nesta
 * máquina (o filho pode sobreviver ao wrapper morto e continuar na GPU); de
 * outra máquina, pela idade do registro.
 */
export function classifyJob(rec: JobRecord, ctx: LivenessContext): JobStatus {
  if (rec.state === "done") return rec.exit_code === 0 ? "done-ok" : "done-fail";
  if (rec.host !== ctx.host) {
    const started = Date.parse(rec.started_at);
    return Number.isFinite(started) && ctx.nowMs - started < FOREIGN_RUNNING_MAX_MS ? "running" : "stale";
  }
  const alive = ctx.isPidAlive(rec.pid) || (rec.child_pid !== undefined && ctx.isPidAlive(rec.child_pid));
  return alive ? "running" : "stale";
}

export type LaunchDecision =
  | { action: "launch"; previous: JobStatus | "none" }
  | { action: "attach"; record: JobRecord }
  | { action: "busy"; record: JobRecord };

/**
 * O que um `run` faz diante do registro atual: job vivo com os mesmos
 * argumentos = se junta a ele (nunca lança outro); vivo com outros = recusa;
 * sem registro, terminado ou morto = lança.
 */
export function decideLaunch(rec: JobRecord | null, argv: readonly string[], ctx: LivenessContext): LaunchDecision {
  if (!rec) return { action: "launch", previous: "none" };
  const status = classifyJob(rec, ctx);
  if (status !== "running") return { action: "launch", previous: status };
  const same = rec.argv.length === argv.length && rec.argv.every((a, i) => a === argv[i]);
  return same ? { action: "attach", record: rec } : { action: "busy", record: rec };
}

/** Exit code do `status` para um job: 0 ok, 1 falhou ou morreu sem terminar, 3 rodando. */
export function statusExitCode(status: JobStatus): number {
  if (status === "running") return JOB_RUNNING_EXIT_CODE;
  return status === "done-ok" ? 0 : 1;
}

/** As últimas `n` linhas não vazias de um texto de log. */
export function tailLines(text: string, n: number): string[] {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n);
}
