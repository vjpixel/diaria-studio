import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isBranchCreateCheckoutCommand,
  shouldBlockBranchCheckout,
  readActiveCoordinatorSessionIds,
  isLinkedWorktree,
  findGitRootNoSpawn,
  sessionsDir,
  machineTag,
  stripQuotedSpans,
  BLOCK_REASON,
  resolveBranchCreateTargets,
  mainRootsHitByTargets,
  mainCheckoutRootOf,
  tokenizeShellSegments,
} from "../.claude/hooks/block-branch-checkout-main.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// #6509: guard MECÂNICO contra `git checkout -b`/`git switch -c` no checkout
// PRINCIPAL compartilhado enquanto uma rodada overnight/develop/continuo
// ativa não é a chamadora — mesma classe de `block-gh-pr-merge-subagent.mjs`
// (#5716), mas para branch-switch em vez de `gh pr merge`.
//
// Incidente de origem: rodada `/diaria-overnight 260828b` (#6481 item 3) —
// o checkout principal foi encontrado num branch de feature em vez de
// master, sem stash e sem perda de trabalho, mas é exatamente a classe de
// corrupção de estado compartilhado que este guard existe para prevenir.

describe("isBranchCreateCheckoutCommand (#6509)", () => {
  it("detecta 'git checkout -b <nome>' standalone", () => {
    assert.equal(isBranchCreateCheckoutCommand("git checkout -b overnight/fix-123-slug"), true);
  });

  it("detecta 'git switch -c <nome>' e '--create'", () => {
    assert.equal(isBranchCreateCheckoutCommand("git switch -c overnight/fix-123-slug"), true);
    assert.equal(isBranchCreateCheckoutCommand("git switch --create overnight/fix-123-slug"), true);
  });

  it("detecta dentro de comando encadeado", () => {
    assert.equal(isBranchCreateCheckoutCommand("cd repo && git checkout -b foo"), true);
    assert.equal(isBranchCreateCheckoutCommand("npm ci; git checkout -b foo"), true);
    assert.equal(isBranchCreateCheckoutCommand("git status | cat && git checkout -b foo"), true);
    assert.equal(isBranchCreateCheckoutCommand("git status\ngit checkout -b foo"), true);
  });

  it("NÃO detecta voltar pra master nem restauração de arquivo", () => {
    assert.equal(isBranchCreateCheckoutCommand("git checkout master"), false);
    assert.equal(isBranchCreateCheckoutCommand("git switch main"), false);
    assert.equal(isBranchCreateCheckoutCommand("git checkout origin/master -- file.ts"), false);
    assert.equal(isBranchCreateCheckoutCommand("git checkout HEAD scripts/foo.ts"), false);
    assert.equal(isBranchCreateCheckoutCommand("git checkout scripts/foo.ts"), false);
    assert.equal(isBranchCreateCheckoutCommand("git checkout ."), false);
  });

  it("#12165: detecta troca para branch existente que não seja master", () => {
    assert.equal(isBranchCreateCheckoutCommand("git checkout overnight/fix-1-x"), true);
    assert.equal(isBranchCreateCheckoutCommand("git switch outra-branch"), true);
    assert.equal(isBranchCreateCheckoutCommand("git switch -"), true);
    assert.equal(isBranchCreateCheckoutCommand("git checkout -B x"), true);
    assert.equal(isBranchCreateCheckoutCommand("git switch -C x"), true);
    assert.equal(isBranchCreateCheckoutCommand("git checkout --orphan x"), true);
  });

  it("NÃO detecta 'git checkout -- <file>' (checkout de arquivo, não de branch)", () => {
    assert.equal(isBranchCreateCheckoutCommand("git checkout -- src/foo.ts"), false);
  });

  it("NÃO detecta -b como substring de outra flag (ex: --builder)", () => {
    // #12165: o alvo é master, então só a leitura errada de --builder como -b acusaria
    assert.equal(isBranchCreateCheckoutCommand("git checkout --builder master"), false);
  });

  it("NÃO detecta 'git checkout -b' citado dentro de um argumento (--body/--title)", () => {
    assert.equal(
      isBranchCreateCheckoutCommand('gh issue create --body "rode git checkout -b antes de mexer"'),
      false,
    );
  });

  it("NÃO detecta comando não-git", () => {
    assert.equal(isBranchCreateCheckoutCommand("npm run build -b"), false);
  });

  it("tipo não-string devolve false", () => {
    assert.equal(isBranchCreateCheckoutCommand(undefined), false);
    assert.equal(isBranchCreateCheckoutCommand(null), false);
  });
});

describe("stripQuotedSpans (#6509)", () => {
  it("remove conteúdo entre aspas simples e duplas, preserva o resto", () => {
    assert.equal(stripQuotedSpans('echo "a b c" && git checkout -b x'), "echo  && git checkout -b x");
    assert.equal(stripQuotedSpans("echo 'a b c'"), "echo ");
  });
});

describe("isLinkedWorktree (#6509)", () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  function freshRoot(): string {
    const root = join(tmpdir(), `branch-checkout-hook-worktree-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    return root;
  }

  it("'.git' como DIRETÓRIO → checkout principal (false)", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".git"));
    assert.equal(isLinkedWorktree(root), false);
  });

  it("'.git' como ARQUIVO com 'gitdir:' → worktree vinculado (true)", () => {
    const root = freshRoot();
    writeFileSync(join(root, ".git"), "gitdir: /some/main/.git/worktrees/agent-x\n", "utf8");
    assert.equal(isLinkedWorktree(root), true);
  });

  it("'.git' ausente → não dá para determinar, erra para 'não é worktree' (false)", () => {
    const root = freshRoot();
    assert.equal(isLinkedWorktree(root), false);
  });
});

describe("findGitRootNoSpawn (#8937) — resolve a raiz a partir de payload.cwd, não import.meta.url", () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  function freshRoot(): string {
    const root = join(tmpdir(), `branch-checkout-hook-gitroot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    return root;
  }

  it("acha a raiz quando startDir já É a raiz ('.git' como diretório)", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".git"));
    assert.equal(findGitRootNoSpawn(root), root);
  });

  it("acha a raiz de um worktree vinculado ('.git' como arquivo)", () => {
    const root = freshRoot();
    writeFileSync(join(root, ".git"), "gitdir: /some/main/.git/worktrees/agent-x\n", "utf8");
    assert.equal(findGitRootNoSpawn(root), root);
  });

  it("sobe a partir de um SUBDIRETÓRIO até achar '.git' — o caso real de payload.cwd num worktree", () => {
    const root = freshRoot();
    writeFileSync(join(root, ".git"), "gitdir: /some/main/.git/worktrees/agent-x\n", "utf8");
    const sub = join(root, "scripts", "lib");
    mkdirSync(sub, { recursive: true });
    assert.equal(findGitRootNoSpawn(sub), root);
  });

  it("startDir vazio/ausente/não-string → null (fail-soft)", () => {
    assert.equal(findGitRootNoSpawn(""), null);
    assert.equal(findGitRootNoSpawn(undefined), null);
    assert.equal(findGitRootNoSpawn(null), null);
  });

  it("sobe até a raiz do filesystem sem achar '.git' → null", () => {
    const base = freshRoot();
    const orphan = join(base, "a", "b");
    mkdirSync(orphan, { recursive: true });
    assert.equal(findGitRootNoSpawn(orphan, 2), null);
  });
});

describe("#8937 — isLinkedWorktree(cwdRoot) reconhece um worktree de subagente quando cwdRoot vem de payload.cwd", () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  function freshRoot(): string {
    const root = join(tmpdir(), `branch-checkout-hook-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    return root;
  }

  it("regressão do achado #8937: um worktree de subagente (`.git` arquivo) NUNCA é tratado como checkout principal quando a raiz é derivada de payload.cwd — reproduz o bug pré-fix (import.meta.url sempre resolvia pro checkout principal, então isLinkedWorktree(checkoutRoot) dava false mesmo dentro de um worktree real)", () => {
    const worktreeRoot = freshRoot();
    writeFileSync(join(worktreeRoot, ".git"), "gitdir: /home/vjpixel/diaria-studio/.git/worktrees/agent-abc\n", "utf8");
    const cwdInsideWorktree = join(worktreeRoot, "scripts", "lib");
    mkdirSync(cwdInsideWorktree, { recursive: true });

    // O fix: cwdRoot vem de findGitRootNoSpawn(payload.cwd), não de hookDir.
    const cwdRoot = findGitRootNoSpawn(cwdInsideWorktree);
    assert.equal(cwdRoot, worktreeRoot);
    assert.equal(isLinkedWorktree(cwdRoot), true, "worktree real deve ser reconhecido como tal — guard nunca bloqueia aqui");

    // O bug: se alguém revertesse pra derivar a raiz de hookDir (sempre o
    // checkout principal, `.git` é diretório lá), isLinkedWorktree voltaria
    // false mesmo com o cwd real dentro de um worktree — este teste falharia
    // detectando exatamente essa regressão se `cwdRoot` fosse trocado de
    // volta por um valor fixo/checkout-principal.
  });
});

describe("readActiveCoordinatorSessionIds (#6509) — fail-open sempre", () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  function freshRoot(): string {
    const root = join(tmpdir(), `branch-checkout-hook-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    return root;
  }
  function writeSession(root: string, filename: string, record: Record<string, unknown>) {
    const dir = sessionsDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), JSON.stringify(record), "utf8");
  }

  const NOW = Date.parse("2026-08-28T12:00:00.000Z");
  const ONE_HOUR_MS = 60 * 60 * 1000;

  it("diretório data/sessions/ ausente → Set vazio (fail-open, (d))", () => {
    assert.deepEqual(readActiveCoordinatorSessionIds(freshRoot(), NOW), new Set());
  });

  it("sessão kind=overnight fresca, mesma máquina → incluída", () => {
    const root = freshRoot();
    writeSession(root, "overnight-300-sess1.json", {
      kind: "overnight",
      sessionId: "sess1",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      lastHeartbeat: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set(["sess1"]));
  });

  it("kind=develop e kind=continuo também contam; kind desconhecido é ignorado", () => {
    const root = freshRoot();
    writeSession(root, "develop-300-sess2.json", {
      kind: "develop",
      sessionId: "sess2",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    writeSession(root, "continuo-300-sess3.json", {
      kind: "continuo",
      sessionId: "sess3",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    writeSession(root, "outro-300-sess4.json", {
      kind: "algo-nao-reconhecido",
      sessionId: "sess4",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set(["sess2", "sess3"]));
  });

  it("sessão de OUTRA máquina é ignorada (data/sessions/ é compartilhado via OneDrive)", () => {
    const root = freshRoot();
    writeSession(root, "overnight-outra-maquina-sess5.json", {
      kind: "overnight",
      sessionId: "sess5",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: "outra-maquina-diferente",
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set());
  });

  it("sessão mais velha que MAX_SESSION_AGE_MS (24h) é ignorada", () => {
    const root = freshRoot();
    writeSession(root, "overnight-300-sess6.json", {
      kind: "overnight",
      sessionId: "sess6",
      startedAt: new Date(NOW - 25 * ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set());
  });

  it("sessão sem heartbeat há mais de SOFT_STALE_MS (90 min) é ignorada", () => {
    const root = freshRoot();
    writeSession(root, "overnight-300-sess7.json", {
      kind: "overnight",
      sessionId: "sess7",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      lastHeartbeat: new Date(NOW - 2 * ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set());
  });

  it("JSON malformado em uma entrada não derruba a leitura das demais (fail-open por entrada, (d))", () => {
    const root = freshRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), "overnight-300-broken.json"), "{not valid json", "utf8");
    writeSession(root, "overnight-300-sess8.json", {
      kind: "overnight",
      sessionId: "sess8",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set(["sess8"]));
  });

  it("ignora .merge-lock.json, dotfiles e cópias -safeBackup- do OneDrive", () => {
    const root = freshRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(
      join(sessionsDir(root), ".merge-lock.json"),
      JSON.stringify({ heldBy: "x", acquiredAt: new Date(NOW).toISOString() }),
      "utf8",
    );
    writeSession(root, "overnight-300-sess9-safeBackup-0001.json", {
      kind: "overnight",
      sessionId: "sess9",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set());
  });
});

describe("shouldBlockBranchCheckout (#6509)", () => {
  it("(a) bloqueia: há coordenadora ativa diferente da chamada atual", () => {
    assert.equal(shouldBlockBranchCheckout(new Set(["coord-1"]), "subagent-2"), true);
  });

  it("permite: chamada É a própria coordenadora registrada", () => {
    assert.equal(shouldBlockBranchCheckout(new Set(["coord-1"]), "coord-1"), false);
  });

  it("(c) permite: nenhuma coordenadora ativa (Set vazio) — sessão interativa comum", () => {
    assert.equal(shouldBlockBranchCheckout(new Set(), "qualquer-sessao"), false);
  });

  it("(d) fail-open: session_id da chamada ausente/vazio", () => {
    assert.equal(shouldBlockBranchCheckout(new Set(["coord-1"]), undefined), false);
    assert.equal(shouldBlockBranchCheckout(new Set(["coord-1"]), null), false);
    assert.equal(shouldBlockBranchCheckout(new Set(["coord-1"]), ""), false);
  });

  it("(d) fail-open: activeCoordinatorSessionIds ausente (undefined/null)", () => {
    // sem tipos declarados pro .mjs (TS7016 aceito), o parâmetro é any — sem erro de tipo esperado aqui
    assert.equal(shouldBlockBranchCheckout(undefined, "sess-x"), false);
    assert.equal(shouldBlockBranchCheckout(null, "sess-x"), false);
  });
});

describe("BLOCK_REASON (#6509)", () => {
  it("cita a issue de origem e o item da regra violada", () => {
    assert.match(BLOCK_REASON, /#6509/);
    assert.match(BLOCK_REASON, /checkout principal/);
    assert.match(BLOCK_REASON, /worktree/);
  });
});

// ---------------------------------------------------------------------------
// #12165: o alvo sai do PRÓPRIO comando (`cd <dir>` anterior e `git -C <dir>`),
// não só do cwd da sessão. Achado ao vivo em 04/11/2026 (#12092):
//   - falso positivo: `cd <worktree linkado> && git switch -c X` rodado de uma
//     sessão no checkout principal era bloqueado;
//   - furo: `git -C <checkout principal> switch -c X` rodado de um worktree
//     linkado passava (o `-C` nem era reconhecido).
// ---------------------------------------------------------------------------

const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".claude", "hooks", "block-branch-checkout-main.mjs");

function makeFixture() {
  const base = join(tmpdir(), `branch-guard-12165-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const main = join(base, "main");
  const wt = join(main, ".claude", "worktrees", "agent-x");
  const outsideWt = join(base, "scratch", "wt12092"); // worktree fora de .claude/worktrees/ (caso real da issue)
  mkdirSync(join(main, ".git", "worktrees", "agent-x"), { recursive: true });
  mkdirSync(join(main, ".git", "worktrees", "wt12092"), { recursive: true });
  mkdirSync(join(main, "scripts"), { recursive: true });
  mkdirSync(join(wt, "scripts"), { recursive: true });
  mkdirSync(outsideWt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "agent-x")}\n`, "utf8");
  writeFileSync(join(outsideWt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt12092")}\n`, "utf8");
  return { base, main, wt, outsideWt };
}

function writeCoordinator(main: string, sessionId: string) {
  const dir = sessionsDir(main);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `overnight-${sessionId}.json`),
    JSON.stringify({ kind: "overnight", sessionId, startedAt: now, lastHeartbeat: now, machineTag: machineTag() }),
    "utf8",
  );
}

function runHook(payload: Record<string, unknown>): string {
  const r = spawnSync(process.execPath, [HOOK_PATH], { input: JSON.stringify(payload), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

describe("resolveBranchCreateTargets (#12165) — alvo derivado do comando", () => {
  const fx = makeFixture();
  after(() => rmSync(fx.base, { recursive: true, force: true }));
  const HOME = "/home/fake";

  it("sem cd/-C: o alvo é o cwd da sessão", () => {
    assert.deepEqual(resolveBranchCreateTargets("git checkout -b x", fx.main, HOME), [fx.main]);
  });

  it("`cd <abs> && git switch -c`: o alvo é o diretório do cd", () => {
    assert.deepEqual(resolveBranchCreateTargets(`cd ${fx.wt} && git switch -q -c fix/x`, fx.main, HOME), [fx.wt]);
  });

  it("`git -C <abs> switch -c`: o alvo é o -C (o -C antes era ignorado na detecção)", () => {
    assert.deepEqual(resolveBranchCreateTargets(`git -C ${fx.main} switch -c x`, fx.wt, HOME), [fx.main]);
  });

  it("cd relativo e -C relativo compõem como no shell/git", () => {
    assert.deepEqual(resolveBranchCreateTargets("cd scripts && git -C .. checkout -b x", fx.wt, HOME), [fx.wt]);
    assert.deepEqual(resolveBranchCreateTargets("git -C .claude -C worktrees/agent-x switch -c x", fx.main, HOME), [fx.wt]);
  });

  it("vale o ÚLTIMO cd antes do git", () => {
    assert.deepEqual(
      resolveBranchCreateTargets(`cd ${fx.wt} && cd ${fx.main} && git checkout -b x`, fx.wt, HOME),
      [fx.main],
    );
  });

  it("cd dentro de subshell não vaza para fora dele", () => {
    assert.deepEqual(resolveBranchCreateTargets(`(cd ${fx.wt}) && git checkout -b x`, fx.main, HOME), [fx.main]);
    assert.deepEqual(resolveBranchCreateTargets(`(cd ${fx.wt} && git checkout -b x)`, fx.main, HOME), [fx.wt]);
  });

  it("path entre aspas (com espaço) é lido inteiro", () => {
    assert.deepEqual(resolveBranchCreateTargets(`cd "/tmp/a b" && git switch -c x`, fx.main, HOME), ["/tmp/a b"]);
  });

  it("`~` e `$HOME` expandem para o home", () => {
    assert.deepEqual(resolveBranchCreateTargets("cd ~/repo && git switch -c x", fx.main, HOME), ["/home/fake/repo"]);
    assert.deepEqual(resolveBranchCreateTargets("git -C $HOME/repo switch -c x", fx.main, HOME), ["/home/fake/repo"]);
  });

  it("fail-closed: variável, substituição, `cd -`, popd, --git-dir/--work-tree → não resolvido (null)", () => {
    assert.deepEqual(resolveBranchCreateTargets("cd $W && git switch -c x", fx.wt, HOME), [null]);
    assert.deepEqual(resolveBranchCreateTargets('git -C "$(pwd)" switch -c x', fx.wt, HOME), [null]);
    assert.deepEqual(resolveBranchCreateTargets("cd - && git checkout -b x", fx.wt, HOME), [null]);
    assert.deepEqual(resolveBranchCreateTargets("popd && git checkout -b x", fx.wt, HOME), [null]);
    assert.deepEqual(resolveBranchCreateTargets(`git --work-tree=${fx.main} checkout -b x`, fx.wt, HOME), [null]);
    assert.deepEqual(resolveBranchCreateTargets(`git --git-dir ${fx.main}/.git checkout -b x`, fx.wt, HOME), [null]);
    assert.deepEqual(resolveBranchCreateTargets("git $OPTS switch -c x", fx.wt, HOME), [null]);
  });

  it("variável atribuída com valor literal antes no MESMO comando é expandida (forma do caso real, `W=...; cd $W`)", () => {
    assert.deepEqual(resolveBranchCreateTargets(`W=${fx.wt}; cd $W && git switch -q -c x`, fx.main, HOME), [fx.wt]);
    assert.deepEqual(resolveBranchCreateTargets(`export W=${fx.wt} && cd "\${W}" && git switch -c x`, fx.main, HOME), [fx.wt]);
    assert.deepEqual(resolveBranchCreateTargets(`W=${fx.wt}\ngit -C "$W/scripts" switch -c x`, fx.main, HOME), [join(fx.wt, "scripts")]);
    // valor dinâmico na atribuição, ou atribuição só dentro de subshell → segue não resolvido
    assert.deepEqual(resolveBranchCreateTargets("W=$(pwd); cd $W && git switch -c x", fx.main, HOME), [null]);
    assert.deepEqual(resolveBranchCreateTargets(`(W=${fx.wt}); cd $W && git switch -c x`, fx.main, HOME), [null]);
    // `W=x git ...` é env do comando, não variável do shell para `$W` na mesma linha
    assert.deepEqual(resolveBranchCreateTargets(`W=${fx.wt} git -C $W switch -c x`, fx.main, HOME), [null]);
  });

  it("#12214: `git -C $(...) switch -c` SEM aspas → não resolvido (null), não lista vazia", () => {
    assert.deepEqual(
      resolveBranchCreateTargets("git -C $(git rev-parse --show-toplevel) switch -c x", fx.wt, HOME),
      [null],
    );
    // aninhada, com `;`/`&&` dentro, e aritmética `$((...))`
    assert.deepEqual(resolveBranchCreateTargets("git -C $(cd $(pwd) && pwd; echo) checkout -b x", fx.wt, HOME), [null]);
    assert.deepEqual(resolveBranchCreateTargets("git -C /x$((1+2)) switch -c x", fx.wt, HOME), [null]);
    // `git switch -c` DENTRO da substituição segue detectado, com o cwd de fora
    assert.deepEqual(resolveBranchCreateTargets("echo $(git switch -c x)", fx.main, HOME), [fx.main]);
    // `cd` dentro da substituição não vaza
    assert.deepEqual(resolveBranchCreateTargets(`X=$(cd ${fx.wt}) && git checkout -b x`, fx.main, HOME), [fx.main]);
    // subshell comum segue igual
    assert.deepEqual(resolveBranchCreateTargets(`(cd ${fx.wt} && git checkout -b x)`, fx.main, HOME), [fx.wt]);
  });

  it("#12214: tokenizeShellSegments mantém `$(...)` sem aspas no token corrente (dinâmico)", () => {
    const segs = tokenizeShellSegments("git -C $(git rev-parse --show-toplevel) switch -c x", HOME);
    const outer = segs.find((s: Array<{ value: string }>) => s[0]?.value === "git" && s.some((t) => t.value === "switch"));
    assert.ok(outer, JSON.stringify(segs));
    assert.deepEqual(
      outer.map((t: { value: string }) => t.value),
      ["git", "-C", "$(git rev-parse --show-toplevel)", "switch", "-c", "x"],
    );
    assert.equal(outer[2].dynamic, true);
  });

  it("variável em aspas simples é literal (não dinâmica)", () => {
    assert.deepEqual(resolveBranchCreateTargets("cd '/tmp/$x' && git switch -c y", fx.main, HOME), ["/tmp/$x"]);
  });

  it("não cria branch → lista vazia (nada a decidir)", () => {
    assert.deepEqual(resolveBranchCreateTargets(`cd ${fx.main} && git switch master`, fx.wt, HOME), []);
    assert.deepEqual(resolveBranchCreateTargets('gh pr create --body "rode git checkout -b x"', fx.main, HOME), []);
    assert.deepEqual(resolveBranchCreateTargets("git -C /x log -b", fx.main, HOME), []);
  });

  it("isBranchCreateCheckoutCommand passa a reconhecer opções globais e VAR=x", () => {
    assert.equal(isBranchCreateCheckoutCommand("git -C /x switch -c y"), true);
    assert.equal(isBranchCreateCheckoutCommand("git -c core.x=1 checkout -b y"), true);
    assert.equal(isBranchCreateCheckoutCommand("GIT_TRACE=1 git checkout -b y"), true);
    assert.equal(isBranchCreateCheckoutCommand("git checkout -b y 2>&1 | tail -3"), true);
  });

  it("tokenizeShellSegments separa `&&`/`;`/`|`/newline fora de aspas e mantém o conteúdo citado num token", () => {
    const segs = tokenizeShellSegments('cd "a && b" && git x; y | z\nw', HOME).map((s: Array<{ value: string }>) =>
      s.map((t) => t.value),
    );
    assert.deepEqual(segs, [["cd", "a && b"], ["git", "x"], ["y"], ["z"], ["w"]]);
  });
});

describe("mainRootsHitByTargets / mainCheckoutRootOf (#12165)", () => {
  const fx = makeFixture();
  after(() => rmSync(fx.base, { recursive: true, force: true }));

  it("mainCheckoutRootOf: principal → ele mesmo; worktree → principal pelo gitdir", () => {
    assert.equal(mainCheckoutRootOf(fx.main), fx.main);
    assert.equal(mainCheckoutRootOf(fx.wt), fx.main);
    assert.equal(mainCheckoutRootOf(fx.outsideWt), fx.main);
  });

  it("alvo worktree linkado (inclusive subdiretório e fora de .claude/worktrees/) → nada atingido", () => {
    assert.deepEqual(mainRootsHitByTargets([fx.wt, join(fx.wt, "scripts"), fx.outsideWt], fx.main), []);
  });

  it("alvo checkout principal (ou subdiretório dele) → principal atingido", () => {
    assert.deepEqual(mainRootsHitByTargets([join(fx.main, "scripts")], fx.wt), [fx.main]);
  });

  it("alvo não resolvido → principal da sessão (fail-closed), mesmo com a sessão num worktree", () => {
    assert.deepEqual(mainRootsHitByTargets([null], fx.wt), [fx.main]);
  });
});

describe("hook end-to-end (#12165) — os dois casos da issue", () => {
  const fx = makeFixture();
  writeCoordinator(fx.main, "coord-1");
  after(() => rmSync(fx.base, { recursive: true, force: true }));
  const denied = (out: string) => out.includes('"permissionDecision":"deny"');
  const hook = (cwd: string, command: string, sessionId = "outra-sessao") =>
    runHook({ tool_name: "Bash", session_id: sessionId, cwd, tool_input: { command } });

  it("regressão (falso positivo): sessão no principal, `cd <worktree linkado> && git switch -c` → LIBERA", () => {
    const out = hook(fx.main, `cd ${fx.outsideWt} && git switch -q -c fix/12092-x`);
    assert.equal(denied(out), false, out);
  });

  it("regressão (falso positivo, forma literal da issue): `W=<worktree>; cd $W && git switch -q -c` → LIBERA", () => {
    const out = hook(fx.main, `W=${fx.outsideWt}\ncd $W && git switch -q -c fix/12092-x`);
    assert.equal(denied(out), false, out);
  });

  it("regressão (furo): sessão num worktree, `git -C <principal> switch -c` → BLOQUEIA", () => {
    const out = hook(fx.wt, `git -C ${fx.main} switch -c outra-branch`);
    assert.equal(denied(out), true, out);
  });

  it("sessão num worktree, `cd <principal> && git checkout -b` → BLOQUEIA", () => {
    assert.equal(denied(hook(fx.wt, `cd ${fx.main} && git checkout -b x`)), true);
  });

  it("comando comum de subagente: `git checkout -b X` com cwd no próprio worktree → LIBERA", () => {
    assert.equal(denied(hook(fx.wt, "git checkout -b overnight/fix-1-x")), false);
  });

  it("sessão no principal, `git checkout -b` sem cd → BLOQUEIA (comportamento #6509 preservado)", () => {
    assert.equal(denied(hook(fx.main, "git checkout -b x")), true);
  });

  it("alvo não resolvido (`cd $W`) com coordenadora alheia ativa → BLOQUEIA (fail-closed)", () => {
    assert.equal(denied(hook(fx.wt, "cd $W && git switch -c x")), true);
  });

  it("regressão #12214: `git -C $(git rev-parse --show-toplevel) switch -c` sem aspas, de um worktree → BLOQUEIA (fail-closed)", () => {
    assert.equal(denied(hook(fx.wt, "git -C $(git rev-parse --show-toplevel) switch -c x")), true);
    // as formas com aspas e com crase já bloqueavam e seguem bloqueando
    assert.equal(denied(hook(fx.wt, 'git -C "$(pwd)" switch -c x')), true);
    assert.equal(denied(hook(fx.wt, "git -C `pwd` switch -c x")), true);
  });

  it("a própria coordenadora no principal → LIBERA", () => {
    assert.equal(denied(hook(fx.main, "git checkout -b x", "coord-1")), false);
  });

  it("regressão #12165 (residual): de um worktree, `git -C <principal> switch <branch existente>` → BLOQUEIA", () => {
    assert.equal(denied(hook(fx.wt, `git -C ${fx.main} switch outra-branch`)), true);
    assert.equal(denied(hook(fx.wt, `cd ${fx.main} && git checkout overnight/fix-1-x`)), true);
  });

  it("#12165: no próprio principal, `git checkout <branch existente>` → BLOQUEIA", () => {
    assert.equal(denied(hook(fx.main, "git checkout outra-branch")), true);
  });

  it("#12165: voltar o principal para master segue livre, de onde vier", () => {
    assert.equal(denied(hook(fx.wt, `git -C ${fx.main} switch master`)), false);
    assert.equal(denied(hook(fx.main, "git checkout master")), false);
    assert.equal(denied(hook(fx.wt, `cd ${fx.main} && git checkout main`)), false);
  });

  it("#12165: trocar de branch dentro do próprio worktree linkado segue livre", () => {
    assert.equal(denied(hook(fx.wt, "git switch outra-branch")), false);
  });
});
