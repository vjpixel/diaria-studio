/**
 * test/jev-ab-report-significance-8911.test.ts (#8911)
 *
 * `scripts/jev-ab-report.ts` apresentava só a média por braço, sem teste de
 * significância e sem piso de n — a diferença "A 2,8 (n=6) x B 1,5 (n=4)"
 * lia como vitória do Jev quando com n=4x6 podia ser ruído. Cobre:
 * mediana, teste de Mann-Whitney (exato e normal approx), banner de piso
 * (#8412: >=5 edições por braço) e o veredito explícito.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  median,
  mannWhitneyTest,
  bootstrapMeanDiffCI,
  buildAbReport,
  renderAbReport,
  MIN_N_PER_ARM,
  type EditionRaw,
} from "../scripts/lib/jev-ab-report.ts";

describe("median", () => {
  it("ímpar pega o meio; par faz média dos dois centrais; vazio é null", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), null);
  });
});

describe("mannWhitneyTest", () => {
  it("amostras sem diferença real: p-valor alto", () => {
    const a = [10, 12.1, 11, 13, 10.5, 12];
    const b = [11.2, 12.3, 10.1, 13.4, 11.5, 12.7];
    const { pValue, method } = mannWhitneyTest(a, b);
    assert.equal(method, "exact");
    assert.ok(pValue > 0.3, `esperava p alto (sem diferença significativa), veio ${pValue}`);
  });

  it("diferença grande com n suficiente: p-valor baixo", () => {
    const a = [1, 2.1, 1.2, 2.3, 1.4, 2.5, 1.6, 2.7];
    const b = [10, 11.1, 10.2, 11.3, 10.4, 11.5, 10.6, 11.7];
    const { pValue, method } = mannWhitneyTest(a, b);
    assert.equal(method, "exact");
    assert.ok(pValue < 0.01, `esperava p baixo, veio ${pValue}`);
  });

  it("cai para normal approx quando há empates, mesmo com n1+n2 pequeno", () => {
    const a = Array.from({ length: 6 }, () => 5);
    const b = Array.from({ length: 6 }, () => 6);
    const { method, pValue } = mannWhitneyTest(a, b);
    assert.equal(method, "normal-approx");
    assert.ok(pValue < 0.01);
  });

  it("cai para normal approx quando n1+n2>60, mesmo sem empates", () => {
    const a = Array.from({ length: 31 }, (_, i) => i + 0.01);
    const b = Array.from({ length: 31 }, (_, i) => i + 100.02);
    assert.equal(a.length + b.length, 62);
    const { method, pValue } = mannWhitneyTest(a, b);
    assert.equal(method, "normal-approx");
    assert.ok(pValue < 0.01);
  });

  it("é simétrico entre os braços (mesmo p-valor trocando a ordem)", () => {
    const a = [1, 3, 5, 7, 2];
    const b = [4, 6, 8, 9, 10];
    const r1 = mannWhitneyTest(a, b);
    const r2 = mannWhitneyTest(b, a);
    assert.ok(Math.abs(r1.pValue - r2.pValue) < 1e-9);
  });
});

describe("bootstrapMeanDiffCI", () => {
  it("determinístico (mesma seed = mesmo resultado) e braço vazio é null", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [10, 11, 12, 13, 14];
    const r1 = bootstrapMeanDiffCI(a, b);
    const r2 = bootstrapMeanDiffCI(a, b);
    assert.deepEqual(r1, r2);
    assert.ok(r1 && r1[0] < r1[1]);
    assert.equal(bootstrapMeanDiffCI([], b), null);
  });

  it("IC não cobre 0 quando a diferença é grande e consistente", () => {
    const a = [1, 2, 1, 2, 1, 2, 1, 2];
    const b = [10, 11, 10, 11, 10, 11, 10, 11];
    const ci = bootstrapMeanDiffCI(a, b);
    assert.ok(ci && ci[0] > 0, `esperava IC inteiramente positivo, veio ${JSON.stringify(ci)}`);
  });
});

// Helpers de fixture — mesmo padrão de test/jev-profile-8421.test.ts.
const absent = { state: "absent" as const };
function ed(id: string, arm: "A" | "B", overrides: Partial<{ gate4: number; tokens: number }> = {}): EditionRaw {
  const isB = arm === "B";
  const stageRows = {
    state: "ok" as const,
    value: [
      { stage: 1, pipeline_ms: 60000, tokens_in: overrides.tokens ?? 100, tokens_out: 50 },
      { stage: 4, duration_ms: 120000, pipeline_ms: 60000 },
    ],
  };
  const editorRequests = {
    state: "ok" as const,
    value: {
      rows: Array.from({ length: overrides.gate4 ?? 0 }, () => ({ stage: 4 })),
      invalidLines: 0,
    },
  };
  return {
    edition: id,
    exists: true,
    profile: isB ? { state: "ok", value: { profile: "all", features: ["dedup_grayzone"], shadow: false } } : absent,
    editorRequests,
    stageRows,
    dedupArtifact: isB ? { state: "ok", value: { profile_env: "all", shadow: false } } : absent,
  };
}

describe("buildAbReport: piso #8412 e veredito", () => {
  it("n<5 num braço: banner INCONCLUSIVO e todo veredito fica 'inconclusivo (piso)'", () => {
    const editions = [
      ...[1, 2, 3, 4, 5, 6].map((i) => ed(`a${i}`, "A", { gate4: 3, tokens: 100 })),
      ...[1, 2, 3].map((i) => ed(`b${i}`, "B", { gate4: 1, tokens: 90 })),
    ];
    const r = buildAbReport(editions);
    assert.equal(r.arms.A.editions, 6);
    assert.equal(r.arms.B.editions, 3);
    for (const k of Object.keys(r.tests) as (keyof typeof r.tests)[]) {
      assert.equal(r.tests[k].pisoAtingido, false);
      assert.equal(r.tests[k].verdict, "inconclusivo (piso)");
    }
    const txt = renderAbReport(r);
    assert.match(txt, /INCONCLUSIVO: n<5 no braço B \(n=3\)/);
    assert.doesNotMatch(txt, /INCONCLUSIVO: n<5 no braço A/);
  });

  it("ambos os braços >=5 com diferença grande e consistente: veredito nomeia o braço vencedor", () => {
    const editions = [
      ...[1, 2, 3, 4, 5, 6].map((i) => ed(`a${i}`, "A", { gate4: 10, tokens: 100 })),
      ...[1, 2, 3, 4, 5, 6].map((i) => ed(`b${i}`, "B", { gate4: 1, tokens: 100 })),
    ];
    const r = buildAbReport(editions);
    assert.equal(r.arms.A.editions, MIN_N_PER_ARM + 1);
    assert.equal(r.arms.B.editions, MIN_N_PER_ARM + 1);
    const t = r.tests.gate4Corrections;
    assert.equal(t.pisoAtingido, true);
    assert.ok(t.pValue !== null && t.pValue < 0.05, `esperava p<0.05, veio ${t.pValue}`);
    assert.equal(t.verdict, "B");
    const txt = renderAbReport(r);
    assert.doesNotMatch(txt, /INCONCLUSIVO/);
    assert.match(txt, /\| B \|$|\| B \|\n/m);
  });

  it("ambos os braços >=5, sem diferença real: veredito 'sem diferença'", () => {
    const editions = [
      ...[1, 2, 3, 4, 5, 6].map((i) => ed(`a${i}`, "A", { gate4: 2, tokens: 100 })),
      ...[1, 2, 3, 4, 5, 6].map((i) => ed(`b${i}`, "B", { gate4: 2, tokens: 100 })),
    ];
    const r = buildAbReport(editions);
    const t = r.tests.gate4Corrections;
    assert.equal(t.pisoAtingido, true);
    assert.equal(t.verdict, "sem diferença");
  });

  it("piso atingido mas métrica sem dado num braço: veredito 'sem dado', não 'inconclusivo (piso)'", () => {
    // gate4Corrections tem dado nas 2 pontas; tokens fica sem dado no braço B via stageRows corrompido.
    const A = [1, 2, 3, 4, 5, 6].map((i) => ed(`a${i}`, "A", { gate4: 3, tokens: 100 }));
    const B = [1, 2, 3, 4, 5, 6].map((i) => {
      const e = ed(`b${i}`, "B", { gate4: 1, tokens: 100 });
      return { ...e, stageRows: { state: "corrupt" as const } };
    });
    const r = buildAbReport([...A, ...B]);
    assert.equal(r.arms.A.editions, 6);
    assert.equal(r.arms.B.editions, 6);
    const t = r.tests.tokens;
    assert.equal(t.pisoAtingido, true);
    assert.equal(t.n.B, 0);
    assert.equal(t.verdict, "sem dado");
  });

  it("--json (via renderAbReport/buildAbReport) expõe n, mediana, p-valor, IC95 e veredito por métrica", () => {
    const editions = [
      ...[1, 2, 3, 4, 5, 6].map((i) => ed(`a${i}`, "A", { gate4: 10, tokens: 100 })),
      ...[1, 2, 3, 4, 5, 6].map((i) => ed(`b${i}`, "B", { gate4: 1, tokens: 100 })),
    ];
    const r = buildAbReport(editions);
    const t = r.tests.gate4Corrections;
    assert.equal(typeof t.n.A, "number");
    assert.equal(typeof t.n.B, "number");
    assert.equal(typeof t.medianA, "number");
    assert.equal(typeof t.medianB, "number");
    assert.equal(typeof t.pValue, "number");
    assert.ok(Array.isArray(t.ci95));
    assert.equal(typeof t.verdict, "string");
    // Round-trip via JSON.stringify (é o que `--json` faz de fato).
    const parsed = JSON.parse(JSON.stringify(r));
    assert.equal(parsed.tests.gate4Corrections.verdict, "B");
  });
});
