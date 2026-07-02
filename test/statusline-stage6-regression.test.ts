/**
 * test/statusline-stage6-regression.test.ts (#2800, #2803)
 *
 * #2800 — Stage 6 fica "running" no stage-status.json apesar de concluir.
 *
 * Causa-raiz encontrada: `blockReasonForMarkingStageDone` (stage 6) exige
 * `_internal/edition-report.html`, que só é gerado no passo 6b-6 (auto-reporter,
 * Etapa 6b) — mas o orchestrator chamava `update-stage-status --stage 6 --status
 * done` ANTES disso, no antigo §6f (logo após o sentinel write). Como o report
 * ainda não existia nesse ponto, a chamada SEMPRE bloqueava (exit 1, doc não
 * gravado). A mesma checagem também derruba o auto-update-on-sentinel-write
 * (`autoUpdateStageStatusOnSentinel`, `scripts/pipeline-sentinel.ts` #1563), então
 * nem o `pipeline-sentinel.ts write` consertava a linha. A falha era tratada
 * como "logar warn, não bloquear auto-reporter" — a linha ficava presa em
 * `running` para sempre, mesmo com `.step-6-done.json` provando que o stage
 * concluiu de fato (evidência real: edição 260702).
 *
 * Fix: `.claude/agents/orchestrator-stage-6.md` foi reordenado — o
 * `--status done` agora roda em §6b-7, DEPOIS do report existir (§6b-6) — ver
 * seção 1 abaixo, que reproduz o bloqueio antes/depois via
 * `blockReasonForMarkingStageDone` direto (mesma função que tanto o CLI quanto
 * `autoUpdateStageStatusOnSentinel` chamam).
 *
 * Bônus (pedido pela issue): guard de reconciliação read-only —
 * `reconcileZombieRunningRows` (`scripts/overnight-statusline.ts`) corrige a
 * EXIBIÇÃO (não o arquivo) quando `.step-N-done.json` existe mas a row diz
 * `running` — autocura edições já afetadas (ex: 260702) sem editar
 * `data/editions/` manualmente. Seção 2 abaixo.
 *
 * #2803 — Statusline modo develop (`data/develop/{AAMMDD}/plan.json`).
 * `readTodayDevelopPlan` + `renderDevelopBar` + precedência
 * edição > develop > overnight > idle, reusando o guard de staleness (mesma
 * classe de zumbi do #2800: um `plan.json` de develop ANTIGO não sequestra a
 * barra). Seção 3 abaixo.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyUpdate,
  blockReasonForMarkingStageDone,
  loadDoc,
  saveDoc,
  type StageStatusDoc,
} from "../scripts/update-stage-status.ts";
import { writeSentinel } from "../scripts/lib/pipeline-state.ts";
import {
  reconcileZombieRunningRows,
  readTodayDevelopPlan,
  isStaleDevelopPlan,
  renderDevelopBar,
  renderStatusline,
  DEVELOP_DIR_RE,
  type Plan,
  type DevelopPlanEntry,
} from "../scripts/overnight-statusline.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Simula exatamente o que `main()` de update-stage-status.ts faz para --status done. */
function markStageDoneViaCli(
  editionDir: string,
  editionId: string,
  stage: number,
): { ok: boolean; reason?: string } {
  const blockReason = blockReasonForMarkingStageDone(editionDir, stage);
  if (blockReason) return { ok: false, reason: blockReason };
  const doc = loadDoc(editionDir, editionId);
  const updated = applyUpdate(doc, { stage, status: "done" }, new Date().toISOString());
  saveDoc(editionDir, updated);
  return { ok: true };
}

function makeStage6RunningDoc(editionId: string): StageStatusDoc {
  return {
    edition: editionId,
    generated_at: "2026-07-02T03:30:08.000Z",
    rows: [
      { stage: 0, status: "done" },
      { stage: 1, status: "done" },
      { stage: 2, status: "done" },
      { stage: 3, status: "done" },
      { stage: 4, status: "done" },
      { stage: 5, status: "done" },
      // Reproduz exatamente o estado real da edição 260702: stage 6 preso em
      // "running" após pipeline-sentinel write (03:30:08) e a tentativa de
      // mark-done que se seguia (bloqueada pela ausência de edition-report.html).
      { stage: 6, status: "running", start: "2026-07-02T03:29:00.000Z" },
    ],
  };
}

function writePublished(editionDir: string, extra: Record<string, unknown> = {}): void {
  const internalDir = join(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  writeFileSync(
    join(internalDir, "05-published.json"),
    JSON.stringify({ status: "draft", scheduled_at: "2026-07-03T09:00:00.000Z", ...extra }),
    "utf8",
  );
}

// ─── 1. Causa-raiz: gate de edition-report.html bloqueia done ANTES do report existir ─

describe("#2800 causa-raiz: blockReasonForMarkingStageDone(stage 6) exige edition-report.html", () => {
  it("SEM edition-report.html: bloqueia (exit 1) — reproduz a falha do antigo §6f", () => {
    const editionDir = makeTmpDir("stage6-block-no-report-");
    try {
      writePublished(editionDir);
      const reason = blockReasonForMarkingStageDone(editionDir, 6);
      assert.ok(reason !== null, "sem edition-report.html deve bloquear stage 6 done");
      assert.ok(
        reason!.includes("edition-report.html") || reason!.includes("edition report"),
        `motivo deve mencionar o report ausente: ${reason}`,
      );
    } finally {
      rmSync(editionDir, { recursive: true, force: true });
    }
  });

  it("update-stage-status --stage 6 --status done falha (no-op) quando chamado ANTES do report (§6f antigo)", () => {
    const editionDir = makeTmpDir("stage6-cli-block-");
    const editionId = "260702";
    try {
      const doc = makeStage6RunningDoc(editionId);
      saveDoc(editionDir, doc);
      writePublished(editionDir);
      // Nenhum edition-report.html ainda — ponto onde o §6f antigo chamava --status done.

      const result = markStageDoneViaCli(editionDir, editionId, 6);
      assert.equal(result.ok, false, "mark-done deve falhar sem o report (reproduz #2800)");

      // A row continua "running" — exatamente o sintoma relatado na issue.
      const reloaded = loadDoc(editionDir, editionId);
      const row6 = reloaded.rows.find((r) => r.stage === 6);
      assert.equal(row6?.status, "running", "sem o fix de ordering, stage 6 fica preso em running");
    } finally {
      rmSync(editionDir, { recursive: true, force: true });
    }
  });

  it("COM edition-report.html + scheduled_at: NÃO bloqueia — reproduz o §6b-7 corrigido", () => {
    const editionDir = makeTmpDir("stage6-cli-ok-");
    const editionId = "260702";
    try {
      const doc = makeStage6RunningDoc(editionId);
      saveDoc(editionDir, doc);
      writePublished(editionDir);
      writeFileSync(join(editionDir, "_internal", "edition-report.html"), "<html>relatorio</html>", "utf8");

      const result = markStageDoneViaCli(editionDir, editionId, 6);
      assert.equal(result.ok, true, `mark-done deve ter sucesso com o report presente: ${result.reason}`);

      const reloaded = loadDoc(editionDir, editionId);
      const row6 = reloaded.rows.find((r) => r.stage === 6);
      assert.equal(row6?.status, "done", "stage 6 deve virar done");
      assert.ok(row6?.end, "deve carimbar um timestamp de fim novo");
      // O `end` novo é o carimbo automático de applyUpdate — precisa ser
      // posterior ao generated_at original do doc fixture (2026-07-02T03:30:08Z).
      assert.ok(
        new Date(row6!.end as string).getTime() > new Date("2026-07-02T03:30:08.000Z").getTime(),
        `end deve ser um timestamp NOVO, não o generated_at original: ${row6?.end}`,
      );
    } finally {
      rmSync(editionDir, { recursive: true, force: true });
    }
  });
});

// ─── 2. Bônus: reconcileZombieRunningRows (guard de reconciliação read-only) ──

describe("#2800 bônus: reconcileZombieRunningRows — sentinel existe mas row diz running", () => {
  it("row running + sentinel do stage escrito → reconciliada para done (sem persistir)", () => {
    const editionDir = makeTmpDir("reconcile-zombie-");
    const editionId = "260702";
    try {
      const doc = makeStage6RunningDoc(editionId);
      // Sentinel do stage 6 existe (pipeline-sentinel write já rodou) mesmo
      // que a row ainda diga "running" — exatamente o estado real observado.
      writeSentinel(editionDir, 6, ["_internal/05-published.json"]);

      const reconciled = reconcileZombieRunningRows(doc, editionDir);
      const row6 = reconciled.rows.find((r) => r.stage === 6);
      assert.equal(row6?.status, "done", "row com sentinel escrito deve ser exibida como done");
      assert.ok(row6?.end, "deve ter um end (do sentinel.completed_at)");

      // Outras rows preservadas.
      const row5 = reconciled.rows.find((r) => r.stage === 5);
      assert.equal(row5?.status, "done", "rows não-running preservadas");
    } finally {
      rmSync(editionDir, { recursive: true, force: true });
    }
  });

  it("row running SEM sentinel → não altera (stage genuinamente em andamento)", () => {
    const editionDir = makeTmpDir("reconcile-no-sentinel-");
    const editionId = "260702";
    try {
      const doc = makeStage6RunningDoc(editionId);
      // Sem writeSentinel — stage 6 genuinamente em progresso.
      const reconciled = reconcileZombieRunningRows(doc, editionDir);
      const row6 = reconciled.rows.find((r) => r.stage === 6);
      assert.equal(row6?.status, "running", "sem sentinel, running deve permanecer running");
    } finally {
      rmSync(editionDir, { recursive: true, force: true });
    }
  });

  it("doc sem nenhuma row running → retorna o mesmo doc (no-op, sem mutação supérflua)", () => {
    const editionDir = makeTmpDir("reconcile-noop-");
    const doc: StageStatusDoc = {
      edition: "260702",
      generated_at: "2026-07-02T03:30:08.000Z",
      rows: [
        { stage: 0, status: "done" },
        { stage: 1, status: "pending" },
      ],
    };
    const reconciled = reconcileZombieRunningRows(doc, editionDir);
    assert.deepEqual(reconciled, doc, "sem rows running, deve retornar equivalente ao original");
  });

  it("sentinel_exists lança erro inesperado → fail-open (row inalterada, sem throw)", () => {
    // editionDir inválido (caractere nulo) para forçar erro em existsSync/resolve
    // dentro de sentinelExists — reconcileZombieRunningRows deve engolir e preservar a row.
    const doc = makeStage6RunningDoc("260702");
    assert.doesNotThrow(() => {
      const reconciled = reconcileZombieRunningRows(doc, "\0invalid\0path");
      const row6 = reconciled.rows.find((r) => r.stage === 6);
      assert.equal(row6?.status, "running");
    });
  });
});

// ─── 3. #2803: readTodayDevelopPlan + renderDevelopBar + precedência ──────────

describe("#2803 readTodayDevelopPlan — dir mais recente, análogo a readTodayPlan", () => {
  let tmpRoot: string;

  // Baseline fixo (não depende do relógio real da máquina que roda o teste) —
  // todas as fixtures deste describe usam datas próximas a este instante, e
  // `now` nos testes fica sempre <24h à frente (evita falso-positivo de
  // staleness por causa da divergência entre a data fictícia e o mtime real
  // do arquivo, que sem isso seria "agora" de verdade).
  const FIXTURE_MTIME = new Date("2026-07-02T18:00:00.000Z");

  function writeDevelopPlan(dirName: string, plan: Plan, mtime: Date = FIXTURE_MTIME): string {
    const dir = join(tmpRoot, "data", "develop", dirName);
    mkdirSync(dir, { recursive: true });
    const planPath = join(dir, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan), "utf8");
    utimesSync(planPath, mtime, mtime);
    return planPath;
  }

  before(() => {
    tmpRoot = makeTmpDir("develop-plan-");
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("sem data/develop/ → null", () => {
    const emptyRoot = makeTmpDir("develop-empty-");
    try {
      assert.equal(readTodayDevelopPlan(emptyRoot), null);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("retorna o dir MAIS RECENTE com issues não-vazias", () => {
    writeDevelopPlan("260630", { issues: [{ status: "elegivel" }] });
    writeDevelopPlan("260702", { issues: [{ status: "elegivel" }, { status: "mergeada" }] });

    const now = new Date("2026-07-02T20:00:00.000Z");
    const entry = readTodayDevelopPlan(tmpRoot, now);
    assert.ok(entry !== null);
    assert.equal(entry!.id, "260702");
    assert.equal(entry!.plan.issues.length, 2);
  });

  it("ignora dir com plan vazio (issues:[]) e cai pro próximo mais antigo", () => {
    writeDevelopPlan("260703", { issues: [] }); // mesmo FIXTURE_MTIME — não é o vazio que causa staleness

    const now = new Date("2026-07-02T20:00:00.000Z"); // mesmo instante do teste anterior — determinístico
    const entry = readTodayDevelopPlan(tmpRoot, now);
    assert.ok(entry !== null);
    assert.equal(entry!.id, "260702", "deve pular o plan vazio de 260703 e retornar 260702");
  });

  it("DEVELOP_DIR_RE aceita só 6 dígitos (sem sufixo de letra, diferente de OVERNIGHT_DIR_RE)", () => {
    assert.equal(DEVELOP_DIR_RE.test("260702"), true);
    assert.equal(DEVELOP_DIR_RE.test("260702b"), false);
    assert.equal(DEVELOP_DIR_RE.test("abc123"), false);
  });
});

describe("#2803 staleness: plan de develop ANTIGO não sequestra a barra (mesma classe de zumbi do #2800)", () => {
  it("isStaleDevelopPlan: mtime >24h atrás → stale (true)", () => {
    const dir = makeTmpDir("develop-stale-mtime-");
    try {
      const planPath = join(dir, "plan.json");
      writeFileSync(planPath, JSON.stringify({ issues: [{ status: "elegivel" }] }), "utf8");
      const oldTime = new Date("2026-06-25T10:00:00.000Z");
      utimesSync(planPath, oldTime, oldTime);

      const now = new Date("2026-07-02T20:00:00.000Z"); // > 24h depois
      assert.equal(isStaleDevelopPlan(planPath, now), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isStaleDevelopPlan: mtime recente (<24h) → não-stale (false)", () => {
    const dir = makeTmpDir("develop-fresh-mtime-");
    try {
      const planPath = join(dir, "plan.json");
      writeFileSync(planPath, JSON.stringify({ issues: [{ status: "elegivel" }] }), "utf8");
      const recentTime = new Date("2026-07-02T18:00:00.000Z");
      utimesSync(planPath, recentTime, recentTime);

      const now = new Date("2026-07-02T20:00:00.000Z"); // 2h depois
      assert.equal(isStaleDevelopPlan(planPath, now), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isStaleDevelopPlan: arquivo ausente → fail-open (false, sem throw)", () => {
    assert.doesNotThrow(() => {
      const result = isStaleDevelopPlan("/does/not/exist/plan.json", new Date());
      assert.equal(result, false);
    });
  });

  it("readTodayDevelopPlan pula dir com plan.json stale e cai pro próximo válido", () => {
    const root = makeTmpDir("develop-stale-integration-");
    try {
      const staleDir = join(root, "data", "develop", "260625");
      mkdirSync(staleDir, { recursive: true });
      const stalePlanPath = join(staleDir, "plan.json");
      writeFileSync(stalePlanPath, JSON.stringify({ issues: [{ status: "elegivel" }] }), "utf8");
      const oldTime = new Date("2026-06-25T10:00:00.000Z");
      utimesSync(stalePlanPath, oldTime, oldTime);
      // 260625 é o ÚNICO dir — sem fallback fresco disponível.

      const now = new Date("2026-07-02T20:00:00.000Z");
      const entry = readTodayDevelopPlan(root, now);
      assert.equal(entry, null, "plan.json antigo (zumbi) não deve sequestrar a barra — retorna null");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readTodayDevelopPlan: dir mais recente stale, dir mais antigo fresco → retorna o fresco", () => {
    const root = makeTmpDir("develop-stale-fallback-");
    try {
      // Dir mais recente por nome (260702) mas plan.json abandonado há dias.
      const staleDir = join(root, "data", "develop", "260702");
      mkdirSync(staleDir, { recursive: true });
      const stalePlanPath = join(staleDir, "plan.json");
      writeFileSync(stalePlanPath, JSON.stringify({ issues: [{ status: "elegivel" }] }), "utf8");
      utimesSync(stalePlanPath, new Date("2026-06-20T10:00:00.000Z"), new Date("2026-06-20T10:00:00.000Z"));

      // Dir mais antigo por nome (260628) mas plan.json foi reescrito agora
      // (não deveria acontecer na prática, mas exercita o "cair pro próximo").
      const freshDir = join(root, "data", "develop", "260628");
      mkdirSync(freshDir, { recursive: true });
      const freshPlanPath = join(freshDir, "plan.json");
      writeFileSync(freshPlanPath, JSON.stringify({ issues: [{ status: "elegivel", number: 42 }] }), "utf8");
      const now = new Date("2026-07-02T20:00:00.000Z");
      utimesSync(freshPlanPath, now, now);

      const entry = readTodayDevelopPlan(root, now);
      assert.ok(entry !== null);
      assert.equal(entry!.id, "260628", "deve pular o dir mais recente (stale) e retornar o mais antigo mas fresco");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#2803 renderDevelopBar", () => {
  it("null entry → string vazia", () => {
    assert.equal(renderDevelopBar(null), "");
  });

  it("entry com progresso parcial → prefixo 'develop {AAMMDD}' + barra reusada de renderOvernightBar", () => {
    const entry: DevelopPlanEntry = {
      id: "260702",
      plan: {
        issues: [
          { status: "mergeada" },
          { status: "mergeada" },
          { status: "mergeada" },
          { status: "elegivel" },
          { status: "elegivel" },
          { status: "elegivel" },
          { status: "elegivel" },
          { status: "elegivel" },
        ],
      },
    };
    const bar = renderDevelopBar(entry);
    assert.ok(bar.startsWith("develop 260702"), `deve prefixar com develop {AAMMDD}: ${bar}`);
    assert.ok(bar.includes("(3/8)"), `deve refletir progresso 3/8: ${bar}`);
    assert.ok(!bar.includes("Publicação") && !bar.includes("Agendamento"), `não deve reusar rótulos de stage de edição: ${bar}`);
  });

  it("plan sem issues (vazio) → string vazia (delega o guard pra renderOvernightBar)", () => {
    const entry: DevelopPlanEntry = { id: "260702", plan: { issues: [] } };
    assert.equal(renderDevelopBar(entry), "");
  });

  it("rodada develop encerrada (100% terminal) → visível, não some", () => {
    const entry: DevelopPlanEntry = {
      id: "260628",
      plan: { issues: [{ status: "mergeada" }, { status: "pulada" }] },
    };
    const bar = renderDevelopBar(entry);
    assert.ok(bar.includes("100%"), `encerrada deve mostrar 100%: ${bar}`);
    assert.ok(bar.startsWith("develop 260628"), `prefixo deve ser mantido mesmo encerrada: ${bar}`);
  });
});

describe("#2803 precedência: edição > develop > overnight > idle", () => {
  const editionDocRunning: StageStatusDoc = {
    edition: "260702",
    generated_at: "2026-07-02T10:00:00.000Z",
    rows: [
      { stage: 0, status: "done" },
      { stage: 1, status: "running", start: "2026-07-02T10:00:00.000Z" },
      { stage: 2, status: "pending" },
      { stage: 3, status: "pending" },
      { stage: 4, status: "pending" },
      { stage: 5, status: "pending" },
      { stage: 6, status: "pending" },
    ],
  };

  const developEntry: DevelopPlanEntry = {
    id: "260702",
    plan: { issues: [{ status: "elegivel" }, { status: "mergeada" }] },
  };

  const overnightPlan: Plan = {
    issues: [{ status: "mergeada" }, { status: "elegivel" }, { status: "elegivel" }],
  };

  it("edição em curso vence develop E overnight", () => {
    const out = renderStatusline(editionDocRunning, overnightPlan, "260702", editionDocRunning, "master", developEntry);
    assert.ok(out.includes("edição 260702"), `deve mostrar a barra de edição: ${out}`);
    assert.ok(!out.includes("develop"), `não deve mostrar barra de develop: ${out}`);
  });

  it("sem edição em curso: develop vence overnight", () => {
    const out = renderStatusline(null, overnightPlan, null, null, "master", developEntry);
    assert.ok(out.includes("develop 260702"), `deve mostrar barra de develop: ${out}`);
    assert.ok(!out.includes("(1/3)"), `não deve mostrar a barra de overnight (1/3 do fixture): ${out}`);
  });

  it("sem edição em curso e sem develop: cai pro overnight (comportamento pré-#2803 preservado)", () => {
    const out = renderStatusline(null, overnightPlan, null, null, "master", null);
    assert.ok(out.includes("(1/3)"), `deve mostrar a barra de overnight: ${out}`);
  });

  it("sem edição, sem develop, sem overnight: idle (comportamento pré-#2803 preservado)", () => {
    const out = renderStatusline(null, null, null, null, "master", null);
    assert.ok(out.includes("sem rodada ativa"), `deve cair no idle: ${out}`);
  });

  it("renderStatusline sem 6º argumento (call site legado) continua funcionando — default null", () => {
    const out = renderStatusline(null, overnightPlan, null, null, "master");
    assert.ok(out.includes("(1/3)"), `call site de 5 args deve continuar caindo no overnight: ${out}`);
  });
});
