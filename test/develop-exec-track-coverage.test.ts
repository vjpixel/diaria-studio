import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findMissingExecTrack,
  checkExecTrackCoverageFromPlan,
  EXEC_TRACK_VALUES,
  type PlanWithIssues,
} from "../scripts/lib/develop-exec-track-coverage.ts";
import type { DevelopPlanIssueLike } from "../scripts/lib/develop-plan-motivo.ts";

describe("EXEC_TRACK_VALUES", () => {
  it("é o espelho exato do enum ExecTrack de issue-exec-track.ts", async () => {
    // Compara contra `EXEC_TRACK_UI` (fonte real do enum em runtime, #6200/
    // #6201) em vez de um array literal duplicado aqui — antes desta
    // mudança, o comentário PROMETIA "se alguém acrescentar um track lá,
    // este teste quebra aqui", mas o array `fonte` era outra cópia manual: a
    // adição de `epica` (#6201) passaria batida por ESTE teste (só quebraria
    // se `EXEC_TRACK_VALUES` em si esquecesse a entrada, não se as DUAS
    // listas esquecessem juntas). Derivar `fonte` de `EXEC_TRACK_UI` fecha
    // esse gap — agora é impossível as duas divergirem sem o teste acusar.
    const mod = await import("../scripts/lib/issue-exec-track.ts");
    const fonte = mod.EXEC_TRACK_UI.map((e) => e.track);
    assert.deepEqual([...EXEC_TRACK_VALUES].sort(), [...fonte].sort());
  });
});

describe("findMissingExecTrack — #5907(a), cobertura do passo 6a", () => {
  it("todas as entradas com track válido → ok (listas vazias)", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 1, status: "mergeada", exec_track_painel: "overnight" },
      { number: 2, status: "pulada", motivo: "deixado-para-o-helios", exec_track_painel: "develop" },
      { number: 3, status: "pendente", exec_track_painel: "bloqueada" },
    ];
    assert.deepEqual(findMissingExecTrack(issues), { missing: [], invalid: [] });
  });

  it("entrada sem exec_track_painel → missing (o gap da 260821c)", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 5125, status: "deixado-para-o-helios" },
      { number: 5891, status: "deixado-para-o-helios" },
    ];
    assert.deepEqual(findMissingExecTrack(issues), { missing: [5125, 5891], invalid: [] });
  });

  it("exec_track_painel não-string e string vazia também são missing", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 10, exec_track_painel: 42 },
      { number: 11, exec_track_painel: "" },
      { number: 12, exec_track_painel: null },
    ];
    assert.deepEqual(findMissingExecTrack(issues), { missing: [10, 11, 12], invalid: [] });
  });

  it("valor fora do enum de 5 tracks → invalid com o valor gravado (typo)", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 20, exec_track_painel: "Overnight" },
      { number: 21, exec_track_painel: "develop-track" },
    ];
    const r = findMissingExecTrack(issues);
    assert.equal(r.missing.length, 0);
    assert.deepEqual(r.invalid, [
      { number: 20, value: "Overnight" },
      { number: 21, value: "develop-track" },
    ]);
  });

  it("missing tem precedência sobre invalid na mesma entrada (campo não-string não valida valor)", () => {
    const issues: DevelopPlanIssueLike[] = [{ number: 30, exec_track_painel: 7 }];
    assert.deepEqual(findMissingExecTrack(issues), { missing: [30], invalid: [] });
  });

  it("entradas sem number numérico são ignoradas (mesmo contrato dos gates irmãos)", () => {
    const issues: DevelopPlanIssueLike[] = [
      { status: "mergeada", exec_track_painel: "overnight" },
      { number: Number.NaN, exec_track_painel: undefined },
      null as unknown as DevelopPlanIssueLike,
    ];
    assert.deepEqual(findMissingExecTrack(issues), { missing: [], invalid: [] });
  });

  it("saída ordenada e deduplicada", () => {
    const issues: DevelopPlanIssueLike[] = [
      { number: 900, exec_track_painel: undefined },
      { number: 100, exec_track_painel: undefined },
      { number: 100, exec_track_painel: undefined },
    ];
    assert.deepEqual(findMissingExecTrack(issues).missing, [100, 900]);
  });
});

describe("checkExecTrackCoverageFromPlan — shape do plan.json", () => {
  it("issues como array → veredito direto", () => {
    const plan: PlanWithIssues = {
      issues: [{ number: 1, exec_track_painel: "agendada" }],
    };
    assert.deepEqual(checkExecTrackCoverageFromPlan(plan), { status: "ok" });
  });

  it("issues como dict (shape legado) → normalizado antes de checar", () => {
    const plan: PlanWithIssues = {
      issues: { a: { number: 5, status: "pulada" } },
    };
    assert.deepEqual(checkExecTrackCoverageFromPlan(plan), { status: "missing", numbers: [5] });
  });

  it("issues ausente/vazio → ok (fail-open documentado; gate irmão #5718 cobre sessão sem entrada)", () => {
    assert.deepEqual(checkExecTrackCoverageFromPlan({}), { status: "ok" });
    assert.deepEqual(checkExecTrackCoverageFromPlan({ issues: [] }), { status: "ok" });
  });

  it("missing vence invalid no veredito composto (mesma ordem da função pura)", () => {
    const plan: PlanWithIssues = {
      issues: [
        { number: 7, exec_track_painel: "typo" },
        { number: 8 },
      ],
    };
    assert.deepEqual(checkExecTrackCoverageFromPlan(plan), { status: "missing", numbers: [8] });
  });

  it("fixture real: plan.json da 260821c (15 issues, nenhuma com track) dispara missing pro conjunto certo", () => {
    // O plano real que motivou a issue: passo 6a nunca rodou, TODAS as 15
    // entradas foram gravadas sem exec_track_painel. Inline (data/ é
    // gitignored — CI não tem o arquivo; mesmo fix do #5914 no gate b).
    const numerosReais = [
      5878, 5869, 5875, 5897, 5846, 5892, 5894, 5895, 5899, 5901, 5903, 5904,
      5116, 5125, 5891,
    ];
    const issues: DevelopPlanIssueLike[] = numerosReais.map((number) => ({
      number,
      status: number === 5875 || number === 5897 ? "mergeada" : "deixado-para-o-helios",
    }));
    const r = findMissingExecTrack(issues);
    assert.deepEqual(r.missing.sort((a, b) => a - b), [...numerosReais].sort((a, b) => a - b));
    assert.equal(r.invalid.length, 0);
  });
});
