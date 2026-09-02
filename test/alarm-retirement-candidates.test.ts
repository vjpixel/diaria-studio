/**
 * test/alarm-retirement-candidates.test.ts (#6798, ampliado no #7049)
 *
 * Cobre a lógica PURA de `scripts/lib/alarm-retirement-candidates.ts`:
 * extração do `check` do marcador de dedup, o parse de `stateReason` na
 * fronteira (`parseGithubStateReason`), o critério "sem ação"
 * (`stateReason === "NOT_PLANNED"`), o limiar N e a limitação assumida
 * (DUPLICATE fica de fora, COMPLETED nunca conta). Fixtures inline —
 * nunca rede, nunca `data/` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractAlarmCheck,
  findAlarmRetirementCandidates,
  parseGithubStateReason,
  ALARM_RETIREMENT_THRESHOLD,
  type ClosedAlarmIssueRecord,
  type AlarmIssueStateReason,
} from "../scripts/lib/alarm-retirement-candidates.ts";
import { alarmFindingMarker } from "../scripts/lib/alarm-issues.ts";

function makeIssue(
  overrides: Partial<ClosedAlarmIssueRecord> & { check?: string; fingerprint?: string },
): ClosedAlarmIssueRecord {
  const check = overrides.check ?? "some-check";
  const fingerprint = overrides.fingerprint ?? "fp-1";
  const marker = alarmFindingMarker(check, fingerprint);
  return {
    number: overrides.number ?? 1,
    title: overrides.title ?? `achado de ${check}`,
    body: overrides.body ?? `corpo qualquer\n\n${marker}\n`,
    stateReason: overrides.stateReason ?? "NOT_PLANNED",
    closedAt: overrides.closedAt ?? "2026-08-01T00:00:00Z",
  };
}

describe("ALARM_RETIREMENT_THRESHOLD", () => {
  it("é 3 (decisão do editor, 01/09/2026, #6798)", () => {
    assert.equal(ALARM_RETIREMENT_THRESHOLD, 3);
  });
});

describe("extractAlarmCheck", () => {
  it("extrai o check do marcador de dedup padrão", () => {
    const body = `algo\n\n${alarmFindingMarker("session-registry-safebackup", "onedrive-conflict-x")}\n`;
    assert.equal(extractAlarmCheck(body), "session-registry-safebackup");
  });

  it("retorna null quando o corpo não carrega o marcador (issue pré-#5112 ou editada à mão)", () => {
    assert.equal(extractAlarmCheck("corpo qualquer, sem marcador nenhum"), null);
  });

  it("lida com check contendo hífen, sem confundir com o separador do fingerprint", () => {
    const body = alarmFindingMarker("clarice-opens-catchup-alarm", "streak-failing");
    assert.equal(extractAlarmCheck(body), "clarice-opens-catchup-alarm");
  });
});

describe("findAlarmRetirementCandidates — critério e agrupamento", () => {
  it("nenhum candidato quando nada atinge o limiar", () => {
    const issues = [
      makeIssue({ number: 1, check: "cursos-error-alarm", fingerprint: "a" }),
      makeIssue({ number: 2, check: "cursos-error-alarm", fingerprint: "b" }),
    ];
    assert.deepEqual(findAlarmRetirementCandidates(issues), []);
  });

  it("vira candidato exatamente ao atingir o limiar (>= threshold, não >)", () => {
    const issues = [
      makeIssue({ number: 1, check: "cursos-error-alarm", fingerprint: "a" }),
      makeIssue({ number: 2, check: "cursos-error-alarm", fingerprint: "b" }),
      makeIssue({ number: 3, check: "cursos-error-alarm", fingerprint: "c" }),
    ];
    const candidates = findAlarmRetirementCandidates(issues);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].check, "cursos-error-alarm");
    assert.equal(candidates[0].noActionCount, 3);
  });

  it("issues fechadas como COMPLETED (correção real via PR) nunca contam como sem ação", () => {
    const issues = [
      makeIssue({ number: 1, check: "x", fingerprint: "a", stateReason: "COMPLETED" }),
      makeIssue({ number: 2, check: "x", fingerprint: "b", stateReason: "COMPLETED" }),
      makeIssue({ number: 3, check: "x", fingerprint: "c", stateReason: "COMPLETED" }),
    ];
    assert.deepEqual(findAlarmRetirementCandidates(issues), []);
  });

  it("issues DUPLICATE ficam de fora da contagem (nem ação, nem sem ação — dedup falho, problema diferente)", () => {
    const issues = [
      makeIssue({ number: 1, check: "x", fingerprint: "a", stateReason: "NOT_PLANNED" }),
      makeIssue({ number: 2, check: "x", fingerprint: "b", stateReason: "NOT_PLANNED" }),
      makeIssue({ number: 3, check: "x", fingerprint: "c", stateReason: "DUPLICATE" }),
    ];
    // só 2 NOT_PLANNED — abaixo do limiar de 3, mesmo com 3 issues no total.
    assert.deepEqual(findAlarmRetirementCandidates(issues), []);
  });

  it("stateReason UNKNOWN (issue reaberta/refechada sem reason, ou valor não-reconhecido) nunca conta como sem ação", () => {
    const issues = [
      makeIssue({ number: 1, check: "x", fingerprint: "a", stateReason: "UNKNOWN" }),
      makeIssue({ number: 2, check: "x", fingerprint: "b", stateReason: "UNKNOWN" }),
      makeIssue({ number: 3, check: "x", fingerprint: "c", stateReason: "UNKNOWN" }),
    ];
    assert.deepEqual(findAlarmRetirementCandidates(issues), []);
  });

  it("issue sem marcador identificável (extractAlarmCheck null) é pulada, nunca vira grupo 'desconhecido'", () => {
    const issues = [
      makeIssue({ number: 1, check: "x", fingerprint: "a" }),
      makeIssue({ number: 2, check: "x", fingerprint: "b" }),
      { number: 3, title: "sem marcador", body: "corpo qualquer sem marcador", stateReason: "NOT_PLANNED" as const, closedAt: null },
    ];
    // só 2 do check "x" com marcador — abaixo do limiar.
    assert.deepEqual(findAlarmRetirementCandidates(issues), []);
  });

  it("agrupa por check corretamente quando múltiplos checks coexistem", () => {
    const issues = [
      makeIssue({ number: 1, check: "a", fingerprint: "1" }),
      makeIssue({ number: 2, check: "a", fingerprint: "2" }),
      makeIssue({ number: 3, check: "a", fingerprint: "3" }),
      makeIssue({ number: 4, check: "b", fingerprint: "1" }),
      makeIssue({ number: 5, check: "b", fingerprint: "2" }),
    ];
    const candidates = findAlarmRetirementCandidates(issues);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].check, "a");
  });

  it("ordena candidatos por noActionCount decrescente, empate por nome do check", () => {
    const issues = [
      ...["1", "2", "3"].map((fp) => makeIssue({ number: Number(fp), check: "b-check", fingerprint: fp })),
      ...["1", "2", "3", "4"].map((fp) => makeIssue({ number: 10 + Number(fp), check: "a-check", fingerprint: fp })),
    ];
    const candidates = findAlarmRetirementCandidates(issues);
    assert.deepEqual(
      candidates.map((c) => c.check),
      ["a-check", "b-check"],
    );
  });

  it("evidence vem ordenada por closedAt crescente (mais antiga primeiro)", () => {
    const issues = [
      makeIssue({ number: 3, check: "x", fingerprint: "c", closedAt: "2026-08-03T00:00:00Z" }),
      makeIssue({ number: 1, check: "x", fingerprint: "a", closedAt: "2026-08-01T00:00:00Z" }),
      makeIssue({ number: 2, check: "x", fingerprint: "b", closedAt: "2026-08-02T00:00:00Z" }),
    ];
    const candidates = findAlarmRetirementCandidates(issues);
    assert.deepEqual(
      candidates[0].evidence.map((e) => e.issueNumber),
      [1, 2, 3],
    );
  });

  it("respeita threshold customizado (override explícito)", () => {
    const issues = [
      makeIssue({ number: 1, check: "x", fingerprint: "a" }),
      makeIssue({ number: 2, check: "x", fingerprint: "b" }),
    ];
    assert.equal(findAlarmRetirementCandidates(issues, 2).length, 1);
    assert.equal(findAlarmRetirementCandidates(issues, 3).length, 0);
  });

  it("lista vazia de issues nunca produz candidato", () => {
    assert.deepEqual(findAlarmRetirementCandidates([]), []);
  });
});

describe("parseGithubStateReason (#7049, finding P2 — união fechada + parse na fronteira)", () => {
  it("normaliza os 3 valores reais da REST (minúsculas, snake_case) pra maiúsculas", () => {
    const cases: Array<[string, AlarmIssueStateReason]> = [
      ["not_planned", "NOT_PLANNED"],
      ["completed", "COMPLETED"],
      ["duplicate", "DUPLICATE"],
    ];
    for (const [raw, expected] of cases) {
      assert.equal(parseGithubStateReason(raw), expected);
    }
  });

  it("já aceita a convenção GraphQL (maiúsculas) sem quebrar", () => {
    assert.equal(parseGithubStateReason("NOT_PLANNED"), "NOT_PLANNED");
  });

  it("tolera espaço em volta (defensivo, trim antes de comparar)", () => {
    assert.equal(parseGithubStateReason(" not_planned "), "NOT_PLANNED");
  });

  it("null vira UNKNOWN, nunca um dos 3 valores conhecidos por engano", () => {
    assert.equal(parseGithubStateReason(null), "UNKNOWN");
  });

  it("undefined vira UNKNOWN", () => {
    assert.equal(parseGithubStateReason(undefined), "UNKNOWN");
  });

  it("string vazia vira UNKNOWN", () => {
    assert.equal(parseGithubStateReason(""), "UNKNOWN");
  });

  it("valor não-reconhecido (typo, novo state_reason do GitHub) vira UNKNOWN — nunca silêncio", () => {
    assert.equal(parseGithubStateReason("not_a_real_reason"), "UNKNOWN");
  });
});
