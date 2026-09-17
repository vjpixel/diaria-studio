/**
 * test/log-stage4-adjust-timing-cli.test.ts (#8123 Fatia 5)
 *
 * Testes de CLI (subprocess) do wrapper `scripts/log-stage4-adjust-timing.ts`:
 * grava evento no run-log com os 3 deltas + nº de chamadas, exit codes de
 * validação, e nunca lança pro caller em input malformado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(PROJECT_ROOT, "scripts", "log-stage4-adjust-timing.ts");

function runCli(args: string[], rootDir: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT_PATH, ...args, "--root-dir", rootDir],
    { encoding: "utf8", cwd: PROJECT_ROOT },
  );
}

function makeTmpRoot(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "log-stage4-adjust-timing-cli-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("log-stage4-adjust-timing.ts — CLI", () => {
  it("loga o evento no run-log com os 3 deltas + toolCalls, e imprime as métricas em stdout", () => {
    const { dir, cleanup } = makeTmpRoot();
    try {
      const res = runCli(
        [
          "--edition",
          "260918",
          "--requested-at",
          "2026-09-18T12:00:00.000Z",
          "--edited-at",
          "2026-09-18T12:00:02.000Z",
          "--preview-served-at",
          "2026-09-18T12:00:07.000Z",
          "--calls",
          "3",
          "--description",
          "troca titulo D2",
        ],
        dir,
      );
      assert.equal(res.status, 0, res.stderr);

      const stdoutMetrics = JSON.parse(res.stdout.trim());
      assert.equal(stdoutMetrics.requestToPreviewMs, 7000);
      assert.equal(stdoutMetrics.withinTarget10s, true);

      const logPath = join(dir, "data", "run-log.jsonl");
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      const event = JSON.parse(lines[lines.length - 1]);
      assert.equal(event.edition, "260918");
      assert.equal(event.stage, 4);
      assert.equal(event.agent, "orchestrator");
      assert.equal(event.level, "info");
      assert.match(event.message, /timing do ajustar/);
      assert.equal(event.details.description, "troca titulo D2");
      assert.equal(event.details.requestToEditMs, 2000);
      assert.equal(event.details.editToPreviewMs, 5000);
      assert.equal(event.details.requestToPreviewMs, 7000);
      assert.equal(event.details.toolCalls, 3);
      assert.equal(event.details.withinTarget10s, true);
    } finally {
      cleanup();
    }
  });

  it("loga level=warn quando o delta pedido→preview excede o alvo de 10s", () => {
    const { dir, cleanup } = makeTmpRoot();
    try {
      const res = runCli(
        [
          "--edition",
          "260918",
          "--requested-at",
          "2026-09-18T12:00:00.000Z",
          "--edited-at",
          "2026-09-18T12:00:15.000Z",
          "--preview-served-at",
          "2026-09-18T12:00:45.000Z",
          "--calls",
          "27",
        ],
        dir,
      );
      assert.equal(res.status, 0, res.stderr);
      const logPath = join(dir, "data", "run-log.jsonl");
      const event = JSON.parse(readFileSync(logPath, "utf8").trim());
      assert.equal(event.level, "warn");
      assert.equal(event.details.withinTarget10s, false);
    } finally {
      cleanup();
    }
  });

  it("exit 2 quando faltam flags obrigatórias, sem gravar nada no run-log", () => {
    const { dir, cleanup } = makeTmpRoot();
    try {
      const res = runCli(["--edition", "260918"], dir);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /requested-at/);
    } finally {
      cleanup();
    }
  });

  it("exit 2 em --calls não-inteiro, sem lançar/crashar", () => {
    const { dir, cleanup } = makeTmpRoot();
    try {
      const res = runCli(
        [
          "--edition",
          "260918",
          "--requested-at",
          "2026-09-18T12:00:00.000Z",
          "--edited-at",
          "2026-09-18T12:00:02.000Z",
          "--preview-served-at",
          "2026-09-18T12:00:07.000Z",
          "--calls",
          "abc",
        ],
        dir,
      );
      assert.equal(res.status, 2);
      assert.match(res.stderr, /--calls/);
    } finally {
      cleanup();
    }
  });

  it("exit 2 em timestamp inválido, com mensagem acionável, sem lançar", () => {
    const { dir, cleanup } = makeTmpRoot();
    try {
      const res = runCli(
        [
          "--edition",
          "260918",
          "--requested-at",
          "not-a-date",
          "--edited-at",
          "2026-09-18T12:00:02.000Z",
          "--preview-served-at",
          "2026-09-18T12:00:07.000Z",
          "--calls",
          "1",
        ],
        dir,
      );
      assert.equal(res.status, 2);
      assert.match(res.stderr, /requestedAt/);
    } finally {
      cleanup();
    }
  });
});
