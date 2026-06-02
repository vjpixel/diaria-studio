/**
 * test/analyze-vote-timing.test.ts (#1657)
 *
 * Cobre as funções puras de análise de timing de votos: buckets de latência,
 * hora-do-dia BRT, histograma de latência (com cobertura/tolerância a sent_at
 * faltando), recorrência por coorte, acerto×latência, e parse do log.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bucketForLatency,
  hourOfDayBrt,
  computeLatencyStats,
  computeHourOfDayBrt,
  computeRecurrence,
  computeAccuracyByLatency,
  parseVoteLog,
  renderReport,
  type VoteLogEntry,
} from "../scripts/analyze-vote-timing.ts";

function entry(over: Partial<VoteLogEntry>): VoteLogEntry {
  return {
    ts: "2026-06-02T12:00:00.000Z",
    edition: "260602",
    month_slug: "2026-06",
    email_hash: "h1",
    choice: "A",
    correct: null,
    ...over,
  };
}

describe("bucketForLatency (#1657)", () => {
  it("mapeia minutos pro bucket certo", () => {
    assert.equal(bucketForLatency(0), "<15min");
    assert.equal(bucketForLatency(14), "<15min");
    assert.equal(bucketForLatency(15), "15-60min");
    assert.equal(bucketForLatency(59), "15-60min");
    assert.equal(bucketForLatency(60), "1-6h");
    assert.equal(bucketForLatency(359), "1-6h");
    assert.equal(bucketForLatency(360), "6-24h");
    assert.equal(bucketForLatency(1439), "6-24h");
    assert.equal(bucketForLatency(1440), "1-3d");
    assert.equal(bucketForLatency(4319), "1-3d");
    assert.equal(bucketForLatency(4320), ">3d");
    assert.equal(bucketForLatency(99999), ">3d");
  });

  it("latência negativa → anomalia", () => {
    assert.equal(bucketForLatency(-1), "anomalia(<0)");
  });
});

describe("hourOfDayBrt (#1657)", () => {
  it("converte UTC pra BRT (UTC-3)", () => {
    assert.equal(hourOfDayBrt("2026-06-02T12:00:00.000Z"), 9); // 12 UTC = 09 BRT
    assert.equal(hourOfDayBrt("2026-06-02T00:00:00.000Z"), 21); // 00 UTC = 21 BRT (dia anterior)
    assert.equal(hourOfDayBrt("2026-06-02T02:00:00.000Z"), 23); // wrap
    assert.equal(hourOfDayBrt("2026-06-02T03:00:00.000Z"), 0);
  });

  it("ISO inválido → null", () => {
    assert.equal(hourOfDayBrt("não-é-data"), null);
  });
});

describe("computeLatencyStats (#1657)", () => {
  const sentAt = { "260602": "2026-06-02T09:00:00.000Z" };

  it("histograma + cobertura com sent_at presente", () => {
    const entries = [
      entry({ ts: "2026-06-02T09:05:00.000Z" }), // 5min → <15min
      entry({ ts: "2026-06-02T09:30:00.000Z" }), // 30min → 15-60min
      entry({ ts: "2026-06-02T12:00:00.000Z" }), // 3h → 1-6h
    ];
    const r = computeLatencyStats(entries, sentAt);
    assert.equal(r.matched, 3);
    assert.equal(r.unmatched, 0);
    assert.equal(r.coverage, 1);
    assert.equal(r.histogram["<15min"], 1);
    assert.equal(r.histogram["15-60min"], 1);
    assert.equal(r.histogram["1-6h"], 1);
  });

  it("tolera votos sem sent_at correspondente (unmatched, não enviesa)", () => {
    const entries = [
      entry({ edition: "260602", ts: "2026-06-02T09:05:00.000Z" }), // matched
      entry({ edition: "260601", ts: "2026-06-01T10:00:00.000Z" }), // sem sent_at → unmatched
    ];
    const r = computeLatencyStats(entries, sentAt);
    assert.equal(r.matched, 1);
    assert.equal(r.unmatched, 1);
    assert.equal(r.coverage, 0.5);
    assert.equal(r.histogram["<15min"], 1);
    // o unmatched NÃO entra em nenhum bucket
    assert.equal(Object.values(r.histogram).reduce((a, b) => a + b, 0), 1);
  });

  it("total 0 → coverage null (sem divisão por zero)", () => {
    const r = computeLatencyStats([], sentAt);
    assert.equal(r.coverage, null);
  });

  it("voto antes do envio (clock skew) → bucket anomalia", () => {
    const entries = [entry({ ts: "2026-06-02T08:00:00.000Z" })]; // 1h antes do sent 09:00
    const r = computeLatencyStats(entries, sentAt);
    assert.equal(r.histogram["anomalia(<0)"], 1);
  });
});

describe("computeHourOfDayBrt (#1657)", () => {
  it("conta votos por hora BRT", () => {
    const entries = [
      entry({ ts: "2026-06-02T12:00:00.000Z" }), // 09 BRT
      entry({ ts: "2026-06-02T12:30:00.000Z" }), // 09 BRT
      entry({ ts: "2026-06-02T15:00:00.000Z" }), // 12 BRT
    ];
    const hours = computeHourOfDayBrt(entries);
    assert.equal(hours[9], 2);
    assert.equal(hours[12], 1);
    assert.equal(hours.length, 24);
  });
});

describe("computeRecurrence (#1657)", () => {
  it("conta edições DISTINTAS por email_hash + repeat rate", () => {
    const entries = [
      entry({ email_hash: "a", edition: "260601" }),
      entry({ email_hash: "a", edition: "260602" }), // a votou em 2 edições
      entry({ email_hash: "b", edition: "260602" }), // b votou em 1
    ];
    const r = computeRecurrence(entries);
    assert.equal(r.uniqueVoters, 2);
    assert.equal(r.distribution["1"], 1); // b
    assert.equal(r.distribution["2"], 1); // a
    assert.equal(r.repeatRate, 0.5); // 1 de 2 votou ≥2
  });

  it("dupes da mesma edição/voter não inflam (Set por edição)", () => {
    const entries = [
      entry({ email_hash: "a", edition: "260602" }),
      entry({ email_hash: "a", edition: "260602" }), // dup no dump
    ];
    const r = computeRecurrence(entries);
    assert.equal(r.uniqueVoters, 1);
    assert.equal(r.distribution["1"], 1);
  });

  it("bucket 4+ pra votantes muito recorrentes", () => {
    const entries = ["260601", "260602", "260603", "260604", "260605"].map((ed) =>
      entry({ email_hash: "fan", edition: ed }),
    );
    const r = computeRecurrence(entries);
    assert.equal(r.distribution["4+"], 1);
  });

  it("0 votantes → repeatRate null", () => {
    assert.equal(computeRecurrence([]).repeatRate, null);
  });
});

describe("computeAccuracyByLatency (#1657)", () => {
  const sentAt = { "260602": "2026-06-02T09:00:00.000Z" };

  it("acurácia por bucket, ignora correct=null e unmatched", () => {
    const entries = [
      entry({ ts: "2026-06-02T09:05:00.000Z", correct: true }), // <15min, acerto
      entry({ ts: "2026-06-02T09:10:00.000Z", correct: false }), // <15min, erro
      entry({ ts: "2026-06-02T12:00:00.000Z", correct: true }), // 1-6h, acerto
      entry({ ts: "2026-06-02T09:05:00.000Z", correct: null }), // ignorado (sem gabarito)
      entry({ edition: "260601", ts: "2026-06-01T10:00:00.000Z", correct: true }), // unmatched
    ];
    const rows = computeAccuracyByLatency(entries, sentAt);
    const byBucket = Object.fromEntries(rows.map((r) => [r.bucket, r]));
    assert.equal(byBucket["<15min"].total, 2);
    assert.equal(byBucket["<15min"].correct, 1);
    assert.equal(byBucket["<15min"].accuracy, 0.5);
    assert.equal(byBucket["1-6h"].total, 1);
    assert.equal(byBucket["1-6h"].accuracy, 1);
    // só buckets com dado aparecem
    assert.ok(!("6-24h" in byBucket));
  });

  it("sem entries elegíveis → array vazio", () => {
    assert.deepEqual(computeAccuracyByLatency([entry({ correct: null })], sentAt), []);
  });
});

describe("parseVoteLog (#1657)", () => {
  it("filtra entradas inválidas, mantém válidas", () => {
    const raw = JSON.stringify([
      { ts: "t", edition: "260602", email_hash: "h", choice: "A", correct: null },
      { ts: "t" }, // sem edition/email_hash → descartada
      null,
      { edition: "260603", email_hash: "h2", ts: "t2", choice: "B", correct: true },
    ]);
    const parsed = parseVoteLog(raw);
    assert.equal(parsed.length, 2);
  });

  it("não-array → lança", () => {
    assert.throws(() => parseVoteLog('{"a":1}'), /array/);
  });
});

describe("renderReport (#1657 smoke)", () => {
  it("gera markdown com as seções e surfaça cobertura quando sent_at falta", () => {
    const entries = [
      entry({ edition: "260602", ts: "2026-06-02T09:05:00.000Z", correct: true }),
      entry({ edition: "260601", ts: "2026-06-01T10:00:00.000Z", email_hash: "b" }), // sem sent_at
    ];
    const md = renderReport(entries, { "260602": "2026-06-02T09:00:00.000Z" });
    assert.match(md, /# Análise de timing de votos/);
    assert.match(md, /Latência envio→voto/);
    assert.match(md, /hora-do-dia \(BRT\)/);
    assert.match(md, /Recorrência por coorte/);
    assert.match(md, /Acerto × latência/);
    // cobertura parcial deve ser surfaçada
    assert.match(md, /sem sent_at/);
  });
});
