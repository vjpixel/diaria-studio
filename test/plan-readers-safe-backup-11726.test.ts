/**
 * #11726 — follow-up da #11721: os leitores restantes de `plan.json` de rodada
 * (statusline, gates de exec_track e surfaced-live, re-espera de CI) passam
 * pelo leitor único `readPlanJson`, que recupera a cópia de conflito do
 * OneDrive (`plan-{máquina}-safeBackup-{NNNN}.json`, #10579) antes de concluir
 * que a rodada não existe. Cenário real: o plano vivo some e só o backup fica
 * no diretório — antes cada um desses leitores tratava como "sem plano".
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readPlanFromDir } from "../scripts/overnight-statusline.ts";
import { applyQueueReawait } from "../scripts/lib/ci-queue-reawait.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  root = null;
});

/** Diretório de rodada com o plano vivo ausente e só a cópia de conflito do OneDrive. */
function roundWithOnlySafeBackup(plan: Record<string, unknown>): string {
  root = mkdtempSync(join(tmpdir(), "plan-readers-11726-"));
  writeFileSync(join(root, "plan-300-safeBackup-0001.json"), JSON.stringify(plan), "utf8");
  return join(root, "plan.json");
}

function runCli(script: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", resolve(ROOT, script), ...args], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

describe("readPlanFromDir (statusline) com plano só no safeBackup (#11726)", () => {
  it("devolve o plano recuperado, sem escrever nada em stderr", () => {
    const planPath = roundWithOnlySafeBackup({ issues: [{ number: 1, status: "elegivel" }] });
    const original = console.error;
    const errs: string[] = [];
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    let plan;
    try {
      plan = readPlanFromDir(planPath);
    } finally {
      console.error = original;
    }
    assert.ok(plan, "plano do backup deveria ser lido");
    assert.equal((plan as unknown as { issues: Array<{ number: number }> }).issues[0].number, 1);
    assert.deepEqual(errs, [], "statusline é caminho quente: nenhum aviso");
    assert.ok(existsSync(planPath), "plan.json restaurado a partir do backup");
  });

  it("sem plano e sem backup continua null", () => {
    root = mkdtempSync(join(tmpdir(), "plan-readers-11726-"));
    assert.equal(readPlanFromDir(join(root, "plan.json")), null);
  });
});

describe("check-exec-track-coverage com plano só no safeBackup (#11726)", () => {
  it("recupera e valida (exit 0) em vez de 'plan.json não encontrado'", () => {
    const planPath = roundWithOnlySafeBackup({ issues: [{ number: 1, exec_track_painel: "overnight" }] });
    const r = runCli("scripts/check-exec-track-coverage.ts", ["--plan", planPath]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /safeBackup/);
  });

  it("sem plano e sem backup segue exit 2", () => {
    root = mkdtempSync(join(tmpdir(), "plan-readers-11726-"));
    const r = runCli("scripts/check-exec-track-coverage.ts", ["--plan", join(root, "plan.json")]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /plan\.json não encontrado/);
  });
});

describe("check-surfaced-live com plano só no safeBackup (#11726)", () => {
  it("recupera e roda o gate (exit 0) em vez de 'plan.json não encontrado'", () => {
    const planPath = roundWithOnlySafeBackup({ issues: [] });
    const r = runCli("scripts/check-surfaced-live.ts", ["--plan", planPath]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /não encontrado/);
  });

  it("JSON ilegível segue exit 2 com a mesma mensagem", () => {
    root = mkdtempSync(join(tmpdir(), "plan-readers-11726-"));
    const planPath = join(root, "plan.json");
    writeFileSync(planPath, "{ truncado", "utf8");
    const r = runCli("scripts/check-surfaced-live.ts", ["--plan", planPath]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /plan\.json ilegível/);
  });
});

describe("applyQueueReawait com plano só no safeBackup (#11726)", () => {
  it("recupera o plano e grava o contador nele, sem perder o resto", () => {
    const planPath = roundWithOnlySafeBackup({ issues: [], marker: "vivo" });
    const decision = applyQueueReawait(planPath, 42, 7);
    assert.equal(decision.pr, 42);
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(written.marker, "vivo");
    assert.ok(written.ci_queue_reawaits);
  });
});
