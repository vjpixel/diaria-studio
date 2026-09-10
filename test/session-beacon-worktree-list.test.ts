/**
 * test/session-beacon-worktree-list.test.ts (#7722 item 2)
 *
 * Regressão para o bug descrito na issue: o beacon publicava um único
 * `branch` derivado do checkout onde o HOOK mora (o checkout PRINCIPAL, pra
 * coordenador/interativa) — nunca refletindo a branch dos worktrees onde a
 * sessão de fato trabalha via `cd` por chamada de Bash. Três sessões
 * concorrentes, cada uma num worktree com branch diferente, publicavam
 * TODAS a mesma `branch` (a do principal), tornando qualquer guard
 * construído sobre esse campo decorativo.
 *
 * Cenário mínimo exigido pelo dispatch: sessão com MÚLTIPLOS worktrees
 * ativos, cada um em branch diferente — o registro precisa refletir CADA
 * worktree, não só o checkout principal. Cobre 3 camadas:
 *   1. `resolveWorktreeBranches` (unidade pura, fixture de filesystem —
 *      mesmo padrão de `resolveMainRepoRootNoSpawn` em session-beacon-hook.test.ts)
 *   2. `buildBeaconRecord` (o campo `worktrees` chega ao registro publicado)
 *   3. `selectInUseWorktreeNames`/`filterOutInUseWorktrees`
 *      (`scripts/cleanup-merged-worktrees.ts`) — o consumidor real que
 *      protege um worktree externo de remoção por branch, e que o `branch`
 *      singular sozinho não alcançava (#7750).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWorktreeBranches, buildBeaconRecord } from "../.claude/hooks/session-beacon.mjs";
import { selectInUseWorktreeNames, filterOutInUseWorktrees } from "../scripts/cleanup-merged-worktrees.ts";
import type { SessionRecord } from "../scripts/lib/session-registry.ts";

/** Cria `<main>/.git/worktrees/<name>/{HEAD,gitdir}` sem precisar de `git` real. */
function makeFakeWorktree(mainGitDir: string, name: string, branch: string, worktreePath: string): void {
  const metaDir = join(mainGitDir, "worktrees", name);
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, "HEAD"), `ref: refs/heads/${branch}\n`, "utf8");
  writeFileSync(join(metaDir, "gitdir"), `${worktreePath}/.git\n`, "utf8");
}

test("#7722 item 2 — resolveWorktreeBranches lista TODOS os worktrees a partir do checkout PRINCIPAL (o startDir real de coordenador/interativa)", () => {
  const base = mkdtempSync(join(tmpdir(), "beacon-wtlist-"));
  try {
    const main = join(base, "main");
    mkdirSync(join(main, ".git"), { recursive: true }); // .git é DIRETÓRIO — checkout principal
    makeFakeWorktree(join(main, ".git"), "agent-a1", "overnight/fix-100", join(base, "wt-a1"));
    makeFakeWorktree(join(main, ".git"), "agent-b2", "develop/fix-200", join(base, "wt-b2"));
    makeFakeWorktree(join(main, ".git"), "agent-c3", "continuo/fix-300", join(base, "wt-c3"));

    // ANTES da correção (#7810), esta chamada devolvia `null` — o filtro
    // interno só populava `out` quando `startDir` em SI já era um worktree
    // vinculado, e o `startDir` real do beacon é sempre o checkout
    // PRINCIPAL (coordenador/interativa nunca rodam de dentro de um
    // worktree vinculado — `isLinkedWorktree` faz o entrypoint retornar
    // antes disso pra subagente).
    const result = resolveWorktreeBranches(main);
    assert.notEqual(result, null, "deve resolver algo a partir do checkout principal — era o bug");
    const byBranch = Object.fromEntries((result as Array<{ branch: string; path: string | null }>).map((w) => [w.branch, w.path]));
    assert.equal(byBranch["overnight/fix-100"], join(base, "wt-a1"), "worktree A deve refletir a branch dele, não a do principal");
    assert.equal(byBranch["develop/fix-200"], join(base, "wt-b2"), "worktree B deve refletir a branch dele, não a do principal");
    assert.equal(byBranch["continuo/fix-300"], join(base, "wt-c3"), "worktree C deve refletir a branch dele, não a do principal");
    assert.equal(Object.keys(byBranch).length, 3, "os 3 worktrees devem aparecer, nenhum colapsando nos outros");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#7722 item 2 — resolveWorktreeBranches funciona igual partindo de um worktree vinculado (cwd-independente)", () => {
  const base = mkdtempSync(join(tmpdir(), "beacon-wtlist2-"));
  try {
    const main = join(base, "main");
    const wtA = join(base, "wt-a1");
    mkdirSync(join(main, ".git"), { recursive: true });
    makeFakeWorktree(join(main, ".git"), "agent-a1", "overnight/fix-100", wtA);
    makeFakeWorktree(join(main, ".git"), "agent-b2", "develop/fix-200", join(base, "wt-b2"));

    mkdirSync(wtA, { recursive: true });
    writeFileSync(join(wtA, ".git"), `gitdir: ${join(main, ".git", "worktrees", "agent-a1")}\n`, "utf8");

    const result = resolveWorktreeBranches(wtA);
    assert.notEqual(result, null);
    const branches = (result as Array<{ branch: string }>).map((w) => w.branch).sort();
    assert.deepEqual(branches, ["develop/fix-200", "overnight/fix-100"], "a lista é do REPO inteiro, não só do worktree de onde partiu");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#7722 item 2 — sem .git/worktrees (repo sem worktree nenhum) → null, fail-open", () => {
  const base = mkdtempSync(join(tmpdir(), "beacon-wtlist3-"));
  try {
    mkdirSync(join(base, ".git"), { recursive: true });
    assert.equal(resolveWorktreeBranches(base), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#7722 item 2 — buildBeaconRecord publica `known_worktrees` (path+branch) a partir de worktreeBranches do event", () => {
  const event = {
    kind: "overnight",
    machineTag: "300",
    sessionId: "sess-1",
    branch: "master", // o singular, do checkout principal — sempre "errado" neste cenário
    newPaths: [],
    verb: null,
    nowIso: "2026-09-09T12:00:00.000Z",
    pid: 4242,
    worktreeBranches: [
      { worktreeName: "agent-a1", branch: "overnight/fix-100", path: "/repo/.claude/worktrees/agent-a1" },
      { worktreeName: "agent-b2", branch: "develop/fix-200", path: "/repo/.claude/worktrees/agent-b2" },
    ],
  };
  const record = buildBeaconRecord(null, event);
  assert.notEqual(record, null);
  assert.equal(record.branch, "master", "o singular continua publicado, por compatibilidade");
  assert.deepEqual(record.known_worktrees, [
    { path: "/repo/.claude/worktrees/agent-a1", branch: "overnight/fix-100" },
    { path: "/repo/.claude/worktrees/agent-b2", branch: "develop/fix-200" },
  ]);
});

test("#7722 item 2 — buildBeaconRecord descarta entradas sem path resolvido (gitdir ilegível)", () => {
  const event = {
    kind: "overnight",
    machineTag: "300",
    sessionId: "sess-1",
    branch: "master",
    newPaths: [],
    verb: null,
    nowIso: "2026-09-09T12:00:00.000Z",
    pid: 4242,
    worktreeBranches: [
      { worktreeName: "agent-a1", branch: "overnight/fix-100", path: null },
      { worktreeName: "agent-b2", branch: "develop/fix-200", path: "/repo/.claude/worktrees/agent-b2" },
    ],
  };
  const record = buildBeaconRecord(null, event);
  assert.deepEqual(record.known_worktrees, [{ path: "/repo/.claude/worktrees/agent-b2", branch: "develop/fix-200" }]);
});

test("#7722 item 2 — cleanup-merged-worktrees: 3 sessões concorrentes, mesmo `branch` singular (checkout principal), CADA worktree protegido pela sua PRÓPRIA branch via `worktrees`", () => {
  // Reproduz a medição ao vivo da issue: 3 sessões interativas do Neo, todas
  // publicando `branch=hotfix/robots-guard-expected-hosts` (a do checkout
  // principal) — nenhuma delas de fato trabalhando ali. Cada uma tem seu
  // PRÓPRIO worktree/branch em `worktrees`, populado pelo beacon corrigido.
  const SAME_MAIN_BRANCH = "hotfix/robots-guard-expected-hosts";
  const sessions: SessionRecord[] = [
    {
      kind: "overnight",
      machineTag: "neo",
      sessionId: "sess-a",
      startedAt: "2026-09-09T00:00:00.000Z",
      lastHeartbeat: "2026-09-09T00:05:00.000Z",
      branch: SAME_MAIN_BRANCH,
      known_worktrees: [{ path: "C:/Users/vjpix/Projects/wt-A", branch: "overnight/fix-100" }],
    },
    {
      kind: "develop",
      machineTag: "neo",
      sessionId: "sess-b",
      startedAt: "2026-09-09T00:00:00.000Z",
      lastHeartbeat: "2026-09-09T00:05:00.000Z",
      branch: SAME_MAIN_BRANCH,
      known_worktrees: [{ path: "C:/Users/vjpix/Projects/wt-B", branch: "develop/fix-200" }],
    },
    {
      kind: "continuo",
      machineTag: "neo",
      sessionId: "sess-c",
      startedAt: "2026-09-09T00:00:00.000Z",
      lastHeartbeat: "2026-09-09T00:05:00.000Z",
      branch: SAME_MAIN_BRANCH,
      known_worktrees: [{ path: "C:/Users/vjpix/Projects/wt-C", branch: "continuo/fix-300" }],
    },
  ];

  const entries = [
    { path: "C:/Users/vjpix/Projects/wt-A", branch: "overnight/fix-100", locked: false },
    { path: "C:/Users/vjpix/Projects/wt-B", branch: "develop/fix-200", locked: false },
    { path: "C:/Users/vjpix/Projects/wt-C", branch: "continuo/fix-300", locked: false },
    { path: "C:/Users/vjpix/Projects/wt-livre", branch: "chore/nada-a-ver", locked: false },
  ];

  const inUse = selectInUseWorktreeNames(sessions);
  // Apenas o `branch` singular (checkout principal) NÃO teria protegido
  // nenhum dos 3 worktrees externos — é exatamente o bug da issue.
  assert.equal(inUse.branches.has(SAME_MAIN_BRANCH), true);
  assert.equal(inUse.branches.has("overnight/fix-100"), true, "protegido via worktrees da sess-a, não via branch singular");
  assert.equal(inUse.branches.has("develop/fix-200"), true, "protegido via worktrees da sess-b, não via branch singular");
  assert.equal(inUse.branches.has("continuo/fix-300"), true, "protegido via worktrees da sess-c, não via branch singular");

  const filtered = filterOutInUseWorktrees(entries, inUse);
  assert.deepEqual(
    filtered.map((e) => e.path),
    ["C:/Users/vjpix/Projects/wt-livre"],
    "os 3 worktrees ativos sobrevivem à varredura; só o livre é candidato a remoção",
  );
});

test("#7722 item 2 — sem `known_worktrees` no registro (sessão anterior ao fix, ou beacon nunca resolveu), comportamento cai pro anterior (só `branch` singular)", () => {
  const sessions: SessionRecord[] = [
    {
      kind: "develop",
      machineTag: "neo",
      sessionId: "sess-legado",
      startedAt: "2026-09-09T00:00:00.000Z",
      lastHeartbeat: "2026-09-09T00:05:00.000Z",
      branch: "chore/legado",
      // sem `known_worktrees` — registro anterior ao #7722
    },
  ];
  const inUse = selectInUseWorktreeNames(sessions);
  assert.deepEqual([...inUse.branches], ["chore/legado"]);
  assert.equal(inUse.names.size, 0);
});

test("#7722 item 2 — buildBeaconRecord NUNCA escreve no campo `worktrees` (contrato estreito de #6168 Parte A, `activeSessionWorktreePaths`) — só `known_worktrees`", () => {
  // Achado do self-review desta PR: a 1ª versão reaproveitava `worktrees`
  // (schema existente, nunca populado) pra publicar a foto global — isso
  // alargaria silenciosamente o contrato ESTREITO que
  // `scripts/lib/shared-session-guard.ts` (`activeSessionWorktreePaths`) já
  // documenta pra esse campo: "path aberto POR ESTA SESSÃO", usado por
  // `branch-cleanup.ts` como proteção incondicional mesmo com
  // `--confirm-shared`. Se `worktrees` virasse a lista global, TODO
  // worktree existente passaria a ficar protegido sempre que qualquer
  // sessão estivesse viva — justamente o que `--confirm-shared` existe pra
  // permitir ultrapassar. Por isso o campo publicado é outro:
  // `known_worktrees`, nunca `worktrees`.
  const event = {
    kind: "overnight",
    machineTag: "300",
    sessionId: "sess-1",
    branch: "master",
    newPaths: [],
    verb: null,
    nowIso: "2026-09-09T12:00:00.000Z",
    pid: 4242,
    worktreeBranches: [{ worktreeName: "agent-a1", branch: "overnight/fix-100", path: "/repo/.claude/worktrees/agent-a1" }],
  };
  const record = buildBeaconRecord(null, event);
  assert.equal(record.worktrees, undefined, "worktrees (contrato estreito, #6168 Parte A) deve continuar intocado por este fix");
  assert.ok(Array.isArray(record.known_worktrees) && record.known_worktrees.length === 1, "known_worktrees é quem publica a foto global");
});
