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
import { buildEnvioAlarmFindings, isHaltFingerprint, listTodayEnvioReports, toAlarmFinding } from "../scripts/clarice-envio-alarm.ts";
import { buildHaltStaleAlarmEmail } from "../scripts/lib/clarice-envio-alarm.ts";
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

describe("toAlarmFinding — base colapsada (#10114)", () => {
  it("achado de ESTADO com fingerprint estável (sem aammdd): uma issue enquanto durar", () => {
    const a = toAlarmFinding({ verdict: "alarm-failure", reportId: "envio-261013-base-colapsada" }, "261013");
    const b = toAlarmFinding({ verdict: "alarm-failure", reportId: "envio-261014-base-colapsada" }, "261014");
    assert.equal(a.family, "estado");
    assert.equal(a.fingerprint, "base-colapsada");
    assert.equal(b.fingerprint, a.fingerprint);
    assert.match(a.body, /--accept-base/);
  });

  it("falha ao gravar a parada (#10115) é EVENTO do dia, com fingerprint por aammdd", () => {
    const f = toAlarmFinding({ verdict: "alarm-failure", reportId: "envio-261013-fila-insuficiente-halt-write-failed" }, "261013");
    assert.equal(f.family, "evento");
    assert.equal(f.fingerprint, "261013:alarm-failure:envio-261013-fila-insuficiente-halt-write-failed");
  });
});

describe("buildEnvioAlarmFindings — parada lida sempre (#10125)", () => {
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
  const FP = "halt:2609-10:2026-10-01T22:00:00.000Z";
  // 23:30 UTC = 20:30 BRT, horário do alarme.
  const at = (day: string) => new Date(`2026-10-${day}T23:30:00.000Z`);
  const stale = (aammdd: string) => ({ verdict: "alarm-failure" as const, reportId: `envio-${aammdd}${HALT_STALE_REPORT_SUFFIX}` });

  function mockGh() {
    const calls = { creates: 0, closes: 0, reopens: 0 };
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
      if (args[0] === "issue" && args[1] === "create") {
        calls.creates++;
        return { status: 0, stdout: "https://github.com/x/y/issues/9001\n", stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "view") return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
      if (args[0] === "issue" && args[1] === "close") {
        calls.closes++;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "reopen") {
        calls.reopens++;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "comment") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "label") return { status: 0, stdout: "", stderr: "" };
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    return { calls, run };
  }

  it("achado 1: dias sem relatório -vencida (no-report, -lock-held, --volume manual) com a parada ainda vencida NÃO fecham a issue", () => {
    const days = [
      { aammdd: "261005", evaluation: stale("261005") },
      { aammdd: "261006", evaluation: { verdict: "alarm-no-report" as const, reportId: null } },
      { aammdd: "261007", evaluation: { verdict: "alarm-failure" as const, reportId: "envio-261007-lock-held" } },
      // `--volume N` manual depois das 19:00: relatório OK vira o mais recente.
      { aammdd: "261008", evaluation: { verdict: "ok" as const, reportId: "envio-261008" } },
    ];
    const { calls, run } = mockGh();
    let state: AlarmIssuesState = {};
    for (const d of days) {
      const findings = buildEnvioAlarmFindings(d.evaluation, d.aammdd, HALT, at(d.aammdd.slice(4)));
      const haltFindings = findings.filter((f) => isHaltFingerprint(f.fingerprint));
      assert.equal(haltFindings.length, 1, `${d.aammdd}: parada vencida sempre gera o achado`);
      assert.equal(haltFindings[0].fingerprint, FP, `${d.aammdd}: mesmo fingerprint todo dia`);
      state = applyAlarmReconciliation(findings, state, { cwd: "/repo", closeAfterRuns: 2, run }).nextState;
    }
    assert.equal(calls.closes, 0, "issue da parada não fecha enquanto a parada continua vencida");
    assert.equal(calls.reopens, 0);
    // 1 issue de parada + 2 eventos do dia (no-report e lock-held).
    assert.equal(calls.creates, 3);
  });

  it("achado 1: falha comum do dia coexiste com o achado de parada (evento + estado)", () => {
    const f = buildEnvioAlarmFindings({ verdict: "alarm-failure", reportId: "envio-261007-abort" }, "261007", HALT, at("07"));
    assert.deepEqual(
      f.map((x) => x.fingerprint),
      [FP, "261007:alarm-failure:envio-261007-abort"],
    );
    assert.match(f[0].body, /nenhum `-vencida` hoje/);
  });

  it("achado 1: parada ainda DENTRO do limite e relatório OK => nenhum achado", () => {
    assert.ok(HALT.halted && !HALT.invalid);
    const fresh: ClariceEnvioHaltRead = { halted: true, invalid: false, halt: { ...HALT.halt, since: "2026-10-05T22:00:00.000Z" } };
    assert.deepEqual(buildEnvioAlarmFindings({ verdict: "ok", reportId: "envio-261006-fila-insuficiente-pendente" }, "261006", fresh, at("06")), []);
  });

  it("achado 1: arquivo de parada ilegível conta como vencida mesmo sem relatório -vencida", () => {
    const f = buildEnvioAlarmFindings({ verdict: "ok", reportId: "envio-261006" }, "261006", { halted: true, invalid: true, error: "x" }, at("06"));
    assert.deepEqual(f.map((x) => x.fingerprint), ["halt:ilegivel"]);
  });

  it("achado 2: relatório -vencida mas parada já limpa (--clear antes das 20:30) => nenhum achado, nada de halt:sem-arquivo", () => {
    assert.deepEqual(buildEnvioAlarmFindings(stale("261005"), "261005", { halted: false }, at("05")), []);
    assert.deepEqual(buildEnvioAlarmFindings(stale("261005"), "261005", null, at("05")), []);
  });

  it("achado 2: depois do --clear a issue real avança a streak e fecha — sem issue nova", () => {
    const { calls, run } = mockGh();
    let state: AlarmIssuesState = {};
    state = applyAlarmReconciliation(buildEnvioAlarmFindings(stale("261005"), "261005", HALT, at("05")), state, { cwd: "/repo", closeAfterRuns: 2, run }).nextState;
    state = applyAlarmReconciliation(buildEnvioAlarmFindings(stale("261006"), "261006", { halted: false }, at("06")), state, { cwd: "/repo", closeAfterRuns: 2, run }).nextState;
    applyAlarmReconciliation(buildEnvioAlarmFindings({ verdict: "ok", reportId: "envio-261007" }, "261007", { halted: false }, at("07")), state, { cwd: "/repo", closeAfterRuns: 2, run });
    assert.equal(calls.creates, 1, "o --clear não abre issue halt:sem-arquivo");
    assert.equal(calls.closes, 1, "a issue da parada fecha sozinha");
  });

  it("e-mail sem relatório -vencida aponta pro arquivo de parada, não pra relatório inexistente", () => {
    const { subject, body } = buildHaltStaleAlarmEmail(null, { issueNumber: 9001, url: "u", action: "created" });
    assert.match(body, /data\/clarice-envio-halt\.json/);
    assert.doesNotMatch(body, /envio-reports/);
    assert.match(body, /--clear/);
    assert.match(subject, /rampa parada/);
  });
});
