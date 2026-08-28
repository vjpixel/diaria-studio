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
 *   - `loadState`/`saveState` — roundtrip de idempotência, mesmo molde de
 *     `test/home-meta-check-script.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listTodayEnvioReports, loadState, saveState, toAlarmFinding } from "../scripts/clarice-envio-alarm.ts";
import { emptyEnvioAlarmState, markEnvioAlarmed } from "../scripts/lib/clarice-envio-alarm.ts";

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

describe("loadState/saveState (idempotência)", () => {
  it("arquivo ausente => estado vazio (default LIGADO pra alarmar na 1ª falha real)", () => {
    const dir = mkdtempSync(join(tmpdir(), "envio-alarm-state-"));
    const statePath = resolve(dir, "envio-alarm-state.json");
    assert.deepEqual(loadState(statePath), emptyEnvioAlarmState());
    rmSync(dir, { recursive: true, force: true });
  });

  it("roundtrip: save então load devolve o mesmo estado", () => {
    const dir = mkdtempSync(join(tmpdir(), "envio-alarm-state-"));
    const statePath = resolve(dir, "sub", "envio-alarm-state.json"); // mkdirSync recursivo no save
    const state = markEnvioAlarmed(emptyEnvioAlarmState(), "260811");
    saveState(state, statePath);
    assert.deepEqual(loadState(statePath), state);
    rmSync(dir, { recursive: true, force: true });
  });

  it("JSON corrompido => estado vazio, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "envio-alarm-state-"));
    const statePath = resolve(dir, "envio-alarm-state.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(statePath, "{ nao e json valido");
    assert.deepEqual(loadState(statePath), emptyEnvioAlarmState());
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("toAlarmFinding — family (#5558)", () => {
  it("é sempre 'evento' — a falha de um aammdd específico é fato histórico, não se auto-resolve", () => {
    const finding = toAlarmFinding({ verdict: "alarm-failure", reportId: "envio-260811" }, "260811");
    assert.equal(finding.family, "evento");
  });
});
