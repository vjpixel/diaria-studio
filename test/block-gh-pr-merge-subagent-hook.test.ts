import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isGhPrMergeCommand,
  shouldBlockGhPrMerge,
  readActiveCoordinatorSessionIds,
  sessionsDir,
  machineTag,
  BLOCK_REASON,
} from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";

// #5716: guard MECÂNICO contra subagente implementador mergeando o próprio
// PR — 2ª ocorrência do incidente #4740 (a Regra 11 de
// context/overnight-dispatch-rules.md era só prosa, sem enforcement). Este
// hook nega `gh pr merge` quando a chamada não pertence à sessão
// coordenadora registrada de uma rodada overnight/develop/continuo ativa.

describe("isGhPrMergeCommand (#5716)", () => {
  it("detecta 'gh pr merge' standalone", () => {
    assert.equal(isGhPrMergeCommand("gh pr merge 5713"), true);
  });

  it("detecta com flags (--squash, --auto, --delete-branch)", () => {
    assert.equal(isGhPrMergeCommand("gh pr merge 5713 --squash --delete-branch"), true);
    assert.equal(isGhPrMergeCommand("gh pr merge --auto 5713"), true);
  });

  it("detecta mesmo dentro de comando encadeado", () => {
    assert.equal(isGhPrMergeCommand("cd worktree && gh pr merge 5713 --squash"), true);
    assert.equal(isGhPrMergeCommand("gh pr checks 5713 --watch; gh pr merge 5713"), true);
    assert.equal(isGhPrMergeCommand("gh pr checks 5713 --watch | gh pr merge 5713"), true);
  });

  it("não detecta 'gh pr create'/'gh pr view'/'gh pr list'", () => {
    assert.equal(isGhPrMergeCommand("gh pr create --title x --body y"), false);
    assert.equal(isGhPrMergeCommand("gh pr view 5713 --json mergedBy"), false);
    assert.equal(isGhPrMergeCommand("gh pr list"), false);
  });

  it("não detecta 'merge' fora do contexto 'gh pr' (ex: git merge)", () => {
    assert.equal(isGhPrMergeCommand("git merge origin/master"), false);
  });

  it("não detecta 'gh pr merge' citado dentro de um argumento (#5787 Defeito 3)", () => {
    // O erro antigo: `gh issue create --body "...gh pr merge bloqueado pelo guard..."` era negado.
    assert.equal(
      isGhPrMergeCommand('gh issue create --body "gh pr merge bloqueado pelo guard do overnight"'),
      false,
    );
    assert.equal(
      isGhPrMergeCommand('echo "o comando gh pr merge foi bloqueado"'),
      false,
    );
    assert.equal(
      isGhPrMergeCommand('grep "gh pr merge" .claude/hooks/block-gh-pr-merge-subagent.mjs'),
      false,
    );
  });

  it("não detecta 'gh pr merge' no meio de um --body em linha de comando (#5787)", () => {
    assert.equal(
      isGhPrMergeCommand(
        'gh issue create --title "Teste" --body "Comando: gh pr merge 5713 --squash" --label bug',
      ),
      false,
    );
  });

  it("não lança em input não-string", () => {
    assert.equal(isGhPrMergeCommand(undefined), false);
    assert.equal(isGhPrMergeCommand(null), false);
    assert.equal(isGhPrMergeCommand(42), false);
  });

  it("detecta 'gh pr merge' depois de separador newline puro (#5805)", () => {
    // Regressão: o regex antigo não incluía \n na alternação de separadores
    // (só && ; | ||), então um comando Bash multi-linha cuja 1ª linha não é
    // `gh pr merge` mas contém a chamada numa linha posterior passava direto.
    assert.equal(isGhPrMergeCommand("git fetch\ngh pr merge 123 --squash"), true);
    assert.equal(
      isGhPrMergeCommand("cd worktree\ngit fetch origin\ngh pr merge 5713 --squash --delete-branch"),
      true,
    );
  });

  it("não reabre o Defeito 3 (#5787) em variante multi-linha: 'gh pr merge' citado dentro de aspas com newline literal", () => {
    // Se o fix do #5805 tivesse adicionado \n à alternação de separadores
    // sem tratar quoting, um --body multi-linha com a citação numa linha
    // posterior (mas ainda DENTRO das aspas) voltaria a ser negado por
    // engano — exatamente o falso-positivo que o #5787 Defeito 3 corrigiu.
    assert.equal(
      isGhPrMergeCommand(
        'gh issue create --title "Teste" --body "Comando:\ngh pr merge 5713 --squash\nfoi bloqueado" --label bug',
      ),
      false,
    );
    assert.equal(
      isGhPrMergeCommand(
        "gh pr comment 5805 --body 'linha 1\ngh pr merge citado aqui\nlinha 3'",
      ),
      false,
    );
  });
});

describe("shouldBlockGhPrMerge (#5716)", () => {
  it("nenhuma rodada coordenadora ativa → false (permite — sessão interativa comum, #5251)", () => {
    assert.equal(shouldBlockGhPrMerge(new Set(), "sessao-interativa-1"), false);
  });

  it("rodada ativa + session_id da chamada BATE com o coordenador registrado → false (permite — é o próprio coordenador)", () => {
    const active = new Set(["sessao-coordenador-abc"]);
    assert.equal(shouldBlockGhPrMerge(active, "sessao-coordenador-abc"), false);
  });

  it("rodada ativa + session_id da chamada NÃO bate com nenhum coordenador → true (bloqueia — subagente implementador)", () => {
    const active = new Set(["sessao-coordenador-abc"]);
    assert.equal(shouldBlockGhPrMerge(active, "sessao-subagente-xyz"), true);
  });

  it("múltiplas rodadas ativas (overnight + develop simultâneos) — bate com QUALQUER uma delas → permite", () => {
    const active = new Set(["sessao-overnight-1", "sessao-develop-2"]);
    assert.equal(shouldBlockGhPrMerge(active, "sessao-develop-2"), false);
    assert.equal(shouldBlockGhPrMerge(active, "sessao-overnight-1"), false);
    assert.equal(shouldBlockGhPrMerge(active, "sessao-outra-3"), true);
  });

  it("session_id da chamada ausente → false (fail-open — não dá pra comparar contra nada)", () => {
    const active = new Set(["sessao-coordenador-abc"]);
    assert.equal(shouldBlockGhPrMerge(active, undefined), false);
    assert.equal(shouldBlockGhPrMerge(active, null), false);
    assert.equal(shouldBlockGhPrMerge(active, ""), false);
  });

  it("activeCoordinatorSessionIds ausente/null → false (fail-open)", () => {
    assert.equal(shouldBlockGhPrMerge(null, "sessao-x"), false);
    assert.equal(shouldBlockGhPrMerge(undefined, "sessao-x"), false);
  });
});

describe("readActiveCoordinatorSessionIds (#5716)", () => {
  const roots = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = join(
      tmpdir(),
      `block-gh-pr-merge-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(root);
    return root;
  }

  function writeSession(root, filename, record) {
    const dir = sessionsDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), JSON.stringify(record), "utf8");
  }

  const NOW = Date.parse("2026-08-19T12:00:00.000Z");
  const ONE_HOUR_MS = 60 * 60 * 1000;

  it("diretório data/sessions/ ausente → Set vazio", () => {
    assert.deepEqual(readActiveCoordinatorSessionIds(freshRoot(), NOW), new Set());
  });

  it("sessão kind=overnight fresca → incluída", () => {
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

  it("sessão kind=develop e kind=continuo também contam", () => {
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
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set(["sess2", "sess3"]));
  });

  it("kind desconhecido/irrelevante é ignorado", () => {
    const root = freshRoot();
    writeSession(root, "outro-host-a-sess4.json", {
      kind: "algo-nao-reconhecido",
      sessionId: "sess4",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set());
  });

  it("sessão de OUTRA máquina é ignorada — data/sessions/ é compartilhado via OneDrive (#5787 Defeito 2)", () => {
    const root = freshRoot();
    writeSession(root, "overnight-outra-maquina-sess-outra.json", {
      kind: "overnight",
      sessionId: "sess-outra-maquina",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      lastHeartbeat: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: "outra-maquina-diferente",
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set());
  });

  it("sessão mais velha que MAX_SESSION_AGE_MS (24h) é ignorada — rodada abandonada não trava o guard pra sempre", () => {
    const root = freshRoot();
    writeSession(root, "overnight-helios-sess5.json", {
      kind: "overnight",
      sessionId: "sess5",
      startedAt: new Date(NOW - 25 * ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set());
  });

  it("timestamp no futuro é ignorado (clock skew/corrupção nunca vira sessão ativa)", () => {
    const root = freshRoot();
    writeSession(root, "overnight-helios-sess6.json", {
      kind: "overnight",
      sessionId: "sess6",
      startedAt: new Date(NOW + 10 * ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set());
  });

  it("JSON malformado em uma entrada não derruba a leitura das demais", () => {
    const root = freshRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), "overnight-helios-broken.json"), "{not valid json", "utf8");
    writeSession(root, "overnight-helios-sess7.json", {
      kind: "overnight",
      sessionId: "sess7",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set(["sess7"]));
  });

  it("ignora .merge-lock.json e dotfiles", () => {
    const root = freshRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(
      join(sessionsDir(root), ".merge-lock.json"),
      JSON.stringify({ heldBy: "x", acquiredAt: new Date(NOW).toISOString() }),
      "utf8",
    );
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set());
  });

  it("ignora cópias de conflito do OneDrive (-safeBackup-)", () => {
    const root = freshRoot();
    writeSession(root, "overnight-helios-sess8-safeBackup-0001.json", {
      kind: "overnight",
      sessionId: "sess8",
      startedAt: new Date(NOW - ONE_HOUR_MS).toISOString(),
      machineTag: machineTag(),
    });
    assert.deepEqual(readActiveCoordinatorSessionIds(root, NOW), new Set());
  });
});

describe("BLOCK_REASON (#5716)", () => {
  it("menciona a Regra 11 e como o subagente deve proceder (retornar ao coordenador)", () => {
    assert.match(BLOCK_REASON, /[Rr]egra 11/);
    assert.match(BLOCK_REASON, /coordenador/);
    assert.match(BLOCK_REASON, /self-review/);
  });
});
