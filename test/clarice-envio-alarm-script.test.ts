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
import {
  buildEnvioAlarmEmailForOutcomes,
  buildEnvioAlarmFindings,
  holdDecisionDriftEntries,
  isEditorDecisionFinding,
  isHaltFingerprint,
  listTodayEnvioReports,
  splitOutcomesBySeverity,
  toAlarmFinding,
} from "../scripts/clarice-envio-alarm.ts";
import { buildHaltStaleAlarmEmail } from "../scripts/lib/clarice-envio-alarm.ts";
import { applyAlarmReconciliation, type AlarmIssuesState, type GhRunFn } from "../scripts/lib/alarm-issues.ts";
import {
  HALT_STALE_REPORT_SUFFIX,
  haltAlarmFingerprint,
  type ClariceEnvioBaseCollapseRead,
  type ClariceEnvioHaltRead,
} from "../scripts/lib/clarice-envio-halt.ts";
import { classifyExecTrack } from "../scripts/lib/issue-exec-track.ts";
import { notifyEditorForOutcomes } from "../scripts/lib/editor-notify.ts";
import type { DecisionStateCheck } from "../scripts/lib/decision-state-drift.ts";

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

// ─── #10208 — achados que só o editor decide chegam ao editor e ficam fora da fila autônoma ───

describe("#10208 — severidade e rota dos achados de decisão do editor", () => {
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
  const at = (day: string) => new Date(`2026-10-${day}T23:30:00.000Z`);
  const issueLabels = (f: { labels?: string[]; priority?: string }) => [...(f.labels ?? []), "alarm", f.priority ?? "P2"];

  const decisionFindings = () => [
    toAlarmFinding({ verdict: "alarm-failure", reportId: `envio-261005${HALT_STALE_REPORT_SUFFIX}` }, "261005", HALT),
    toAlarmFinding({ verdict: "alarm-failure", reportId: "envio-261013-base-colapsada" }, "261013"),
    toAlarmFinding({ verdict: "alarm-failure", reportId: "envio-261013-fila-insuficiente-halt-write-failed" }, "261013"),
  ];

  it("parada vencida, base colapsada e parada não gravada nascem develop-track → classifyExecTrack = develop (nunca overnight)", () => {
    for (const f of decisionFindings()) {
      assert.ok(f.labels?.includes("develop-track"), f.fingerprint);
      assert.equal(classifyExecTrack({ labels: issueLabels(f), body: f.body }), "develop", f.fingerprint);
      assert.equal(isEditorDecisionFinding(f.fingerprint), true, f.fingerprint);
    }
  });

  it("falha comum do dia continua fora do develop-track e com severidade acao", () => {
    const f = toAlarmFinding({ verdict: "alarm-failure", reportId: "envio-261005-abort" }, "261005");
    assert.ok(!f.labels?.includes("develop-track"));
    assert.equal(isEditorDecisionFinding(f.fingerprint), false);
  });

  it("parada não gravada (#10115) tem texto próprio: nunca 'falhou'/'monte a onda manualmente'", () => {
    const f = decisionFindings()[2];
    assert.doesNotMatch(f.title, /falhou/i);
    assert.match(f.body, /NÃO monte a onda manualmente/);
    assert.doesNotMatch(f.body, /Monte a onda manualmente via/);
    assert.match(f.body, /clarice-envio-enabled\.ts --set disabled/);
  });

  it("cenário real: parada vencida sob email_policy urgent_only MANDA e-mail (antes: só issue)", async () => {
    const findings = buildEnvioAlarmFindings(
      { verdict: "alarm-failure", reportId: `envio-261005${HALT_STALE_REPORT_SUFFIX}` },
      "261005",
      HALT,
      at("05"),
    );
    const outcomes = findings.map((f) => ({ check: f.check, fingerprint: f.fingerprint, issueNumber: 9001, url: "u", action: "created" as const }));
    const groups = splitOutcomesBySeverity(outcomes);
    assert.equal(groups.urgente.length, 1);
    assert.equal(groups.acao.length, 0);
    const sent: string[] = [];
    const sendPush = async (m: { subject: string }) => {
      sent.push(m.subject);
      return { ok: true };
    };
    const byFp = new Map(findings.map((f) => [f.fingerprint, f]));
    const evaluation = { verdict: "alarm-failure" as const, reportId: `envio-261005${HALT_STALE_REPORT_SUFFIX}` };
    const urg = await notifyEditorForOutcomes(groups.urgente, "urgente", (q) => buildEnvioAlarmEmailForOutcomes(q, evaluation, "261005", byFp), {
      emailPolicy: "urgent_only",
      sendPush,
    });
    assert.equal(urg.emailSent, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /rampa parada/);
    // Controle: a mesma issue com severidade "acao" (comportamento antigo) não manda nada.
    const old = await notifyEditorForOutcomes(groups.urgente, "acao", () => ({ subject: "x", body: "x" }), {
      emailPolicy: "urgent_only",
      sendPush,
    });
    assert.equal(old.emailSent, false);
  });

  it("vários achados qualificados viram UM e-mail com uma seção por achado", () => {
    const findings = decisionFindings();
    const outcomes = findings.map((f, i) => ({ check: f.check, fingerprint: f.fingerprint, issueNumber: 9000 + i, url: `u${i}`, action: "created" as const }));
    const email = buildEnvioAlarmEmailForOutcomes(
      outcomes,
      { verdict: "alarm-failure", reportId: "envio-261013-fila-insuficiente-halt-write-failed" },
      "261013",
      new Map(findings.map((f) => [f.fingerprint, f])),
    );
    assert.match(email.subject, /3 alarmes/);
    assert.match(email.body, /rampa parada há tempo demais/);
    assert.match(email.body, /volume-base da rampa colapsou/);
    assert.match(email.body, /NÃO gravada/);
  });
});

// ─── #10209 item 3 — base colapsada lida do ESTADO, não só do relatório do dia ───

describe("#10209 — base colapsada persiste entre dias sem relatório -base-colapsada", () => {
  const COLLAPSE: ClariceEnvioBaseCollapseRead = {
    collapsed: true,
    invalid: false,
    state: {
      detectedAt: "2026-10-13T22:00:00.000Z",
      reportId: "envio-261013-base-colapsada",
      baseVolume: 101,
      baseDay: "2026-10-13",
      peakVolume: 40_180,
      peakDay: "2026-10-10",
      fraction: 101 / 40_180,
    },
  };
  const at = (day: string) => new Date(`2026-10-${day}T23:30:00.000Z`);

  function mockGh() {
    const calls = { creates: 0, closes: 0 };
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
      if (args[0] === "issue" && args[1] === "create") {
        calls.creates++;
        return { status: 0, stdout: "https://github.com/x/y/issues/9002\n", stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "view") return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
      if (args[0] === "issue" && args[1] === "close") {
        calls.closes++;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "comment") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "label") return { status: 0, stdout: "", stderr: "" };
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    return { calls, run };
  }

  it("dias -paused / sem relatório com o colapso ainda gravado NÃO fecham a issue", () => {
    const days = [
      { aammdd: "261013", evaluation: { verdict: "alarm-failure" as const, reportId: "envio-261013-base-colapsada" } },
      { aammdd: "261014", evaluation: { verdict: "ok" as const, reportId: "envio-261014-paused" } },
      { aammdd: "261015", evaluation: { verdict: "alarm-no-report" as const, reportId: null } },
      { aammdd: "261016", evaluation: { verdict: "ok" as const, reportId: "envio-261016-paused" } },
    ];
    const { calls, run } = mockGh();
    let state: AlarmIssuesState = {};
    for (const d of days) {
      const findings = buildEnvioAlarmFindings(d.evaluation, d.aammdd, null, at(d.aammdd.slice(4)), { baseCollapse: COLLAPSE });
      assert.equal(findings.filter((f) => f.fingerprint === "base-colapsada").length, 1, d.aammdd);
      state = applyAlarmReconciliation(findings, state, { cwd: "/repo", closeAfterRuns: 2, run }).nextState;
    }
    assert.equal(calls.closes, 0, "issue do colapso não fecha enquanto o colapso continua gravado");
    // 1 issue de colapso + 1 evento (no-report).
    assert.equal(calls.creates, 2);
  });

  it("colapso apagado (rodada sem colapso / --accept-base) → issue fecha pela streak", () => {
    const { calls, run } = mockGh();
    let state: AlarmIssuesState = {};
    state = applyAlarmReconciliation(
      buildEnvioAlarmFindings({ verdict: "ok", reportId: "envio-261014-paused" }, "261014", null, at("14"), { baseCollapse: COLLAPSE }),
      state,
      { cwd: "/repo", closeAfterRuns: 2, run },
    ).nextState;
    for (const day of ["15", "16"]) {
      state = applyAlarmReconciliation(
        buildEnvioAlarmFindings({ verdict: "ok", reportId: `envio-2610${day}` }, `2610${day}`, null, at(day), { baseCollapse: { collapsed: false } }),
        state,
        { cwd: "/repo", closeAfterRuns: 2, run },
      ).nextState;
    }
    assert.equal(calls.closes, 1);
  });

  it("corpo traz os números do estado, o N mínimo e --accept-base primeiro", () => {
    const [f] = buildEnvioAlarmFindings({ verdict: "ok", reportId: "envio-261014-paused" }, "261014", null, at("14"), { baseCollapse: COLLAPSE });
    assert.match(f.body, /base 101 em 2026-10-13/);
    assert.match(f.body, /N ≥ 10045/);
    assert.ok(f.body.indexOf("--accept-base") < f.body.indexOf("--volume N"));
    assert.ok(f.labels?.includes("develop-track"));
  });

  it("relatório -base-colapsada sem arquivo (gravação falhou) ainda gera o achado", () => {
    const f = buildEnvioAlarmFindings({ verdict: "alarm-failure", reportId: "envio-261013-base-colapsada" }, "261013", null, at("13"), {
      baseCollapse: { collapsed: false },
    });
    assert.deepEqual(f.map((x) => x.fingerprint), ["base-colapsada"]);
  });
});

// ─── #10210 — decisão do editor contradita pelo toggle vira achado ───

describe("#10210 — alarme decisão×toggle vira finding", () => {
  const drift = (ok: boolean): DecisionStateCheck => ({
    issue: 8099,
    title: "Rampa Clarice",
    toggle: "clarice-envio-enabled",
    expectedEnabled: false,
    actualEnabled: !ok,
    ok,
    decision: {
      decided_at: "2026-09-30T12:00:00.000Z",
      pergunta: "manter a rampa pausada?",
      resposta: "manter pausada",
      sessao: "interactive",
      estado_esperado: { toggle: "clarice-envio-enabled", enabled: false },
    },
    toggleState: { enabled: !ok, updatedAt: "2026-10-01T10:00:00.000Z" },
  });
  const at = new Date("2026-10-05T23:30:00.000Z");

  it("cenário do incidente: decisão 'manter pausada' + toggle ligado + rodada enviou normal → achado urgente, develop-track", () => {
    const findings = buildEnvioAlarmFindings({ verdict: "ok", reportId: "envio-261005" }, "261005", null, at, { decisionChecks: [drift(false)] });
    assert.equal(findings.length, 1);
    const f = findings[0];
    assert.equal(f.fingerprint, "decisao-contradita:8099:clarice-envio-enabled:2026-09-30T12:00:00.000Z");
    assert.equal(f.family, "estado");
    assert.match(f.body, /DECISÃO CONTRADITA \(#8099/);
    assert.equal(isEditorDecisionFinding(f.fingerprint), true);
    assert.equal(classifyExecTrack({ labels: [...(f.labels ?? []), "alarm", "P2"], body: f.body }), "develop");
  });

  it("toggle de acordo com a decisão → nenhum achado; checagem indisponível (null) → nenhum achado", () => {
    assert.deepEqual(buildEnvioAlarmFindings({ verdict: "ok", reportId: "envio-261005" }, "261005", null, at, { decisionChecks: [drift(true)] }), []);
    assert.deepEqual(buildEnvioAlarmFindings({ verdict: "ok", reportId: "envio-261005" }, "261005", null, at, { decisionChecks: null }), []);
  });

  it("gh indisponível: entries de decisão contradita ficam fora da reconciliação (não avançam a streak de fechamento)", () => {
    const state = {
      "clarice-envio:decisao-contradita:8099:clarice-envio-enabled:2026-09-30T12:00:00.000Z": {
        issueNumber: 1,
        url: "u",
        missingStreak: 1,
        family: "estado",
      },
      "clarice-envio:base-colapsada": { issueNumber: 2, url: "u2", missingStreak: 0, family: "estado" },
    } as unknown as AlarmIssuesState;
    const { active, held } = holdDecisionDriftEntries(state);
    assert.deepEqual(Object.keys(held), ["clarice-envio:decisao-contradita:8099:clarice-envio-enabled:2026-09-30T12:00:00.000Z"]);
    assert.deepEqual(Object.keys(active), ["clarice-envio:base-colapsada"]);
  });
});
