#!/usr/bin/env node
/**
 * scripts/failover/neo-readiness.ts (#12983)
 *
 * Prontidão do Neo para assumir o `300` (contingência do #12982,
 * `docs/failover-neo.md`). Para cada task `failover: "critical"` do registro,
 * uma linha `pronto` / `falta X`. Lógica pura e lista de segredos por script:
 * `scripts/lib/failover/neo-readiness.ts`.
 *
 * Checagens (cada uma isolada: a que falha ou lança nunca derruba as outras):
 *   - scripts dos passos existem; arquivo do `guard` existe em `data/`;
 *   - segredos de cada script presentes no `.env`/ambiente e no Doppler
 *     (`doppler secrets --only-names`, só NOMES; valor nunca é lido do vault
 *     nem impresso);
 *   - `data/` acessível e com escrita nas últimas 72 h (Drive sincronizando);
 *   - Node contra o `.nvmrc` e `node_modules` contra o `package-lock.json`;
 *   - `gh auth status` (só o exit code);
 *   - checkout principal em `master` e não atrás do `origin/master` local
 *     (sem fetch: o Passo 0 de `/diaria-edicao` acabou de buscar);
 *   - tokens das redes em modo leitura: LinkedIn pessoal (`GET /v2/userinfo`,
 *     `checkTokenRemote`) e Threads pessoal (lista os posts da última hora,
 *     `listThreadsProfilePosts`). Instagram: sem helper de leitura exportado,
 *     sai "não verificado" em vez de inventar chamada.
 *
 * Uso:
 *   npx tsx scripts/failover/neo-readiness.ts             # tabela; exit 0 pronto, 1 falta algo
 *   npx tsx scripts/failover/neo-readiness.ts --json      # relatório em JSON
 *   npx tsx scripts/failover/neo-readiness.ts --record    # grava o relatório no KV (infra:neo-readiness)
 *   npx tsx scripts/failover/neo-readiness.ts --offline   # sem chamada às APIs das redes
 *   npx tsx scripts/failover/neo-readiness.ts --if-neo --record
 *       Modo do Passo 0 de `/diaria-edicao`: fora do Neo não faz nada; no Neo
 *       grava no KV e imprime UMA linha de resumo. Sempre exit 0 (fail-soft:
 *       nunca bloqueia a edição).
 *
 * Sem `--record` não há efeito colateral (nenhuma escrita, nem no KV).
 * O `300` lê o registro e alarma se ele tiver mais de 7 dias ou estiver
 * vermelho (`scripts/neo-readiness-alarm.ts`, task `Diaria-Neo-Readiness-Alarm`).
 *
 * Exit: 0 pronto (ou `--if-neo`); 1 falta algo ou o `--record` falhou; 2 uso inválido.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";
import { findUnknownFlags, hasFlag, isMainModule } from "../lib/cli-args.ts";
import { checkNodeVersion } from "../lib/check-node-version.ts";
import { createKvRestOps } from "../lib/cloudflare-kv-rest.ts";
import { resolveOpsStateKvConfig } from "../lib/diaria/short-related-kv.ts";
import { isAgentWorktreePath } from "../lib/failover/neo-takeover-plan.ts";
import {
  aggregateReadiness,
  classifyThreadsReadError,
  CRITICAL_SCRIPT_REQUIREMENTS,
  evaluateDataDir,
  evaluateGhAuth,
  evaluateGit,
  evaluateNodeModules,
  evaluateNodeVersion,
  evaluateSecret,
  evaluateToken,
  formatSummaryLine,
  formatTaskLines,
  LEASE_SECRETS,
  NEO_READINESS_KV_KEY,
  serializeReadinessRecord,
  type CheckResult,
  type ReadinessReport,
  type TokenId,
  type TokenProbe,
} from "../lib/failover/neo-readiness.ts";
import { mergeDotenvUnderEnv, readPlatformConfigFile } from "../lib/failover/task-gate.ts";
import { checkTokenRemote, parseExpiresAt, readPersonalCreds } from "../lib/linkedin-personal.ts";
import { getMachineId, isNeoMachine } from "../lib/machine-id.ts";
import { resolveFailoverTier, SCHEDULED_TASKS, type ScheduledTaskDefinition } from "../lib/scheduled-tasks.ts";
import { DOPPLER_SCOPE_ARGS } from "../lib/secret-persist.ts";
import { listThreadsProfilePosts, readThreadsPersonalCreds, THREADS_PERSONAL_ENV } from "../lib/threads-personal-video.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const P = "[neo-readiness]";
const KNOWN_FLAGS = ["json", "record", "if-neo", "offline"] as const;
const FETCH_TIMEOUT_MS = 20_000;

export interface ReadinessDeps {
  root: string;
  now: () => Date;
  machineId: () => string;
  env: Record<string, string | undefined>;
  readDotenv: (root: string) => Record<string, string>;
  /** Nomes do Doppler; `null` = não consultado (CLI ausente, sem login, erro). */
  dopplerNames: () => { names: Set<string> } | { error: string };
  /** Roda um comando e devolve só o exit code e stdout (stderr descartado). */
  run: (cmd: string, args: string[], cwd: string) => { code: number | null; stdout: string; error?: string };
  fetch: typeof fetch;
  /** Grava no KV; lança em falha. */
  putKv: (env: Record<string, string | undefined>, key: string, value: string) => Promise<void>;
  tasks: readonly ScheduledTaskDefinition[];
  log: (msg: string) => void;
  err: (msg: string) => void;
}

function readDotenvFile(root: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(join(root, ".env"), "utf8"));
  } catch {
    return {};
  }
}

function runCmd(cmd: string, args: string[], cwd: string): { code: number | null; stdout: string; error?: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 60_000, windowsHide: true });
  if (r.error) return { code: null, stdout: "", error: r.error.message };
  return { code: r.status, stdout: r.stdout ?? "" };
}

/** Nomes do vault (JSON `{"NOME": {}}` do `--only-names --json`). */
export function parseDopplerNames(stdout: string): Set<string> | null {
  try {
    const o = JSON.parse(stdout) as unknown;
    if (Array.isArray(o)) return new Set(o.filter((x): x is string => typeof x === "string"));
    if (o && typeof o === "object") return new Set(Object.keys(o));
  } catch {
    // cai no null
  }
  return null;
}

function defaultDopplerNames(): { names: Set<string> } | { error: string } {
  const bin = process.env.DOPPLER_BIN || "doppler";
  const r = spawnSync(bin, ["secrets", "--only-names", "--json", ...DOPPLER_SCOPE_ARGS], { encoding: "utf8", timeout: 60_000, windowsHide: true });
  if (r.error) return { error: `doppler indisponível (${r.error.message})` };
  if (r.status !== 0) return { error: `doppler saiu ${r.status} (sem login?)` };
  const names = parseDopplerNames(r.stdout ?? "");
  return names ? { names } : { error: "saída do doppler ilegível" };
}

async function defaultPutKv(env: Record<string, string | undefined>, key: string, value: string): Promise<void> {
  const pc = readPlatformConfigFile(ROOT);
  if (pc.kind !== "ok") throw new Error(pc.kind === "absent" ? "platform.config.json ausente" : `platform.config.json ilegível (${pc.error})`);
  const cfg = resolveOpsStateKvConfig(pc.value, env);
  if (!cfg.ok) throw new Error(`configuração do KV ausente: ${cfg.missing.join(", ")}`);
  const kv = createKvRestOps(cfg.config);
  await kv.put(key, value);
  const back = await kv.get(key);
  if (back !== value) throw new Error("releitura do KV não confirmou a escrita");
}

function defaultDeps(): ReadinessDeps {
  return {
    root: ROOT,
    now: () => new Date(),
    machineId: getMachineId,
    env: process.env,
    readDotenv: readDotenvFile,
    dopplerNames: defaultDopplerNames,
    run: runCmd,
    // Teto por chamada: `listThreadsProfilePosts` não põe timeout, e o Passo 0
    // de `/diaria-edicao` não pode ficar pendurado numa API de rede social.
    fetch: (u, i) => fetch(u, { ...i, signal: i?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
    putKv: defaultPutKv,
    tasks: SCHEDULED_TASKS,
    log: (m) => console.log(m),
    err: (m) => console.error(m),
  };
}

/** Roda uma checagem; exceção vira `unverified` com o motivo, sem derrubar as outras. */
async function safe(id: string, fn: () => CheckResult | Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await fn();
  } catch (e) {
    return { id, status: "unverified", detail: `${id}: checagem falhou (${(e as Error).message.slice(0, 160)})` };
  }
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/** mtime mais recente de `data/` e de `data/editions/` (varredura rasa, com teto). */
function scanDataDir(dataDir: string): { accessible: boolean; error?: string; newestMtimeMs: number | null } {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch (e) {
    return { accessible: false, error: (e as NodeJS.ErrnoException).code ?? (e as Error).message, newestMtimeMs: null };
  }
  let newest: number | null = null;
  const consider = (p: string) => {
    try {
      const m = statSync(p).mtimeMs;
      if (newest === null || m > newest) newest = m;
    } catch {
      // entrada que sumiu ou sem permissão: ignora
    }
  };
  for (const e of entries.slice(0, 400)) consider(join(dataDir, e));
  try {
    for (const e of readdirSync(join(dataDir, "editions")).slice(-60)) consider(join(dataDir, "editions", e));
  } catch {
    // sem editions: segue com o topo
  }
  return { accessible: true, newestMtimeMs: newest };
}

async function probeLinkedIn(env: Record<string, string | undefined>, now: Date, fetchFn: typeof fetch): Promise<TokenProbe> {
  const creds = readPersonalCreds(env, now);
  if (!creds.ok) return creds.configured ? { state: "invalid", reason: creds.reason } : { state: "skipped", reason: "credencial ausente" };
  const remote = await checkTokenRemote(fetchFn, creds.creds.accessToken);
  if (remote.state === "valid") return { state: "valid" };
  if (remote.state === "revoked") return { state: "invalid", reason: remote.reason };
  return { state: "unknown", reason: remote.reason };
}

async function probeThreads(env: Record<string, string | undefined>, now: Date, fetchFn: typeof fetch): Promise<TokenProbe> {
  const creds = readThreadsPersonalCreds(env);
  if (!creds.ready) return { state: "skipped", reason: "credencial ausente" };
  const exp = parseExpiresAt(env[THREADS_PERSONAL_ENV.expiresAt]);
  if (exp && exp.getTime() <= now.getTime()) return { state: "invalid", reason: `vencido em ${exp.toISOString()}` };
  try {
    await listThreadsProfilePosts({ creds: creds.creds, sinceIso: new Date(now.getTime() - 3_600_000).toISOString(), fetch: fetchFn });
    return { state: "valid" };
  } catch (e) {
    return classifyThreadsReadError((e as Error).message);
  }
}

export interface CollectOptions {
  offline: boolean;
}

/** Roda todas as checagens e agrega. Nunca lança. */
export async function collectReadiness(d: ReadinessDeps, opts: CollectOptions): Promise<ReadinessReport> {
  const now = d.now();
  const tasks = d.tasks.filter((t) => resolveFailoverTier(t) === "critical");
  const env = mergeDotenvUnderEnv(d.readDotenv(d.root), d.env);
  const byId = new Map<string, CheckResult>();
  const put = (c: CheckResult) => byId.set(c.id, c);

  // Doppler: uma consulta para todos os segredos.
  let doppler: Set<string> | null = null;
  const dop = await safe("doppler", () => {
    const r = d.dopplerNames();
    if ("error" in r) return { id: "doppler", status: "unverified", detail: `Doppler não consultado: ${r.error}` };
    doppler = r.names;
    return { id: "doppler", status: "ok", detail: `Doppler consultado (${r.names.size} nomes)` };
  });

  const common: CheckResult[] = [dop];
  common.push(
    await safe("node", () => {
      const nvmrcPath = join(d.root, ".nvmrc");
      const nvmrc = existsSync(nvmrcPath) ? readFileSync(nvmrcPath, "utf8") : null;
      return evaluateNodeVersion(process.version, nvmrc, checkNodeVersion(process.version).ok);
    }),
  );
  common.push(await safe("node_modules", () => evaluateNodeModules(readJson(join(d.root, "package-lock.json")), readJson(join(d.root, "node_modules", ".package-lock.json")))));
  common.push(
    await safe("gh", () => {
      const r = d.run("gh", ["auth", "status"], d.root);
      return evaluateGhAuth(r.code, r.error);
    }),
  );
  common.push(
    await safe("git", () => {
      const branch = d.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], d.root);
      const behind = d.run("git", ["rev-list", "--count", "HEAD..origin/master"], d.root);
      const dirty = d.run("git", ["status", "--porcelain", "--untracked-files=no"], d.root);
      const n = Number(behind.stdout.trim());
      return evaluateGit({
        branch: branch.code === 0 ? branch.stdout.trim() : null,
        behind: behind.code === 0 && Number.isFinite(n) ? n : null,
        dirtyTracked: dirty.code === 0 ? dirty.stdout.split("\n").filter((l) => l.trim()).length : null,
        isAgentWorktree: isAgentWorktreePath(d.root),
      });
    }),
  );
  common.push(await safe("data", () => evaluateDataDir(scanDataDir(join(d.root, "data")), now)));
  for (const names of LEASE_SECRETS) common.push(await safe(`secret:${names[0]}`, () => evaluateSecret(names, env, doppler)));

  // Por task: scripts, guard, segredos e tokens.
  const tokens = new Set<TokenId>();
  for (const task of tasks) {
    for (const step of task.steps) {
      const id = `script:${step.script}`;
      if (!byId.has(id)) put(await safe(id, () => (existsSync(join(d.root, step.script)) ? { id, status: "ok", detail: `${step.script} existe` } : { id, status: "fail", detail: `${step.script} não existe no checkout` })));
      const req = CRITICAL_SCRIPT_REQUIREMENTS[step.script];
      for (const names of req?.secrets ?? []) {
        const sid = `secret:${names[0]}`;
        if (!byId.has(sid)) put(await safe(sid, () => evaluateSecret(names, env, doppler)));
      }
      for (const t of req?.tokens ?? []) tokens.add(t);
    }
    if (task.guard) {
      const id = `guard:${task.guard.requiredFile}`;
      const file = task.guard.requiredFile;
      if (!byId.has(id)) put(await safe(id, () => (existsSync(join(d.root, "data", ...file.split("/"))) ? { id, status: "ok", detail: `data/${file} existe` } : { id, status: "fail", detail: `data/${file} ausente` })));
    }
  }

  for (const t of tokens) {
    const id = `token:${t}`;
    put(
      await safe(id, async () => {
        if (opts.offline) return evaluateToken(t, { state: "skipped", reason: "--offline" });
        if (t === "linkedin") return evaluateToken(t, await probeLinkedIn(env, now, d.fetch));
        if (t === "threads") return evaluateToken(t, await probeThreads(env, now, d.fetch));
        return evaluateToken(t, { state: "no-helper", reason: "sem helper de leitura seguro no repo" });
      }),
    );
  }

  return aggregateReadiness({ tasks, common, byId, now, machineId: d.machineId() });
}

export async function main(argv: string[], deps: Partial<ReadinessDeps> = {}): Promise<number> {
  const d: ReadinessDeps = { ...defaultDeps(), ...deps };
  const unknown = findUnknownFlags(argv, KNOWN_FLAGS);
  if (unknown.length) {
    d.err(`${P} flag desconhecida: ${unknown.join(", ")}\nUso: neo-readiness.ts [--json] [--record] [--offline] [--if-neo]`);
    return 2;
  }
  const ifNeo = hasFlag(argv, "if-neo");
  const record = hasFlag(argv, "record");
  const id = d.machineId();
  if (ifNeo && !isNeoMachine(id)) {
    d.log(`${P} máquina ${id || "?"} não é o Neo: check de prontidão pulado`);
    return 0;
  }

  let report: ReadinessReport;
  try {
    report = await collectReadiness(d, { offline: hasFlag(argv, "offline") });
  } catch (e) {
    // collectReadiness não deveria lançar; se lançar, o Passo 0 segue.
    d.err(`${P} erro inesperado: ${(e as Error).message}`);
    return ifNeo ? 0 : 1;
  }

  let recordFailed = false;
  if (record) {
    try {
      const env = mergeDotenvUnderEnv(d.readDotenv(d.root), d.env);
      await d.putKv(env, NEO_READINESS_KV_KEY, serializeReadinessRecord(report));
    } catch (e) {
      recordFailed = true;
      d.err(`${P} AVISO: registro no KV falhou (${(e as Error).message}); o alarme do 300 vai ver o check como velho`);
    }
  }

  if (ifNeo) {
    d.log(`${P} ${formatSummaryLine(report)}${record ? (recordFailed ? " (NÃO gravado no KV)" : " (gravado no KV)") : ""}`);
    return 0;
  }
  if (hasFlag(argv, "json")) d.log(JSON.stringify(report, null, 2));
  else {
    for (const line of formatTaskLines(report)) d.log(line);
    for (const c of report.checks.filter((x) => x.status !== "ok")) d.err(`${P} ${c.status === "fail" ? "FALHA" : "não verificado"}: ${c.detail}`);
    d.log(`${P} ${formatSummaryLine(report)}`);
  }
  return report.ok && !recordFailed ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (c) => {
      process.exitCode = c;
    },
    (e) => {
      console.error(`${P}`, e instanceof Error ? e.message : e);
      process.exitCode = hasFlag(process.argv.slice(2), "if-neo") ? 0 : 1;
    },
  );
}
