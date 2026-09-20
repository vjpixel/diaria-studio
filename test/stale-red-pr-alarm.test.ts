/**
 * test/stale-red-pr-alarm.test.ts (#8530)
 *
 * Regressão pura pra `scripts/lib/stale-red-pr-alarm.ts` — os 4 cenários
 * pedidos explicitamente pela issue:
 *   1. PR vermelha + sem commit há mais de N horas -> dispara (achado).
 *   2. PR vermelha recente (< N horas) -> não dispara.
 *   3. PR draft -> não dispara, mesmo vermelha e parada.
 *   4. PR verde -> não dispara.
 *
 * Mais os casos de borda que a própria issue cita: verdict `"pending"`
 * (CI ainda rodando) e `"blocked_by_conflict"` nunca contam como
 * "vermelho confirmado" — só `"fail"` do gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrCheckNode } from "../scripts/lib/pr-checks-gate.ts";
import {
  evaluateStaleRedPrs,
  selectStaleRedPrCandidates,
  shouldAlarmStaleRedPrs,
  staleRedPrFindingSetKey,
  buildStaleRedPrAlarmEmail,
  latestCommitDate,
  type StaleRedPrListEntry,
} from "../scripts/lib/stale-red-pr-alarm.ts";

const NOW = new Date("2026-09-20T18:00:00Z");
const THRESHOLD_HOURS = 3;

function check(name: string, status: string, conclusion: string | null): PrCheckNode {
  return { name, status, conclusion };
}

function pr(overrides: Partial<StaleRedPrListEntry> = {}): StaleRedPrListEntry {
  return {
    number: 8510,
    title: "fix(#8507): dedup",
    isDraft: false,
    mergeable: "MERGEABLE",
    statusCheckRollup: [check("test", "COMPLETED", "FAILURE")],
    commits: [{ committedDate: "2026-09-20T05:07:00Z" }],
    ...overrides,
  };
}

describe("evaluateStaleRedPrs (#8530) — os 4 cenários da issue", () => {
  it("1. CI vermelho + sem commit há mais de N horas -> dispara", () => {
    // último commit 05:07, avaliação 18:00 -> quase 13h, muito acima do limiar de 3h.
    const findings = evaluateStaleRedPrs([pr()], NOW, THRESHOLD_HOURS);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].number, 8510);
    assert.deepEqual(findings[0].failingChecks, ["test"]);
    assert.ok(findings[0].hoursSinceLastCommit > 12);
  });

  it("2. CI vermelho mas commit recente (< N horas) -> não dispara", () => {
    const recent = pr({ commits: [{ committedDate: "2026-09-20T17:00:00Z" }] }); // 1h atrás
    const findings = evaluateStaleRedPrs([recent], NOW, THRESHOLD_HOURS);
    assert.equal(findings.length, 0);
  });

  it("3. PR draft -> nunca dispara, mesmo vermelha e parada há muito tempo", () => {
    const draft = pr({ isDraft: true });
    const findings = evaluateStaleRedPrs([draft], NOW, THRESHOLD_HOURS);
    assert.equal(findings.length, 0);
  });

  it("4. CI verde -> não dispara", () => {
    const green = pr({ statusCheckRollup: [check("test", "COMPLETED", "SUCCESS")] });
    const findings = evaluateStaleRedPrs([green], NOW, THRESHOLD_HOURS);
    assert.equal(findings.length, 0);
  });

  it("CI ainda pendente (não COMPLETED) -> não dispara, mesmo parado há muito tempo", () => {
    const pending = pr({ statusCheckRollup: [check("test", "IN_PROGRESS", null)] });
    const findings = evaluateStaleRedPrs([pending], NOW, THRESHOLD_HOURS);
    assert.equal(findings.length, 0);
  });

  it("bloqueado por conflito (statusCheckRollup vazio + CONFLICTING) -> não conta como vermelho confirmado", () => {
    const blocked = pr({ statusCheckRollup: [], mergeable: "CONFLICTING" });
    const findings = evaluateStaleRedPrs([blocked], NOW, THRESHOLD_HOURS);
    assert.equal(findings.length, 0);
  });

  it("statusCheckRollup malformado (verdict 'error') -> não dispara, nunca lido como vermelho", () => {
    const malformed = pr({ statusCheckRollup: null });
    const findings = evaluateStaleRedPrs([malformed], NOW, THRESHOLD_HOURS);
    assert.equal(findings.length, 0);
  });

  it("commits sem committedDate válido -> não dispara (nunca inventa 0h)", () => {
    const noDate = pr({ commits: [{ committedDate: null }, { authoredDate: "2026-09-20T05:00:00Z" }] });
    const findings = evaluateStaleRedPrs([noDate], NOW, THRESHOLD_HOURS);
    assert.equal(findings.length, 0);
  });

  it("commits vazio -> não dispara", () => {
    const noCommits = pr({ commits: [] });
    const findings = evaluateStaleRedPrs([noCommits], NOW, THRESHOLD_HOURS);
    assert.equal(findings.length, 0);
  });

  it("múltiplas PRs paradas -> ordena por horas paradas (mais antigo primeiro)", () => {
    const older = pr({ number: 1, commits: [{ committedDate: "2026-09-20T01:00:00Z" }] });
    const newer = pr({ number: 2, commits: [{ committedDate: "2026-09-20T10:00:00Z" }] });
    const findings = evaluateStaleRedPrs([newer, older], NOW, THRESHOLD_HOURS);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].number, 1);
    assert.equal(findings[1].number, 2);
  });
});

describe("selectStaleRedPrCandidates (#8530) — só pede 'commits' pra quem precisa", () => {
  it("seleciona só PRs vermelhas e não-draft (mesmo filtro de draft/gate de evaluateStaleRedPrs)", () => {
    const red = pr({ number: 1 });
    const green = pr({ number: 2, statusCheckRollup: [check("test", "COMPLETED", "SUCCESS")] });
    const draftRed = pr({ number: 3, isDraft: true });
    const pending = pr({ number: 4, statusCheckRollup: [check("test", "IN_PROGRESS", null)] });
    const { commits: _c1, ...redBasic } = red;
    const { commits: _c2, ...greenBasic } = green;
    const { commits: _c3, ...draftBasic } = draftRed;
    const { commits: _c4, ...pendingBasic } = pending;
    const candidates = selectStaleRedPrCandidates([redBasic, greenBasic, draftBasic, pendingBasic]);
    assert.deepEqual(
      candidates.map((c) => c.number),
      [1],
    );
  });

  it("lista vazia -> nenhum candidato", () => {
    assert.deepEqual(selectStaleRedPrCandidates([]), []);
  });
});

describe("latestCommitDate", () => {
  it("escolhe o committedDate mais recente entre vários commits", () => {
    const d = latestCommitDate([
      { committedDate: "2026-09-18T00:00:00Z" },
      { committedDate: "2026-09-20T05:07:00Z" },
      { committedDate: "2026-09-19T00:00:00Z" },
    ]);
    assert.equal(d, "2026-09-20T05:07:00Z");
  });

  it("ignora entradas sem committedDate válido", () => {
    const d = latestCommitDate([{ committedDate: null }, { committedDate: "not-a-date" }]);
    assert.equal(d, null);
  });

  it("lista vazia -> null", () => {
    assert.equal(latestCommitDate([]), null);
  });
});

describe("shouldAlarmStaleRedPrs / staleRedPrFindingSetKey / buildStaleRedPrAlarmEmail", () => {
  it("shouldAlarmStaleRedPrs: false para lista vazia, true com >=1 achado", () => {
    assert.equal(shouldAlarmStaleRedPrs([]), false);
    const findings = evaluateStaleRedPrs([pr()], NOW, THRESHOLD_HOURS);
    assert.equal(shouldAlarmStaleRedPrs(findings), true);
  });

  it("staleRedPrFindingSetKey muda quando o conjunto de PRs paradas muda (mesmo padrão do on-hold-vencimento-alarm)", () => {
    const findingsA = evaluateStaleRedPrs([pr({ number: 1 })], NOW, THRESHOLD_HOURS);
    const findingsB = evaluateStaleRedPrs([pr({ number: 1 }), pr({ number: 2 })], NOW, THRESHOLD_HOURS);
    assert.notEqual(staleRedPrFindingSetKey(findingsA), staleRedPrFindingSetKey(findingsB));
  });

  it("staleRedPrFindingSetKey é estável pro MESMO conjunto (independente da ordem de entrada)", () => {
    const a = evaluateStaleRedPrs([pr({ number: 1 }), pr({ number: 2 })], NOW, THRESHOLD_HOURS);
    const b = evaluateStaleRedPrs([pr({ number: 2 }), pr({ number: 1 })], NOW, THRESHOLD_HOURS);
    assert.equal(staleRedPrFindingSetKey(a), staleRedPrFindingSetKey(b));
  });

  it("buildStaleRedPrAlarmEmail cita o número da PR e as horas paradas no corpo", () => {
    const findings = evaluateStaleRedPrs([pr()], NOW, THRESHOLD_HOURS);
    const { subject, body } = buildStaleRedPrAlarmEmail(findings, THRESHOLD_HOURS, NOW);
    assert.match(subject, /1 PR\(s\)/);
    assert.match(body, /#8510/);
    assert.match(body, /test/);
  });
});
