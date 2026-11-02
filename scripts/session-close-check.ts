/** Read-only evidence for /diaria-encerra (#11524). Unknown checks block closure. */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { listActiveSessions, resolveRepoRoot, type SessionRecord } from "./lib/session-registry.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  hashPath, isUnchangedSinceSnapshot, readSnapshot, snapshotFilePath, type DirtySnapshot,
} from "../.claude/hooks/lib/session-dirty-snapshot.mjs";

type Run = (command: string, args: string[], cwd: string) => string;
const runCommand: Run = (command, args, cwd) => execFileSync(command, args, {
  cwd, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
});

export interface CloseReport {
  canClose: boolean;
  pending: string[];
  errors: string[];
  checkedWorktrees: string[];
  manualChecks: string[];
  /** Dirty entries that do not block closure (#11733): line-ending-only diffs and routine audience snapshots. */
  ignored: string[];
  /** Dirt that was already in the checkout when the session started (#11785): never affects canClose, stays visible. */
  preExisting: string[];
  /** How preExisting was attributed per checked worktree (#11785): start-of-session snapshot, or mtime fallback. */
  attribution: string[];
}

/** Loads the start-of-session dirty snapshot (`.claude/hooks/session-start-dirty-snapshot.mjs`) of a checkout. */
export type SnapshotLoader = (sessionId: string, checkout: string) => DirtySnapshot | null;
const loadSnapshotFromTmp: SnapshotLoader = (sessionId, checkout) => {
  const path = snapshotFilePath(sessionId, checkout);
  return path ? readSnapshot(path) : null;
};

/** Routine Stage 0 audience snapshots, committed by `chore: snapshot de audiência`, never by the session (#11733). */
export function isRoutineAudienceSnapshot(path: string): boolean {
  return path === "context/audience-profile.md" || /^docs\/audience-history\/[^/]+\.md$/.test(path);
}

interface StatusEntry { code: string; path: string; line: string }

/** Parses `git status --porcelain=v1`; renames keep the destination path. Quoted paths stay as-is (never filtered). */
export function parsePorcelainStatus(status: string): StatusEntry[] {
  return status.split("\n").filter(Boolean).map(line => {
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    return { code, path: arrow >= 0 ? rest.slice(arrow + 4) : rest, line };
  });
}

/** Only plain modifications (M in index and/or worktree, nothing else) can be line-ending-only. */
const isPlainModification = (code: string): boolean => /^[M ][M ]$/.test(code) && code !== "  ";

/** Latest of mtime/ctime (ms; ctime moves on rename/chmod and cannot be set by `touch -d`) of a regular file; undefined for missing files, directories or errors (never ignorable). */
const fileMtimeMs = (abs: string): number | undefined => {
  try { const st = statSync(abs); return st.isFile() ? Math.max(st.mtimeMs, st.ctimeMs) : undefined; } catch { return undefined; }
};

/** Does not infer process liveness from registry.pid (an ephemeral beacon PID). */
export function checkSessionClose(root: string, session: SessionRecord | undefined,
  extraWorktrees: string[] = [], run: Run = runCommand,
  mtimeMs: (abs: string) => number | undefined = fileMtimeMs,
  loadSnapshot: SnapshotLoader = loadSnapshotFromTmp,
  hash: (abs: string) => string | null = hashPath): CloseReport {
  const report: CloseReport = { canClose: false, pending: [], errors: [], checkedWorktrees: [], ignored: [],
    preExisting: [], attribution: [], manualChecks: ["tasks/agents em segundo plano", "promessas e follow-ups no transcript"] };
  if (!session) {
    report.errors.push("Sessão não encontrada no registry; confirme a identidade antes de encerrar.");
    return report;
  }
  const query = (command: string, args: string[], cwd = root): string | undefined => {
    try { return run(command, args, cwd); }
    catch (error) { report.errors.push(`${command} ${args.join(" ")} (${cwd}): ${String(error)}`); return undefined; }
  };
  for (const issue of session.claimed_issues ?? []) report.pending.push(`claim: #${issue}`);
  for (const issue of session.claimed_foreign_issues ?? []) report.pending.push(`claim: ${issue}`);
  const branches = new Set<string>(session.branch ? [session.branch] : []);
  const paths = new Set([...extraWorktrees, ...(session.worktrees ?? []).map(w => w.path)].map(p => resolve(root, p)));
  const worktrees = query("git", ["worktree", "list", "--porcelain"]);
  // Discover the current location of the session branch, never all peer worktrees.
  for (const block of worktrees?.split("\n\n") ?? []) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (path && branch && branches.has(branch)) paths.add(path);
  }
  if (!paths.size) report.errors.push("Nenhum worktree atribuído; informe --worktree pelo histórico da sessão.");
  for (const path of paths) {
    report.checkedWorktrees.push(path);
    const snapshot = loadSnapshot(session.sessionId, path);
    // With a snapshot, untracked files are listed one by one (as in the snapshot), so each is matched by hash.
    const status = query("git", ["status", "--porcelain=v1", `--untracked-files=${snapshot ? "all" : "normal"}`], path);
    if (status?.trim()) {
      const entries = parsePorcelainStatus(status);
      // Content diff ignoring CR at EOL: a CRLF-only working copy (core.autocrlf, Windows editor) has
      // no entry here. Any failure keeps every modification blocking (conservative, #11733).
      let contentChanged: Set<string> | undefined;
      if (entries.some(e => isPlainModification(e.code))) {
        const names = query("git", ["diff", "--ignore-space-at-eol", "--name-only", "HEAD"], path);
        if (names !== undefined) contentChanged = new Set(names.split("\n").filter(Boolean));
      }
      // Initial-state signal. Preferred (#11785): the start-of-session snapshot. Dirt that was there with the same
      // status code and content hash is pre-existing; a new file, a changed hash (even on a file that was already
      // dirty) or a changed code blocks. Fallback without a snapshot (#11733): a file last written BEFORE the session
      // started is very unlikely to have been touched by it (best-effort: mtime/ctime). Unknown mtime, directories,
      // quoted paths and deletions stay blocking; nothing is restored or removed.
      const startedMs = Date.parse(session.startedAt);
      const preExisting = (e: StatusEntry): boolean => {
        if (e.path.startsWith("\"")) return false;
        if (snapshot) return isUnchangedSinceSnapshot(snapshot, path, e, hash);
        if (!Number.isFinite(startedMs) || e.path.endsWith("/")) return false;
        if (!(e.code === "??" || e.code === " M")) return false; // staged entries are a session action
        const m = mtimeMs(resolve(path, e.path));
        return m !== undefined && m < startedMs;
      };
      const blocking: string[] = [];
      for (const entry of entries) {
        if (isRoutineAudienceSnapshot(entry.path)) {
          report.ignored.push(`snapshot de audiência rotineiro (não bloqueia): ${path}: ${entry.line}`);
        } else if (contentChanged && isPlainModification(entry.code) && !entry.path.startsWith("\"")
          && !contentChanged.has(entry.path)) {
          report.ignored.push(`só fim de linha (CRLF/LF, não bloqueia): ${path}: ${entry.line}`);
        } else if (preExisting(entry)) {
          report.preExisting.push(`${path}: ${entry.line}`);
        } else blocking.push(entry.line);
      }
      if (blocking.length) report.pending.push(`mudanças não commitadas: ${path}\n${blocking.join("\n")}`);
      report.attribution.push(snapshot
        ? `${path}: foto do início da sessão (${snapshot.capturedAt}), por código de status e hash`
        : `${path}: sem foto do início da sessão, atribuição por hash impossível; usado o mtime (best-effort)`);
    }
    const branch = query("git", ["branch", "--show-current"], path)?.trim();
    if (branch) branches.add(branch);
    else if (branch === "") report.errors.push(`HEAD detached: ${path}; conferir commits da sessão.`);
    const upstream = query("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], path)?.trim();
    if (upstream) {
      // Refresh remote evidence; stale tracking refs must not certify a push.
      const remote = query("git", ["config", "--get", `branch.${branch}.remote`], path)?.trim();
      if (remote && remote !== ".") query("git", ["fetch", "--no-tags", remote], path);
      const ahead = query("git", ["rev-list", "--count", "@{upstream}..HEAD"], path)?.trim();
      if (ahead && ahead !== "0") report.pending.push(`commits não enviados: ${path} (${ahead})`);
    }
  }
  for (const branch of branches) {
    const raw = query("gh", ["pr", "list", "--head", branch, "--state", "open", "--limit", "100", "--json", "number,url,headRefName"]);
    if (raw !== undefined) {
      try {
        const prs: { number: number; url: string; headRefName: string }[] = JSON.parse(raw);
        for (const pr of prs) if (pr.headRefName === branch) report.pending.push(`PR aberta: #${pr.number} ${pr.url}`);
      } catch (error) { report.errors.push(`Resposta de PR inválida: ${String(error)}`); }
    }
  }
  const stashes = query("git", ["stash", "list", "--format=%gd%x09%ct%x09%gs"]);
  for (const line of stashes?.trim().split("\n").filter(Boolean) ?? []) {
    const [ref, seconds, ...subject] = line.split("\t");
    if (Number(seconds) * 1000 >= Date.parse(session.startedAt)) {
      report.pending.push(`stash desde início da sessão (confirmar autoria): ${ref} ${subject.join("\t")}`);
    }
  }
  // canClose covers mechanical checks only; the skill must also clear manualChecks.
  report.canClose = report.pending.length === 0 && report.errors.length === 0;
  return report;
}

if (isMainModule(import.meta.url)) {
  try {
    const { values } = parseArgs(process.argv.slice(2));
    const sessionId = values["session-id"] ?? process.env.DIARIA_INJECTED_SESSION_ID ?? process.env.CLAUDE_SESSION_ID;
    if (!sessionId) throw new Error("Informe o ID real da sessão com --session-id; não invente uma identidade.");
    const root = resolveRepoRoot();
    const session = listActiveSessions(root).find(s => s.sessionId === sessionId);
    const report = checkSessionClose(root, session, values.worktree ? [values.worktree] : []);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.canClose ? 0 : 1;
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
