/**
 * test/aquisicao-reconcile.test.ts (#5734)
 *
 * Cobre as funções PURAS de scripts/aquisicao-reconcile.ts — agregação da
 * coorte real (janela + agrupamento por canal) e cálculo do fator de
 * superestimação. NUNCA rede real: o fetch da Beehiiv fica no subcomando
 * `baseline` e reusa `fetchAllSubscribers` (já testado em
 * test/cohort-engagement.test.ts); aqui só lógica determinística.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateBaseline,
  computeFactor,
  dayToEpochSeconds,
  type BaselineFile,
} from "../scripts/aquisicao-reconcile.ts";
import type { EngagementSubscriber } from "../scripts/cohort-engagement.ts";

function sub(created: number, utm: string | null, referring?: string | null): EngagementSubscriber {
  return { id: `s${created}-${utm}`, created, utm_source: utm, referring_site: referring ?? null, status: "active" };
}

// Janela de teste: 2026-08-24 (from) .. 2026-08-28 (to, inclusivo no discurso)
const FROM = "2026-08-24";
const TO = "2026-08-28";
const FROM_EPOCH = dayToEpochSeconds(FROM, "--from");
const TO_EPOCH = dayToEpochSeconds(TO, "--to");

describe("dayToEpochSeconds", () => {
  it("converte AAAA-MM-DD para epoch UTC 00:00", () => {
    assert.equal(dayToEpochSeconds("2026-08-24", "--from"), Date.UTC(2026, 7, 24) / 1000);
  });
  it("rejeita data que não existe (rolagem de mês/dia, #4556)", () => {
    assert.throws(() => dayToEpochSeconds("2026-13-45", "--from"), /data não existe/);
  });
  it("rejeita formato inválido", () => {
    assert.throws(() => dayToEpochSeconds("24/08/2026", "--from"), /esperado AAAA-MM-DD/);
  });
});

describe("aggregateBaseline", () => {
  it("filtra pela janela [from, to-inclusivo] e agrupa por canal", () => {
    const subs = [
      sub(FROM_EPOCH, "meta"), // borda inferior inclusiva
      sub(FROM_EPOCH + 3600, "meta"),
      sub(TO_EPOCH + 86_399, "google"), // último segundo do dia `to` — conta
      sub(TO_EPOCH + 86_400, "google"), // primeiro segundo DEPOIS da janela — fora
      sub(FROM_EPOCH - 1, "linkedin"), // antes da janela — fora
      sub(TO_EPOCH + 90_000, "google"), // depois — fora
    ];
    const b = aggregateBaseline(subs, FROM, TO);
    assert.equal(b.total, 3);
    assert.deepEqual(b.per_channel, { meta: 2, google: 1 });
    assert.equal(b.window_epoch.to_exclusive, TO_EPOCH + 86_400);
  });

  it("sem timestamp (created null) fica fora da coorte datável", () => {
    const b = aggregateBaseline([sub(NaN as unknown as number, "meta"), { created: null, utm_source: "google" }], FROM, TO);
    assert.equal(b.total, 0);
  });

  it("fallback referring_site via resolveGroupKey quando utm_source ausente", () => {
    const b = aggregateBaseline([sub(FROM_EPOCH + 60, null, "t.co")], FROM, TO);
    assert.deepEqual(b.per_channel, { "t.co": 1 });
  });

  it("per_day agrega por dia UTC", () => {
    const b = aggregateBaseline(
      [sub(FROM_EPOCH, "meta"), sub(FROM_EPOCH + 86_400, "meta"), sub(FROM_EPOCH + 3600, "google")],
      FROM,
      String(TO),
    );
    assert.equal(b.per_day["2026-08-24"], 2);
    assert.equal(b.per_day["2026-08-25"], 1);
  });
});

describe("computeFactor", () => {
  const baseline: BaselineFile = {
    generated_at: "2026-08-28T12:00:00Z",
    window: { from: FROM, to: TO },
    window_epoch: { from: FROM_EPOCH, to_exclusive: TO_EPOCH + 86_400 },
    total: 30,
    per_channel: { meta: 10, google: 20 },
    per_day: { "2026-08-24": 30 },
    method: "test",
  };

  it("fator = reportado / coorte real por canal", () => {
    const r = computeFactor(baseline, {
      channels: { meta: { reported_conversions: 70 }, google: { reported_conversions: 40 } },
    });
    assert.equal(r.rows.length, 2);
    const meta = r.rows.find((x) => x.channel === "meta")!;
    assert.equal(meta.coorte_real, 10);
    assert.equal(meta.fator_superestimacao, 7);
    assert.equal(meta.status, "ok");
  });

  it("coorte 0 -> fator null + status sem-coorte (nunca divisão por zero)", () => {
    const r = computeFactor(baseline, { channels: { linkedin: { reported_conversions: 5 } } });
    const li = r.rows.find((x) => x.channel === "linkedin")!;
    assert.equal(li.fator_superestimacao, null);
    assert.equal(li.status, "sem-coorte");
  });

  it("cohort_key explícito mapeia canal do painel para chave real da coorte", () => {
    const r = computeFactor(baseline, {
      channels: { microsoft: { reported_conversions: 9, cohort_key: "google" } },
    });
    const ms = r.rows.find((x) => x.channel === "microsoft")!;
    assert.equal(ms.cohort_key, "google");
    assert.equal(ms.coorte_real, 20);
    assert.ok(Math.abs((ms.fator_superestimacao ?? 0) - 0.45) < 1e-9);
  });

  it("reported_conversions não-numérico lança erro explícito", () => {
    assert.throws(
      () => computeFactor(baseline, { channels: { meta: { reported_conversions: "muito" as unknown as number } } }),
      /reported_conversions/,
    );
  });

  it("canais da coorte ausentes no painel são listados para auditoria", () => {
    const r = computeFactor(baseline, { channels: { meta: { reported_conversions: 1 } } });
    assert.deepEqual(r.canais_coorte_sem_painel, ["google"]);
  });
});
