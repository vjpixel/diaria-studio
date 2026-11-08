/**
 * scripts/triage-preserved-worktrees.ts (#12374)
 *
 * Irmão de `cleanup-merged-worktrees.ts`: aquele remove o que é seguro e
 * PRESERVA todo worktree com trabalho não commitado (#7304); este faz a
 * triagem do que ficou preservado e oferece uma rota de descarte com resgate.
 *
 * Modo padrão = RELATÓRIO, somente leitura: lista cada worktree com arquivo
 * sujo ou commit não enviado, com idade, contagem de sujos, commits fora do
 * remoto, estado da PR da branch, lock e uso por sessão viva, e o veredito
 * (`descartavel`/`manter`, regra em `scripts/lib/worktree-triage.ts`).
 *
 * `--discard` = descarte com resgate, só dos `descartavel` (e, com `--only`,
 * só dos nomes listados). Para cada um, ANTES de remover, grava em
 * `{rescue-dir}/{AAAA-MM-DD}/{nome}/`:
 *   - `tracked.diff`            — `git diff --binary HEAD` (rastreados, staged + unstaged);
 *   - `untracked.txt`           — lista dos arquivos untracked (o conteúdo deles NÃO vai);
 *   - `unpushed-commits.patch`  — `git format-patch --stdout HEAD --not --remotes`;
 *   - `meta.json`               — os fatos da triagem, HEAD e data.
 * Confere que os arquivos foram gravados (tamanho no disco = bytes gerados) e
 * só então remove. Logo antes de remover, reconfere a PR aberta da branch.
 * Nunca remove worktree em uso por sessão viva, com lock ativo/recente ou com
 * PR aberta (a regra completa está na lib). `rescue-dir` default é
 * `{root}/data/worktree-rescue`; sem `data/` no checkout, o descarte recusa.
 *
 * Uso:
 *   npx tsx scripts/triage-preserved-worktrees.ts [--root <repo>] [--json]
 *       [--all] [--min-idle-days N] [--session-id <id>]
 *       [--discard [--only nome1,nome2] [--rescue-dir <dir>]]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsWithTrueDefault as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { listActiveSessions, type SessionRecord } from "./lib/session-registry.ts";
import {
  excludeMainWorktree,
  filterOutInUseWorktrees,
  getWorktreeLastActivityMsSafe,
  parseWorktreePorcelain,
  removeWorktreeSafe,
  selectInUseWorktreeNames,
  worktreeNameFromPath,
  type WorktreeEntry,
} from "./cleanup-merged-worktrees.ts";
import {
  classifyForDiscard,
  DEFAULT_MIN_IDLE_MS,
  parseLockPid,
  parseLockReasons,
  renderTriageReport,
  rescueSubdirFor,
  summarizePorcelainStatus,
  summarizePrState,
  type PrSummary,
  type TriageDecision,
  type TriageFacts,
} from "./lib/worktree-triage.ts";

const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 512 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TriageDeps {
  /** `gh pr list --head B --state all`; `null` quando a consulta falha. */
  prsForBranch: (branch: string) => PrSummary[] | null;
  listActiveSessions: () => { sessions: SessionRecord[]; readable: boolean };
  /** `true` vivo, `false` morto, `null` sem como conferir. */
  isPidAlive: (pid: number) => boolean | null;
  removeWorktree: (path: string) => { ok: boolean; error?: string };
  nowMs: number;
  log: (line: string) => void;
}

function git(args: string[], cwd: string): { ok: boolean; stdout: Buffer; stderr: string } {
  try {
    const r = spawnSync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    return { ok: r.status === 0, stdout: r.stdout ?? Buffer.alloc(0), stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8") };
  } catch (e) {
    return { ok: false, stdout: Buffer.alloc(0), stderr: (e as Error).message };
  }
}

export function prsForBranchViaGh(branch: string, cwd: string): PrSummary[] | null {
  try {
    const r = spawnSync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state", "--limit", "20"],
      { cwd, encoding: "utf8", timeout: 15_000 },
    );
    if (r.status !== 0) return null;
    const parsed = JSON.parse(r.stdout ?? "") as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (p): p is PrSummary => typeof p === "object" && p !== null && typeof (p as PrSummary).number === "number",
    );
  } catch {
    return null;
  }
}

export function isPidAliveSafe(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM = existe, mas é de outro usuário: vivo.
    if (code === "EPERM") return true;
    return null;
  }
}

function dirtySummary(path: string): TriageFacts["dirty"] {
  if (!existsSync(path)) return { tracked: 0, untracked: 0, total: 0 };
  const r = git(["status", "--porcelain"], path);
  return r.ok ? summarizePorcelainStatus(r.stdout.toString("utf8")) : null;
}

function unpushedCount(path: string): number | null {
  if (!existsSync(path)) return null;
  const r = git(["rev-list", "--count", "HEAD", "--not", "--remotes"], path);
  if (!r.ok) return null;
  const n = Number(r.stdout.toString("utf8").trim());
  return Number.isFinite(n) ? n : null;
}

export interface TriageRow {
  facts: TriageFacts;
  decision: TriageDecision;
}

/** Coleta os fatos de cada worktree (exceto o principal) e classifica. Somente leitura. */
export function collectTriage(
  repoRoot: string,
  deps: Pick<TriageDeps, "prsForBranch" | "listActiveSessions" | "isPidAlive" | "nowMs">,
  opts: { includeClean: boolean; minIdleMs: number; ownSessionId?: string },
): TriageRow[] {
  const list = git(["worktree", "list", "--porcelain"], repoRoot);
  if (!list.ok) throw new Error(`git worktree list falhou: ${list.stderr.trim()}`);
  const porcelain = list.stdout.toString("utf8");
  const entries: WorktreeEntry[] = excludeMainWorktree(parseWorktreePorcelain(porcelain));
  const lockReasons = parseLockReasons(porcelain);
  const probe = deps.listActiveSessions();
  const inUseSets = selectInUseWorktreeNames(probe.sessions, opts.ownSessionId);
  const notInUse = new Set(filterOutInUseWorktrees(entries, inUseSets).map((e) => e.path));

  const rows: TriageRow[] = [];
  for (const e of entries) {
    const dirty = dirtySummary(e.path);
    const unpushed = unpushedCount(e.path);
    const hasWork = dirty === null || dirty.total > 0 || unpushed === null || unpushed > 0;
    if (!opts.includeClean && !hasWork) continue;
    const lockReason = lockReasons.get(e.path) ?? null;
    const pid = e.locked ? parseLockPid(lockReason) : null;
    const facts: TriageFacts = {
      path: e.path,
      name: worktreeNameFromPath(e.path),
      branch: e.branch,
      locked: e.locked,
      lockReason,
      lockPidAlive: pid === null ? null : deps.isPidAlive(pid),
      lastActivityMs: getWorktreeLastActivityMsSafe(e.path),
      dirty,
      unpushedCommits: unpushed,
      pr: e.branch === null ? { state: "unknown", prNumbers: [] } : summarizePrState(deps.prsForBranch(e.branch)),
      inUse: !notInUse.has(e.path),
      registryReadable: probe.readable,
    };
    rows.push({ facts, decision: classifyForDiscard(facts, deps.nowMs, opts.minIdleMs) });
  }
  return rows;
}

function writeChecked(file: string, content: Buffer | string): void {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  writeFileSync(file, buf);
  const size = statSync(file).size;
  if (size !== buf.length) throw new Error(`${file}: gravou ${size} de ${buf.length} bytes`);
}

/**
 * Grava o resgate de um worktree e devolve o diretório. Lança se qualquer
 * leitura do git falhar ou a gravação não conferir: sem resgate íntegro, o
 * chamador não remove.
 */
export function saveRescueBundle(facts: TriageFacts, rescueRoot: string, nowMs: number): string {
  const dir = join(rescueRoot, rescueSubdirFor(facts.name, nowMs));
  if (existsSync(dir)) throw new Error(`diretório de resgate já existe: ${dir}`);
  mkdirSync(dir, { recursive: true });

  const head = git(["rev-parse", "HEAD"], facts.path);
  if (!head.ok) throw new Error(`git rev-parse HEAD falhou: ${head.stderr.trim()}`);
  const diff = git(["diff", "--binary", "HEAD"], facts.path);
  if (!diff.ok) throw new Error(`git diff falhou: ${diff.stderr.trim()}`);
  if ((facts.dirty?.tracked ?? 0) > 0 && diff.stdout.length === 0) {
    throw new Error("há arquivo rastreado sujo e o git diff saiu vazio");
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], facts.path);
  if (!untracked.ok) throw new Error(`git ls-files falhou: ${untracked.stderr.trim()}`);
  const untrackedList = untracked.stdout
    .toString("utf8")
    .split("\0")
    .filter((p) => p !== "");
  const commits = git(["format-patch", "--stdout", "HEAD", "--not", "--remotes"], facts.path);
  if (!commits.ok) throw new Error(`git format-patch falhou: ${commits.stderr.trim()}`);
  if ((facts.unpushedCommits ?? 0) > 0 && commits.stdout.length === 0) {
    throw new Error("há commit não enviado e o format-patch saiu vazio");
  }

  writeChecked(join(dir, "tracked.diff"), diff.stdout);
  writeChecked(join(dir, "untracked.txt"), untrackedList.join("\n") + (untrackedList.length > 0 ? "\n" : ""));
  writeChecked(join(dir, "unpushed-commits.patch"), commits.stdout);
  writeChecked(
    join(dir, "meta.json"),
    JSON.stringify(
      { issue: 12374, saved_at: new Date(nowMs).toISOString(), head: head.stdout.toString("utf8").trim(), untracked_count: untrackedList.length, ...facts },
      null,
      2,
    ) + "\n",
  );
  return dir;
}

export function runTriage(args: Record<string, string>, repoRoot: string, deps: TriageDeps): number {
  const discard = args.discard === "true";
  const minIdleDays = args["min-idle-days"] !== undefined ? Number(args["min-idle-days"]) : NaN;
  const minIdleMs = Number.isFinite(minIdleDays) && minIdleDays >= 0 ? minIdleDays * DAY_MS : DEFAULT_MIN_IDLE_MS;
  const ownSessionId = args["session-id"] ? String(args["session-id"]) : undefined;
  const only = args.only ? new Set(String(args.only).split(",").map((s) => s.trim()).filter(Boolean)) : null;

  let rows: TriageRow[];
  try {
    rows = collectTriage(repoRoot, deps, { includeClean: args.all === "true", minIdleMs, ownSessionId });
  } catch (e) {
    deps.log(`[triage-preserved-worktrees] ${(e as Error).message}`);
    return 2;
  }

  if (args.json === "true") deps.log(JSON.stringify(rows, null, 2));
  else deps.log(renderTriageReport(rows));

  if (!discard) return 0;

  const explicitRescue = args["rescue-dir"] !== undefined && args["rescue-dir"] !== "true";
  const rescueRoot = explicitRescue ? resolve(String(args["rescue-dir"])) : join(repoRoot, "data", "worktree-rescue");
  if (!explicitRescue && !existsSync(join(repoRoot, "data"))) {
    deps.log(`[triage-preserved-worktrees] --discard recusado: ${join(repoRoot, "data")} não existe para guardar o resgate.`);
    return 1;
  }

  let removed = 0;
  let failed = 0;
  for (const { facts, decision } of rows) {
    if (decision.verdict !== "descartavel") continue;
    if (only !== null && !only.has(facts.name)) continue;
    // Reconfere a PR logo antes de remover: uma PR aberta no meio do caminho manda manter.
    const fresh = facts.branch === null ? { state: "unknown" } : summarizePrState(deps.prsForBranch(facts.branch));
    if (fresh.state !== "merged" && fresh.state !== "closed") {
      deps.log(`[triage-preserved-worktrees] mantido ${facts.name}: estado da PR mudou para ${fresh.state}.`);
      continue;
    }
    let dir: string;
    try {
      dir = saveRescueBundle(facts, rescueRoot, deps.nowMs);
    } catch (e) {
      failed++;
      deps.log(`[triage-preserved-worktrees] resgate falhou, ${facts.name} mantido: ${(e as Error).message}`);
      continue;
    }
    if (facts.locked) {
      const unlock = git(["worktree", "unlock", facts.path], repoRoot);
      if (!unlock.ok) {
        failed++;
        deps.log(`[triage-preserved-worktrees] unlock falhou, ${facts.name} mantido (resgate em ${dir}): ${unlock.stderr.trim()}`);
        continue;
      }
    }
    const result = deps.removeWorktree(facts.path);
    if (result.ok) {
      removed++;
      deps.log(`[triage-preserved-worktrees] removido ${facts.name} (resgate em ${dir}).`);
    } else {
      failed++;
      deps.log(`[triage-preserved-worktrees] remoção falhou, ${facts.name} mantido (resgate em ${dir}): ${result.error}`);
    }
  }
  deps.log(`[triage-preserved-worktrees] descarte: ${removed} removido(s), ${failed} falha(s).`);
  return failed > 0 ? 1 : 0;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.root ? resolve(String(args.root)) : ROOT;
  process.exitCode = runTriage(args, repoRoot, {
    prsForBranch: (branch) => prsForBranchViaGh(branch, repoRoot),
    listActiveSessions: () => {
      try {
        return { sessions: listActiveSessions(repoRoot), readable: true };
      } catch {
        return { sessions: [], readable: false };
      }
    },
    isPidAlive: isPidAliveSafe,
    removeWorktree: (path) => removeWorktreeSafe(path, repoRoot),
    nowMs: Date.now(),
    log: (line) => console.log(line),
  });
}

if (isMainModule(import.meta.url)) {
  main();
}
