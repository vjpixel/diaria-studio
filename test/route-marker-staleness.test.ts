/**
 * test/route-marker-staleness.test.ts (#7270 Parte 2, #7288 Parte B)
 *
 * Cobre `scripts/lib/route-marker-staleness.ts` — as 5 categorias de
 * achado, puro, `RouteMarkerStalenessConsultor` sempre em memória (nunca
 * `gh` real), mesmo padrão de `test/block-staleness.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatExecutionBlockMarker, type ExecutionBlock } from "../scripts/lib/issue-decisions.ts";
import { formatRouteIssueMarker } from "../scripts/lib/issue-route.ts";
import {
  findRouteMarkerStaleness,
  describeConsultorCoverage,
  STALE_EXTERNAL_DAYS,
  AGENDADA_RENEWAL_THRESHOLD,
  UNKNOWN_FRACTION_WARN_THRESHOLD,
  type RouteMarkerStalenessConsultor,
  type RouteMarkerStalenessIssueInput,
  type IssueLookupState,
} from "../scripts/lib/route-marker-staleness.ts";

const NOW = new Date("2026-09-03T12:00:00Z");

function issue(overrides: Partial<RouteMarkerStalenessIssueInput> = {}): RouteMarkerStalenessIssueInput {
  return {
    number: 1,
    labels: [],
    body: "",
    state: "OPEN",
    comments: [],
    ...overrides,
  };
}

function block(overrides: Partial<ExecutionBlock> = {}): ExecutionBlock {
  return {
    recorded_at: "2026-09-01",
    motivo: "motivo qualquer",
    sessao: "overnight",
    condicao: { tipo: "externo", descricao: "condição qualquer" },
    ...overrides,
  };
}

/** Consultor fixo por mapa `{ [issueNumber]: state }` — ausente = UNKNOWN. */
function fakeConsultor(states: Record<number, IssueLookupState> = {}): RouteMarkerStalenessConsultor {
  return {
    getIssueState: (n) => states[n] ?? "UNKNOWN",
  };
}

function agendadaComment(reason?: string): string {
  const marker = formatRouteIssueMarker("agendada");
  return [marker, "", `Roteado para **agendada**${reason ? ` — ${reason}` : "."}`].join("\n");
}

describe("findRouteMarkerStaleness — issue fechada nunca produz achado", () => {
  it("issue CLOSED com label de bloqueio e sem marcador é ignorada", () => {
    const findings = findRouteMarkerStaleness(
      [issue({ number: 1, labels: ["external-blocker"], state: "CLOSED", comments: [] })],
      fakeConsultor(),
      NOW,
    );
    assert.deepEqual(findings, []);
  });
});

describe("findRouteMarkerStaleness — bloqueada-sem-marcador (#7270)", () => {
  it("label de bloqueio sem ExecutionBlock válido é achado", () => {
    const findings = findRouteMarkerStaleness(
      [issue({ number: 42, labels: ["bloqueio-execucao"], comments: ["comentário qualquer, sem marcador"] })],
      fakeConsultor(),
      NOW,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].category, "bloqueada-sem-marcador");
  });

  it("label de bloqueio com ExecutionBlock válido NÃO é achado desta categoria", () => {
    const b = block({ condicao: { tipo: "externo", descricao: "x" }, recorded_at: NOW.toISOString().slice(0, 10) });
    const findings = findRouteMarkerStaleness(
      [issue({ number: 42, labels: ["bloqueio-execucao"], comments: [formatExecutionBlockMarker(b)] })],
      fakeConsultor(),
      NOW,
    );
    assert.deepEqual(findings, []);
  });

  it("issue sem NENHUMA label de bloqueio nunca entra nesta categoria mesmo sem marcador", () => {
    const findings = findRouteMarkerStaleness(
      [issue({ number: 42, labels: ["enhancement"], comments: [] })],
      fakeConsultor(),
      NOW,
    );
    assert.deepEqual(findings, []);
  });
});

describe("findRouteMarkerStaleness — bloqueada-depends-on-fechada (#7270)", () => {
  it("condicao depends_on cuja dependência já fechou é achado", () => {
    const b = block({ condicao: { tipo: "depends_on", issue: 6798 } });
    const findings = findRouteMarkerStaleness(
      [issue({ number: 7124, labels: ["dependencia-aberta"], comments: [formatExecutionBlockMarker(b)] })],
      fakeConsultor({ 6798: "CLOSED" }),
      NOW,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].category, "bloqueada-depends-on-fechada");
  });

  it("condicao depends_on cuja dependência ainda está aberta NÃO é achado", () => {
    const b = block({ condicao: { tipo: "depends_on", issue: 6798 } });
    const findings = findRouteMarkerStaleness(
      [issue({ number: 7124, labels: ["dependencia-aberta"], comments: [formatExecutionBlockMarker(b)] })],
      fakeConsultor({ 6798: "OPEN" }),
      NOW,
    );
    assert.deepEqual(findings, []);
  });

  it("estado UNKNOWN (gh indisponível) nunca produz achado — fail-soft", () => {
    const b = block({ condicao: { tipo: "depends_on", issue: 6798 } });
    const findings = findRouteMarkerStaleness(
      [issue({ number: 7124, labels: ["dependencia-aberta"], comments: [formatExecutionBlockMarker(b)] })],
      fakeConsultor(),
      NOW,
    );
    assert.deepEqual(findings, []);
  });
});

describe("findRouteMarkerStaleness — bloqueada-externa-sem-atualizacao (#7270)", () => {
  it("condicao externo com recorded_at recente NÃO é achado", () => {
    const b = block({
      condicao: { tipo: "externo", descricao: "x" },
      recorded_at: "2026-09-01", // 2 dias antes de NOW
    });
    const findings = findRouteMarkerStaleness(
      [issue({ number: 5, labels: ["external-blocker"], comments: [formatExecutionBlockMarker(b)] })],
      fakeConsultor(),
      NOW,
    );
    assert.deepEqual(findings, []);
  });

  it(`condicao externo com recorded_at >= ${STALE_EXTERNAL_DAYS} dias é achado`, () => {
    const staleDate = new Date(NOW.getTime() - (STALE_EXTERNAL_DAYS + 1) * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const b = block({ condicao: { tipo: "externo", descricao: "conta Beehiiv" }, recorded_at: staleDate });
    const findings = findRouteMarkerStaleness(
      [issue({ number: 5, labels: ["external-blocker"], comments: [formatExecutionBlockMarker(b)] })],
      fakeConsultor(),
      NOW,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].category, "bloqueada-externa-sem-atualizacao");
  });
});

describe("findRouteMarkerStaleness — agendada-motivo-cita-issue-fechada (#7288)", () => {
  it("razão do agendamento cita issue já fechada é achado (caso real #6771)", () => {
    const findings = findRouteMarkerStaleness(
      [
        issue({
          number: 6771,
          labels: [],
          body: "<!-- aguardando-ate: 2026-09-06 -->",
          comments: [agendadaComment("segurar até o #6716 fechar")],
        }),
      ],
      fakeConsultor({ 6716: "CLOSED" }),
      NOW,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].category, "agendada-motivo-cita-issue-fechada");
  });

  it("razão que cita issue ainda aberta NÃO é achado", () => {
    const findings = findRouteMarkerStaleness(
      [
        issue({
          number: 6771,
          body: "<!-- aguardando-ate: 2026-09-06 -->",
          comments: [agendadaComment("segurar até o #6716 fechar")],
        }),
      ],
      fakeConsultor({ 6716: "OPEN" }),
      NOW,
    );
    assert.deepEqual(findings, []);
  });

  it("razão sem citação de issue nenhuma NÃO é achado", () => {
    const findings = findRouteMarkerStaleness(
      [
        issue({
          number: 43,
          body: "<!-- aguardando-ate: 2026-09-06 -->",
          comments: [agendadaComment("aguardando resposta da Beehiiv")],
        }),
      ],
      fakeConsultor(),
      NOW,
    );
    assert.deepEqual(findings, []);
  });

  it("issue sem marcador aguardando-ate: nunca entra nesta checagem", () => {
    const findings = findRouteMarkerStaleness(
      [issue({ number: 43, body: "", comments: [agendadaComment("segurar até o #6716 fechar")] })],
      fakeConsultor({ 6716: "CLOSED" }),
      NOW,
    );
    assert.deepEqual(findings, []);
  });
});

describe("findRouteMarkerStaleness — agendada-renovada-multiplas-vezes (#7288)", () => {
  it(`${AGENDADA_RENEWAL_THRESHOLD}+ comentários route-issue track=agendada é achado (caso real #5998)`, () => {
    const comments = Array.from({ length: AGENDADA_RENEWAL_THRESHOLD }, (_, i) =>
      agendadaComment(`adiando de novo, tentativa ${i + 1}`),
    );
    const findings = findRouteMarkerStaleness(
      [issue({ number: 5998, body: "<!-- aguardando-ate: 2026-09-10 -->", comments })],
      fakeConsultor(),
      NOW,
    );
    assert.ok(findings.some((f) => f.category === "agendada-renovada-multiplas-vezes"));
  });

  it(`menos de ${AGENDADA_RENEWAL_THRESHOLD} comentários NÃO é achado`, () => {
    const comments = Array.from({ length: AGENDADA_RENEWAL_THRESHOLD - 1 }, () => agendadaComment("motivo x"));
    const findings = findRouteMarkerStaleness(
      [issue({ number: 5998, body: "<!-- aguardando-ate: 2026-09-10 -->", comments })],
      fakeConsultor(),
      NOW,
    );
    assert.equal(findings.filter((f) => f.category === "agendada-renovada-multiplas-vezes").length, 0);
  });
});

describe("findRouteMarkerStaleness — ordenação e agregação", () => {
  it("achados vêm ordenados por número de issue crescente", () => {
    const findings = findRouteMarkerStaleness(
      [
        issue({ number: 99, labels: ["bloqueio-execucao"], comments: [] }),
        issue({ number: 5, labels: ["bloqueio-execucao"], comments: [] }),
        issue({ number: 42, labels: ["bloqueio-execucao"], comments: [] }),
      ],
      fakeConsultor(),
      NOW,
    );
    assert.deepEqual(findings.map((f) => f.number), [5, 42, 99]);
  });
});

// ─── describeConsultorCoverage (#7316 review — silent-failure-hunter) ──────

describe("describeConsultorCoverage", () => {
  it("nenhuma UNKNOWN -> null (cobertura completa, nada a dizer)", () => {
    assert.equal(describeConsultorCoverage({ queried: 10, unknown: 0 }), null);
  });

  it("0 issues consultadas -> null (nenhuma categoria dependente do consultor foi avaliada)", () => {
    assert.equal(describeConsultorCoverage({ queried: 0, unknown: 0 }), null);
  });

  it("fração de UNKNOWN abaixo do limiar -> severe: false", () => {
    const result = describeConsultorCoverage({ queried: 100, unknown: 5 }, UNKNOWN_FRACTION_WARN_THRESHOLD);
    assert.ok(result);
    assert.equal(result?.severe, false);
    assert.match(result?.message ?? "", /5\/100/);
  });

  it("fração de UNKNOWN NO limiar (exatamente) -> severe: true (>= , não >)", () => {
    const result = describeConsultorCoverage({ queried: 10, unknown: 1 }, 0.1);
    assert.ok(result);
    assert.equal(result?.severe, true);
  });

  it("fração de UNKNOWN acima do limiar -> severe: true, mensagem diz PARCIAL", () => {
    const result = describeConsultorCoverage({ queried: 10, unknown: 6 }, UNKNOWN_FRACTION_WARN_THRESHOLD);
    assert.ok(result);
    assert.equal(result?.severe, true);
    assert.match(result?.message ?? "", /PARCIAL/);
  });

  it("queried: 0 mas unknown > 0 (caso degenerado, não deveria ocorrer na prática) trata como 100% -> severe: true", () => {
    const result = describeConsultorCoverage({ queried: 0, unknown: 1 });
    assert.ok(result);
    assert.equal(result?.severe, true);
  });
});
