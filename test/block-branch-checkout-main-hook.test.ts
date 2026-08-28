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
  sessionsDir,
  machineTag,
  stripQuotedSpans,
  BLOCK_REASON,
} from "../.claude/hooks/block-branch-checkout-main.mjs";

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

  it("NÃO detecta 'git checkout <branch-existente>' sem -b (fora de escopo, #6509)", () => {
    assert.equal(isBranchCreateCheckoutCommand("git checkout master"), false);
    assert.equal(isBranchCreateCheckoutCommand("git checkout origin/master -- file.ts"), false);
  });

  it("NÃO detecta 'git checkout -- <file>' (checkout de arquivo, não de branch)", () => {
    assert.equal(isBranchCreateCheckoutCommand("git checkout -- src/foo.ts"), false);
  });

  it("NÃO detecta -b como substring de outra flag (ex: --builder)", () => {
    assert.equal(isBranchCreateCheckoutCommand("git checkout --builder foo"), false);
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
    writeSession(root, "overnight-helios-sess1.json", {
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
    writeSession(root, "develop-helios-sess2.json", {
      kind: "develop",
      sessionId: "sess2",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    writeSession(root, "continuo-helios-sess3.json", {
      kind: "continuo",
      sessionId: "sess3",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    writeSession(root, "outro-helios-sess4.json", {
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
    writeSession(root, "overnight-helios-sess6.json", {
      kind: "overnight",
      sessionId: "sess6",
      startedAt: new Date(NOW - 25 * ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set());
  });

  it("sessão sem heartbeat há mais de SOFT_STALE_MS (90 min) é ignorada", () => {
    const root = freshRoot();
    writeSession(root, "overnight-helios-sess7.json", {
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
    writeFileSync(join(sessionsDir(root), "overnight-helios-broken.json"), "{not valid json", "utf8");
    writeSession(root, "overnight-helios-sess8.json", {
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
    writeSession(root, "overnight-helios-sess9-safeBackup-0001.json", {
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
    // @ts-expect-error — exercita o fallback `?? new Set()` do próprio guard
    assert.equal(shouldBlockBranchCheckout(undefined, "sess-x"), false);
    // @ts-expect-error
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
