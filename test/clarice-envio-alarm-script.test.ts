/**
 * test/clarice-envio-alarm-script.test.ts (#5058, item 2)
 *
 * Cobre a parte de I/O de `scripts/clarice-envio-alarm.ts` que não exige
 * rede real nem `data/.credentials.json` (guard de #573/CLAUDE.md — sem
 * credencial Gmail real neste worktree; regra de dispatch overnight #738
 * proíbe qualquer chamada de rede real nesta sessão):
 *
 *   - `listTodayEnvioReports` — glob + mtime, sobre um diretório temporário
 *     com arquivos `envio-{aammdd}*.md` reais (não mockado — é só fs local).
 *
 * `loadState`/`saveState` (roundtrip de `envio-alarm-state.json`) removidos
 * (#7960) — o script não gerencia mais idempotência de e-mail própria, isso
 * agora é `notifyEditorForOutcomes`/`shouldEmailForIssueOutcome`
 * (`scripts/lib/editor-notify.ts`, coberto por `test/editor-notify.test.ts`).
 * `shouldSendEnvioAlarm`/`markEnvioAlarmed` continuam testados puros em
 * `test/clarice-envio-alarm.test.ts` (lib), sem I/O — não removidos, só não
 * mais chamados por este script.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listTodayEnvioReports, toAlarmFinding } from "../scripts/clarice-envio-alarm.ts";
import { applyAlarmReconciliation, type AlarmIssuesState, type GhRunFn } from "../scripts/lib/alarm-issues.ts";
import { HALT_STALE_REPORT_SUFFIX, haltAlarmFingerprint, type ClariceEnvioHaltRead } from "../scripts/lib/clarice-envio-halt.ts";

describe("listTodayEnvioReports", () => {
  it("diretório ausente (junction data/ não montada) => [] sem lançar", () => {
    const dir = resolve(mkdtempSync(join(tmpdir(), "envio-alarm-")), "nao-existe");
    assert.deepEqual(listTodayEnvioReports(dir, "260811"), []);
  });

  it("filtra só arquivos envio-{aammdd}*.md de HOJE — ignora outros dias e outros arquivos", () => {
    const dir = mkdtempSync(join(tmpdir(), "envio-alarm-"));
    writeFileSync(resolve(dir, "envio-260811-abort.md"), "x");
    writeFileSync(resolve(dir, "envio-260810.md"), "y"); // outro dia
    writeFileSync(resolve(dir, "leia-me.txt"), "z"); // não é .md de envio
    const found = listTodayEnvioReports(dir, "260811");
    assert.equal(found.length, 1);
    assert.equal(found[0].reportId, "envio-260811-abort");
    assert.ok(found[0].mtimeMs > 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("2 relatórios do mesmo dia (retry manual) => os 2 aparecem, com mtime distinto", () => {
    const dir = mkdtempSync(join(tmpdir(), "envio-alarm-"));
    writeFileSync(resolve(dir, "envio-260811-abort.md"), "x");
    writeFileSync(resolve(dir, "envio-260811.md"), "y");
    const found = listTodayEnvioReports(dir, "260811");
    assert.equal(found.length, 2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("toAlarmFinding — family (#5558)", () => {
  it("é sempre 'evento' — a falha de um aammdd específico é fato histórico, não se auto-resolve", () => {
    const finding = toAlarmFinding({ verdict: "alarm-failure", reportId: "envio-260811" }, "260811");
    assert.equal(finding.family, "evento");
  });
});

describe("toAlarmFinding — parada vencida (#10123)", () => {
  const HALT: ClariceEnvioHaltRead = {
    halted: true,
    invalid: false,
    halt: {
      kind: "fila-insuficiente",
      since: "2026-10-01T22:00:00.000Z",
      reportId: "envio-261001",
      cycle: "2609-10",
      queueAvailable: 10,
      desiredVolume: 3450,
      baseVolume: 3005,
    },
  };
  const stale = (aammdd: string) => ({ verdict: "alarm-failure" as const, reportId: `envio-${aammdd}${HALT_STALE_REPORT_SUFFIX}` });

  it("fingerprint vem da parada (sem aammdd), família estado, texto sem 'falhou'/'monte'", () => {
    const f = toAlarmFinding(stale("261005"), "261005", HALT);
    assert.equal(f.fingerprint, "halt:2609-10:2026-10-01T22:00:00.000Z");
    assert.equal(f.family, "estado");
    assert.doesNotMatch(f.title, /falhou/i);
    assert.doesNotMatch(f.body, /falhou|monte a onda manualmente/i);
    assert.match(f.body, /--clear/);
  });

  it("2 dias seguidos com a mesma parada => o mesmo achado, 1 issue só", () => {
    const d1 = toAlarmFinding(stale("261005"), "261005", HALT);
    const d2 = toAlarmFinding(stale("261006"), "261006", HALT);
    assert.equal(d1.fingerprint, d2.fingerprint);

    let creates = 0;
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
      if (args[0] === "issue" && args[1] === "create") {
        creates++;
        return { status: 0, stdout: "https://github.com/x/y/issues/9001\n", stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "view") return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
      if (args[0] === "label") return { status: 0, stdout: "", stderr: "" };
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    let state: AlarmIssuesState = {};
    const r1 = applyAlarmReconciliation([d1], state, { cwd: "/repo", closeAfterRuns: 2, run });
    state = r1.nextState;
    const r2 = applyAlarmReconciliation([d2], state, { cwd: "/repo", closeAfterRuns: 2, run });
    assert.equal(r1.findingOutcomes[0]?.action, "created");
    assert.equal(r2.findingOutcomes[0]?.action, "reused");
    assert.equal(creates, 1, "a mesma parada não abre issue nova por dia");
  });

  it("parada diferente (novo since) => achado novo; ilegível e ausente têm fingerprint estável próprio", () => {
    assert.ok(HALT.halted && !HALT.invalid);
    const other: ClariceEnvioHaltRead = { halted: true, invalid: false, halt: { ...HALT.halt, since: "2026-10-09T22:00:00.000Z" } };
    assert.notEqual(haltAlarmFingerprint(other), haltAlarmFingerprint(HALT));
    assert.equal(haltAlarmFingerprint({ halted: true, invalid: true, error: "x" }), "halt:ilegivel");
    assert.equal(haltAlarmFingerprint(null), "halt:sem-arquivo");
    assert.equal(haltAlarmFingerprint({ halted: false }), "halt:sem-arquivo");
    assert.equal(toAlarmFinding(stale("261005"), "261005", { halted: true, invalid: true, error: "x" }).family, "estado");
  });

  it("falha comum continua evento por dia (não regrediu)", () => {
    const f = toAlarmFinding({ verdict: "alarm-failure", reportId: "envio-261005-abort" }, "261005", HALT);
    assert.equal(f.family, "evento");
    assert.equal(f.fingerprint, "261005:alarm-failure:envio-261005-abort");
  });
});
