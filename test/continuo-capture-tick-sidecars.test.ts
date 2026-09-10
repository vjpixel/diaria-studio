/**
 * test/continuo-capture-tick-sidecars.test.ts (#7814)
 *
 * Regressão de integração pro CLI: log de exemplo -> sidecars persistidos
 * em disco, idempotência entre 2 rodadas, e poda por retenção.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = new URL("../scripts/continuo-capture-tick-sidecars.ts", import.meta.url).pathname;

function runCli(args: string[]): { stdout: string; stderr: string } {
  const result = execFileSync("npx", ["tsx", SCRIPT, ...args], { encoding: "utf8" });
  return { stdout: result, stderr: "" };
}

describe("continuo-capture-tick-sidecars CLI", () => {
  it("extrai sidecars de um agent.log de exemplo, idempotente, e poda os velhos", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuo-sidecar-test-"));
    const logsDir = join(dir, "logs");
    const sidecarDir = join(dir, "sidecars");
    mkdirSync(logsDir, { recursive: true });

    const logLines = [
      // sessão encerrada há muito tempo (deve ser capturada)
      "2026-09-09 09:00:00,000 INFO [cron_5d791ef6fc2c_20260909_085000] agent.tool_executor: tool write_file completed (0.20s, 611 chars)",
      "2026-09-09 09:00:05,000 INFO [cron_5d791ef6fc2c_20260909_085000] agent.tool_executor: tool terminal completed (1.0s, 100 chars)",
      // sessão ainda "em andamento" (perto de now, não deve ser capturada)
      "2026-09-09 11:55:00,000 INFO [cron_5d791ef6fc2c_20260909_115000] agent.tool_executor: tool terminal completed (1.0s, 50 chars)",
      // outra sessão, de outro job (fora do prefixo, nunca capturada)
      "2026-09-09 09:00:00,000 INFO [cron_outrojob_20260909_085000] agent.tool_executor: tool terminal completed (1.0s, 10 chars)",
      // linha sem bracket (ignorada)
      '2026-09-09 09:00:01,000 INFO agent.tool_executor: tool read_file failed (0.05s): {"error": "x"}',
    ].join("\n");
    writeFileSync(join(logsDir, "agent.log"), logLines, "utf8");

    const nowIso = "2026-09-09T12:00:00.000Z";

    const out1 = runCli([
      "--logs-dir", logsDir,
      "--sidecar-dir", sidecarDir,
      "--now-iso", nowIso,
      "--min-idle-minutes", "60",
      "--json",
    ]);
    const summary1 = JSON.parse(out1.stdout);
    assert.deepEqual(summary1.captured, ["cron_5d791ef6fc2c_20260909_085000"]);

    const sidecarPath = join(sidecarDir, "cron_5d791ef6fc2c_20260909_085000.json");
    assert.ok(existsSync(sidecarPath), "sidecar deveria ter sido escrito");
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    assert.equal(sidecar.sessionId, "cron_5d791ef6fc2c_20260909_085000");
    assert.equal(sidecar.toolCallCount, 2);
    assert.equal(sidecar.toolCalls[0].tool, "write_file");
    assert.equal(sidecar.toolCalls[0].sizeChars, 611);

    // sessão em andamento (perto de now) NÃO foi capturada ainda
    assert.ok(!existsSync(join(sidecarDir, "cron_5d791ef6fc2c_20260909_115000.json")));
    // sessão de outro job nunca é capturada
    assert.ok(!existsSync(join(sidecarDir, "cron_outrojob_20260909_085000.json")));

    // 2ª rodada, mesmo log: idempotente — nada novo capturado pra sessão já existente
    const out2 = runCli([
      "--logs-dir", logsDir,
      "--sidecar-dir", sidecarDir,
      "--now-iso", nowIso,
      "--min-idle-minutes", "60",
      "--json",
    ]);
    const summary2 = JSON.parse(out2.stdout);
    assert.deepEqual(summary2.captured, []);

    // poda: sidecar "velho" (mais de 1 dia antes de nowFuture) some
    const nowFuture = "2026-11-01T00:00:00.000Z";
    const out3 = runCli([
      "--logs-dir", logsDir,
      "--sidecar-dir", sidecarDir,
      "--now-iso", nowFuture,
      "--max-age-days", "1",
      "--json",
    ]);
    const summary3 = JSON.parse(out3.stdout);
    assert.deepEqual(summary3.pruned, ["cron_5d791ef6fc2c_20260909_085000.json"]);
    assert.ok(!existsSync(sidecarPath));

    rmSync(dir, { recursive: true, force: true });
  });

  it("sidecar corrompido pré-existente (write não-atômico interrompido): fica intocado, nunca recapturado nem podado (#7889)", () => {
    // Cenário exato do finding P2 do self-review: um `.json` truncado/inválido
    // já presente em `sidecar-dir` — simula o que um `writeFileSync` direto
    // (não-atômico) deixaria pra trás se o processo morresse no meio da
    // escrita. `renameSync` corrige a ESCRITA daqui pra frente, mas o teste
    // confirma que, SE um arquivo assim existir por algum motivo residual, o
    // fluxo de captura/poda não quebra nem re-processa a sessão.
    const dir = mkdtempSync(join(tmpdir(), "continuo-sidecar-test-corrupt-"));
    const logsDir = join(dir, "logs");
    const sidecarDir = join(dir, "sidecars");
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(sidecarDir, { recursive: true });

    const sessionId = "cron_5d791ef6fc2c_20260909_085000";
    const logLines = [
      `2026-09-09 09:00:00,000 INFO [${sessionId}] agent.tool_executor: tool write_file completed (0.20s, 611 chars)`,
      `2026-09-09 09:00:05,000 INFO [${sessionId}] agent.tool_executor: tool terminal completed (1.0s, 100 chars)`,
    ].join("\n");
    writeFileSync(join(logsDir, "agent.log"), logLines, "utf8");

    // JSON truncado — exatamente o estado que um kill no meio de writeFileSync deixaria.
    const corruptPath = join(sidecarDir, `${sessionId}.json`);
    writeFileSync(corruptPath, '{"sessionId": "cron_5d791ef6fc2c_20260909_085000", "toolCa', "utf8");

    const nowIso = "2026-09-09T12:00:00.000Z";
    const out = runCli([
      "--logs-dir", logsDir,
      "--sidecar-dir", sidecarDir,
      "--now-iso", nowIso,
      "--min-idle-minutes", "60",
      "--json",
    ]);
    const summary = JSON.parse(out.stdout);

    // Não recapturado: o nome do arquivo já existe (listAlreadyCaptured só
    // checa existência), então a sessão nunca entra em `toCapture`.
    assert.deepEqual(summary.captured, []);
    // Não podado: `capturedAt` ilegível (JSON.parse falha -> "") é
    // "indeterminado", e indeterminado nunca vira remoção (selectSidecarsToPrune).
    assert.deepEqual(summary.pruned, []);
    // O arquivo corrompido permanece exatamente como estava — intocado.
    assert.equal(readFileSync(corruptPath, "utf8"), '{"sessionId": "cron_5d791ef6fc2c_20260909_085000", "toolCa');

    rmSync(dir, { recursive: true, force: true });
  });

  it("logs-dir ausente: sai limpo (exit 0), sem capturar nada", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuo-sidecar-test-empty-"));
    const out = runCli(["--logs-dir", join(dir, "nao-existe"), "--sidecar-dir", join(dir, "sidecars"), "--json"]);
    const summary = JSON.parse(out.stdout);
    assert.deepEqual(summary.captured, []);
    assert.deepEqual(summary.logFiles, []);
    rmSync(dir, { recursive: true, force: true });
  });
});
