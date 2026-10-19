/**
 * #10439 — com duas rodadas overnight concorrentes (#6328), a que termina
 * antes via os PRs em voo da outra como candidatos sem nenhuma forma de
 * reconhecê-los como alheios confirmados; o coordenador gravava
 * `alien_prs_confirmed` no plano à mão e o gate ignorava o campo.
 * Cenário real: rodada 261018b × 261018 (PRs #10396, #10421, #10435).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkPrTerminalState,
  foreignLiveBranches,
  readAlienPrsConfirmed,
  verdictExitCode,
  type OpenPrLike,
  type PlanIssueWithPrLike,
} from "../scripts/lib/pr-terminal-state.ts";

const otherRoundPrs: OpenPrLike[] = [
  { number: 10396, headRefName: "overnight/fix-10390-a" },
  { number: 10421, headRefName: "overnight/fix-10419-b" },
  { number: 10435, headRefName: "overnight/batch-c" },
];
const ownPlan: PlanIssueWithPrLike[] = [{ number: 10430, status: "mergeada", pr: 10431 }];

describe("alien_prs_confirmed no plano (#10439)", () => {
  it("cenário 261018b: PRs listados no plano saem dos candidatos e viram alheios confirmados", () => {
    const planRaw = { session_id: "b", alien_prs_confirmed: [10396, 10421, 10435] };
    const v = checkPrTerminalState(otherRoundPrs, ownPlan, undefined, {
      confirmedPrs: readAlienPrsConfirmed(planRaw),
    });
    assert.equal(v.status, "ok");
    assert.deepEqual(v.unregisteredCandidates, []);
    assert.deepEqual(
      v.alienConfirmed.map((a) => [a.pr, a.source]),
      [
        [10396, "plan-alien_prs_confirmed"],
        [10421, "plan-alien_prs_confirmed"],
        [10435, "plan-alien_prs_confirmed"],
      ],
    );
    assert.equal(verdictExitCode(v), 0);
  });

  it("sem evidência, continuam candidatos (comportamento #10430 intacto)", () => {
    const v = checkPrTerminalState(otherRoundPrs, ownPlan);
    assert.equal(v.status, "candidates");
    assert.equal(v.unregisteredCandidates.length, 3);
    assert.deepEqual(v.alienConfirmed, []);
  });

  it("readAlienPrsConfirmed ignora formas inválidas", () => {
    assert.deepEqual([...readAlienPrsConfirmed({ alien_prs_confirmed: [1, "2", -3, 4.5, null, 7] })], [1, 7]);
    assert.equal(readAlienPrsConfirmed({ alien_prs_confirmed: "10396" }).size, 0);
    assert.equal(readAlienPrsConfirmed(null).size, 0);
  });

  it("alien_prs_confirmed não esconde divergência registrada (cenário 1 continua exit 1)", () => {
    const v = checkPrTerminalState(
      [{ number: 500, headRefName: "overnight/fix-1" }],
      [{ number: 1, status: "pendente", pr: 500 }],
      undefined,
      { confirmedPrs: new Set([500]) },
    );
    assert.equal(v.status, "divergent");
    assert.equal(verdictExitCode(v), 1);
  });
});

describe("cruzamento com session-registry (#10439)", () => {
  const sessions = [
    { sessionId: "own", known_worktrees: [{ branch: "overnight/fix-esquecida" }] },
    { sessionId: "0b68d4a7", known_worktrees: [{ branch: "overnight/fix-10390-a" }, { branch: "overnight/batch-c" }] },
    { sessionId: "morta", stale: true, known_worktrees: [{ branch: "overnight/fix-10419-b" }] },
  ];

  it("branch em known_worktrees de outra sessão viva → alheio confirmado; stale não conta", () => {
    const v = checkPrTerminalState(otherRoundPrs, ownPlan, undefined, {
      liveForeignBranches: foreignLiveBranches(sessions, "own"),
    });
    assert.deepEqual(
      v.alienConfirmed.map((a) => [a.pr, a.source]),
      [
        [10396, "session-registry"],
        [10435, "session-registry"],
      ],
    );
    assert.deepEqual(v.unregisteredCandidates.map((c) => c.pr), [10421]);
    assert.equal(v.status, "candidates");
  });

  it("branch da PRÓPRIA sessão nunca vira alheio (caso #5823 continua candidato)", () => {
    const branches = foreignLiveBranches(sessions, "own");
    assert.equal(branches.has("overnight/fix-esquecida"), false);
  });

  it("plano sem session_id → sem cruzamento (não dá pra saber qual é a própria)", () => {
    assert.equal(foreignLiveBranches(sessions, undefined).size, 0);
  });
});
