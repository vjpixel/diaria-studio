/**
 * test/clarice-envio-guard-alarm-script.test.ts (#5220)
 *
 * Cobre a parte de I/O de `scripts/clarice-envio-guard-alarm.ts` que não
 * exige rede real nem `data/.credentials.json` (guard de #573/CLAUDE.md —
 * sem credencial Gmail real neste worktree; regra de dispatch overnight #738
 * proíbe qualquer chamada de rede real nesta sessão):
 *
 *   - `listTodayGuardReports` — glob + mtime, sobre um diretório temporário
 *     com arquivos `envio-{aammdd}-guard-*.md` reais (não mockado — é só fs
 *     local). Cobre o Gap 2 central: NUNCA pega um relatório do run das
 *     19:00 (sem `-guard`), mesmo do mesmo dia.
 *   - `loadState`/`saveState` — roundtrip de idempotência, mesmo molde de
 *     `test/clarice-envio-alarm-script.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listTodayGuardReports, loadState, saveState, toAlarmFinding } from "../scripts/clarice-envio-guard-alarm.ts";
import { emptyEnvioGuardAlarmState, markGuardAlarmed } from "../scripts/lib/clarice-envio-guard-alarm.ts";

describe("listTodayGuardReports", () => {
  it("diretório ausente (junction data/ não montada) => [] sem lançar", () => {
    const dir = resolve(mkdtempSync(join(tmpdir(), "envio-guard-alarm-")), "nao-existe");
    assert.deepEqual(listTodayGuardReports(dir, "260812"), []);
  });

  it("filtra só arquivos envio-{aammdd}-guard-*.md de HOJE — ignora outros dias e outros arquivos", () => {
    const dir = mkdtempSync(join(tmpdir(), "envio-guard-alarm-"));
    writeFileSync(resolve(dir, "envio-260812-guard-abort.md"), "x");
    writeFileSync(resolve(dir, "envio-260811-guard-ok.md"), "y"); // outro dia
    writeFileSync(resolve(dir, "leia-me.txt"), "z"); // não é .md
    const found = listTodayGuardReports(dir, "260812");
    assert.equal(found.length, 1);
    assert.equal(found[0].reportId, "envio-260812-guard-abort");
    assert.ok(found[0].mtimeMs > 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("NUNCA pega o relatório do RUN das 19:00 (envio-{aammdd}.md, sem '-guard') do MESMO dia — Gap 2 da issue #5220", () => {
    const dir = mkdtempSync(join(tmpdir(), "envio-guard-alarm-"));
    writeFileSync(resolve(dir, "envio-260812.md"), "run das 19:00, sucesso"); // MESMO dia, SEM -guard
    writeFileSync(resolve(dir, "envio-260812-paused.md"), "run pausado"); // idem
    writeFileSync(resolve(dir, "envio-260812-guard-ok.md"), "guard das 05:00, ok");
    const found = listTodayGuardReports(dir, "260812");
    assert.equal(found.length, 1, "só o -guard- deveria aparecer");
    assert.equal(found[0].reportId, "envio-260812-guard-ok");
    rmSync(dir, { recursive: true, force: true });
  });

  it("2 relatórios do mesmo dia (retry manual do guard) => os 2 aparecem, com mtime distinto", () => {
    const dir = mkdtempSync(join(tmpdir(), "envio-guard-alarm-"));
    writeFileSync(resolve(dir, "envio-260812-guard-abort.md"), "x");
    writeFileSync(resolve(dir, "envio-260812-guard-ok.md"), "y");
    const found = listTodayGuardReports(dir, "260812");
    assert.equal(found.length, 2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("loadState/saveState (idempotência)", () => {
  it("arquivo ausente => estado vazio (default LIGADO pra alarmar na 1ª falha real)", () => {
    const dir = mkdtempSync(join(tmpdir(), "envio-guard-alarm-state-"));
    const statePath = resolve(dir, "envio-guard-alarm-state.json");
    assert.deepEqual(loadState(statePath), emptyEnvioGuardAlarmState());
    rmSync(dir, { recursive: true, force: true });
  });

  it("roundtrip: save então load devolve o mesmo estado", () => {
    const dir = mkdtempSync(join(tmpdir(), "envio-guard-alarm-state-"));
    const statePath = resolve(dir, "sub", "envio-guard-alarm-state.json"); // mkdirSync recursivo no save
    const state = markGuardAlarmed(emptyEnvioGuardAlarmState(), "260812");
    saveState(state, statePath);
    assert.deepEqual(loadState(statePath), state);
    rmSync(dir, { recursive: true, force: true });
  });

  it("JSON corrompido => estado vazio, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "envio-guard-alarm-state-"));
    const statePath = resolve(dir, "envio-guard-alarm-state.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(statePath, "{ nao e json valido");
    assert.deepEqual(loadState(statePath), emptyEnvioGuardAlarmState());
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("toAlarmFinding — family (#5558)", () => {
  it("é sempre 'evento' — a falha de um aammdd específico é fato histórico, não se auto-resolve", () => {
    const finding = toAlarmFinding({ verdict: "alarm-failure", reportId: "envio-260811-guard" }, "260811");
    assert.equal(finding.family, "evento");
  });
});

// #6221 — achado ao vivo #6215: o alarme (verdict alarm-failure, título
// "falhou") levou um coordenador de overnight a ler uma escalada deliberada
// (override do editor vigente, #6134) como bug real, quase recomendando uma
// ação que teria revertido a decisão do editor. Cobre o vocabulário e o
// isolamento de dedup do verdict novo.
describe("toAlarmFinding — alarm-escalated (#6221)", () => {
  const reportId = "envio-260826-guard-prereq-fallback-override-vigente";

  it("family continua 'evento' (mesmo padrão dos outros verdicts, #5558)", () => {
    const finding = toAlarmFinding({ verdict: "alarm-escalated", reportId }, "260826");
    assert.equal(finding.family, "evento");
  });

  it('título NUNCA usa "falhou" — usa "escalou" e nomeia a causa (override do editor)', () => {
    const finding = toAlarmFinding({ verdict: "alarm-escalated", reportId }, "260826");
    assert.doesNotMatch(finding.title, /falhou/i);
    assert.match(finding.title, /escalou/i);
    assert.match(finding.title, /override/i);
  });

  it("corpo declara explicitamente que NENHUMA ação automática foi tomada e que é o comportamento desejado", () => {
    const finding = toAlarmFinding({ verdict: "alarm-escalated", reportId }, "260826");
    assert.match(finding.body, /N[ãa]O [ée] uma falha/i);
    assert.match(finding.body, /[Nn]enhuma a[çc][ãa]o autom[áa]tica\s+foi tomada/i);
    assert.match(finding.body, /comportamento DESEJADO/i);
  });

  it('label é "question" (decisão do editor a confirmar), NUNCA "bug" — não é defeito de código', () => {
    const finding = toAlarmFinding({ verdict: "alarm-escalated", reportId }, "260826");
    assert.deepEqual(finding.labels, ["question"]);
  });

  it("REGRESSÃO — fingerprint muda entre alarm-failure e alarm-escalated pro MESMO reportId/aammdd (dedup por verdict, #5339)", () => {
    const asFailure = toAlarmFinding({ verdict: "alarm-failure", reportId }, "260826");
    const asEscalated = toAlarmFinding({ verdict: "alarm-escalated", reportId }, "260826");
    // Documentado no PR #6262/#6221: como o verdict deste reportId MUDOU de
    // código pra código (era alarm-failure, agora é alarm-escalated), o
    // fingerprint (que inclui o verdict) também muda — um dia cujo alarme já
    // rodou sob o código ANTIGO (fingerprint com "alarm-failure") e recebe
    // uma 2ª execução no MESMO dia sob o código NOVO cria uma issue distinta
    // pro mesmo evento, em vez de reusar a issue antiga. Risco aceito e
    // documentado (janela de colisão: só "esta task rodar 2x no dia do
    // deploy") — nunca escondido.
    assert.notEqual(asFailure.fingerprint, asEscalated.fingerprint);
    assert.equal(asFailure.fingerprint, "260826:alarm-failure:envio-260826-guard-prereq-fallback-override-vigente");
    assert.equal(asEscalated.fingerprint, "260826:alarm-escalated:envio-260826-guard-prereq-fallback-override-vigente");
  });
});
