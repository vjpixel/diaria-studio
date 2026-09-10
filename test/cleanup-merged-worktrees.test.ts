/**
 * test/cleanup-merged-worktrees.test.ts (#4335)
 *
 * Cobre a lógica PURA de scripts/cleanup-merged-worktrees.ts: parse do
 * `git worktree list --porcelain`, filtro por diretório e seleção dos
 * worktrees com PR mergeada — tudo com um checker `isMerged` injetável, sem
 * precisar de worktrees reais nem chamadas de rede pro `gh`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWorktreePorcelain,
  filterUnderWorktreesDir,
  excludeMainWorktree,
  selectMergedForRemoval,
  selectOrphanedForStaleRemoval,
  extractIssueNumberFromWorktreeBranch,
  extractIssueNumbersFromWorktreeBranch,
  selectAbandonedForRemoval,
  ABANDONED_ISSUE_CLOSED_STALE_THRESHOLD_MS,
  shouldSkipForSharedSession,
  shouldSkipEntireScanForUnreadableRegistry,
  extractWorktreeNamesFromPaths,
  selectInUseWorktreeNames,
  worktreeNameFromPath,
  filterOutInUseWorktrees,
  filterOutLockedWorktrees,
  filterOutDirtyWorktrees,
  isWorktreeDirtySafe,
  ORPHAN_STALE_THRESHOLD_MS,
} from "../scripts/cleanup-merged-worktrees.ts";
import type { SessionRecord } from "../scripts/lib/session-registry.ts";

// ── parseWorktreePorcelain ──

test("parseWorktreePorcelain — parseia múltiplos blocos com branch", () => {
  const output = [
    "worktree C:/Users/vjpix/Projects/diaria-studio",
    "HEAD 13cf4e408e3f7880c15c76145091e0037d2ad755",
    "branch refs/heads/master",
    "",
    "worktree C:/Users/vjpix/Projects/diaria-studio/.claude/worktrees/agent-abc123",
    "HEAD a33bcd3c4b320447890451878e581f0b7015c656",
    "branch refs/heads/overnight/fix-4326",
    "",
  ].join("\n");

  const entries = parseWorktreePorcelain(output);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, "C:/Users/vjpix/Projects/diaria-studio");
  assert.equal(entries[0].branch, "master");
  assert.equal(entries[1].path, "C:/Users/vjpix/Projects/diaria-studio/.claude/worktrees/agent-abc123");
  assert.equal(entries[1].branch, "overnight/fix-4326");
});

test("parseWorktreePorcelain — worktree detached (sem 'branch') vira branch null", () => {
  const output = [
    "worktree /repo/.claude/worktrees/agent-xyz",
    "HEAD 1234567",
    "detached",
    "",
  ].join("\n");
  const entries = parseWorktreePorcelain(output);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].branch, null);
});

test("parseWorktreePorcelain — sem linha em branco final ainda fecha o último bloco", () => {
  const output = ["worktree /repo", "HEAD abc", "branch refs/heads/master"].join("\n");
  const entries = parseWorktreePorcelain(output);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].branch, "master");
});

test("parseWorktreePorcelain — output vazio retorna array vazio", () => {
  assert.deepEqual(parseWorktreePorcelain(""), []);
});

test("parseWorktreePorcelain — normaliza backslash pra forward slash no path (Windows)", () => {
  const output = ["worktree C:\\Users\\vjpix\\repo", "branch refs/heads/master", ""].join("\n");
  const entries = parseWorktreePorcelain(output);
  assert.equal(entries[0].path, "C:/Users/vjpix/repo");
});

test("#7048 — parseWorktreePorcelain marca locked=true quando a linha 'locked ...' aparece", () => {
  const output = [
    "worktree /repo/.claude/worktrees/agent-abc",
    "HEAD 1234567",
    "branch refs/heads/overnight/fix-1",
    "locked claude agent agent-abc (pid 4242)",
    "",
  ].join("\n");
  const entries = parseWorktreePorcelain(output);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].locked, true);
});

test("#7048 — parseWorktreePorcelain marca locked=true mesmo sem razão (linha 'locked' isolada)", () => {
  const output = ["worktree /repo/.claude/worktrees/agent-abc", "branch refs/heads/x", "locked", ""].join("\n");
  const entries = parseWorktreePorcelain(output);
  assert.equal(entries[0].locked, true);
});

test("parseWorktreePorcelain — locked=false quando a linha 'locked' está ausente", () => {
  const output = ["worktree /repo/.claude/worktrees/agent-abc", "branch refs/heads/x", ""].join("\n");
  const entries = parseWorktreePorcelain(output);
  assert.equal(entries[0].locked, false);
});

// ── filterUnderWorktreesDir ──

test("filterUnderWorktreesDir — mantém só os sob o diretório, nunca o worktree principal do repo", () => {
  const entries = [
    { path: "C:/repo", branch: "master", locked: false },
    { path: "C:/repo/.claude/worktrees/agent-a", branch: "overnight/fix-1", locked: false },
    { path: "C:/repo/.claude/worktrees/agent-b", branch: "develop/fix-2", locked: false },
  ];
  const result = filterUnderWorktreesDir(entries, "C:/repo/.claude/worktrees");
  assert.equal(result.length, 2);
  assert.ok(result.every((e) => e.path.includes(".claude/worktrees")));
});

test("filterUnderWorktreesDir — não confunde prefixo parcial de path (ex: 'worktrees-old')", () => {
  const entries = [
    { path: "C:/repo/.claude/worktrees-old/agent-x", branch: "b", locked: false },
    { path: "C:/repo/.claude/worktrees/agent-y", branch: "b2", locked: false },
  ];
  const result = filterUnderWorktreesDir(entries, "C:/repo/.claude/worktrees");
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "C:/repo/.claude/worktrees/agent-y");
});

test("filterUnderWorktreesDir — tolera barra final no worktreesDir", () => {
  const entries = [{ path: "C:/repo/.claude/worktrees/agent-a", branch: "b", locked: false }];
  const result = filterUnderWorktreesDir(entries, "C:/repo/.claude/worktrees/");
  assert.equal(result.length, 1);
});

// ── excludeMainWorktree (#7650 fatia 1) ──

test("#7650 — excludeMainWorktree remove só o 1º da lista (principal), preserva os demais dentro E fora de .claude/worktrees/", () => {
  const entries = [
    { path: "C:/repo", branch: "master", locked: false },
    { path: "C:/repo/.claude/worktrees/agent-a", branch: "overnight/fix-1", locked: false },
    { path: "C:/Users/vjpix/Projects/wt-develop-7406c", branch: "develop/clarice-daily-cutover-7406", locked: false },
  ];
  const result = excludeMainWorktree(entries);
  assert.deepEqual(
    result.map((e) => e.path),
    ["C:/repo/.claude/worktrees/agent-a", "C:/Users/vjpix/Projects/wt-develop-7406c"],
    "worktree externo (fora de .claude/worktrees/) agora entra na varredura — só o principal (1º da lista) fica de fora",
  );
});

test("#7650 — excludeMainWorktree com lista vazia retorna vazio, sem lançar", () => {
  assert.deepEqual(excludeMainWorktree([]), []);
});

test("#7650 — excludeMainWorktree com só o principal retorna vazio", () => {
  assert.deepEqual(excludeMainWorktree([{ path: "C:/repo", branch: "master", locked: false }]), []);
});

// ── selectMergedForRemoval ──

test("selectMergedForRemoval — só seleciona os que o checker confirma como mergeados", () => {
  const entries = [
    { path: "/a", branch: "overnight/fix-1", locked: false },
    { path: "/b", branch: "overnight/fix-2", locked: false },
    { path: "/c", branch: "develop/fix-3", locked: false },
  ];
  const merged = new Set(["overnight/fix-1", "develop/fix-3"]);
  const result = selectMergedForRemoval(entries, (b) => merged.has(b));
  assert.deepEqual(
    result.map((e) => e.path).sort(),
    ["/a", "/c"],
  );
});

test("selectMergedForRemoval — worktree detached (branch null) nunca é selecionado, mesmo com checker sempre-true", () => {
  const entries = [{ path: "/a", branch: null, locked: false }];
  const result = selectMergedForRemoval(entries, () => true);
  assert.equal(result.length, 0);
});

test("selectMergedForRemoval — nenhum mergeado -> array vazio (fail-soft: nunca remove por engano)", () => {
  const entries = [
    { path: "/a", branch: "overnight/fix-1", locked: false },
    { path: "/b", branch: "overnight/fix-2", locked: false },
  ];
  const result = selectMergedForRemoval(entries, () => false);
  assert.deepEqual(result, []);
});

test("selectMergedForRemoval — lista vazia de entrada -> array vazio", () => {
  assert.deepEqual(selectMergedForRemoval([], () => true), []);
});

// ── selectOrphanedForStaleRemoval (#5418) ──

const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const EIGHT_DAYS_AGO = NOW - 8 * 24 * 60 * 60 * 1000;
const ONE_DAY_AGO = NOW - 1 * 24 * 60 * 60 * 1000;

test("selectOrphanedForStaleRemoval — worktree detached HEAD antigo (>7 dias) é removido", () => {
  const entries = [{ path: "/a", branch: null, locked: false }];
  const result = selectOrphanedForStaleRemoval(
    entries,
    [],
    () => true,
    () => EIGHT_DAYS_AGO,
    NOW,
  );
  assert.deepEqual(result.map((e) => e.path), ["/a"]);
});

test("selectOrphanedForStaleRemoval — worktree detached HEAD recente (<7 dias) é preservado", () => {
  const entries = [{ path: "/a", branch: null, locked: false }];
  const result = selectOrphanedForStaleRemoval(
    entries,
    [],
    () => true,
    () => ONE_DAY_AGO,
    NOW,
  );
  assert.deepEqual(result, []);
});

test("selectOrphanedForStaleRemoval — branch com ref local deletado e antigo é removido", () => {
  const entries = [{ path: "/a", branch: "overnight/fix-old", locked: false }];
  const result = selectOrphanedForStaleRemoval(
    entries,
    [],
    (branch) => branch !== "overnight/fix-old", // ref não existe mais localmente
    () => EIGHT_DAYS_AGO,
    NOW,
  );
  assert.deepEqual(result.map((e) => e.path), ["/a"]);
});

test("selectOrphanedForStaleRemoval — branch local ainda existe, mesmo antigo, NUNCA é removido (decisão de escopo #5418)", () => {
  const entries = [{ path: "/a", branch: "overnight/fix-still-open", locked: false }];
  const result = selectOrphanedForStaleRemoval(
    entries,
    [],
    () => true, // branch ainda existe localmente
    () => EIGHT_DAYS_AGO,
    NOW,
  );
  assert.deepEqual(result, []);
});

test("selectOrphanedForStaleRemoval — mtime desconhecido (stat falhou) nunca conta como stale (fail-soft)", () => {
  const entries = [{ path: "/a", branch: null, locked: false }];
  const result = selectOrphanedForStaleRemoval(
    entries,
    [],
    () => true,
    () => null,
    NOW,
  );
  assert.deepEqual(result, []);
});

test("selectOrphanedForStaleRemoval — worktree já selecionado por merge não é duplicado", () => {
  const entries = [{ path: "/a", branch: null, locked: false }];
  const alreadySelected = [{ path: "/a", branch: null, locked: false }];
  const result = selectOrphanedForStaleRemoval(
    entries,
    alreadySelected,
    () => true,
    () => EIGHT_DAYS_AGO,
    NOW,
  );
  assert.deepEqual(result, []);
});

test("selectOrphanedForStaleRemoval — respeita threshold customizado", () => {
  const entries = [{ path: "/a", branch: null, locked: false }];
  const twoDaysAgo = NOW - 2 * 24 * 60 * 60 * 1000;
  const oneDayThreshold = 24 * 60 * 60 * 1000;
  const result = selectOrphanedForStaleRemoval(entries, [], () => true, () => twoDaysAgo, NOW, oneDayThreshold);
  assert.deepEqual(result.map((e) => e.path), ["/a"]);
});

test("ORPHAN_STALE_THRESHOLD_MS — 7 dias em ms", () => {
  assert.equal(ORPHAN_STALE_THRESHOLD_MS, 7 * 24 * 60 * 60 * 1000);
});

// ── extractIssueNumberFromWorktreeBranch (#7650 fatia 2) ──

test("#7650 — extractIssueNumberFromWorktreeBranch casa 'fix-NNNN-slug' sem prefixo de trilha", () => {
  assert.equal(extractIssueNumberFromWorktreeBranch("fix-4306-review-pass3"), 4306);
  assert.equal(extractIssueNumberFromWorktreeBranch("fix-4669-work"), 4669);
});

test("#7650 — extractIssueNumberFromWorktreeBranch casa com prefixo de trilha (overnight/develop/continuo)", () => {
  assert.equal(extractIssueNumberFromWorktreeBranch("develop/fix-7739"), 7739);
  assert.equal(extractIssueNumberFromWorktreeBranch("overnight/fix-7487-ads-daily-digest"), 7487);
  assert.equal(extractIssueNumberFromWorktreeBranch("continuo/fix-7701-onedrive-alarm-action"), 7701);
});

test("#7650 — extractIssueNumberFromWorktreeBranch casa 'fix/NNNN' (barra em vez de hífen)", () => {
  assert.equal(extractIssueNumberFromWorktreeBranch("fix/7650-slug"), 7650);
});

test("#7650 — extractIssueNumberFromWorktreeBranch casa 'fixNNNN' sem separador", () => {
  assert.equal(extractIssueNumberFromWorktreeBranch("fix5156-local"), 5156);
});

test("#7650 — extractIssueNumberFromWorktreeBranch rejeita 'fixer-NNNN' (fix seguido de letra, não dígito/separador)", () => {
  assert.equal(extractIssueNumberFromWorktreeBranch("fixer-5611-local"), null);
});

test("#7650 — extractIssueNumberFromWorktreeBranch rejeita 'prefix-NNNN' (fix precedido de letra — falso-positivo do lookbehind)", () => {
  assert.equal(extractIssueNumberFromWorktreeBranch("prefix-1234-slug"), null);
});

test("#7650 — extractIssueNumberFromWorktreeBranch rejeita branch sem número após 'fix' ('work-4790-fix')", () => {
  assert.equal(extractIssueNumberFromWorktreeBranch("work-4790-fix"), null);
});

test("#7650 — extractIssueNumberFromWorktreeBranch rejeita branch sem 'fix' nenhum (nomes aleatórios do harness)", () => {
  assert.equal(extractIssueNumberFromWorktreeBranch("worktree-agent-a80abb401b0a84448"), null);
  assert.equal(extractIssueNumberFromWorktreeBranch("merge-4581-work"), null);
  assert.equal(extractIssueNumberFromWorktreeBranch("mr-now"), null);
});

// ── extractIssueNumbersFromWorktreeBranch (#7750, plural) ──

test("#7750 — extractIssueNumbersFromWorktreeBranch extrai TODAS as issues de uma branch multi-issue real", () => {
  assert.deepEqual(extractIssueNumbersFromWorktreeBranch("develop/fix-4121-4160-4161-4054"), [4121, 4160, 4161, 4054]);
  assert.deepEqual(extractIssueNumbersFromWorktreeBranch("develop/fix-4059-4040-4041-mensal-utm"), [4059, 4040, 4041]);
});

test("#7750 — extractIssueNumbersFromWorktreeBranch com uma única issue devolve array de 1", () => {
  assert.deepEqual(extractIssueNumbersFromWorktreeBranch("fix-4306-review-pass3"), [4306]);
  assert.deepEqual(extractIssueNumbersFromWorktreeBranch("fix5156-local"), [5156]);
});

test("#7750 — extractIssueNumbersFromWorktreeBranch devolve [] quando a branch não segue a convenção", () => {
  assert.deepEqual(extractIssueNumbersFromWorktreeBranch("worktree-agent-xyz"), []);
  assert.deepEqual(extractIssueNumbersFromWorktreeBranch("fixer-5611-local"), []);
  assert.deepEqual(extractIssueNumbersFromWorktreeBranch("prefix-1234-slug"), []);
});

test("#7750 — extractIssueNumberFromWorktreeBranch (alias legado singular) devolve só a PRIMEIRA issue de uma branch multi-issue", () => {
  assert.equal(extractIssueNumberFromWorktreeBranch("develop/fix-4121-4160-4161-4054"), 4121);
});

// ── ABANDONED_ISSUE_CLOSED_STALE_THRESHOLD_MS (#7650 fatia 2) ──

test("#7650 — ABANDONED_ISSUE_CLOSED_STALE_THRESHOLD_MS é o DOBRO de ORPHAN_STALE_THRESHOLD_MS (14 dias, folga deliberada — ver docblock)", () => {
  assert.equal(ABANDONED_ISSUE_CLOSED_STALE_THRESHOLD_MS, 2 * ORPHAN_STALE_THRESHOLD_MS);
  assert.equal(ABANDONED_ISSUE_CLOSED_STALE_THRESHOLD_MS, 14 * 24 * 60 * 60 * 1000);
});

// ── selectAbandonedForRemoval (#7650 fatia 2) ──

const NOW_7650 = Date.parse("2026-09-09T12:00:00.000Z");
const ISSUE_CLOSED_20_DAYS_AGO = NOW_7650 - 20 * 24 * 60 * 60 * 1000;
const ISSUE_CLOSED_2_DAYS_AGO = NOW_7650 - 2 * 24 * 60 * 60 * 1000;

test("#7650 — selectAbandonedForRemoval remove worktree com branch viva cuja issue fechou há mais do que o piso, sem PR aberta", () => {
  const entries = [{ path: "/repo/.claude/worktrees/agent-abandonado", branch: "fix-7650-slug", locked: false }];
  const result = selectAbandonedForRemoval(
    entries,
    [],
    () => ISSUE_CLOSED_20_DAYS_AGO,
    () => false,
    NOW_7650,
  );
  assert.deepEqual(result.map((e) => e.path), ["/repo/.claude/worktrees/agent-abandonado"]);
});

test("#7650 — selectAbandonedForRemoval preserva quando a issue fechou há MENOS do que o piso (14 dias)", () => {
  const entries = [{ path: "/repo/.claude/worktrees/agent-recente", branch: "fix-7650-slug", locked: false }];
  const result = selectAbandonedForRemoval(
    entries,
    [],
    () => ISSUE_CLOSED_2_DAYS_AGO,
    () => false,
    NOW_7650,
  );
  assert.deepEqual(result, []);
});

test("#7650 — selectAbandonedForRemoval preserva quando a branch tem PR ABERTA, mesmo com issue fechada há muito tempo", () => {
  const entries = [{ path: "/repo/.claude/worktrees/agent-com-pr-aberta", branch: "fix-7650-slug", locked: false }];
  const result = selectAbandonedForRemoval(
    entries,
    [],
    () => ISSUE_CLOSED_20_DAYS_AGO,
    () => true, // tem PR aberta
    NOW_7650,
  );
  assert.deepEqual(result, []);
});

test("#7650 — selectAbandonedForRemoval preserva quando a issue NÃO está fechada (getIssueClosedAtMs retorna null)", () => {
  const entries = [{ path: "/repo/.claude/worktrees/agent-issue-aberta", branch: "fix-7650-slug", locked: false }];
  const result = selectAbandonedForRemoval(
    entries,
    [],
    () => null, // issue aberta, ou dado indeterminado
    () => false,
    NOW_7650,
  );
  assert.deepEqual(result, []);
});

test("#7650 — selectAbandonedForRemoval nunca avalia worktree sem branch (órfão é outro seletor)", () => {
  const entries = [{ path: "/repo/.claude/worktrees/agent-detached", branch: null, locked: false }];
  const result = selectAbandonedForRemoval(
    entries,
    [],
    () => ISSUE_CLOSED_20_DAYS_AGO,
    () => false,
    NOW_7650,
  );
  assert.deepEqual(result, []);
});

test("#7650 — selectAbandonedForRemoval nunca avalia branch que não referencia issue nenhuma (nome sem convenção fix-N)", () => {
  const entries = [{ path: "/repo/.claude/worktrees/agent-sem-issue", branch: "worktree-agent-xyz", locked: false }];
  const getIssueClosedAtMs = (): number | null => {
    throw new Error("não deveria ser chamado — branch não tem issue extraível");
  };
  const result = selectAbandonedForRemoval(entries, [], getIssueClosedAtMs, () => false, NOW_7650);
  assert.deepEqual(result, []);
});

test("#7650 — selectAbandonedForRemoval não duplica worktree já selecionado por merge ou por órfão+stale", () => {
  const entries = [{ path: "/repo/.claude/worktrees/agent-x", branch: "fix-7650-slug", locked: false }];
  const alreadySelected = [{ path: "/repo/.claude/worktrees/agent-x", branch: "fix-7650-slug", locked: false }];
  const result = selectAbandonedForRemoval(
    entries,
    alreadySelected,
    () => ISSUE_CLOSED_20_DAYS_AGO,
    () => false,
    NOW_7650,
  );
  assert.deepEqual(result, []);
});

test("#7650 — selectAbandonedForRemoval respeita threshold customizado", () => {
  const entries = [{ path: "/repo/.claude/worktrees/agent-x", branch: "fix-7650-slug", locked: false }];
  const oneDayThreshold = 24 * 60 * 60 * 1000;
  const result = selectAbandonedForRemoval(
    entries,
    [],
    () => ISSUE_CLOSED_2_DAYS_AGO, // 2 dias > piso customizado de 1 dia
    () => false,
    NOW_7650,
    oneDayThreshold,
  );
  assert.deepEqual(result.map((e) => e.path), ["/repo/.claude/worktrees/agent-x"]);
});

test("#7750 — selectAbandonedForRemoval PRESERVA branch multi-issue quando só a PRIMEIRA issue está fechada há muito tempo e as demais seguem abertas", () => {
  // Caso real do review #7750: develop/fix-4121-4160-4161-4054 — #4121 fechada
  // há 20 dias, mas #4160/#4161/#4054 seguem abertas. Antes do fix, só a
  // primeira issue era checada e o worktree era classificado (errado) como
  // abandonado, destruindo trabalho pendente das outras 3 issues.
  const entries = [{ path: "/repo/.claude/worktrees/agent-multi", branch: "develop/fix-4121-4160-4161-4054", locked: false }];
  const closedMap: Record<number, number | null> = {
    4121: ISSUE_CLOSED_20_DAYS_AGO,
    4160: null, // ainda aberta
    4161: null,
    4054: null,
  };
  const result = selectAbandonedForRemoval(
    entries,
    [],
    (issueNumber) => closedMap[issueNumber] ?? null,
    () => false,
    NOW_7650,
  );
  assert.deepEqual(result, [], "worktree NÃO deve ser removido — 3 das 4 issues ainda abertas");
});

test("#7750 — selectAbandonedForRemoval remove branch multi-issue só quando TODAS as issues estão fechadas há mais que o piso", () => {
  const entries = [{ path: "/repo/.claude/worktrees/agent-multi-fechada", branch: "develop/fix-4059-4040-4041-mensal-utm", locked: false }];
  const closedMap: Record<number, number> = {
    4059: ISSUE_CLOSED_20_DAYS_AGO,
    4040: ISSUE_CLOSED_20_DAYS_AGO,
    4041: ISSUE_CLOSED_20_DAYS_AGO,
  };
  const result = selectAbandonedForRemoval(
    entries,
    [],
    (issueNumber) => closedMap[issueNumber] ?? null,
    () => false,
    NOW_7650,
  );
  assert.deepEqual(result.map((e) => e.path), ["/repo/.claude/worktrees/agent-multi-fechada"]);
});

// ── #7045: exclusão POR WORKTREE em vez de skip global ──
//
// Antes do #7045, `main()` pulava a varredura INTEIRA sempre que existia
// ≥1 sessão coordenadora ativa — com o contínuo rodando quase 24/7, isso
// virava um no-op quase incondicional (51 worktrees acumulados, 28 com PR
// já mergeada, achado ao vivo). A partir do #7045, só o worktree cujo
// caminho aparece em touched_paths/dirty_paths de alguma sessão ATIVA e
// não-stale fica de fora — os demais seguem avaliados normalmente mesmo com
// outras sessões ativas.
test("#7045 — sessão ativa NÃO bloqueia mais a varredura inteira: worktree sem footprint segue elegível", () => {
  const entries = [{ path: "/a", branch: null, locked: false }];
  const wouldRemoveInIsolation = selectOrphanedForStaleRemoval(
    entries,
    [],
    () => true,
    () => EIGHT_DAYS_AGO,
    NOW,
  );
  assert.deepEqual(wouldRemoveInIsolation.map((e) => e.path), ["/a"], "confirma que o worktree É candidato isoladamente");

  // Sessão ativa cujo footprint NÃO toca o worktree "/a" — não deveria
  // excluí-lo (comportamento novo: a exclusão é por nome de worktree, não
  // por "existe alguma sessão viva em algum lugar").
  const activeSession: SessionRecord = {
    kind: "develop",
    machineTag: "host-b",
    sessionId: "sess-live",
    startedAt: "2026-08-16T11:00:00.000Z",
    lastHeartbeat: "2026-08-16T11:59:00.000Z",
    touched_paths: [".claude/worktrees/agent-outro-qualquer/scripts/foo.ts"],
  };
  const inUse = selectInUseWorktreeNames([activeSession]);
  assert.equal(inUse.names.has("a"), false, "'/a' não é o nome de nenhum worktree tocado por essa sessão");
  const filtered = filterOutInUseWorktrees(entries, inUse);
  assert.deepEqual(filtered.map((e) => e.path), ["/a"], "worktree sem footprint continua elegível mesmo com sessão ativa");
});

test("#7045 — worktree É excluído quando seu nome aparece em touched_paths/dirty_paths de sessão ativa", () => {
  const entries = [
    { path: "C:/repo/.claude/worktrees/agent-em-uso", branch: "develop/fix-1", locked: false },
    { path: "C:/repo/.claude/worktrees/agent-livre", branch: "overnight/fix-2", locked: false },
  ];
  const activeSession: SessionRecord = {
    kind: "continuo",
    machineTag: "300",
    sessionId: "sess-continuo",
    startedAt: "2026-09-01T00:00:00.000Z",
    lastHeartbeat: "2026-09-01T00:05:00.000Z",
    dirty_paths: [".claude/worktrees/agent-em-uso/scripts/lib/foo.ts"],
  };
  const inUse = selectInUseWorktreeNames([activeSession]);
  const filtered = filterOutInUseWorktrees(entries, inUse);
  assert.deepEqual(filtered.map((e) => e.path), ["C:/repo/.claude/worktrees/agent-livre"]);
});

test("#7750 — worktree EXTERNO (fora de .claude/worktrees/) é protegido via matching por BRANCH, não por nome", () => {
  // Caso real do review #7750: C:/Users/vjpix/Projects/wt-model-bench, branch
  // chore/model-bench-harness, PR já mergeada, árvore limpa — nenhum
  // touched_paths/dirty_paths pode casar o nome desse worktree (o regex de
  // extractWorktreeNamesFromPaths exige o segmento .claude/worktrees), então
  // só o matching por branch protege esse caso.
  const entries = [
    { path: "C:/Users/vjpix/Projects/wt-model-bench", branch: "chore/model-bench-harness", locked: false },
    { path: "C:/repo/.claude/worktrees/agent-livre", branch: "overnight/fix-2", locked: false },
  ];
  const activeSession: SessionRecord = {
    kind: "develop",
    machineTag: "neo",
    sessionId: "sess-follow-up",
    startedAt: "2026-09-09T00:00:00.000Z",
    lastHeartbeat: "2026-09-09T00:05:00.000Z",
    branch: "chore/model-bench-harness",
    // Sem touched_paths/dirty_paths apontando pro worktree externo — a
    // proteção por nome sozinha não alcançaria este caso.
  };
  const inUse = selectInUseWorktreeNames([activeSession]);
  assert.equal(inUse.branches.has("chore/model-bench-harness"), true);
  const filtered = filterOutInUseWorktrees(entries, inUse);
  assert.deepEqual(
    filtered.map((e) => e.path),
    ["C:/repo/.claude/worktrees/agent-livre"],
    "worktree externo com branch em uso por sessão ativa deve ser preservado",
  );
});

test("#7750 — worktree externo SEM sessão ativa na sua branch continua elegível (matching por branch não superprotege)", () => {
  const entries = [{ path: "C:/Users/vjpix/Projects/wt-outro-externo", branch: "chore/outro-trabalho", locked: false }];
  const activeSession: SessionRecord = {
    kind: "develop",
    machineTag: "neo",
    sessionId: "sess-outra",
    startedAt: "2026-09-09T00:00:00.000Z",
    lastHeartbeat: "2026-09-09T00:05:00.000Z",
    branch: "chore/model-bench-harness", // branch diferente da do worktree candidato
  };
  const inUse = selectInUseWorktreeNames([activeSession]);
  const filtered = filterOutInUseWorktrees(entries, inUse);
  assert.deepEqual(filtered.map((e) => e.path), ["C:/Users/vjpix/Projects/wt-outro-externo"]);
});

test("#7045 — sessão STALE não exclui worktree nenhum (mesmo com footprint)", () => {
  const entries = [{ path: "C:/repo/.claude/worktrees/agent-x", branch: "develop/fix-1", locked: false }];
  const staleSession: SessionRecord = {
    kind: "overnight",
    machineTag: "300",
    sessionId: "sess-morta",
    startedAt: "2026-08-30T00:00:00.000Z",
    lastHeartbeat: "2026-08-30T00:05:00.000Z",
    touched_paths: [".claude/worktrees/agent-x/scripts/foo.ts"],
    stale: true,
  };
  const inUse = selectInUseWorktreeNames([staleSession]);
  assert.equal(inUse.names.size, 0);
  assert.equal(inUse.branches.size, 0);
  assert.deepEqual(filterOutInUseWorktrees(entries, inUse), entries);
});

test("#7045 — extractWorktreeNamesFromPaths aceita '/' e '\\\\' (Windows)", () => {
  assert.deepEqual(
    [...extractWorktreeNamesFromPaths([".claude/worktrees/agent-a/scripts/x.ts", ".claude\\worktrees\\agent-b\\scripts\\y.ts"])].sort(),
    ["agent-a", "agent-b"],
  );
});

test("#7045 — extractWorktreeNamesFromPaths ignora paths fora de worktrees/", () => {
  assert.deepEqual([...extractWorktreeNamesFromPaths(["scripts/lib/foo.ts", ".claude/hooks/bar.mjs"])], []);
});

test("#7048 — extractWorktreeNamesFromPaths casa path sob .claude/worktrees/", () => {
  assert.deepEqual(
    [...extractWorktreeNamesFromPaths([".claude/worktrees/agent-a/scripts/foo.ts"])],
    ["agent-a"],
  );
});

test("#7048 — extractWorktreeNamesFromPaths NÃO casa 'worktrees/' fora de .claude/ (regex não-ancorado do PR #7048)", () => {
  // Antes do fix, /[/\\]worktrees[/\\]([^/\\]+)/ casaria QUALQUER segmento
  // "worktrees/{nome}" em qualquer lugar do repo — não só .claude/worktrees.
  // Um path legítimo como "some/other/worktrees/agent-a/x.ts" (repo
  // secundário, diretório de terceiros, etc.) nunca deveria alimentar o
  // conjunto de exclusão deste script.
  assert.deepEqual(
    [...extractWorktreeNamesFromPaths(["some/other/worktrees/agent-a/x.ts"])],
    [],
  );
});

test("#7045 — worktreeNameFromPath extrai o basename, tolerando barra final e backslash", () => {
  assert.equal(worktreeNameFromPath("C:/repo/.claude/worktrees/agent-a"), "agent-a");
  assert.equal(worktreeNameFromPath("C:/repo/.claude/worktrees/agent-a/"), "agent-a");
  assert.equal(worktreeNameFromPath("C:\\repo\\.claude\\worktrees\\agent-a".replace(/\\/g, "/")), "agent-a");
});

// ── filterOutLockedWorktrees (#7048) ──

test("#7048 — worktree locked com PR mergeada e SEM touched_paths é preservado, mesmo elegível por merge", () => {
  const entries = [
    { path: "C:/repo/.claude/worktrees/agent-locked", branch: "overnight/fix-1", locked: true },
    { path: "C:/repo/.claude/worktrees/agent-free", branch: "overnight/fix-2", locked: false },
  ];
  // Nenhuma sessão registrou touched_paths pra nenhum dos dois — simula um
  // agent recém-despachado, worktree já pinado (locked) antes do 1º
  // heartbeat gravar footprint no session-registry.
  const inUseNames = selectInUseWorktreeNames([]);
  const afterInUse = filterOutInUseWorktrees(entries, inUseNames);
  const candidates = filterOutLockedWorktrees(afterInUse);

  // O locked NUNCA chega a candidates, então nunca é avaliado por
  // selectMergedForRemoval — mesmo com um checker que sempre confirma merge.
  const toRemove = selectMergedForRemoval(candidates, () => true);
  assert.deepEqual(
    toRemove.map((e) => e.path),
    ["C:/repo/.claude/worktrees/agent-free"],
  );
  assert.ok(!toRemove.some((e) => e.path.includes("agent-locked")));
});

test("#7048 — worktree NÃO-locked, PR mergeada, livre e limpo é removido", () => {
  const entries = [{ path: "C:/repo/.claude/worktrees/agent-livre", branch: "overnight/fix-3", locked: false }];
  const inUseNames = selectInUseWorktreeNames([]);
  const candidates = filterOutLockedWorktrees(filterOutInUseWorktrees(entries, inUseNames));
  const toRemove = selectMergedForRemoval(candidates, () => true);
  assert.deepEqual(
    toRemove.map((e) => e.path),
    ["C:/repo/.claude/worktrees/agent-livre"],
  );
});

test("#7048 — filterOutLockedWorktrees remove só os locked, preserva os demais na mesma ordem", () => {
  const entries = [
    { path: "/a", branch: "b1", locked: false },
    { path: "/b", branch: "b2", locked: true },
    { path: "/c", branch: "b3", locked: false },
  ];
  assert.deepEqual(filterOutLockedWorktrees(entries).map((e) => e.path), ["/a", "/c"]);
});

// ── shouldSkipEntireScanForUnreadableRegistry (#7045 checklist item 3) ──

test("shouldSkipEntireScanForUnreadableRegistry — registro ilegível sem --confirm-shared → pula tudo", () => {
  assert.equal(shouldSkipEntireScanForUnreadableRegistry(false, false), true);
});

test("shouldSkipEntireScanForUnreadableRegistry — registro ilegível COM --confirm-shared → prossegue", () => {
  assert.equal(shouldSkipEntireScanForUnreadableRegistry(false, true), false);
});

test("shouldSkipEntireScanForUnreadableRegistry — registro legível (mesmo vazio) NUNCA pula tudo", () => {
  assert.equal(shouldSkipEntireScanForUnreadableRegistry(true, false), false);
  assert.equal(shouldSkipEntireScanForUnreadableRegistry(true, true), false);
});

// ── shouldSkipForSharedSession (#5156 item 9) ──

const fakeSession: SessionRecord = {
  kind: "overnight",
  machineTag: "host-a",
  sessionId: "sess-1",
  startedAt: "2026-08-12T02:00:00.000Z",
  lastHeartbeat: "2026-08-12T02:00:00.000Z",
};

test("shouldSkipForSharedSession — nenhuma sessão ativa registrada → nunca pula (comportamento pré-#5156)", () => {
  assert.equal(shouldSkipForSharedSession([], false), false);
  assert.equal(shouldSkipForSharedSession([], true), false);
});

test("shouldSkipForSharedSession — sessão ativa sem --confirm-shared → pula", () => {
  assert.equal(shouldSkipForSharedSession([fakeSession], false), true);
});

test("shouldSkipForSharedSession — sessão ativa COM --confirm-shared → prossegue", () => {
  assert.equal(shouldSkipForSharedSession([fakeSession], true), false);
});

test("shouldSkipForSharedSession — múltiplas sessões ativas sem confirmação → pula", () => {
  assert.equal(shouldSkipForSharedSession([fakeSession, { ...fakeSession, sessionId: "sess-2" }], false), true);
});

// ── #6706 — só sessão coordenadora NÃO-stale conta ──
//
// Achado ao vivo: `cleanup-merged-worktrees.ts` recusou rodar reportando 15
// sessões "ativas" quando só 2 estavam de fato vivas — o guard contava
// qualquer registro coordenador presente em `data/sessions/` dentro do teto
// absoluto de 24h (`MAX_SESSION_AGE_MS`), sem checar o campo `stale` que
// `listActiveSessions` já computa a partir de `SOFT_STALE_MS` (90min). O
// campo `pid` não serve de substituto (#6294/#6706: nunca resolve a um
// processo real neste harness, mesmo pra sessão genuinamente viva).

test("shouldSkipForSharedSession — sessão coordenadora STALE (heartbeat morto >90min, mas dentro das 24h) NÃO bloqueia mais (#6706)", () => {
  const staleSession: SessionRecord = { ...fakeSession, stale: true };
  assert.equal(
    shouldSkipForSharedSession([staleSession], false),
    false,
    "sessão coordenadora stale não deve mais contar como 'ativa' pro guard de sessão compartilhada",
  );
});

test("shouldSkipForSharedSession — mistura de sessões stale e não-stale: só a não-stale bloqueia (#6706)", () => {
  const staleSession: SessionRecord = { ...fakeSession, sessionId: "sess-morta", stale: true };
  const liveSession: SessionRecord = { ...fakeSession, sessionId: "sess-viva", stale: false };
  assert.equal(
    shouldSkipForSharedSession([staleSession, liveSession], false),
    true,
    "com pelo menos 1 coordenadora genuinamente viva no grupo, o guard continua pulando a varredura",
  );
});

test("shouldSkipForSharedSession — TODAS stale → nunca pula, mesmo em grande quantidade (#6706, regressão do incidente '15 sessões ativas, 2 vivas')", () => {
  const manyStale: SessionRecord[] = Array.from({ length: 15 }, (_, i) => ({
    ...fakeSession,
    sessionId: `sess-morta-${i}`,
    stale: true,
  }));
  assert.equal(
    shouldSkipForSharedSession(manyStale, false),
    false,
    "15 registros coordenadores stale não devem bloquear a varredura — nenhum está genuinamente vivo",
  );
});

// ─── #7304 ────────────────────────────────────────────────────────────────
// Dois defeitos distintos, um teste cada:
//   (a) a sessão que chama o cleanup se conta como "outra sessão ativa" e
//       preserva os próprios worktrees — cada rodada limpa só a anterior;
//   (b) "branch mergeada" não implica "worktree descartável": a remoção é
//       `--force` e nada olhava a working tree.

test("#7304 — cleanup rodado pela PRÓPRIA sessão remove o próprio worktree, e preserva o de outra sessão ativa", () => {
  const entries = [
    { path: "/repo/.claude/worktrees/agent-meu", branch: "overnight/fix-1", locked: false },
    { path: "/repo/.claude/worktrees/agent-do-peer", branch: "overnight/fix-2", locked: false },
  ];

  const propria: SessionRecord = {
    kind: "overnight",
    machineTag: "300",
    sessionId: "sess-propria",
    startedAt: "2026-09-03T00:00:00.000Z",
    lastHeartbeat: "2026-09-03T00:05:00.000Z",
    touched_paths: [".claude/worktrees/agent-meu/scripts/foo.ts"],
  };
  const peer: SessionRecord = {
    kind: "continuo",
    machineTag: "300",
    sessionId: "sess-peer",
    startedAt: "2026-09-03T00:00:00.000Z",
    lastHeartbeat: "2026-09-03T00:05:00.000Z",
    dirty_paths: [".claude/worktrees/agent-do-peer/scripts/bar.ts"],
  };

  // Sem exclusão (comportamento pré-#7304): a própria sessão se protege e os
  // DOIS ficam preservados — é o bug medido na rodada 260902b.
  const semExclusao = selectInUseWorktreeNames([propria, peer]);
  assert.deepEqual(
    filterOutInUseWorktrees(entries, semExclusao).map((e) => e.path),
    [],
    "sem excludeSessionId, a rodada preserva o próprio worktree (o defeito)",
  );

  // Com exclusão: o próprio vira elegível, o do peer continua protegido.
  const comExclusao = selectInUseWorktreeNames([propria, peer], "sess-propria");
  assert.deepEqual(
    filterOutInUseWorktrees(entries, comExclusao).map((e) => e.path),
    ["/repo/.claude/worktrees/agent-meu"],
    "com excludeSessionId, o próprio worktree é removível e o do peer segue protegido",
  );
});

test("#7304 — excludeSessionId ausente preserva o comportamento anterior byte a byte", () => {
  const s: SessionRecord = {
    kind: "develop",
    machineTag: "neo",
    sessionId: "sess-x",
    startedAt: "2026-09-03T00:00:00.000Z",
    lastHeartbeat: "2026-09-03T00:05:00.000Z",
    touched_paths: [".claude/worktrees/agent-x/foo.ts"],
  };
  assert.deepEqual([...selectInUseWorktreeNames([s]).names], [...selectInUseWorktreeNames([s], undefined).names]);
  assert.equal(selectInUseWorktreeNames([s]).names.has("agent-x"), true);
});

test("#7304 — worktree de branch MERGEADA com trabalho não-commitado nunca é removido", () => {
  const entries = [
    { path: "/repo/.claude/worktrees/limpo", branch: "overnight/fix-1", locked: false },
    { path: "/repo/.claude/worktrees/sujo", branch: "overnight/fix-2", locked: false },
  ];
  // Ambos passam pela elegibilidade por histórico: branch mergeada.
  const elegiveis = selectMergedForRemoval(entries, () => true);
  assert.equal(elegiveis.length, 2, "os dois são elegíveis olhando só o histórico");

  const { kept, skipped } = filterOutDirtyWorktrees(elegiveis, (p) => p.endsWith("/sujo"));
  assert.deepEqual(kept.map((e) => e.path), ["/repo/.claude/worktrees/limpo"]);
  assert.deepEqual(skipped.map((e) => e.path), ["/repo/.claude/worktrees/sujo"]);
});

test("#7304 — falha ao inspecionar a working tree conta como SUJO (preserva, nunca apaga)", () => {
  const entries = [{ path: "/repo/.claude/worktrees/indeterminado", branch: "overnight/fix", locked: false }];
  const { kept, skipped } = filterOutDirtyWorktrees(entries, () => null);
  assert.deepEqual(kept, [], "git falhou → não remove");
  assert.deepEqual(skipped.map((e) => e.path), ["/repo/.claude/worktrees/indeterminado"]);
});

test("#7304 — o guard de sujeira também cobre o caminho órfão+stale, não só o de branch mergeada", () => {
  const NOW_7304 = Date.parse("2026-09-03T00:00:00.000Z");
  const entries = [{ path: "/repo/.claude/worktrees/orfao-sujo", branch: null, locked: false }];
  const orfaos = selectOrphanedForStaleRemoval(
    entries,
    [],
    () => false,
    () => NOW_7304 - 8 * 24 * 60 * 60 * 1000,
    NOW_7304,
  );
  assert.equal(orfaos.length, 1, "órfão velho é elegível por staleness");
  const { kept, skipped } = filterOutDirtyWorktrees(orfaos, () => true);
  assert.deepEqual(kept, []);
  assert.deepEqual(skipped.map((e) => e.path), ["/repo/.claude/worktrees/orfao-sujo"]);
});

test("#7317 review — worktree cujo diretório sumiu não fica preso no guard de sujeira", () => {
  // Regressão do finding P3 do review: `null` (git falhou) preserva, mas
  // diretório INEXISTENTE não é ambiguidade — não há trabalho a preservar,
  // e é exatamente o caso que selectOrphanedForStaleRemoval limpa. Tratá-lo
  // como sujo tornaria a entrada impossível de remover pra sempre.
  const inexistente = "/repo/.claude/worktrees/sumiu-do-disco-7317";
  assert.equal(isWorktreeDirtySafe(inexistente), false, "diretório ausente → false (limpo), nunca null");

  const entries = [{ path: inexistente, branch: null, locked: false }];
  const { kept, skipped } = filterOutDirtyWorktrees(entries, isWorktreeDirtySafe);
  assert.deepEqual(kept.map((e) => e.path), [inexistente], "continua removível");
  assert.deepEqual(skipped, []);
});
