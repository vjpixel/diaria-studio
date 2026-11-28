/**
 * #14321 — brechas do guard `.claude/hooks/block-worktree-alien-commit.mjs`
 * que viraram falsos negativos silenciosos quando o `claim-worktree` (#14214)
 * passou a gravar claims de verdade:
 *
 * 1. `git -C <wt> commit` (e `-c k=v`, `--git-dir=…`) passava direto: o guard
 *    exigia `tokens[1] === "commit"`;
 * 2. `cd <wt> && git commit` era julgado pelo `payload.cwd`, o diretório de
 *    ANTES do `cd`;
 * 3. o fallback do `--show-toplevel` usava o `payload.cwd` cru, e a chave da
 *    claim (hash do caminho) só batia com a grafia do git.
 *
 * E os P3 do review de confirmação da #14303: uma chamada só de
 * `rev-parse --git-path` com MERGE_HEAD/REVERT_HEAD/sequencer, e a 2ª leitura
 * do arquivo de claim em EBUSY/EPERM transitório (`claims.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claimWorktree, readWorktreeClaimFileWithRetry } from "../scripts/lib/session-registry.ts";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HOOK = join(REPO, ".claude", "hooks", "block-worktree-alien-commit.mjs");
// Import dinâmico por URL: o hook é `.mjs` sem declaração de tipos (TS7016 no
// ratchet de `tsconfig.test.json`), mesmo padrão do teste do #14214.
const hookModule: {
  parseGitInvocation: (words: string[]) => { subcommand: string | null; cDirs: string[]; workTree: string | null } | null;
  isGitCommitCommand: (tokens: string[]) => boolean;
  commandHasGitCommit: (command: string) => boolean;
  commitTargetDirs: (command: string, baseCwd: string, platform?: string) => string[];
  fallbackCheckoutRoot: (probeCwd: string, platform?: string) => string;
  readWorktreeClaimRecord: (
    repoRoot: string,
    checkoutRoot: string,
    now?: number,
    deps?: { read?: (f: string) => string; sleep?: (ms: number) => void; warn?: (line: string) => void },
  ) => { sessionId?: string } | null;
  runHook: (
    data: string,
    write?: (s: string) => void,
    deps?: { check?: (dir: string, sid: string) => string | null; warn?: (line: string) => void },
  ) => void;
  IN_PROGRESS_GIT_PATHS: string[];
  BLOCK_REASON_CLAIM: string;
  BLOCK_REASON_DETACHED: string;
} = await import(pathToFileURL(HOOK).href);
const {
  parseGitInvocation,
  isGitCommitCommand,
  commandHasGitCommit,
  commitTargetDirs,
  fallbackCheckoutRoot,
  readWorktreeClaimRecord,
  runHook,
  IN_PROGRESS_GIT_PATHS,
  BLOCK_REASON_CLAIM,
  BLOCK_REASON_DETACHED,
} = hookModule;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Repo temporário com worktree vinculado; claim gravada pelo toplevel do git, como o CLI faz. */
function setup(): { tmp: string; mainRepo: string; wt: string; toplevel: string } {
  const tmp = mkdtempSync(join(tmpdir(), "alien-commit-14321-"));
  const mainRepo = join(tmp, "main");
  const wt = join(tmp, "wt");
  mkdirSync(mainRepo, { recursive: true });
  git(["init", "-q"], mainRepo);
  git(["config", "user.email", "test@example.com"], mainRepo);
  git(["config", "user.name", "Test"], mainRepo);
  writeFileSync(join(mainRepo, "README.md"), "x");
  git(["add", "."], mainRepo);
  git(["commit", "-q", "-m", "init"], mainRepo);
  git(["branch", "develop/fix-14321"], mainRepo);
  git(["worktree", "add", "-q", wt, "develop/fix-14321"], mainRepo);
  const toplevel = resolve(git(["rev-parse", "--show-toplevel"], wt));
  return { tmp, mainRepo, wt, toplevel };
}

function hook(command: string, cwd: string, sessionId: string): string {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, session_id: sessionId, cwd }),
    encoding: "utf8",
  });
  return (res.stdout ?? "").trim();
}

function denyReason(out: string): string | undefined {
  return out ? JSON.parse(out).hookSpecificOutput?.permissionDecisionReason : undefined;
}

describe("#14321 caso 1: opções globais do git antes do subcomando", () => {
  it("git -C, -c chave=valor, --git-dir=… e --no-pager não escondem o commit", () => {
    assert.equal(isGitCommitCommand(["git", "-C", "/wt", "commit", "-m", "x"]), true);
    assert.equal(isGitCommitCommand(["git", "-c", "commit.gpgsign=false", "commit"]), true);
    assert.equal(isGitCommitCommand(["git", "--git-dir=/wt/.git", "--work-tree", "/wt", "commit"]), true);
    assert.equal(isGitCommitCommand(["git", "--no-pager", "commit"]), true);
    assert.equal(isGitCommitCommand(["git", "-C", "/wt", "status"]), false);
    assert.equal(isGitCommitCommand(["git", "-C", "/wt", "commit-graph", "write"]), false);
  });

  it("parseGitInvocation devolve os -C na ordem e o --work-tree", () => {
    assert.deepEqual(parseGitInvocation(["git", "-C", "a", "-C", "b", "--work-tree=w", "commit"]), {
      subcommand: "commit",
      cDirs: ["a", "b"],
      workTree: "w",
    });
    assert.equal(parseGitInvocation(["ls", "-la"]), null);
  });

  it("valor citado com espaço no -C não come o subcomando; git commit citado não é comando", () => {
    assert.equal(commandHasGitCommit('git -C "/a b/wt" commit -m "x"'), true);
    assert.equal(commandHasGitCommit('echo "git -C /wt commit"'), false);
    assert.equal(commandHasGitCommit("git -c user.name=x commit -m y"), true);
  });

  it("hook: git -C <wt> commit rodado do checkout principal é negado quando outra sessão segura o worktree", () => {
    const { tmp, mainRepo, wt, toplevel } = setup();
    try {
      claimWorktree(toplevel, "sessao-dona", mainRepo, "develop/fix-14321");
      assert.equal(denyReason(hook(`git -C "${wt}" commit -m x`, mainRepo, "outra-sessao")), BLOCK_REASON_CLAIM);
      assert.equal(denyReason(hook("git -c user.name=x commit -m y", wt, "outra-sessao")), BLOCK_REASON_CLAIM);
      assert.equal(hook(`git -C "${wt}" commit -m x`, mainRepo, "sessao-dona"), "", "a dona commita");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("#14321 caso 2: cd da cadeia decide o diretório do commit", () => {
  it("commitTargetDirs aplica cd, -C relativo e escopo de subshell", () => {
    const base = resolve(tmpdir(), "base-14321");
    const wt = resolve(tmpdir(), "wt-14321");
    assert.deepEqual(commitTargetDirs(`cd "${wt}" && git commit -m x`, base), [wt]);
    assert.deepEqual(commitTargetDirs("git -C sub commit", base), [resolve(base, "sub")]);
    assert.deepEqual(commitTargetDirs(`cd "${wt}" && git -C sub -C deeper commit`, base), [resolve(wt, "sub", "deeper")]);
    assert.deepEqual(commitTargetDirs(`(cd "${wt}" && ls); git commit -m x`, base), [base]);
    assert.deepEqual(commitTargetDirs(`git commit -m "cd ${wt}"`, base), [base]);
    assert.deepEqual(commitTargetDirs("git status", base), []);
  });

  it("caminho /c/... do Git Bash vira C:/... no Windows", { skip: process.platform !== "win32" }, () => {
    assert.deepEqual(commitTargetDirs("cd /c/Users/x/wt && git commit", "C:\\base", "win32"), [resolve("C:/Users/x/wt")]);
  });

  it("hook: cd <wt> && git commit a partir do checkout principal é negado; cd para fora do worktree passa", () => {
    const { tmp, mainRepo, wt, toplevel } = setup();
    try {
      claimWorktree(toplevel, "sessao-dona", mainRepo, "develop/fix-14321");
      assert.equal(denyReason(hook(`cd "${wt}" && git commit -m x`, mainRepo, "outra-sessao")), BLOCK_REASON_CLAIM);
      // O inverso: o payload.cwd é o worktree, mas o commit roda no principal (fora de escopo).
      assert.equal(hook(`cd "${mainRepo}" && git commit -m x`, wt, "outra-sessao"), "");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("#14321 caso 3: fallback do --show-toplevel normaliza como o git", () => {
  it("subpasta do worktree sobe até o toplevel e acha a claim", () => {
    const { tmp, mainRepo, wt, toplevel } = setup();
    try {
      claimWorktree(toplevel, "sessao-dona", mainRepo, "develop/fix-14321");
      const sub = join(wt, "a", "b");
      mkdirSync(sub, { recursive: true });
      assert.equal(readWorktreeClaimRecord(mainRepo, fallbackCheckoutRoot(sub))?.sessionId, "sessao-dona");
      // Sem a normalização, o caminho cru da subpasta não acha nada.
      assert.equal(readWorktreeClaimRecord(mainRepo, sub), null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("letra do drive minúscula e /c/... do Git Bash caem na mesma chave", { skip: process.platform !== "win32" }, () => {
    const { tmp, mainRepo, toplevel } = setup();
    try {
      claimWorktree(toplevel, "sessao-dona", mainRepo, "develop/fix-14321");
      const lower = toplevel[0].toLowerCase() + toplevel.slice(1);
      assert.equal(readWorktreeClaimRecord(mainRepo, fallbackCheckoutRoot(lower, "win32"))?.sessionId, "sessao-dona");
      const msys = `/${toplevel[0].toLowerCase()}${toplevel.slice(2).replaceAll("\\", "/")}`;
      assert.equal(readWorktreeClaimRecord(mainRepo, fallbackCheckoutRoot(msys, "win32"))?.sessionId, "sessao-dona");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("#14321: MERGE_HEAD, REVERT_HEAD e sequencer liberam o HEAD destacado", () => {
  it("IN_PROGRESS_GIT_PATHS inclui os 7 marcadores e está congelada", () => {
    for (const m of ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "BISECT_LOG", "MERGE_HEAD", "REVERT_HEAD", "sequencer"]) {
      assert.ok(IN_PROGRESS_GIT_PATHS.includes(m), m);
    }
    assert.ok(Object.isFrozen(IN_PROGRESS_GIT_PATHS));
  });

  for (const [marker, isDir] of [["MERGE_HEAD", false], ["REVERT_HEAD", false], ["sequencer", true]] as const) {
    it(`destacado com ${marker} em curso não é negado`, () => {
      const { tmp, mainRepo, wt, toplevel } = setup();
      try {
        claimWorktree(toplevel, "sessao-dona", mainRepo, "develop/fix-14321");
        git(["checkout", "-q", "--detach"], wt);
        assert.equal(denyReason(hook("git commit -m x", wt, "sessao-dona")), BLOCK_REASON_DETACHED);
        const markerPath = resolve(wt, git(["rev-parse", "--git-path", marker], wt));
        if (isDir) mkdirSync(markerPath, { recursive: true });
        else writeFileSync(markerPath, git(["rev-parse", "HEAD"], wt));
        assert.equal(hook("git commit -m x", wt, "sessao-dona"), "");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});

describe("#14321: 2ª leitura do arquivo de claim (EBUSY/EPERM transitório)", () => {
  it("arquivo existe e a 1ª leitura falha: tenta de novo uma vez", () => {
    const tmp = mkdtempSync(join(tmpdir(), "claim-retry-14321-"));
    try {
      const file = join(tmp, "c.json");
      writeFileSync(file, "{}");
      const answers: Array<{ ok: number } | null> = [null, { ok: 1 }];
      let reads = 0;
      let sleeps = 0;
      const got = readWorktreeClaimFileWithRetry<{ ok: number }>(
        file,
        () => {
          reads++;
          return answers.shift() ?? null;
        },
        () => {
          sleeps++;
        },
      );
      assert.deepEqual(got, { ok: 1 });
      assert.equal(reads, 2);
      assert.equal(sleeps, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("arquivo ausente: uma leitura só; ilegível nas duas: null", () => {
    const tmp = mkdtempSync(join(tmpdir(), "claim-retry-14321-"));
    try {
      let reads = 0;
      const read = () => {
        reads++;
        return null;
      };
      assert.equal(readWorktreeClaimFileWithRetry(join(tmp, "ausente.json"), read, () => {}), null);
      assert.equal(reads, 1);
      const file = join(tmp, "c.json");
      writeFileSync(file, "{nao json");
      reads = 0;
      assert.equal(readWorktreeClaimFileWithRetry(file, read, () => {}), null);
      assert.equal(reads, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("#14321 review 1: readWorktreeClaimRecord do hook tenta de novo e avisa no stderr", () => {
  it("1ª leitura falha (EBUSY), 2ª lê: devolve a claim sem aviso", () => {
    const { tmp, mainRepo, toplevel } = setup();
    try {
      claimWorktree(toplevel, "sessao-dona", mainRepo, "develop/fix-14321");
      let reads = 0;
      let sleeps = 0;
      const warns: string[] = [];
      const record = readWorktreeClaimRecord(mainRepo, toplevel, Date.now(), {
        read: (f) => {
          reads++;
          if (reads === 1) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
          return readFileSync(f, "utf8");
        },
        sleep: () => {
          sleeps++;
        },
        warn: (l) => warns.push(l),
      });
      assert.equal(record?.sessionId, "sessao-dona");
      assert.equal(reads, 2);
      assert.equal(sleeps, 1);
      assert.deepEqual(warns, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falha nas duas: null (fail-open) com uma linha no stderr", () => {
    const { tmp, mainRepo, toplevel } = setup();
    try {
      claimWorktree(toplevel, "sessao-dona", mainRepo, "develop/fix-14321");
      const warns: string[] = [];
      const record = readWorktreeClaimRecord(mainRepo, toplevel, Date.now(), {
        read: () => {
          throw new Error("EPERM: operation not permitted");
        },
        sleep: () => {},
        warn: (l) => warns.push(l),
      });
      assert.equal(record, null);
      assert.equal(warns.length, 1);
      assert.match(warns[0], /ilegível.*EPERM/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("#14321 review 2: exceção num alvo não pula os outros commits da cadeia", () => {
  it("1º alvo lança, 2º nega: o deny sai e o erro vai para o stderr", () => {
    const out: string[] = [];
    const warns: string[] = [];
    const base = resolve(tmpdir(), "base-14321-review");
    runHook(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "git -C a commit -m x; git -C b commit -m y" },
        session_id: "s",
        cwd: base,
      }),
      (s) => out.push(s),
      {
        check: (dir) => {
          if (dir === resolve(base, "a")) throw new Error("boom");
          return dir === resolve(base, "b") ? "negado-em-b" : null;
        },
        warn: (l) => warns.push(l),
      },
    );
    assert.equal(out.length, 1);
    assert.equal(JSON.parse(out[0]).hookSpecificOutput.permissionDecisionReason, "negado-em-b");
    assert.equal(warns.length, 1);
    assert.match(warns[0], /boom/);
  });
});

describe("#14321 review 3: diretório desconhecido volta ao baseCwd", () => {
  const base = resolve(tmpdir(), "base-14321-unk");
  const a = resolve(tmpdir(), "a-14321");
  it("cd -, $VAR, $(...), crase, popd, pushd sem argumento e -C com variável", () => {
    for (const cmd of [
      `cd "${a}" && cd - && git commit`,
      `cd "${a}" && cd "$WT" && git commit`,
      `cd "${a}" && cd $(git rev-parse --show-toplevel) && git commit`,
      `cd "${a}" && cd \`pwd\` && git commit`,
      `pushd "${a}" && popd && git commit`,
      `cd "${a}" && pushd && git commit`,
      `cd "${a}" && git -C "$X" commit`,
    ]) {
      assert.deepEqual(commitTargetDirs(cmd, base), [base], cmd);
    }
  });

  it("cd num job em background (& simples) não vale para o resto; redirecionamento com & não separa", () => {
    assert.deepEqual(commitTargetDirs(`cd "${a}" & git commit`, base), [base]);
    assert.deepEqual(commitTargetDirs(`cd "${a}" && git commit -m x & git commit -m y`, base), [a, base]);
    assert.deepEqual(commitTargetDirs(`cd "${a}" 2>&1 && git commit -m x >&2`, base), [a]);
    assert.deepEqual(commitTargetDirs(`cd "${a}" &>/dev/null && git commit`, base), [a]);
  });

  it("hook: cd <wt> && cd - && git commit a partir do principal não é negado", () => {
    const { tmp, mainRepo, wt, toplevel } = setup();
    try {
      claimWorktree(toplevel, "sessao-dona", mainRepo, "develop/fix-14321");
      assert.equal(hook(`cd "${wt}" && cd - && git commit -m x`, mainRepo, "outra-sessao"), "");
      assert.equal(hook(`cd "${wt}" & git commit -m x`, mainRepo, "outra-sessao"), "");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("#14321 review 4: prefixos antes do git e binário por caminho", () => {
  it("NOME=valor, env, command e caminho absoluto do git", () => {
    assert.equal(isGitCommitCommand(["GIT_AUTHOR_NAME=x", "git", "commit"]), true);
    assert.equal(isGitCommitCommand(["env", "-i", "-u", "HOME", "FOO=1", "git", "commit"]), true);
    assert.equal(isGitCommitCommand(["command", "-p", "git", "commit"]), true);
    assert.equal(isGitCommitCommand(["/usr/bin/git", "commit"]), true);
    assert.equal(commandHasGitCommit('"C:\\Program Files\\Git\\bin\\git.exe" -C x commit -m y'), true);
    assert.equal(isGitCommitCommand(["/usr/bin/gitk", "commit"]), false);
    assert.deepEqual(parseGitInvocation(["env", "-C", "wt", "git", "-C", "sub", "commit"])?.cDirs, ["wt", "sub"]);
  });

  it("bash -c fica fora de escopo, declarado", () => {
    assert.equal(commandHasGitCommit('bash -c "git commit -m x"'), false);
  });

  it("hook: GIT_AUTHOR_NAME=x git -C <wt> commit do principal é negado para sessão alheia", () => {
    const { tmp, mainRepo, wt, toplevel } = setup();
    try {
      claimWorktree(toplevel, "sessao-dona", mainRepo, "develop/fix-14321");
      assert.equal(denyReason(hook(`GIT_AUTHOR_NAME=x git -C "${wt}" commit -m x`, mainRepo, "outra-sessao")), BLOCK_REASON_CLAIM);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("#14321 review 6: o guard de commit não importa o hook de PII", () => {
  it("normalizeMsysPath vem de .claude/hooks/lib/", () => {
    const src = readFileSync(HOOK, "utf8");
    assert.ok(!/from\s+["']\.\/block-pr-create-pii-runtime-artifacts\.mjs["']/.test(src));
    assert.match(src, /from\s+["']\.\/lib\/msys-path\.mjs["']/);
  });
});
