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
  foreignClaimedIssues,
  issueFromBranch,
  partitionAlienCandidates,
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

describe("cruzamento com claims do session-registry (#10439)", () => {
  // known_worktrees é foto GLOBAL (#7722): igual em toda sessão, e por isso
  // nunca pode ser evidência de autoria — está aqui só pra provar que é ignorado.
  const globalSnapshot = otherRoundPrs.map((p) => ({ branch: p.headRefName as string }));
  const sessions = [
    { sessionId: "own", claimed_issues_effective: [5815, 10500], known_worktrees: globalSnapshot },
    { sessionId: "0b68d4a7", claimed_issues_effective: [10390, 10500], known_worktrees: globalSnapshot },
    { sessionId: "morta", stale: true, claimed_issues_effective: [10419], known_worktrees: globalSnapshot },
  ];

  it("issue do branch fix-{N} reivindicada por outra sessão viva → alheio; stale e lote não contam", () => {
    const v = checkPrTerminalState(otherRoundPrs, ownPlan, undefined, {
      liveForeignClaimedIssues: foreignClaimedIssues(sessions, "own"),
    });
    assert.deepEqual(
      v.alienConfirmed.map((a) => [a.pr, a.source]),
      [[10396, "session-registry"]],
    );
    assert.deepEqual(v.unregisteredCandidates.map((c) => c.pr), [10421, 10435]);
    assert.equal(v.status, "candidates");
  });

  it("PR esquecido DESTA rodada (caso #5823) continua candidato mesmo com outra sessão viva", () => {
    const v = checkPrTerminalState(
      [{ number: 5823, headRefName: "develop/fix-5815" }],
      [],
      undefined,
      { liveForeignClaimedIssues: foreignClaimedIssues(sessions, "own") },
    );
    assert.deepEqual(v.alienConfirmed, []);
    assert.deepEqual(v.unregisteredCandidates.map((c) => c.pr), [5823]);
  });

  it("issue reivindicada também pela própria sessão não vira alheia", () => {
    assert.equal(foreignClaimedIssues(sessions, "own").has(10500), false);
  });

  it("plano sem session_id → sem cruzamento (não dá pra saber qual é a própria)", () => {
    assert.equal(foreignClaimedIssues(sessions, undefined).size, 0);
  });

  it("issueFromBranch só reconhece fix-{N} das skills", () => {
    assert.equal(issueFromBranch("overnight/fix-10390-a"), 10390);
    assert.equal(issueFromBranch("develop/fix-5815"), 5815);
    assert.equal(issueFromBranch("continuo/fix-12-x"), 12);
    assert.equal(issueFromBranch("overnight/batch-c"), null);
    assert.equal(issueFromBranch("fix/10390"), null);
  });

  it("issueFromBranch reconhece develop/feat-N e develop/blast-N (#10548)", () => {
    assert.equal(issueFromBranch("develop/blast-10437-flags"), 10437);
    assert.equal(issueFromBranch("develop/feat-123-x"), 123);
    assert.equal(issueFromBranch("develop/blast-55"), 55);
    assert.equal(issueFromBranch("develop/blaster-55"), null);
  });

  it("PR develop/blast-N com issue reivindicada por outra sessão vira alheia confirmada (#10548)", () => {
    const { candidates, alienConfirmed } = partitionAlienCandidates(
      [{ kind: "unregistered-branch-candidate", pr: 10532, headRefName: "develop/blast-10437-flags" }],
      { liveForeignClaimedIssues: new Set([10437]) },
    );
    assert.equal(candidates.length, 0);
    assert.equal(alienConfirmed[0]?.source, "session-registry");
  });
});
