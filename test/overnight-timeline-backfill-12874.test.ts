/**
 * test/overnight-timeline-backfill-12874.test.ts (#12874, regressão #633)
 *
 * Rodada 261111b: todas as unidades mergeadas pelo trem saíram "em andamento"
 * no `render-overnight-timeline.ts` porque nada gravava `timeline.merged`
 * (nem `pr_opened`/`ci_green`) no `plan.json`. O backfill lê o estado real
 * das PRs e preenche o que falta, seguindo o PR-trem quando a original foi
 * fechada por ele.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backfillTimelineFromPrFacts,
  ciGreenAtFromRollup,
  studioPrsFromPlan,
} from "../scripts/lib/overnight-timeline-backfill.ts";
import { backfillPlanTimeline, fetchPrTimelineFacts } from "../scripts/backfill-overnight-timeline.ts";
import { backfillTimelineAtTrainEnd } from "../scripts/run-merge-train.ts";
import { buildTimelineRows } from "../scripts/render-overnight-timeline.ts";
import type { GhJson } from "../scripts/reconcile-overnight-report.ts";

const T = (hhmm: string) => `2026-11-11T${hhmm}:00.000Z`;
const green = (completedAt: string) => ({ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", completedAt });
const trainComment = (train: number) => ({
  authorAssociation: "OWNER",
  body: `Mergeado via trem de merge (#6300) — PR-trem #${train}.`,
});

/** `gh pr view N` falso a partir de uma tabela; PR fora da tabela = erro de gh. */
function fakeGh(views: Record<number, Record<string, unknown>>): GhJson & { calls: number[] } {
  const calls: number[] = [];
  const fn = ((args: string[]) => {
    const n = Number(args[2]);
    calls.push(n);
    const v = views[n];
    return v ? { ok: true as const, data: v } : { ok: false as const, error: `gh pr view ${n} saiu 1: not found` };
  }) as GhJson & { calls: number[] };
  fn.calls = calls;
  return fn;
}

/** Fixture no formato da 261111b: lote no trem, solo direto, pulada, aberta. */
function fixturePlan() {
  return {
    started_at: T("14:00"),
    issues: [
      { number: 12837, status: "mergeada", batch: "lote-a", pr: 12838, timeline: { dispatch: T("14:14") } },
      { number: 12832, status: "mergeada", batch: "lote-a", pr: 12838, timeline: { dispatch: T("14:14") } },
      { number: 12830, status: "mergeada", batch: null, pr: 12847, timeline: { dispatch: T("15:08"), merged: T("16:00") } },
      { number: 12900, status: "mergeada", batch: null, pr: "#12901", timeline: { dispatch: T("15:10") } },
      { number: 12785, status: "pulada", batch: null, pr: 12791 },
      { number: 12999, status: "fora-da-rodada-por-track" },
    ],
  };
}

const VIEWS: Record<number, Record<string, unknown>> = {
  // Original fechada pelo trem #12845 (sem mergedAt próprio).
  12838: { state: "CLOSED", createdAt: T("14:40"), mergedAt: null, comments: [trainComment(12845)], statusCheckRollup: [green(T("14:50"))] },
  12845: { state: "MERGED", createdAt: T("15:00"), mergedAt: T("15:30"), comments: [], statusCheckRollup: [green(T("15:20"))] },
  // Coordenador já gravou merged 16:00; o GitHub diz 15:55 → preserva o do coordenador.
  12847: { state: "MERGED", createdAt: T("15:20"), mergedAt: T("15:55"), comments: [], statusCheckRollup: [green(T("15:40"))] },
  // Merge direto, CI ainda com check vermelho no rollup → sem ci_green.
  12901: { state: "MERGED", createdAt: T("15:30"), mergedAt: T("16:10"), comments: [], statusCheckRollup: [green(T("15:50")), { __typename: "CheckRun", conclusion: "FAILURE", completedAt: T("15:45") }] },
  // Fechada sem merge, sem trem.
  12791: { state: "CLOSED", createdAt: T("14:30"), mergedAt: null, comments: [], statusCheckRollup: [] },
};

describe("ciGreenAtFromRollup (#12874)", () => {
  it("só devolve instante com todos os checks verdes; último completedAt", () => {
    assert.equal(ciGreenAtFromRollup([green(T("10:00")), green(T("10:05")), { state: "SUCCESS" }]), T("10:05"));
    assert.equal(ciGreenAtFromRollup([green(T("10:00")), { conclusion: "SKIPPED", completedAt: T("09:00") }]), T("10:00"));
    assert.equal(ciGreenAtFromRollup([green(T("10:00")), { status: "IN_PROGRESS", conclusion: "" }]), null);
    assert.equal(ciGreenAtFromRollup([green(T("10:00")), { conclusion: "FAILURE", completedAt: T("10:01") }]), null);
    assert.equal(ciGreenAtFromRollup([]), null);
    assert.equal(ciGreenAtFromRollup(undefined), null);
    assert.equal(ciGreenAtFromRollup([{ state: "SUCCESS" }]), null, "sem completedAt legível não chuta");
  });
});

describe("backfillTimelineFromPrFacts (#12874)", () => {
  it("studioPrsFromPlan lê array e dict, '#N', e ignora PR de outro repo", () => {
    assert.deepEqual(studioPrsFromPlan(fixturePlan()), [12791, 12838, 12847, 12901]);
    assert.deepEqual(studioPrsFromPlan({ issues: { "7": { pr: 100 }, "vjpixel/diaria-design#8": { pr: 200 } } }), [100]);
  });

  it("ci_green depois do merged é descartado; timestamp existente nunca é sobrescrito", () => {
    const plan = { issues: [{ number: 1, pr: 10, timeline: { merged: T("12:00") } }] };
    const { plan: next, filled } = backfillTimelineFromPrFacts(plan, [
      { pr: 10, createdAt: T("10:00"), ciGreenAt: T("12:30"), mergedAt: T("11:59") },
    ]);
    const tl = (next.issues as Array<{ timeline: Record<string, string> }>)[0].timeline;
    assert.deepEqual(tl, { merged: T("12:00"), pr_opened: T("10:00") });
    assert.deepEqual(filled, ["10:pr_opened"]);
  });
});

describe("backfill-overnight-timeline sobre plano de fixture (#12874)", () => {
  it("cenário da 261111b: unidades do trem deixam de sair 'em andamento'", () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-12874-"));
    const path = join(dir, "plan.json");
    try {
      writeFileSync(path, JSON.stringify(fixturePlan()));
      // Antes: as do trem estão "em andamento".
      const before = buildTimelineRows(fixturePlan() as never);
      assert.ok(before.some((r) => r.endLabel === "em andamento"));

      const gh = fakeGh(VIEWS);
      const r = backfillPlanTimeline({ planPath: path, gh, warn: () => {} });
      assert.equal(r.exitCode, 0, r.messages.join("\n"));
      // PR-trem lido uma vez só.
      assert.equal(gh.calls.filter((n) => n === 12845).length, 1);

      const plan = JSON.parse(readFileSync(path, "utf8"));
      const by = (n: number) => plan.issues.find((i: { number: number }) => i.number === n).timeline;
      // Lote fechado pelo trem: merged = mergedAt do PR-trem, ci_green da própria PR.
      for (const n of [12837, 12832]) {
        assert.deepEqual(by(n), { dispatch: T("14:14"), pr_opened: T("14:40"), ci_green: T("14:50"), merged: T("15:30") });
      }
      // merged do coordenador preservado.
      assert.equal(by(12830).merged, T("16:00"));
      assert.equal(by(12830).ci_green, T("15:40"));
      // Rollup com check vermelho → sem ci_green, mas merged entra.
      assert.equal(by(12900).ci_green, undefined);
      assert.equal(by(12900).merged, T("16:10"));
      // Fechada sem merge: só pr_opened, nunca merged.
      assert.deepEqual(by(12785), { pr_opened: T("14:30") });

      const rows = buildTimelineRows(plan);
      assert.ok(!rows.some((row) => row.endLabel === "em andamento"), JSON.stringify(rows.map((x) => [x.unidade, x.endLabel])));
      assert.ok(rows.filter((row) => row.endLabel === "mergeado").every((row) => row.durationMs !== null));

      // Idempotente: 2ª passada não grava nada.
      const again = backfillPlanTimeline({ planPath: path, gh: fakeGh(VIEWS), warn: () => {} });
      assert.deepEqual(again.filled, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("dry-run não grava; PR ilegível sai 3 sem impedir as demais", () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-12874-err-"));
    const path = join(dir, "plan.json");
    try {
      writeFileSync(path, JSON.stringify(fixturePlan()));
      const dry = backfillPlanTimeline({ planPath: path, gh: fakeGh(VIEWS), dryRun: true, warn: () => {} });
      assert.ok(dry.filled.length > 0);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), fixturePlan());

      const partial = { ...VIEWS };
      delete partial[12847];
      const r = backfillPlanTimeline({ planPath: path, gh: fakeGh(partial), warn: () => {} });
      assert.equal(r.exitCode, 3);
      assert.match(r.messages.join("\n"), /PR #12847 não lida/);
      const plan = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(plan.issues[0].timeline.merged, T("15:30"));
      assert.equal(plan.issues[2].timeline.ci_green, undefined, "PR ilegível não ganha nada");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("PR-trem não mergeado: original fechada fica sem merged", () => {
    const facts = fetchPrTimelineFacts(1, fakeGh({
      1: { state: "CLOSED", createdAt: T("10:00"), mergedAt: null, comments: [trainComment(2)], statusCheckRollup: [] },
      2: { state: "CLOSED", createdAt: T("10:10"), mergedAt: null, comments: [], statusCheckRollup: [] },
    }));
    assert.equal(facts.mergedAt, null);
  });

  it("plano ausente sai 2", () => {
    const r = backfillPlanTimeline({ planPath: join(tmpdir(), "nao-existe-12874", "plan.json"), gh: fakeGh({}), warn: () => {} });
    assert.equal(r.exitCode, 2);
  });
});

describe("run-merge-train: backfill no fim do trem (#12874)", () => {
  it("usa o plan.json ao lado do report e nunca lança", () => {
    let seen = "";
    const ok = backfillTimelineAtTrainEnd("/x/data/overnight/261111b/report.md", {
      backfill: (p) => { seen = p.planPath; return { exitCode: 0, messages: ["preenchido: 1:merged"], filled: ["1:merged"] }; },
    });
    assert.equal(seen, join("/x/data/overnight/261111b", "plan.json"));
    assert.equal(ok.level, "log");
    assert.match(ok.message, /preenchido: 1:merged/);
    const boom = backfillTimelineAtTrainEnd("/x/report.md", { backfill: () => { throw new Error("disco"); } });
    assert.equal(boom.level, "warn");
    assert.match(boom.message, /não preenchida: disco/);
  });
});
