/**
 * test/alarm-issues.test.ts (#5112)
 *
 * Regressão pura + I/O injetado pra `scripts/lib/alarm-issues.ts` — nenhum
 * teste aqui chama `gh` de verdade (mock via `GhRunFn` injetável, mesmo
 * padrão de `test/beehiiv-home-meta-check-script.test.ts`). Cobre a lista
 * de testes pedida pela issue #5112:
 *
 *   - mesmo fingerprint em 2 execuções -> 1 issue só (2ª reusa)
 *   - issue com marcador + estado local apagado -> adota a existente
 *   - achado some 1 execução -> comenta, não fecha
 *   - achado some 2 execuções -> fecha
 *   - falha na criação -> e-mail teria o motivo, cursor não avança
 *   - corpo do e-mail contém a URL da issue (via wiring de
 *     beehiiv-home-meta-check, testado em test/beehiiv-home-meta-check.test.ts)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GhSpawnResult } from "../scripts/studio-ui/gh-run.ts";
import {
  alarmFindingMarker,
  alarmIssueStateKey,
  emptyAlarmIssuesState,
  findExistingAlarmIssue,
  ensureAlarmIssue,
  commentAlarmIssueResolved,
  closeAlarmIssue,
  planAlarmReconciliation,
  applyAlarmReconciliation,
  type AlarmFinding,
  type AlarmIssuesState,
  type GhRunFn,
} from "../scripts/lib/alarm-issues.ts";

const CWD = "/repo";

function ok(stdout: string): GhSpawnResult {
  return { status: 0, stdout, stderr: "" };
}
function fail(stderr: string, status = 1): GhSpawnResult {
  return { status, stdout: "", stderr };
}

const FINDING_A: AlarmFinding = {
  check: "english-labels",
  fingerprint: "english-labels:rótulo(s) em inglês residual(is) encontrado(s): \"N min read\"",
  title: 'Home Beehiiv: rótulo em inglês residual — "N min read"',
  body: "Achado do smoke-test diário.",
  labels: ["bug"],
};

// ─── alarmFindingMarker / alarmIssueStateKey (puro) ────────────────────────

describe("alarmFindingMarker / alarmIssueStateKey (#5112)", () => {
  it("marcador é determinístico pro mesmo check+fingerprint", () => {
    assert.equal(
      alarmFindingMarker("english-labels", "x"),
      "<!-- alarm-finding: english-labels:x -->",
    );
  });

  it("stateKey combina check e fingerprint", () => {
    assert.equal(alarmIssueStateKey("a", "b"), "a:b");
  });
});

// ─── findExistingAlarmIssue (I/O injetado) ─────────────────────────────────

describe("findExistingAlarmIssue (#5112 item 2 — fallback de dedup por marcador)", () => {
  it("acha issue existente cujo body contém o marcador exato", () => {
    const marker = alarmFindingMarker(FINDING_A.check, FINDING_A.fingerprint);
    const run: GhRunFn = () =>
      ok(JSON.stringify([{ number: 5101, url: "https://github.com/x/y/issues/5101", body: `algo\n\n${marker}\n` }]));
    const found = findExistingAlarmIssue(FINDING_A.check, FINDING_A.fingerprint, CWD, run);
    assert.deepEqual(found, { issueNumber: 5101, url: "https://github.com/x/y/issues/5101" });
  });

  it("nenhum match -> null", () => {
    const run: GhRunFn = () => ok(JSON.stringify([{ number: 1, url: "u", body: "sem marcador nenhum" }]));
    assert.equal(findExistingAlarmIssue(FINDING_A.check, FINDING_A.fingerprint, CWD, run), null);
  });

  it("gh falha (status != 0) -> null, nunca lança", () => {
    const run: GhRunFn = () => fail("rate limited");
    assert.equal(findExistingAlarmIssue(FINDING_A.check, FINDING_A.fingerprint, CWD, run), null);
  });

  it("JSON malformado -> null, nunca lança", () => {
    const run: GhRunFn = () => ok("não é json");
    assert.equal(findExistingAlarmIssue(FINDING_A.check, FINDING_A.fingerprint, CWD, run), null);
  });
});

// ─── ensureAlarmIssue ───────────────────────────────────────────────────────

describe("ensureAlarmIssue (#5112)", () => {
  it("sem cache, sem match no gh search -> cria, retorna action created", () => {
    let createCalled = false;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        createCalled = true;
        return ok("https://github.com/x/y/issues/5101\n");
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    };
    const result = ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.equal(createCalled, true);
    assert.deepEqual(result, { issueNumber: 5101, url: "https://github.com/x/y/issues/5101", action: "created" });
  });

  it("com cache local -> reusa SEM chamar gh (fast path)", () => {
    const run: GhRunFn = () => {
      throw new Error("não deveria chamar gh quando há cache");
    };
    const result = ensureAlarmIssue(FINDING_A, { issueNumber: 42, url: "https://x/42" }, CWD, run);
    assert.deepEqual(result, { issueNumber: 42, url: "https://x/42", action: "reused" });
  });

  it("sem cache, MAS marcador encontrado no gh search -> adota a existente, action reused (#5112: 'issue com marcador + estado local apagado')", () => {
    const marker = alarmFindingMarker(FINDING_A.check, FINDING_A.fingerprint);
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return ok(JSON.stringify([{ number: 777, url: "https://github.com/x/y/issues/777", body: marker }]));
      }
      throw new Error("não deveria criar quando já existe");
    };
    const result = ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.deepEqual(result, { issueNumber: 777, url: "https://github.com/x/y/issues/777", action: "reused" });
  });

  it("mesmo fingerprint em 2 chamadas -> 1 issue só (2ª reusa via cache)", () => {
    let createCount = 0;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        createCount++;
        return ok("https://github.com/x/y/issues/5101\n");
      }
      throw new Error("unexpected");
    };
    const first = ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.equal(first.action, "created");
    // 2ª chamada simula a execução seguinte: o caller passa o cache
    // persistido da 1ª chamada.
    const second = ensureAlarmIssue(
      FINDING_A,
      { issueNumber: first.issueNumber!, url: first.url! },
      CWD,
      run,
    );
    assert.equal(second.action, "reused");
    assert.equal(second.issueNumber, first.issueNumber);
    assert.equal(createCount, 1, "gh issue create só deveria ter sido chamado 1 vez");
  });

  it("falha na criação (gh issue create retorna status != 0) -> action failed, NUNCA fabrica issueNumber/url", () => {
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") return fail("gh: could not create issue: label 'alarm' not found");
      throw new Error("unexpected");
    };
    const result = ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.equal(result.action, "failed");
    assert.equal(result.issueNumber, null);
    assert.equal(result.url, null);
    assert.match(result.error ?? "", /label 'alarm' not found/);
  });

  it("labels incluem sempre 'alarm' + a prioridade resolvida (default P2)", () => {
    let labelArg: string | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        const idx = args.indexOf("--label");
        labelArg = args[idx + 1];
        return ok("https://github.com/x/y/issues/1\n");
      }
      throw new Error("unexpected");
    };
    ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.ok(labelArg);
    assert.match(labelArg!, /\balarm\b/);
    assert.match(labelArg!, /\bP2\b/);
    assert.match(labelArg!, /\bbug\b/);
  });

  it("corpo da issue criada carrega o marcador de dedup", () => {
    let bodyArg: string | null = null;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        const idx = args.indexOf("--body");
        bodyArg = args[idx + 1];
        return ok("https://github.com/x/y/issues/1\n");
      }
      throw new Error("unexpected");
    };
    ensureAlarmIssue(FINDING_A, undefined, CWD, run);
    assert.ok(bodyArg!.includes(alarmFindingMarker(FINDING_A.check, FINDING_A.fingerprint)));
  });
});

// ─── commentAlarmIssueResolved / closeAlarmIssue ───────────────────────────

describe("commentAlarmIssueResolved / closeAlarmIssue (#5112 item 3)", () => {
  it("comment: sucesso -> true", () => {
    const run: GhRunFn = () => ok("");
    assert.equal(commentAlarmIssueResolved(42, new Date("2026-08-12T00:00:00Z"), CWD, run), true);
  });

  it("comment: falha -> false, nunca lança", () => {
    const run: GhRunFn = () => fail("boom");
    assert.equal(commentAlarmIssueResolved(42, new Date(), CWD, run), false);
  });

  it("close: sucesso -> true", () => {
    const run: GhRunFn = () => ok("");
    assert.equal(closeAlarmIssue(42, 2, CWD, run), true);
  });

  it("close: falha -> false, nunca lança", () => {
    const run: GhRunFn = () => fail("boom");
    assert.equal(closeAlarmIssue(42, 2, CWD, run), false);
  });
});

// ─── planAlarmReconciliation (puro) ────────────────────────────────────────

describe("planAlarmReconciliation (#5112 item 3 — puro)", () => {
  it("achado pendente novo -> action ensure", () => {
    const actions = planAlarmReconciliation([FINDING_A], emptyAlarmIssuesState(), 2);
    assert.deepEqual(actions, [{ kind: "ensure", finding: FINDING_A }]);
  });

  it("achado que já era pendente continua tendo action ensure (idempotente)", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 0, closedAt: null },
    };
    const actions = planAlarmReconciliation([FINDING_A], state, 2);
    assert.deepEqual(actions, [{ kind: "ensure", finding: FINDING_A }]);
  });

  it("achado sumiu 1x (streak 0->1) -> comment_resolved, não fecha", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 0, closedAt: null },
    };
    const actions = planAlarmReconciliation([], state, 2);
    assert.deepEqual(actions, [{ kind: "comment_resolved", key, issueNumber: 1 }]);
  });

  it("achado sumiu 2x consecutivas (streak 1->2, closeAfterRuns=2) -> close", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 1, closedAt: null },
    };
    const actions = planAlarmReconciliation([], state, 2);
    assert.deepEqual(actions, [{ kind: "close", key, issueNumber: 1 }]);
  });

  it("issue já fechada (closedAt setado) nunca gera ação, mesmo ausente", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 5, closedAt: "2026-08-01T00:00:00Z" },
    };
    assert.deepEqual(planAlarmReconciliation([], state, 2), []);
  });
});

// ─── applyAlarmReconciliation (I/O injetado) ───────────────────────────────

describe("applyAlarmReconciliation (#5112) — cenários fim-a-fim da issue", () => {
  it("achado sumiu 1 execução -> comenta na issue, NÃO fecha (missingStreak vira 1)", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 0, closedAt: null },
    };
    let commentCalled = false;
    let closeCalled = false;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "comment") {
        commentCalled = true;
        return ok("");
      }
      if (args[0] === "issue" && args[1] === "close") {
        closeCalled = true;
        return ok("");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const { nextState } = applyAlarmReconciliation([], state, { cwd: CWD, closeAfterRuns: 2, run });
    assert.equal(commentCalled, true);
    assert.equal(closeCalled, false);
    assert.equal(nextState[key].missingStreak, 1);
    assert.equal(nextState[key].closedAt, null);
  });

  it("achado sumiu 2 execuções consecutivas -> fecha (missingStreak 1 -> 2, closedAt setado)", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "u", missingStreak: 1, closedAt: null },
    };
    let closeCalled = false;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "close") {
        closeCalled = true;
        return ok("");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const now = new Date("2026-08-14T00:00:00Z");
    const { nextState } = applyAlarmReconciliation([], state, { cwd: CWD, closeAfterRuns: 2, run, now });
    assert.equal(closeCalled, true);
    assert.equal(nextState[key].missingStreak, 2);
    assert.equal(nextState[key].closedAt, now.toISOString());
  });

  it("mesmo fingerprint em 2 execuções (via state persistido) -> 1 issue só", () => {
    let createCount = 0;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") {
        createCount++;
        return ok("https://github.com/x/y/issues/9001\n");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const first = applyAlarmReconciliation([FINDING_A], emptyAlarmIssuesState(), {
      cwd: CWD,
      closeAfterRuns: 2,
      run,
    });
    assert.equal(first.findingOutcomes[0].action, "created");

    const second = applyAlarmReconciliation([FINDING_A], first.nextState, { cwd: CWD, closeAfterRuns: 2, run });
    assert.equal(second.findingOutcomes[0].action, "reused");
    assert.equal(second.findingOutcomes[0].issueNumber, 9001);
    assert.equal(createCount, 1);
  });

  it("issue com marcador no GitHub + estado local apagado -> adota a existente (não duplica)", () => {
    const marker = alarmFindingMarker(FINDING_A.check, FINDING_A.fingerprint);
    let createCalled = false;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return ok(JSON.stringify([{ number: 555, url: "https://github.com/x/y/issues/555", body: marker }]));
      }
      if (args[0] === "issue" && args[1] === "create") {
        createCalled = true;
        return ok("https://github.com/x/y/issues/999\n");
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    // estado local vazio simula o state.json apagado
    const { nextState, findingOutcomes } = applyAlarmReconciliation([FINDING_A], emptyAlarmIssuesState(), {
      cwd: CWD,
      closeAfterRuns: 2,
      run,
    });
    assert.equal(createCalled, false, "não deveria ter criado — deveria ter adotado a existente");
    assert.equal(findingOutcomes[0].action, "reused");
    assert.equal(findingOutcomes[0].issueNumber, 555);
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    assert.equal(nextState[key].issueNumber, 555);
  });

  it("falha na criação -> outcome 'failed' com motivo, estado NÃO avança (cursor não marca como tratado)", () => {
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      if (args[0] === "issue" && args[1] === "create") return fail("HTTP 403: rate limited");
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const { nextState, findingOutcomes } = applyAlarmReconciliation([FINDING_A], emptyAlarmIssuesState(), {
      cwd: CWD,
      closeAfterRuns: 2,
      run,
    });
    assert.equal(findingOutcomes[0].action, "failed");
    assert.match(findingOutcomes[0].error ?? "", /rate limited/);
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    assert.equal(nextState[key], undefined, "estado não deveria ganhar entry pra um achado que falhou ao criar");
  });

  it("achado reaparece depois de fechado -> volta a ser tratado como pendente (closedAt reseta pra null)", () => {
    const key = alarmIssueStateKey(FINDING_A.check, FINDING_A.fingerprint);
    const state: AlarmIssuesState = {
      [key]: { issueNumber: 1, url: "https://x/1", missingStreak: 2, closedAt: "2026-08-01T00:00:00Z" },
    };
    // cache tem a entry -> ensureAlarmIssue reusa via fast path, sem tocar gh
    const run: GhRunFn = () => {
      throw new Error("não deveria chamar gh — deveria reusar via cache");
    };
    const { nextState } = applyAlarmReconciliation([FINDING_A], state, { cwd: CWD, closeAfterRuns: 2, run });
    assert.equal(nextState[key].closedAt, null);
    assert.equal(nextState[key].missingStreak, 0);
  });
});
