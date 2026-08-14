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
import { listTodayGuardReports, loadState, saveState } from "../scripts/clarice-envio-guard-alarm.ts";
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
