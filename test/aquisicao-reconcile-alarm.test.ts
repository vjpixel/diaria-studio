/**
 * test/aquisicao-reconcile-alarm.test.ts (#8591 item 3)
 *
 * Cobre `evaluateReconcileDrift`/`flattenFactorResultsByDay`
 * (scripts/lib/aquisicao-reconcile-alarm.ts) — a decisão pura de quando o
 * fator de superestimação por canal sai da faixa aceitável, agregado numa
 * janela de N dias, respeitando o piso de volume da coorte real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReconcileDrift,
  flattenFactorResultsByDay,
  RECONCILE_DRIFT_HIGH_FACTOR,
  RECONCILE_DRIFT_LOW_FACTOR,
  RECONCILE_MIN_VOLUME_REAL,
  type DatedFactorRow,
} from "../scripts/lib/aquisicao-reconcile-alarm.ts";
import { buildDriftAlarmFinding } from "../scripts/aquisicao-reconcile-daily.ts";
import type { FactorResult } from "../scripts/aquisicao-reconcile.ts";

function row(day: string, channel: string, reported: number, real: number): DatedFactorRow {
  return {
    day,
    channel,
    cohort_key: channel,
    reported_conversions: reported,
    coorte_real: real,
    fator_superestimacao: real > 0 ? reported / real : null,
    status: real > 0 ? "ok" : "sem-coorte",
  };
}

describe("evaluateReconcileDrift", () => {
  it("agrega por canal somando reported/real da janela, não a média dos fatores diários", () => {
    const rows = [
      row("2026-09-01", "meta-ads", 10, 10), // 1.0x
      row("2026-09-02", "meta-ads", 30, 10), // 3.0x isolado, mas a soma decide
    ];
    // soma: reported=40, real=20 -> fator agregado = 2.0 (não a média (1+3)/2=2 coincide aqui,
    // mas o teste abaixo desambigua os dois métodos)
    const [meta] = evaluateReconcileDrift(rows);
    assert.equal(meta.reported_sum, 40);
    assert.equal(meta.real_sum, 20);
    assert.equal(meta.factor, 2);
    assert.equal(meta.status, "alto");
  });

  it("soma (não média) — um dia de volume alto domina um dia de volume baixo", () => {
    const rows = [
      row("2026-09-01", "google-ads", 100, 2), // 50x num dia de volume ínfimo
      row("2026-09-02", "google-ads", 50, 98), // ~0.51x num dia de volume alto
    ];
    // média simples dos fatores seria (50 + 0.51)/2 ~ 25.25 (dispararia "alto" com folga)
    // soma correta: reported=150, real=100 -> fator = 1.5 (limite exato, não > 1.5)
    const [google] = evaluateReconcileDrift(rows);
    assert.equal(google.reported_sum, 150);
    assert.equal(google.real_sum, 100);
    assert.equal(google.factor, 1.5);
    assert.equal(google.status, "ok"); // 1.5 não é > 1.5 (limiar estrito)
  });

  it("fator acima de 1.5x com volume suficiente dispara 'alto'", () => {
    const rows = [row("2026-09-01", "meta-ads", 40, 20)]; // 2.0x, real=20 (== piso, passa)
    const [meta] = evaluateReconcileDrift(rows);
    assert.equal(meta.status, "alto");
  });

  it("fator abaixo de ~0.667x com volume suficiente dispara 'baixo'", () => {
    const rows = [row("2026-09-01", "meta-ads", 10, 30)]; // 0.333x, real=30 > piso
    const [meta] = evaluateReconcileDrift(rows);
    assert.equal(meta.status, "baixo");
  });

  it("fator dentro da faixa (0.667x-1.5x) com volume suficiente é 'ok'", () => {
    const rows = [row("2026-09-01", "meta-ads", 25, 25)]; // 1.0x
    const [meta] = evaluateReconcileDrift(rows);
    assert.equal(meta.status, "ok");
  });

  it("coorte real abaixo do piso de volume nunca dispara alarme, mesmo com fator extremo", () => {
    const rows = [row("2026-09-01", "microsoft-ads", 100, 1)]; // 100x, mas real=1 << piso
    const [ms] = evaluateReconcileDrift(rows);
    assert.equal(ms.status, "volume-insuficiente");
    assert.ok(RECONCILE_MIN_VOLUME_REAL > 1);
  });

  it("coorte real zero nunca produz fator fabricado — null, nunca 0 ou Infinity", () => {
    const rows = [row("2026-09-01", "meta-ads", 5, 0)];
    const [meta] = evaluateReconcileDrift(rows);
    assert.equal(meta.factor, null);
    assert.equal(meta.status, "volume-insuficiente");
  });

  it("canais distintos são avaliados independentemente e ordenados por nome", () => {
    const rows = [
      row("2026-09-01", "meta-ads", 40, 20), // alto
      row("2026-09-01", "google-ads", 25, 25), // ok
    ];
    const out = evaluateReconcileDrift(rows);
    assert.deepEqual(
      out.map((o) => o.channel),
      ["google-ads", "meta-ads"],
    );
    assert.equal(out[0].status, "ok");
    assert.equal(out[1].status, "alto");
  });

  it("thresholds são simétricos em log (high = 1/low)", () => {
    assert.ok(Math.abs(RECONCILE_DRIFT_LOW_FACTOR * RECONCILE_DRIFT_HIGH_FACTOR - 1) < 1e-9);
  });
});

describe("flattenFactorResultsByDay", () => {
  it("achata FactorResult por dia em DatedFactorRow[], preservando o dia de cada linha", () => {
    const byDay = new Map<string, FactorResult>([
      [
        "2026-09-01",
        {
          rows: [
            { channel: "meta-ads", cohort_key: "meta-ads", reported_conversions: 10, coorte_real: 10, fator_superestimacao: 1, status: "ok" },
          ],
          canais_coorte_sem_painel: [],
        },
      ],
      [
        "2026-09-02",
        {
          rows: [
            { channel: "meta-ads", cohort_key: "meta-ads", reported_conversions: 20, coorte_real: 10, fator_superestimacao: 2, status: "ok" },
          ],
          canais_coorte_sem_painel: [],
        },
      ],
    ]);
    const flat = flattenFactorResultsByDay(byDay);
    assert.equal(flat.length, 2);
    assert.deepEqual(
      flat.map((r) => r.day).sort(),
      ["2026-09-01", "2026-09-02"],
    );
  });
});

describe("buildDriftAlarmFinding", () => {
  it("gera um AlarmFinding com fingerprint estável por canal e family 'estado' (auto-resolve)", () => {
    const [ev] = evaluateReconcileDrift([row("2026-09-01", "meta-ads", 40, 20)]);
    const finding = buildDriftAlarmFinding(ev, "2026-09-01");
    assert.equal(finding.check, "aquisicao-reconcile-drift");
    assert.equal(finding.fingerprint, "aquisicao-reconcile-drift:meta-ads");
    assert.equal(finding.family, "estado");
    assert.equal(finding.priority, "P2");
    assert.match(finding.body, /2\.00×/);
  });
});
