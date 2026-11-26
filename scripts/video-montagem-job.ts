/**
 * scripts/video-montagem-job.ts (#14118) — roda um subcomando longo do
 * `video-montagem.ts` como JOB em background, com registro, status e
 * retomada idempotente. Lógica pura em `lib/diaria/video-montagem-job.ts`.
 *
 * Uso:
 *   npx tsx scripts/video-montagem-job.ts run {cmd} {AAMMDD} [args do video-montagem...]
 *       Lançar com `run_in_background`. Os argumentos depois de `run` vão ao
 *       `video-montagem.ts` como estão (ex.: `run build 261126 --seq youtube`).
 *       Job vivo com os mesmos argumentos: não lança outro, espera o que está
 *       rodando e sai com o exit code dele. Vivo com outros argumentos: exit 5.
 *       Sem job vivo: lança, repassa a saída (e grava no log do job) e sai com
 *       o exit code do subcomando.
 *   npx tsx scripts/video-montagem-job.ts status {AAMMDD} [--cmd C [--seq S]] [--tail N] [--json]
 *       Estado dos jobs da edição (ou de um), com as últimas linhas do log.
 *       Exit com `--cmd`: 0 terminou ok, 1 falhou ou morreu sem terminar,
 *       3 rodando, 4 sem registro. Sem `--cmd`: 3 se algum roda, senão 0.
 *
 * Exit 2 = uso inválido. Nunca muda a saída do vídeo: só orquestra (#13999).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { lockHostId, withFileLock } from "./lib/file-lock.ts";
import { isPidAlive } from "./lib/brevo-stage5-background.ts";
import {
  BACKGROUND_COMMANDS,
  JOB_BUSY_EXIT_CODE,
  JOB_NONE_EXIT_CODE,
  JOB_RUNNING_EXIT_CODE,
  classifyJob,
  decideLaunch,
  jobLogPath,
  jobName,
  jobRecordPath,
  listJobRecords,
  readJobRecord,
  statusExitCode,
  tailLines,
  writeJobRecord,
  type JobRecord,
  type LivenessContext,
} from "./lib/diaria/video-montagem-job.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MONTAGEM_SCRIPT = resolve(ROOT, "scripts", "video-montagem.ts");

export interface JobCliDeps {
  /** Base da pasta dos jobs (default: temporário do sistema). */
  base?: string;
  host?: string;
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  /** Lança o `video-montagem.ts` com `argv`. Default: o mesmo node (com o loader do tsx) no script real. */
  spawnMontagem?: (argv: string[]) => ChildProcess;
  sleep?: (ms: number) => Promise<void>;
  /** Intervalo de releitura do registro ao se juntar a um job em andamento. */
  pollMs?: number;
  out?: (s: string) => void;
  err?: (s: string) => void;
  pid?: number;
}

function defaultSpawn(argv: string[]): ChildProcess {
  return spawn(process.execPath, [...process.execArgv, MONTAGEM_SCRIPT, ...argv], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function ctxOf(deps: JobCliDeps): LivenessContext {
  return {
    host: deps.host ?? lockHostId(),
    isPidAlive: deps.isPidAlive ?? isPidAlive,
    nowMs: (deps.now ?? Date.now)(),
  };
}

function readLogTail(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  try {
    return tailLines(readFileSync(path, "utf8"), n);
  } catch {
    return [];
  }
}

function describe(rec: JobRecord): string {
  return `${rec.job} (pid ${rec.pid}${rec.child_pid ? `, filho ${rec.child_pid}` : ""}, desde ${rec.started_at}, ${rec.host}): ${rec.argv.join(" ")}`;
}

async function attach(rec: JobRecord, deps: JobCliDeps, path: string): Promise<number> {
  const out = deps.out ?? ((s) => process.stdout.write(s));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 5_000;
  out(`[job] ${describe(rec)} já está rodando com os mesmos argumentos: não lanço outro, espero este terminar.\n`);
  for (;;) {
    const cur = readJobRecord(path);
    if (!cur || cur.started_at !== rec.started_at || cur.pid !== rec.pid) {
      out(`[job] o registro de ${rec.job} mudou durante a espera; rode \`status\` para ver o job atual.\n`);
      return 1;
    }
    const st = classifyJob(cur, ctxOf(deps));
    if (st !== "running") {
      for (const l of readLogTail(cur.log_path, 40)) out(`${l}\n`);
      if (st === "stale") {
        out(`[job] ${rec.job} morreu sem gravar o fim; rode o mesmo comando de novo para relançar.\n`);
        return 1;
      }
      out(`[job] ${rec.job} terminou (exit ${cur.exit_code}).\n`);
      return cur.exit_code ?? 1;
    }
    await sleep(pollMs);
  }
}

export async function runJob(argv: string[], deps: JobCliDeps = {}): Promise<number> {
  const err = deps.err ?? ((s) => process.stderr.write(s));
  const out = deps.out ?? ((s) => process.stdout.write(s));
  const [cmd, edition] = argv;
  if (!cmd || !BACKGROUND_COMMANDS.includes(cmd)) {
    err(`uso: run {cmd} {AAMMDD} [args]; cmd em: ${BACKGROUND_COMMANDS.join(", ")}\n`);
    return 2;
  }
  if (!edition || !/^\d{6}$/.test(edition)) {
    err("uso: run {cmd} {AAMMDD} [args]; AAMMDD obrigatório (6 dígitos)\n");
    return 2;
  }
  const job = jobName(cmd, argv);
  const path = jobRecordPath(edition, job, deps.base);
  const logPath = jobLogPath(edition, job, deps.base);
  mkdirSync(dirname(path), { recursive: true });

  // Decidir e gravar `running` sob lock: dois `run` simultâneos nunca lançam dois jobs.
  const decision = withFileLock(`${path}.lock`, () => {
    const d = decideLaunch(readJobRecord(path), argv, ctxOf(deps));
    if (d.action === "launch") {
      const rec: JobRecord = {
        job,
        cmd,
        edition,
        argv: [...argv],
        pid: deps.pid ?? process.pid,
        host: deps.host ?? lockHostId(),
        started_at: new Date((deps.now ?? Date.now)()).toISOString(),
        state: "running",
        log_path: logPath,
      };
      writeJobRecord(path, rec);
      return { ...d, record: rec };
    }
    return d;
  });

  if (decision.action === "busy") {
    err(`[job] ${describe(decision.record)} está rodando com outros argumentos; espere terminar (\`status ${edition} --cmd ${cmd}\`) antes de lançar outro.\n`);
    return JOB_BUSY_EXIT_CODE;
  }
  if (decision.action === "attach") return attach(decision.record, deps, path);

  const rec = decision.record;
  if (decision.previous === "stale") out(`[job] registro anterior de ${job} era de um job morto sem fim gravado; lançando de novo.\n`);
  appendFileSync(logPath, `\n=== ${rec.started_at} ${argv.join(" ")} ===\n`);
  const child = (deps.spawnMontagem ?? defaultSpawn)(argv);
  if (child.pid !== undefined) writeJobRecord(path, { ...rec, child_pid: child.pid });

  const tee = (write: (s: string) => void) => (chunk: Buffer | string) => {
    const s = chunk.toString();
    write(s);
    try {
      appendFileSync(logPath, s);
    } catch {
      /* log é conveniência; a saída já foi repassada */
    }
  };
  child.stdout?.on("data", tee(out));
  child.stderr?.on("data", tee(err));

  const forward = (sig: NodeJS.Signals) => () => {
    child.kill(sig);
  };
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  const code = await new Promise<number>((resolveCode) => {
    child.on("error", (e) => {
      err(`[job] falha ao lançar ${job}: ${e.message}\n`);
      resolveCode(1);
    });
    child.on("close", (c) => resolveCode(typeof c === "number" ? c : 1));
  });
  process.off("SIGINT", onInt);
  process.off("SIGTERM", onTerm);

  const finished = { ...rec, child_pid: child.pid, state: "done" as const, finished_at: new Date((deps.now ?? Date.now)()).toISOString(), exit_code: code };
  writeJobRecord(path, finished);
  out(`[job] ${job} terminou (exit ${code}); log em ${logPath}\n`);
  return code;
}

export function statusJobs(argv: string[], deps: JobCliDeps = {}): number {
  const out = deps.out ?? ((s) => process.stdout.write(s));
  const err = deps.err ?? ((s) => process.stderr.write(s));
  const edition = argv.find((a) => /^\d{6}$/.test(a));
  if (!edition) {
    err("uso: status {AAMMDD} [--cmd C [--seq S]] [--tail N] [--json]\n");
    return 2;
  }
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : undefined;
  };
  const cmd = val("cmd");
  const seq = val("seq");
  const tail = Number(val("tail") ?? 15);
  const asJson = argv.includes("--json");
  const ctx = ctxOf(deps);

  const records = cmd
    ? [readJobRecord(jobRecordPath(edition, jobName(cmd, seq ? ["--seq", seq] : []), deps.base))].filter((r): r is JobRecord => r !== null)
    : listJobRecords(edition, deps.base);
  const rows = records.map((r) => ({ ...r, status: classifyJob(r, ctx), log_tail: readLogTail(r.log_path, Number.isFinite(tail) ? tail : 15) }));

  if (asJson) out(JSON.stringify({ edition, jobs: rows }, null, 2) + "\n");
  else if (!rows.length) out(`[job] nenhum job${cmd ? ` ${cmd}${seq ? `-${seq}` : ""}` : ""} registrado para ${edition}.\n`);
  else {
    for (const r of rows) {
      out(`[job] ${r.job}: ${r.status}${r.state === "done" ? ` (exit ${r.exit_code}, fim ${r.finished_at})` : ""} — ${describe(r)}\n`);
      for (const l of r.log_tail) out(`    ${l}\n`);
    }
  }

  if (cmd) return rows.length ? statusExitCode(rows[0].status) : JOB_NONE_EXIT_CODE;
  return rows.some((r) => r.status === "running") ? JOB_RUNNING_EXIT_CODE : 0;
}

export async function main(argv: string[] = process.argv.slice(2), deps: JobCliDeps = {}): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "run") return runJob(rest, deps);
  if (sub === "status") return statusJobs(rest, deps);
  (deps.err ?? ((s) => process.stderr.write(s)))("uso: video-montagem-job.ts run {cmd} {AAMMDD} [args] | status {AAMMDD} [--cmd C [--seq S]] [--tail N] [--json]\n");
  return 2;
}

if (isMainModule(import.meta.url)) {
  runCli(() => main(), { onError: (e) => console.error("video-montagem-job:", e instanceof Error ? e.message : e) });
}
