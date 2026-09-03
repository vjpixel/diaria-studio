/**
 * test/check-metrics-health-script.test.ts (#7172, fatia 8 — #7180)
 *
 * `scripts/check-metrics-health.ts` — a camada de I/O do alarme (achado do
 * review desta fatia, #7378, pr-test-analyzer: o script não tinha nenhum
 * teste dedicado, diferente da convenção do repo pra scripts `-*.ts` desta
 * classe — ver `test/check-acquisition-health-script.test.ts`). Cobre os
 * helpers puros exportados (`nearestSnapshotOnOrBefore`, o "carry forward"
 * do snapshot semanal da Beehiiv; `addDaysYmd`, a aritmética de janela que
 * alimenta `MIN_DIAS_SERIE`) e o finding builder real
 * (`toMetricsHealthAlarmFinding`, já exercitado fim-a-fim no ciclo de
 * issue de `test/metrics-health.test.ts`).
 *
 * Não cobre `main()` fim-a-fim (exigiria mockar `node:sqlite` + `data/` +
 * `gh` — refactor maior que o escopo desta fatia; documentado como gap
 * conhecido no PR, não gap silencioso).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addDaysYmd, nearestSnapshotOnOrBefore, toMetricsHealthAlarmFinding } from "../scripts/check-metrics-health.ts";
import type { MetricsHealthFinding } from "../scripts/lib/metrics/health.ts";

describe("nearestSnapshotOnOrBefore", () => {
  const dates = ["2026-08-10", "2026-08-17", "2026-08-24"];

  it("dia exatamente igual a um snapshot -> esse snapshot", () => {
    assert.equal(nearestSnapshotOnOrBefore(dates, "2026-08-17"), "2026-08-17");
  });

  it("dia entre dois snapshots -> o mais recente ANTES dele (carry forward)", () => {
    assert.equal(nearestSnapshotOnOrBefore(dates, "2026-08-20"), "2026-08-17");
  });

  it("dia antes do 1º snapshot -> null (nada pra carregar pra frente)", () => {
    assert.equal(nearestSnapshotOnOrBefore(dates, "2026-08-01"), null);
  });

  it("dia depois do último snapshot -> o último (ainda é o mais recente disponível)", () => {
    assert.equal(nearestSnapshotOnOrBefore(dates, "2026-09-01"), "2026-08-24");
  });

  it("lista vazia -> sempre null", () => {
    assert.equal(nearestSnapshotOnOrBefore([], "2026-08-20"), null);
  });

  it("ordem de entrada não importa (varre tudo, não assume lista ordenada)", () => {
    const embaralhado = ["2026-08-24", "2026-08-10", "2026-08-17"];
    assert.equal(nearestSnapshotOnOrBefore(embaralhado, "2026-08-20"), "2026-08-17");
  });
});

describe("addDaysYmd", () => {
  it("delta positivo avança o dia", () => {
    assert.equal(addDaysYmd("2026-08-31", 1), "2026-09-01");
  });

  it("delta negativo retrocede o dia", () => {
    assert.equal(addDaysYmd("2026-09-01", -1), "2026-08-31");
  });

  it("delta 0 é identidade", () => {
    assert.equal(addDaysYmd("2026-09-03", 0), "2026-09-03");
  });

  it("atravessa virada de ANO corretamente", () => {
    assert.equal(addDaysYmd("2025-12-31", 1), "2026-01-01");
  });

  it("respeita ano bissexto (2028) — 29/02 existe", () => {
    assert.equal(addDaysYmd("2028-02-28", 1), "2028-02-29");
  });

  it("janela de MIN_DIAS_SERIE=14 dias termina EXATAMENTE em hoje (achado do review — dead-code indirection removida)", () => {
    // Antes do #7378, `primeiroDia` passava por `enumerarDiasInclusive(hoje,
    // hoje)[0]` (sempre === hoje) antes de chegar aqui — round-trip morto.
    // Este teste trava o cálculo direto: hoje - 13 dias é o início de uma
    // janela de 14 dias inclusiva terminando em hoje.
    const hoje = "2026-09-03";
    const inicio = addDaysYmd(hoje, -13);
    assert.equal(inicio, "2026-08-21");
  });
});

describe("toMetricsHealthAlarmFinding — o finding builder REAL (não uma duplicata de teste)", () => {
  const FINDING: MetricsHealthFinding = {
    sinal: "queda",
    metrica_id: "cadastros-dia",
    motivo: "\"Cadastros por dia\" moveu na direção ruim 80.0%",
  };

  it("fingerprint não inclui números — estável entre execuções com motivo diferente", () => {
    const a = toMetricsHealthAlarmFinding(FINDING);
    const b = toMetricsHealthAlarmFinding({ ...FINDING, motivo: "outro motivo com números 42" });
    assert.equal(a.fingerprint, b.fingerprint);
    assert.equal(a.fingerprint, "queda:cadastros-dia");
  });

  it("family é sempre 'estado' (achado re-checável, nunca evento passado)", () => {
    assert.equal(toMetricsHealthAlarmFinding(FINDING).family, "estado");
  });

  it("título nomeia o sinal em português (via SINAL_LABEL) e a métrica", () => {
    const finding = toMetricsHealthAlarmFinding({ ...FINDING, sinal: "meta-nao-atingida" });
    assert.match(finding.title, /meta não atingida/);
    assert.match(finding.title, /cadastros-dia/);
  });

  it("registry-mudo usa metrica_id 'registry' no título sem quebrar", () => {
    const finding = toMetricsHealthAlarmFinding({
      sinal: "registry-mudo",
      metrica_id: "registry",
      motivo: "0 avaliáveis",
    });
    assert.match(finding.title, /registry mudo/);
    assert.equal(finding.fingerprint, "registry-mudo:registry");
  });

  it("body inclui o motivo verbatim (evidência citável, eixo de veracidade do #6798)", () => {
    const finding = toMetricsHealthAlarmFinding(FINDING);
    assert.ok(finding.body.includes(FINDING.motivo));
  });
});
