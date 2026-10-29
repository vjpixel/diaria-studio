/** Read-only evidence for /diaria-encerra (#11524). Unknown checks block closure. */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { listActiveSessions, resolveRepoRoot, type SessionRecord } from "./lib/session-registry.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";

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
}

/** Does not infer process liveness from registry.pid (an ephemeral beacon PID). */
export function checkSessionClose(root: string, session: SessionRecord | undefined,
  extraWorktrees: string[] = [], run: Run = runCommand): CloseReport {
  const report: CloseReport = { canClose: false, pending: [], errors: [], checkedWorktrees: [],
    manualChecks: ["tasks/agents em segundo plano", "promessas e follow-ups no transcript"] };
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
    const status = query("git", ["status", "--porcelain=v1", "--untracked-files=normal"], path);
    if (status?.trim()) report.pending.push(`mudanças não commitadas: ${path}\n${status.trimEnd()}`);
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
