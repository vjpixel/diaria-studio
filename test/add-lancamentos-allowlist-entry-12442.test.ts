/**
 * Regressão #12442: a entrada da allowlist de LANÇAMENTOS decidida no Stage 2
 * era escrita direto em `seed/lancamentos-tool-allowlist.txt` do checkout
 * compartilhado e ficava sem commit (stash `dc3664a9`, #11673). Agora o
 * `add-lancamentos-allowlist-entry.ts` grava a linha num worktree de
 * `origin/master`, empurra uma branch dedicada e abre PR; a edição corrente
 * usa a entrada pela lista pendente em `_internal/`.
 *
 * Git real (repo + origin bare em tmp); `gh` mockado — nenhum PR de verdade.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAllowlistEntry,
  allowlistBranchName,
  appendAllowlistEntry,
  normalizeAllowlistEntry,
  ALLOWLIST_REL,
  type AddAllowlistDeps,
  type GhRunner,
} from "../scripts/add-lancamentos-allowlist-entry.ts";
import { editionDirFromInputPath, loadToolAllowlist, validateLancamentos } from "../scripts/validate-lancamentos.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

const cleanup: string[] = [];
after(() => {
  for (const d of cleanup) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

const SEED = "# allowlist\nblog.replit.com/\n";

function setupRepo(): { rootDir: string; bare: string } {
  const bare = tmp("allow-12442-origin-");
  git(["init", "--bare", "-b", "master"], bare);
  const rootDir = tmp("allow-12442-root-");
  git(["init", "-b", "master"], rootDir);
  git(["config", "user.email", "t@example.com"], rootDir);
  git(["config", "user.name", "T"], rootDir);
  mkdirSync(join(rootDir, "seed"), { recursive: true });
  writeFileSync(join(rootDir, ALLOWLIST_REL), SEED, "utf8");
  git(["add", "."], rootDir);
  git(["commit", "-m", "init"], rootDir);
  git(["remote", "add", "origin", bare], rootDir);
  git(["push", "-u", "origin", "master"], rootDir);
  return { rootDir, bare };
}

function makeDeps(gh: GhRunner, wtParent: string): AddAllowlistDeps & { worktrees: string[] } {
  const worktrees: string[] = [];
  return {
    worktrees,
    git,
    gh,
    makeWorktreePath: () => {
      const p = join(wtParent, `wt-${worktrees.length}`);
      worktrees.push(p);
      return p;
    },
    log: () => {},
  };
}

describe("normalizeAllowlistEntry / appendAllowlistEntry", () => {
  it("tira esquema e www, rejeita o que o loader leria errado", () => {
    assert.equal(normalizeAllowlistEntry("https://www.nvidia.com/jetson-thor"), "nvidia.com/jetson-thor");
    assert.equal(normalizeAllowlistEntry("  exemplo.com/blog/ "), "exemplo.com/blog/");
    assert.throws(() => normalizeAllowlistEntry(""));
    assert.throws(() => normalizeAllowlistEntry("exemplo.com/a b"));
    assert.throws(() => normalizeAllowlistEntry("exemplo.com/#x"));
    assert.throws(() => normalizeAllowlistEntry("jetson"));
  });

  it("acrescenta no fim, idempotente, preserva EOL", () => {
    assert.deepEqual(appendAllowlistEntry("a.com/\n", "b.com/x"), { content: "a.com/\nb.com/x\n", added: true });
    assert.deepEqual(appendAllowlistEntry("a.com/", "b.com/x"), { content: "a.com/\nb.com/x\n", added: true });
    assert.equal(appendAllowlistEntry("a.com/\r\n", "b.com/x").content, "a.com/\r\nb.com/x\r\n");
    assert.equal(appendAllowlistEntry("# c\na.com/\n", "a.com/").added, false);
  });

  it("branch determinística por entrada", () => {
    const a = allowlistBranchName("nvidia.com/jetson-thor", "261109");
    assert.equal(a, allowlistBranchName("nvidia.com/jetson-thor", "261109"));
    assert.match(a, /^allowlist\/261109-nvidia-com-jetson-thor-[0-9a-f]{8}$/);
    assert.notEqual(a, allowlistBranchName("nvidia.com/jetson-thor-2", "261109"));
  });
});

describe("addAllowlistEntry (git real, gh mockado) — #12442", () => {
  it("checkout compartilhado termina limpo; linha vai pra branch dedicada no origin; edição já vê o override", () => {
    const { rootDir, bare } = setupRepo();
    const editionDir = join(tmp("allow-12442-data-"), "261109");
    mkdirSync(editionDir, { recursive: true });
    const ghCalls: string[][] = [];
    const gh: GhRunner = (args) => {
      ghCalls.push(args);
      if (args[1] === "list") return "[]\n";
      if (args[1] === "create") return "https://github.com/vjpixel/diaria-studio/pull/777\n";
      return "";
    };
    const deps = makeDeps(gh, tmp("allow-12442-wt-"));

    const r = addAllowlistEntry(
      { rootDir, entry: "https://nvidia.com/jetson-thor", edition: "261109", editionDir },
      deps,
    );

    assert.equal(r.outcome, "pr_created");
    assert.equal(r.pr_number, 777);
    assert.equal(r.pending_recorded, true);
    // O ponto da issue: o seed do checkout compartilhado não mudou e a árvore está limpa.
    assert.equal(readFileSync(join(rootDir, ALLOWLIST_REL), "utf8"), SEED);
    assert.equal(git(["status", "--porcelain"], rootDir).trim(), "");
    // A linha está na branch dedicada do origin, em cima do master.
    const onBranch = git(["show", `${r.branch}:${ALLOWLIST_REL}`], bare);
    assert.equal(onBranch, SEED + "nvidia.com/jetson-thor\n");
    assert.equal(git(["rev-parse", `${r.branch}~1`], bare).trim(), git(["rev-parse", "master"], bare).trim());
    // O PR foi aberto contra master com a branch certa.
    const create = ghCalls.find((a) => a[1] === "create")!;
    assert.equal(create[create.indexOf("--head") + 1], r.branch);
    assert.equal(create[create.indexOf("--base") + 1], "master");
    assert.match(create[create.indexOf("--body") + 1], /Refs #1968, #12442/);
    // Worktree temporário removido.
    assert.equal(existsSync(deps.worktrees[0]), false);
    // A edição já enxerga a entrada antes do merge; sem editionDir, não.
    assert.ok(loadToolAllowlist(rootDir, editionDir).includes("nvidia.com/jetson-thor"));
    assert.ok(!loadToolAllowlist(rootDir).includes("nvidia.com/jetson-thor"));
  });

  it("PR aberta pra mesma entrada é reaproveitada sem novo push", () => {
    const { rootDir, bare } = setupRepo();
    const gh: GhRunner = (args) =>
      args[1] === "list" ? JSON.stringify([{ number: 55, url: "https://github.com/x/y/pull/55" }]) : "";
    const r = addAllowlistEntry({ rootDir, entry: "nvidia.com/jetson-thor" }, makeDeps(gh, tmp("allow-12442-wt-")));
    assert.equal(r.outcome, "pr_reused");
    assert.equal(r.pr_number, 55);
    assert.equal(git(["branch", "--list", r.branch], bare).trim(), "");
    assert.equal(git(["status", "--porcelain"], rootDir).trim(), "");
  });

  it("entrada já no master: nem branch nem PR", () => {
    const { rootDir } = setupRepo();
    const ghCalls: string[][] = [];
    const gh: GhRunner = (args) => {
      ghCalls.push(args);
      return "[]";
    };
    const r = addAllowlistEntry({ rootDir, entry: "https://blog.replit.com/" }, makeDeps(gh, tmp("allow-12442-wt-")));
    assert.equal(r.outcome, "already_in_master");
    assert.equal(ghCalls.length, 0);
  });

  it("falha do gh: a entrada pendente da edição sobrevive e o worktree sai", () => {
    const { rootDir } = setupRepo();
    const editionDir = join(tmp("allow-12442-data-"), "261109");
    const gh: GhRunner = (args) => {
      if (args[1] === "list") return "[]";
      throw new Error("gh offline");
    };
    const deps = makeDeps(gh, tmp("allow-12442-wt-"));
    assert.throws(() => addAllowlistEntry({ rootDir, entry: "z.ai/blog/glm-x", editionDir }, deps), /gh offline/);
    assert.ok(loadToolAllowlist(rootDir, editionDir).includes("z.ai/blog/glm-x"));
    assert.equal(existsSync(deps.worktrees[0]), false);
    assert.equal(git(["status", "--porcelain"], rootDir).trim(), "");
  });

  it("dry-run não toca nada", () => {
    const { rootDir } = setupRepo();
    const editionDir = join(tmp("allow-12442-data-"), "261109");
    const gh: GhRunner = () => {
      throw new Error("não devia chamar");
    };
    const r = addAllowlistEntry({ rootDir, entry: "a.com/x", editionDir, dryRun: true }, makeDeps(gh, tmp("allow-12442-wt-")));
    assert.equal(r.outcome, "dry_run");
    assert.equal(existsSync(editionDir), false);
  });
});

describe("validate-lancamentos lê a lista pendente da edição — #12442", () => {
  it("editionDirFromInputPath: raiz da edição pra 02-reviewed.md e pra _internal/01-approved.json", () => {
    const ed = join("data", "editions", "261109");
    assert.equal(editionDirFromInputPath(join(ed, "02-reviewed.md")), ed);
    assert.equal(editionDirFromInputPath(join(ed, "_internal", "01-approved.json")), ed);
  });

  it("item not_a_tool vira verificado com a entrada pendente", () => {
    const root = tmp("allow-12442-vroot-");
    const editionDir = tmp("allow-12442-ved-");
    const md = "**LANÇAMENTOS**\n\n[Parceria anunciada](https://openai.com/index/parceria-com-fulano/)\nAlgo.\n";
    const before = validateLancamentos(md, loadToolAllowlist(root, editionDir));
    assert.ok(before.not_a_tool.length > 0, "fixture precisa disparar not_a_tool");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(join(editionDir, "_internal", "lancamentos-tool-allowlist-pending.txt"), "openai.com/index/parceria-com-fulano\n");
    const after = validateLancamentos(md, loadToolAllowlist(root, editionDir));
    assert.equal(after.not_a_tool.length, 0);
  });
});
