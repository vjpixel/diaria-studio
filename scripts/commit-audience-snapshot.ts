#!/usr/bin/env node
/**
 * scripts/commit-audience-snapshot.ts (#11733 item 2)
 *
 * Commita o snapshot de audiência do Stage 0 (passo 0i) numa PR, sem tocar o
 * checkout compartilhado. Chamado pelo `stage-0-run.ts` logo depois do 0i,
 * fail-soft; também roda à mão. Racional e decisões em
 * `scripts/lib/audience-snapshot-pr.ts`.
 *
 * Fluxo:
 *   1. `git status` do checkout (só os caminhos do 0i). Nada sujo → `clean`.
 *   2. `git fetch origin master`; procura PR de snapshot aberta
 *      (`gh pr list`). Com PR: base = a branch dela; sem: `origin/master` e
 *      branch nova `chore/audience-snapshot-AAAAMMDD-HHMMSS`.
 *   3. `git worktree add --detach` temporário na base, copia os arquivos do
 *      checkout para lá (remoção vira remoção), `git add -A` só nesses caminhos.
 *      Nada a commitar (a base já tem esse conteúdo) → `up-to-date`.
 *   4. commit, `git push origin HEAD:refs/heads/{branch}` (sem force) e, sem
 *      PR aberta, `gh pr create`. Nunca mergeia.
 *   5. Remove o worktree no `finally`, sucesso ou falha.
 *
 * Saída: JSON no stdout `{ outcome, paths, branch?, pr?, error? }`.
 * Exit 0 em `clean`/`up-to-date`/`pr-opened`/`pr-updated`; 1 em `failed`.
 *
 * Uso: npx tsx scripts/commit-audience-snapshot.ts [--root DIR] [--dry-run]
 *   --dry-run: só lista o que entraria na PR (sem fetch, worktree, commit nem PR).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  AUDIENCE_SNAPSHOT_PATHSPEC,
  buildSnapshotCommitTitle,
  buildSnapshotPrBody,
  newSnapshotBranchName,
  pickOpenSnapshotPr,
  selectSnapshotPaths,
  type OpenPrRef,
} from "./lib/audience-snapshot-pr.ts";

export type CmdRunner = (args: string[], cwd: string) => string;

const runWith = (bin: string): CmdRunner => (args, cwd) =>
  execFileSync(bin, args, { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });

export interface SnapshotPrDeps {
  git: CmdRunner;
  gh: CmdRunner;
  now: () => Date;
  makeTempDir: () => string;
}

export const productionDeps = (): SnapshotPrDeps => ({
  git: runWith("git"),
  gh: runWith("gh"),
  now: () => new Date(),
  makeTempDir: () => mkdtempSync(join(tmpdir(), "audience-snapshot-")),
});

export type SnapshotPrOutcome = "clean" | "dry-run" | "up-to-date" | "pr-opened" | "pr-updated" | "failed";

export interface SnapshotPrResult {
  outcome: SnapshotPrOutcome;
  paths: string[];
  branch?: string;
  pr?: string;
  error?: string;
}

export function commitAudienceSnapshot(root: string, deps: SnapshotPrDeps, opts: { dryRun?: boolean } = {}): SnapshotPrResult {
  let entries;
  try {
    const status = deps.git(["status", "--porcelain=v1", "--untracked-files=all", "--", ...AUDIENCE_SNAPSHOT_PATHSPEC], root);
    entries = selectSnapshotPaths(status);
  } catch (e) {
    return { outcome: "failed", paths: [], error: `git status: ${(e as Error).message}` };
  }
  const paths = entries.map((e) => e.path);
  if (paths.length === 0) return { outcome: "clean", paths };
  if (opts.dryRun) return { outcome: "dry-run", paths };

  let worktree: string | undefined;
  let branch: string | undefined;
  try {
    deps.git(["fetch", "origin", "master"], root);
    const listed = JSON.parse(deps.gh(["pr", "list", "--state", "open", "--json", "number,headRefName,url", "--limit", "200"], root)) as OpenPrRef[];
    if (!Array.isArray(listed)) throw new Error("gh pr list não devolveu uma lista");
    const open = pickOpenSnapshotPr(listed);
    branch = open?.headRefName ?? newSnapshotBranchName(deps.now());
    let base = "origin/master";
    if (open) {
      deps.git(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], root);
      base = `origin/${branch}`;
    }

    worktree = deps.makeTempDir();
    // mkdtemp cria o diretório; `git worktree add` aceita diretório vazio existente.
    deps.git(["worktree", "add", "--detach", worktree, base], root);
    for (const p of paths) {
      const src = resolve(root, p);
      const dest = resolve(worktree, p);
      if (existsSync(src)) {
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest);
      } else if (existsSync(dest)) {
        rmSync(dest);
      }
    }
    // Pathspec dos 2 caminhos do 0i, não a lista: uma remoção que a base já
    // tem (arquivo ausente nos dois lados) faria `git add -- <arquivo>` falhar
    // com "pathspec did not match". O worktree é recém-criado, então o único
    // diff ali é o que acabou de ser copiado.
    deps.git(["add", "-A", "--", ...AUDIENCE_SNAPSHOT_PATHSPEC], worktree);
    const staged = deps.git(["diff", "--cached", "--name-only"], worktree).trim();
    if (!staged) return { outcome: "up-to-date", paths, branch: open ? branch : undefined, pr: open?.url };

    const title = buildSnapshotCommitTitle(paths);
    deps.git(["commit", "-m", title], worktree);
    deps.git(["push", "origin", `HEAD:refs/heads/${branch}`], worktree);
    if (open) return { outcome: "pr-updated", paths, branch, pr: open.url ?? `#${open.number}` };
    const url = deps.gh(["pr", "create", "--base", "master", "--head", branch, "--title", title, "--body", buildSnapshotPrBody(entries)], worktree).trim();
    return { outcome: "pr-opened", paths, branch, pr: url };
  } catch (e) {
    return { outcome: "failed", paths, branch, error: (e as Error).message };
  } finally {
    if (worktree) {
      try {
        deps.git(["worktree", "remove", "--force", worktree], root);
      } catch {
        try { rmSync(worktree, { recursive: true, force: true }); } catch { /* best-effort */ }
        try { deps.git(["worktree", "prune"], root); } catch { /* best-effort */ }
      }
    }
  }
}

if (isMainModule(import.meta.url)) {
  const root = resolve(getStringArg(process.argv.slice(2), "root") ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const result = commitAudienceSnapshot(root, productionDeps(), { dryRun: hasFlag(process.argv.slice(2), "dry-run") });
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome === "failed") {
    console.error(`[commit-audience-snapshot] falhou: ${result.error}`);
    process.exit(1);
  }
}
