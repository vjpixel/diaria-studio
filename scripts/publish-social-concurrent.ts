#!/usr/bin/env node
/**
 * scripts/publish-social-concurrent.ts (#14037)
 *
 * Roda os 4 publishers sociais da Etapa 5 (§5c-3) AO MESMO TEMPO, num só
 * comando. O playbook pedia "disparar simultaneamente" com várias chamadas
 * Bash na mesma mensagem, mas o harness executa essas chamadas em série
 * (medido na edição 261123: 35 a 52 s do fim do Facebook ao fim do Threads).
 *
 * Cada canal roda o MESMO comando de antes, como processo filho próprio:
 *
 *   publish-facebook.ts  --edition-dir <dir> --schedule
 *   publish-linkedin.ts  --edition-dir <dir> --schedule
 *   publish-instagram.ts --edition-dir <dir> --schedule
 *   publish-threads.ts   --edition-dir <dir> --schedule
 *
 * Nada do publisher muda: idempotência (resume pula entry já agendada), store
 * por canal (`06-social-published.json`, gravado sob o lock de
 * `social-published-store.ts`, #918) e exit code de cada um seguem iguais.
 * Um canal que falha não derruba os outros.
 *
 * Só roda os canais com `"auto"` em `_internal/05-publish-consent.json` (§5b;
 * "Só dispatchar se o canal foi autorizado"). Consent ausente ou ilegível =
 * exit 2 sem despachar nada. `--channels a,b` restringe a um subconjunto
 * (retry de canal); canal pedido explicitamente sem consent `auto` não roda e
 * deixa o exit ≠ 0 (`requested_not_dispatched`).
 *
 * Saída: o stderr de cada filho é repassado ao vivo, com o prefixo
 * `[canal] `. No fim, o stdout traz UM JSON:
 *
 *   { "run_id", "results": [ { channel, dispatched, pid, exit_code,
 *       duration_ms, output (o JSON final do publisher), log (as linhas OK/SKIP
 *       do stdout dele), output_error?, spawn_error? } | { channel,
 *       dispatched: false, reason } ],
 *     "failed_channels": [...], "requested_not_dispatched": [...], "wall_ms": N }
 *
 * O resumo do Stage 5 lê `results[i].output` exatamente como lia o stdout do
 * publisher (`summary`, `posts`, `use_melhor`, `pages`). Canal que sai 0 sem
 * JSON final parseável conta como falha (o resumo não teria o que ler).
 *
 * Progresso: `_internal/05-social-concurrent.json` é regravado quando cada
 * filho inicia (com o pid) e quando termina (`run_id`, `state`, `running`,
 * `results`, `pending`). Um retry com `--channels` faz MERGE: mantém o
 * resultado dos canais que não estão nesta rodada. Canal com pid vivo no
 * progresso (rodada anterior ainda rodando) não é re-rodado: exit 5, nada
 * despachado. SIGINT/SIGTERM são repassados aos filhos pelo PID; o wrapper
 * espera até 5 s os filhos saírem, grava `interrupted` e sai 130/143.
 *
 * Exit: 0 = todos os canais despachados saíram 0 com JSON; 1 = algum falhou,
 * não iniciou ou foi pedido sem consent (ver `failed_channels`,
 * `requested_not_dispatched` e o `exit_code` de cada um, que preserva o
 * significado do publisher: Instagram/Threads exit 2 = Worker não configurado);
 * 2 = argumento inválido ou consent ausente/ilegível (nada despachado);
 * 5 = canal da rodada ainda rodando de uma rodada anterior (nada despachado).
 *
 * Uso:
 *   npx tsx scripts/publish-social-concurrent.ts --edition-dir <dir> [--channels facebook,linkedin,instagram,threads]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { tryResolveEditionDirArg } from "./lib/resolve-edition-dir-arg.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SOCIAL_CHANNELS = ["facebook", "linkedin", "instagram", "threads"] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];

/** Caminho do progresso gravado pelo wrapper, relativo à pasta da edição (#14037). */
export const SOCIAL_CONCURRENT_PROGRESS_FILE = "_internal/05-social-concurrent.json";

/** Exit do wrapper quando um canal da rodada ainda roda de uma rodada anterior. */
export const SOCIAL_BUSY_EXIT_CODE = 5;

/** Progresso de outro host vale como "rodando" por este tempo desde a última gravação. */
export const FOREIGN_RUNNING_FRESH_MS = 15 * 60_000;

/** Quanto o wrapper espera os filhos saírem depois de repassar um sinal. */
export const SIGNAL_CHILD_WAIT_MS = 5_000;

/** Script e argumentos de cada canal: os mesmos do §5c-3 itens 1-4. */
export function channelCommand(channel: SocialChannel, editionDir: string): { script: string; args: string[] } {
  return { script: `scripts/publish-${channel}.ts`, args: ["--edition-dir", editionDir, "--schedule"] };
}

export type ConsentRead = { ok: true; modes: Record<string, unknown> } | { ok: false; error: string };

export function readConsent(editionDir: string): ConsentRead {
  const path = resolve(editionDir, "_internal", "05-publish-consent.json");
  if (!existsSync(path)) return { ok: false, error: `consent ausente: ${path} (rodar o §5b antes do dispatch)` };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!data || typeof data !== "object") return { ok: false, error: `consent não é objeto: ${path}` };
    return { ok: true, modes: data as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: `consent ilegível (${(e as Error).message}): ${path}` };
  }
}

export interface ChannelPlanEntry {
  channel: SocialChannel;
  dispatch: boolean;
  reason?: string;
  /** Pedido explicitamente em `--channels`. */
  requested?: boolean;
}

/**
 * Pura: quais canais rodam. Só `"auto"` despacha (como no §5b); qualquer outro
 * valor, inclusive ausente, fica de fora com o motivo. `requested` (de
 * `--channels`) restringe a lista; canal desconhecido lança.
 */
export function planChannels(modes: Record<string, unknown>, requested?: readonly string[]): ChannelPlanEntry[] {
  let channels: SocialChannel[] = [...SOCIAL_CHANNELS];
  const explicit = !!requested && requested.length > 0;
  if (explicit) {
    const unknown = requested!.filter((c) => !(SOCIAL_CHANNELS as readonly string[]).includes(c));
    if (unknown.length > 0) throw new Error(`--channels com canal desconhecido: ${unknown.join(", ")} (válidos: ${SOCIAL_CHANNELS.join(", ")})`);
    channels = SOCIAL_CHANNELS.filter((c) => requested!.includes(c));
  }
  return channels.map((channel) => {
    const mode = modes[channel];
    const base = mode === "auto"
      ? { channel, dispatch: true }
      : { channel, dispatch: false, reason: `consent ${channel}=${mode === undefined ? "ausente" : JSON.stringify(mode)} (só "auto" despacha)` };
    return explicit ? { ...base, requested: true } : base;
  });
}

/**
 * Pura: separa o JSON final do publisher (impresso com `JSON.stringify(x, null, 2)`
 * depois das linhas de log) do log que vem antes. Procura, de trás pra frente,
 * a primeira linha que começa com `{` a partir da qual o resto parseia.
 */
export function splitTrailingJson(stdout: string): { output: unknown; log: string } | { output: null; log: string; error: string } {
  const lines = stdout.replace(/\r\n/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    const candidate = lines.slice(i).join("\n").trim();
    try {
      const output = JSON.parse(candidate);
      return { output, log: lines.slice(0, i).join("\n").trim() };
    } catch {
      // linha de log que começa com "{": continuar subindo
    }
  }
  return { output: null, log: stdout.trim(), error: "stdout sem JSON final parseável" };
}

export interface ChildRun {
  code: number | null;
  stdout: string;
  /** Erro de spawn (processo nem iniciou) ou sinal que matou o filho. */
  spawnError?: string;
}

/** `onSpawn` recebe o pid do filho assim que ele existe (vai para o progresso). */
export type RunChildFn = (channel: SocialChannel, script: string, args: string[], onSpawn?: (pid: number) => void) => Promise<ChildRun>;

export type ChannelResult =
  | {
      channel: SocialChannel;
      dispatched: true;
      run_id: string;
      pid?: number;
      exit_code: number | null;
      duration_ms: number;
      output: unknown;
      log: string;
      output_error?: string;
      spawn_error?: string;
    }
  | { channel: SocialChannel; dispatched: false; reason: string; requested?: boolean };

export interface ConcurrentResult {
  run_id: string;
  results: ChannelResult[];
  failed_channels: SocialChannel[];
  /** Canais pedidos em `--channels` que não rodaram (consent ≠ auto). */
  requested_not_dispatched: SocialChannel[];
  wall_ms: number;
}

/**
 * Progresso em disco. `results` inclui os canais de rodadas anteriores que
 * esta rodada não tocou (merge do retry com `--channels`); `running` lista os
 * filhos vivos desta rodada com o pid.
 */
export interface ConcurrentProgress {
  run_id: string;
  host: string;
  state: "running" | "done" | "interrupted";
  started_at: string;
  updated_at: string;
  results: ChannelResult[];
  running: Array<{ channel: SocialChannel; pid: number }>;
  pending: SocialChannel[];
  failed_channels: SocialChannel[];
}

/** Canal despachado que falhou: exit ≠ 0, não iniciou, ou saiu 0 sem JSON final. */
export function isFailedResult(r: ChannelResult): boolean {
  return r.dispatched && (r.exit_code !== 0 || r.output_error !== undefined);
}

function failedOf(results: readonly ChannelResult[]): SocialChannel[] {
  return results.filter(isFailedResult).map((r) => r.channel);
}

export function readProgress(path: string): ConcurrentProgress | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as ConcurrentProgress;
    return data && typeof data === "object" && Array.isArray(data.results) ? { ...data, running: Array.isArray(data.running) ? data.running : [] } : null;
  } catch {
    return null;
  }
}

/**
 * Pura: canais do plano que ainda estão rodando numa rodada anterior. Mesmo
 * host: pid vivo. Outro host: progresso `running` gravado há menos de
 * `FOREIGN_RUNNING_FRESH_MS` (pid de outra máquina não se confere daqui).
 */
export function busyChannels(
  previous: ConcurrentProgress | null,
  plan: readonly ChannelPlanEntry[],
  ctx: { host: string; isPidAlive: (pid: number) => boolean; nowEpochMs: number },
): Array<{ channel: SocialChannel; pid: number; host: string }> {
  if (!previous || previous.running.length === 0) return [];
  const planned = new Set(plan.filter((p) => p.dispatch).map((p) => p.channel));
  const sameHost = previous.host === ctx.host;
  const updated = Date.parse(previous.updated_at);
  const foreignFresh = !sameHost && previous.state === "running" && Number.isFinite(updated) && ctx.nowEpochMs - updated < FOREIGN_RUNNING_FRESH_MS;
  return previous.running
    .filter((r) => planned.has(r.channel) && (sameHost ? ctx.isPidAlive(r.pid) : foreignFresh))
    .map((r) => ({ ...r, host: previous.host }));
}

export interface RunConcurrentOptions {
  nowMs?: () => number;
  onProgress?: (p: ConcurrentProgress) => void;
  runId?: string;
  host?: string;
  /** Progresso de rodada anterior, para o merge dos canais fora desta rodada. */
  previous?: ConcurrentProgress | null;
}

/** Roda os canais do plano em paralelo; cada um isolado do outro. */
export async function runConcurrent(
  plan: readonly ChannelPlanEntry[],
  editionDir: string,
  runChild: RunChildFn,
  opts: RunConcurrentOptions = {},
): Promise<ConcurrentResult> {
  const nowMs = opts.nowMs ?? Date.now;
  const t0 = nowMs();
  const runId = opts.runId ?? `social-${new Date(t0).toISOString()}-${process.pid}`;
  const startedAt = new Date(t0).toISOString();
  const thisRun = new Set(plan.map((p) => p.channel));
  const carried = (opts.previous?.results ?? []).filter((r) => !thisRun.has(r.channel));
  const completed = new Map<SocialChannel, ChannelResult>();
  const live = new Map<SocialChannel, number>();
  const emit = (state: ConcurrentProgress["state"]) => {
    if (!opts.onProgress) return;
    const current = plan.map((p) => completed.get(p.channel)).filter((r): r is ChannelResult => r !== undefined);
    const results = [...carried, ...current];
    opts.onProgress({
      run_id: runId,
      host: opts.host ?? hostname(),
      state,
      started_at: startedAt,
      updated_at: new Date(nowMs()).toISOString(),
      results,
      running: [...live.entries()].map(([channel, pid]) => ({ channel, pid })),
      pending: plan.filter((p) => !completed.has(p.channel)).map((p) => p.channel),
      failed_channels: failedOf(results),
    });
  };
  const runOne = async (entry: ChannelPlanEntry): Promise<ChannelResult> => {
    if (!entry.dispatch) {
      return { channel: entry.channel, dispatched: false, reason: entry.reason ?? "não despachado", ...(entry.requested ? { requested: true } : {}) };
    }
    const { script, args } = channelCommand(entry.channel, editionDir);
    const start = nowMs();
    let pid: number | undefined;
    try {
      const run = await runChild(entry.channel, script, args, (p) => {
        pid = p;
        live.set(entry.channel, p);
        emit("running");
      });
      const split = splitTrailingJson(run.stdout);
      return {
        channel: entry.channel,
        dispatched: true,
        run_id: runId,
        ...(pid !== undefined ? { pid } : {}),
        exit_code: run.code,
        duration_ms: nowMs() - start,
        output: split.output,
        log: split.log,
        ...("error" in split ? { output_error: split.error } : {}),
        ...(run.spawnError ? { spawn_error: run.spawnError } : {}),
      };
    } catch (e) {
      return {
        channel: entry.channel,
        dispatched: true,
        run_id: runId,
        ...(pid !== undefined ? { pid } : {}),
        exit_code: null,
        duration_ms: nowMs() - start,
        output: null,
        log: "",
        output_error: "runner lançou exceção",
        spawn_error: (e as Error)?.message ?? String(e),
      };
    }
  };
  emit("running");
  const results = await Promise.all(
    plan.map(async (entry) => {
      const r = await runOne(entry);
      live.delete(entry.channel);
      completed.set(entry.channel, r);
      emit("running");
      return r;
    }),
  );
  emit("done");
  const requested_not_dispatched = results.filter((r) => !r.dispatched && r.requested).map((r) => r.channel);
  return { run_id: runId, results, failed_channels: failedOf(results), requested_not_dispatched, wall_ms: nowMs() - t0 };
}

/** Exit do wrapper: 1 se algum canal falhou ou um canal pedido não rodou. */
export function concurrentExitCode(result: ConcurrentResult): number {
  return result.failed_channels.length > 0 || result.requested_not_dispatched.length > 0 ? 1 : 0;
}

/**
 * Ao receber SIGINT/SIGTERM, mata cada filho vivo pelo PID
 * (`process.kill(pid, sinal)`; no Windows isso é TerminateProcess do próprio
 * PID, e o filho aqui é o `node` do publisher, sem árvore de netos). ESRCH
 * (filho já saiu) é silencioso; qualquer outro erro (EPERM, EINVAL) é logado.
 */
export function forwardSignalToChildren(
  children: Iterable<{ pid?: number }>,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, s) => process.kill(pid, s),
  warn: (msg: string) => void = (m) => process.stderr.write(m + "\n"),
): number[] {
  const killed: number[] = [];
  for (const c of children) {
    if (typeof c.pid !== "number") continue;
    try {
      kill(c.pid, signal);
      killed.push(c.pid);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") warn(`[publish-social-concurrent] AVISO: ${signal} não entregue ao pid ${c.pid} (${code ?? (e as Error).message}).`);
    }
  }
  return killed;
}

/** Espera o conjunto de filhos esvaziar, com teto. Devolve quantos sobraram. */
export async function waitForChildrenExit(
  live: { size: number },
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 100,
): Promise<number> {
  let waited = 0;
  while (live.size > 0 && waited < timeoutMs) {
    await sleep(pollMs);
    waited += pollMs;
  }
  return live.size;
}

/** Produção: `process.execPath --import tsx`, nunca `npx` (guard #4343); stderr repassado com prefixo. */
export function realRunChild(rootDir: string, live: Set<ChildProcess> = new Set()): RunChildFn {
  return (channel, script, args, onSpawn) =>
    new Promise((resolveRun) => {
      const abs = isAbsolute(script) ? script : resolve(rootDir, ...script.split("/"));
      let stdout = "";
      let stderrBuf = "";
      let settled = false;
      const child = spawn(process.execPath, ["--import", "tsx", abs, ...args], { cwd: rootDir, env: process.env });
      const done = (r: ChildRun) => {
        if (settled) return;
        settled = true;
        live.delete(child);
        if (stderrBuf) process.stderr.write(`[${channel}] ${stderrBuf}\n`);
        resolveRun(r);
      };
      live.add(child);
      if (typeof child.pid === "number") onSpawn?.(child.pid);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderrBuf += chunk;
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() ?? "";
        for (const line of lines) process.stderr.write(`[${channel}] ${line}\n`);
      });
      child.on("error", (e) => done({ code: null, stdout, spawnError: e.message }));
      child.on("close", (code, signal) =>
        done({ code, stdout, ...(code === null ? { spawnError: `encerrado por sinal ${signal ?? "desconhecido"}` } : {}) }),
      );
    });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const usage = "uso: npx tsx scripts/publish-social-concurrent.ts --edition-dir <dir> [--channels facebook,linkedin,instagram,threads]\n";
  let editionDirArg: string | undefined;
  let channelsArg: string | undefined;
  try {
    editionDirArg = getStringArg(argv, "edition-dir");
    channelsArg = getStringArg(argv, "channels", { example: "facebook,threads" });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${usage}`);
    process.exit(2);
  }
  if (!editionDirArg) {
    process.stderr.write(usage);
    process.exit(2);
  }
  const resolvedArg = tryResolveEditionDirArg(editionDirArg, { root: ROOT });
  if (!resolvedArg.ok) {
    process.stderr.write(`${resolvedArg.error}\n`);
    process.exit(2);
  }
  const editionDir = resolvedArg.editionDir;
  const consent = readConsent(editionDir);
  if (!consent.ok) {
    process.stderr.write(`ERRO (#14037): ${consent.error} — nenhum canal despachado.\n`);
    process.exit(2);
  }
  let plan: ChannelPlanEntry[];
  try {
    plan = planChannels(consent.modes, channelsArg?.split(",").map((c) => c.trim()).filter(Boolean));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
  const host = hostname();
  const progressPath = resolve(editionDir, ...SOCIAL_CONCURRENT_PROGRESS_FILE.split("/"));
  const previous = readProgress(progressPath);
  const busy = busyChannels(previous, plan, { host, isPidAlive, nowEpochMs: Date.now() });
  if (busy.length > 0) {
    process.stderr.write(
      `ERRO (#14037): canal ainda rodando de uma rodada anterior (${busy.map((b) => `${b.channel} pid ${b.pid} em ${b.host}`).join(", ")}) — ` +
        `nenhum canal despachado; esperar o processo terminar e conferir ${progressPath}.\n`,
    );
    console.log(JSON.stringify({ status: "busy", busy }, null, 2));
    process.exit(SOCIAL_BUSY_EXIT_CODE);
  }
  let lastProgress: ConcurrentProgress | null = null;
  const writeProgress = (p: ConcurrentProgress) => {
    lastProgress = p;
    try {
      mkdirSync(dirname(progressPath), { recursive: true });
      writeFileAtomic(progressPath, JSON.stringify(p, null, 2) + "\n");
    } catch (e) {
      process.stderr.write(`AVISO (#14037): progresso não gravado em ${progressPath} (${(e as Error).message}).\n`);
    }
  };
  const live = new Set<ChildProcess>();
  let interrupting = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (interrupting) return;
      interrupting = true;
      const killed = forwardSignalToChildren(live, sig);
      process.stderr.write(`[publish-social-concurrent] ${sig} recebido — repassado aos filhos (pids ${killed.join(", ") || "nenhum"}).\n`);
      void waitForChildrenExit(live, SIGNAL_CHILD_WAIT_MS).then((left) => {
        if (left > 0) process.stderr.write(`[publish-social-concurrent] AVISO: ${left} filho(s) ainda vivo(s) depois de ${SIGNAL_CHILD_WAIT_MS} ms.\n`);
        const last = lastProgress as ConcurrentProgress | null;
        if (last) writeProgress({ ...last, state: "interrupted", updated_at: new Date().toISOString() });
        process.exit(sig === "SIGINT" ? 130 : 143);
      });
    });
  }
  // Cada publisher recebe o --edition-dir exatamente como veio (mesmo comando do
  // §5c-3); o path resolvido serve só para ler o consent e gravar o progresso.
  const result = await runConcurrent(plan, editionDirArg, realRunChild(ROOT, live), { onProgress: writeProgress, host, previous });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = concurrentExitCode(result);
}
