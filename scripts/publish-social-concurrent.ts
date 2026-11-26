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
 * Um canal que falha não derruba os outros (`Promise.allSettled`).
 *
 * Só roda os canais com `"auto"` em `_internal/05-publish-consent.json` (§5b;
 * "Só dispatchar se o canal foi autorizado"). Consent ausente ou ilegível =
 * exit 2 sem despachar nada. `--channels a,b` restringe a um subconjunto
 * (retry de canal); um canal pedido sem consent `auto` sai como
 * `dispatched: false` com o motivo.
 *
 * Saída: o stderr de cada filho é repassado ao vivo, com o prefixo
 * `[canal] `. No fim, o stdout traz UM JSON:
 *
 *   { "results": [ { channel, dispatched, exit_code, duration_ms,
 *                    output (o JSON final do publisher), log (as linhas OK/SKIP
 *                    do stdout dele), output_error? } | { channel,
 *                    dispatched: false, reason } ],
 *     "failed_channels": [...], "wall_ms": N }
 *
 * O resumo do Stage 5 lê `results[i].output` exatamente como lia o stdout do
 * publisher (`summary`, `posts`, `use_melhor`, `pages`).
 *
 * Exit: 0 = todos os canais despachados saíram 0; 1 = algum saiu ≠ 0 ou não
 * iniciou (ver `failed_channels` e o `exit_code` de cada um, que preserva o
 * significado do publisher: Instagram/Threads exit 2 = Worker não configurado);
 * 2 = argumento inválido ou consent ausente/ilegível (nada despachado).
 *
 * Uso:
 *   npx tsx scripts/publish-social-concurrent.ts --edition-dir <dir> [--channels facebook,linkedin,instagram,threads]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { tryResolveEditionDirArg } from "./lib/resolve-edition-dir-arg.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SOCIAL_CHANNELS = ["facebook", "linkedin", "instagram", "threads"] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];

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
}

/**
 * Pura: quais canais rodam. Só `"auto"` despacha (como no §5b); qualquer outro
 * valor, inclusive ausente, fica de fora com o motivo. `requested` (de
 * `--channels`) restringe a lista; canal desconhecido lança.
 */
export function planChannels(modes: Record<string, unknown>, requested?: readonly string[]): ChannelPlanEntry[] {
  let channels: SocialChannel[] = [...SOCIAL_CHANNELS];
  if (requested && requested.length > 0) {
    const unknown = requested.filter((c) => !(SOCIAL_CHANNELS as readonly string[]).includes(c));
    if (unknown.length > 0) throw new Error(`--channels com canal desconhecido: ${unknown.join(", ")} (válidos: ${SOCIAL_CHANNELS.join(", ")})`);
    channels = SOCIAL_CHANNELS.filter((c) => requested.includes(c));
  }
  return channels.map((channel) => {
    const mode = modes[channel];
    return mode === "auto"
      ? { channel, dispatch: true }
      : { channel, dispatch: false, reason: `consent ${channel}=${mode === undefined ? "ausente" : JSON.stringify(mode)} (só "auto" despacha)` };
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

export type RunChildFn = (channel: SocialChannel, script: string, args: string[]) => Promise<ChildRun>;

export type ChannelResult =
  | {
      channel: SocialChannel;
      dispatched: true;
      exit_code: number | null;
      duration_ms: number;
      output: unknown;
      log: string;
      output_error?: string;
      spawn_error?: string;
    }
  | { channel: SocialChannel; dispatched: false; reason: string };

export interface ConcurrentResult {
  results: ChannelResult[];
  failed_channels: SocialChannel[];
  wall_ms: number;
}

/** Roda os canais do plano em paralelo; cada um isolado do outro. */
export async function runConcurrent(
  plan: readonly ChannelPlanEntry[],
  editionDir: string,
  runChild: RunChildFn,
  nowMs: () => number = Date.now,
): Promise<ConcurrentResult> {
  const t0 = nowMs();
  const settled = await Promise.allSettled(
    plan.map(async (entry): Promise<ChannelResult> => {
      if (!entry.dispatch) return { channel: entry.channel, dispatched: false, reason: entry.reason ?? "não despachado" };
      const { script, args } = channelCommand(entry.channel, editionDir);
      const start = nowMs();
      const run = await runChild(entry.channel, script, args);
      const split = splitTrailingJson(run.stdout);
      return {
        channel: entry.channel,
        dispatched: true,
        exit_code: run.code,
        duration_ms: nowMs() - start,
        output: split.output,
        log: split.log,
        ...("error" in split ? { output_error: split.error } : {}),
        ...(run.spawnError ? { spawn_error: run.spawnError } : {}),
      };
    }),
  );
  const results: ChannelResult[] = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          channel: plan[i].channel,
          dispatched: true,
          exit_code: null,
          duration_ms: 0,
          output: null,
          log: "",
          output_error: "runner lançou exceção",
          spawn_error: (s.reason as Error)?.message ?? String(s.reason),
        },
  );
  const failed_channels = results
    .filter((r): r is Extract<ChannelResult, { dispatched: true }> => r.dispatched && r.exit_code !== 0)
    .map((r) => r.channel);
  return { results, failed_channels, wall_ms: nowMs() - t0 };
}

/** Exit do wrapper: 1 se algum canal despachado não saiu 0. */
export function concurrentExitCode(result: ConcurrentResult): number {
  return result.failed_channels.length > 0 ? 1 : 0;
}

/** Produção: `process.execPath --import tsx`, nunca `npx` (guard #4343); stderr repassado com prefixo. */
export function realRunChild(rootDir: string): RunChildFn {
  return (channel, script, args) =>
    new Promise((resolveRun) => {
      const abs = isAbsolute(script) ? script : resolve(rootDir, ...script.split("/"));
      let stdout = "";
      let stderrBuf = "";
      let settled = false;
      const done = (r: ChildRun) => {
        if (settled) return;
        settled = true;
        if (stderrBuf) process.stderr.write(`[${channel}] ${stderrBuf}\n`);
        resolveRun(r);
      };
      const child = spawn(process.execPath, ["--import", "tsx", abs, ...args], { cwd: rootDir, env: process.env });
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
  // Cada publisher recebe o --edition-dir exatamente como veio (mesmo comando do
  // §5c-3); o path resolvido serve só para ler o consent.
  const result = await runConcurrent(plan, editionDirArg, realRunChild(ROOT));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = concurrentExitCode(result);
}
