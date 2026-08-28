/**
 * test/stage4-decision.test.ts (#6447 Fatia 4, achado 7)
 *
 * `scripts/lib/stage4-decision.ts` — leitura/escrita de
 * `_internal/.step-4-decision.json` (decisão "gate 4 aprovado pelo painel").
 * Mesmo padrão de `test/stage4-capture-state.test.ts` (tmpdir real, sem
 * mock de fs) — a disciplina de lock+tmp+rename é a mesma dos dois módulos.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readStage4Decision,
  writeStage4ApprovedDecision,
  decideGateApproveAction,
  resolveStage4DecisionForConsumption,
} from "../scripts/lib/stage4-decision.ts";

describe("stage4-decision (#6447 Fatia 4, achado 7)", () => {
  let editionDir: string;

  beforeEach(() => {
    editionDir = mkdtempSync(join(tmpdir(), "stage4-decision-"));
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
  });
  afterEach(() => rmSync(editionDir, { recursive: true, force: true }));

  it("readStage4Decision: arquivo ausente -> null (caso normal)", () => {
    assert.equal(readStage4Decision(editionDir), null);
  });

  it("write depois read: round-trip completo", () => {
    const written = writeStage4ApprovedDecision(editionDir, { now: () => new Date("2026-08-28T12:00:00.000Z") });
    assert.equal(written.decision, "approved");
    assert.equal(written.decided_via, "studio");
    assert.equal(written.decided_at, "2026-08-28T12:00:00.000Z");

    const read = readStage4Decision(editionDir);
    assert.deepEqual(read, written);
  });

  it("JSON corrompido -> null, nunca lança", () => {
    writeFileSync(resolve(editionDir, "_internal", ".step-4-decision.json"), "{not json", "utf8");
    assert.equal(readStage4Decision(editionDir), null);
  });

  it("shape inesperado (decision != 'approved') -> null", () => {
    writeFileSync(
      resolve(editionDir, "_internal", ".step-4-decision.json"),
      JSON.stringify({ decision: "rejected", decided_at: "2026-08-28T12:00:00.000Z" }),
      "utf8",
    );
    assert.equal(readStage4Decision(editionDir), null);
  });

  it("2ª escrita sobrescreve a 1ª com novo timestamp", () => {
    writeStage4ApprovedDecision(editionDir, { now: () => new Date("2026-08-28T12:00:00.000Z") });
    const second = writeStage4ApprovedDecision(editionDir, { now: () => new Date("2026-08-28T13:00:00.000Z") });
    assert.equal(second.decided_at, "2026-08-28T13:00:00.000Z");
    assert.equal(readStage4Decision(editionDir)?.decided_at, "2026-08-28T13:00:00.000Z");
  });

  it("escrita é atômica (tmp+rename) — nunca deixa .tmp órfão", () => {
    writeStage4ApprovedDecision(editionDir);
    assert.throws(() => readFileSync(resolve(editionDir, "_internal", ".step-4-decision.json.tmp")));
  });
});

describe("decideGateApproveAction (#6447 Fatia 4, achado 7 — guard de duplo-approve)", () => {
  it("nunca aprovado antes -> write, mesmo sem force", () => {
    assert.deepEqual(decideGateApproveAction(null, false), { kind: "write" });
  });

  it("já aprovado, sem force -> conflict com a decisão existente", () => {
    const existing = { decision: "approved" as const, decided_at: "2026-08-28T12:00:00.000Z", decided_via: "studio" as const };
    const result = decideGateApproveAction(existing, false);
    assert.equal(result.kind, "conflict");
    assert.deepEqual((result as { kind: "conflict"; existing: typeof existing }).existing, existing);
  });

  it("já aprovado, com force:true -> write (sobrescreve)", () => {
    const existing = { decision: "approved" as const, decided_at: "2026-08-28T12:00:00.000Z", decided_via: "studio" as const };
    assert.deepEqual(decideGateApproveAction(existing, true), { kind: "write" });
  });
});

describe("resolveStage4DecisionForConsumption (#6444 — consumo da decisão pelo orchestrator §4d)", () => {
  const APPROVED_AT_NOON = { decision: "approved" as const, decided_at: "2026-08-28T12:00:00.000Z", decided_via: "studio" as const };
  const BEFORE_NOON_MS = Date.parse("2026-08-28T11:00:00.000Z");
  const AFTER_NOON_MS = Date.parse("2026-08-28T13:00:00.000Z");

  it("decisão ausente (null) -> usable:false, reason:absent", () => {
    assert.deepEqual(resolveStage4DecisionForConsumption(null, []), {
      usable: false,
      reason: "absent",
      decision: null,
    });
  });

  it("decisão presente, nenhum conteúdo mais recente -> usable:true", () => {
    const result = resolveStage4DecisionForConsumption(APPROVED_AT_NOON, [BEFORE_NOON_MS, BEFORE_NOON_MS]);
    assert.equal(result.usable, true);
    assert.deepEqual(result.decision, APPROVED_AT_NOON);
  });

  it("nenhum content mtime (lista vazia) -> usable:true (nada pra invalidar)", () => {
    assert.equal(resolveStage4DecisionForConsumption(APPROVED_AT_NOON, []).usable, true);
  });

  it("conteúdo mudou DEPOIS da decisão -> usable:false, reason:stale (não descarta a decisão do retorno)", () => {
    const result = resolveStage4DecisionForConsumption(APPROVED_AT_NOON, [BEFORE_NOON_MS, AFTER_NOON_MS]);
    assert.equal(result.usable, false);
    assert.equal(result.reason, "stale");
    assert.deepEqual(result.decision, APPROVED_AT_NOON);
  });

  it("decided_at não-parseável -> usable:false, reason:absent (nunca lança)", () => {
    const corrupted = { decision: "approved" as const, decided_at: "não-é-data", decided_via: "studio" as const };
    assert.deepEqual(resolveStage4DecisionForConsumption(corrupted, []), {
      usable: false,
      reason: "absent",
      decision: null,
    });
  });
});

describe("CLI --content-files (#6444 — integração read + freshness via subprocess)", () => {
  let editionDir: string;

  beforeEach(() => {
    editionDir = mkdtempSync(join(tmpdir(), "stage4-decision-cli-"));
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
  });
  afterEach(() => rmSync(editionDir, { recursive: true, force: true }));

  function runCli(args: string[]): { stdout: string; status: number | null } {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "lib", "stage4-decision.ts");
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 15000,
    });
    return { stdout: result.stdout.trim(), status: result.status };
  }

  it("--read sem --content-files, decisão ausente -> imprime null", () => {
    const { stdout } = runCli(["--edition-dir", editionDir, "--read"]);
    assert.equal(stdout, "null");
  });

  it("--read com --content-files, arquivo mais novo que a decisão -> usable:false/stale", () => {
    writeStage4ApprovedDecision(editionDir, { now: () => new Date("2026-08-28T12:00:00.000Z") });
    const contentPath = resolve(editionDir, "02-reviewed.md");
    writeFileSync(contentPath, "conteúdo editado depois da aprovação", "utf8");
    const future = new Date("2026-08-28T13:00:00.000Z");
    utimesSync(contentPath, future, future);

    const { stdout } = runCli(["--edition-dir", editionDir, "--read", "--content-files", "02-reviewed.md"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.usable, false);
    assert.equal(parsed.reason, "stale");
  });

  it("--read com --content-files, arquivo ausente não invalida a decisão -> usable:true", () => {
    writeStage4ApprovedDecision(editionDir, { now: () => new Date("2026-08-28T12:00:00.000Z") });
    const { stdout } = runCli(["--edition-dir", editionDir, "--read", "--content-files", "arquivo-que-nao-existe.md"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.usable, true);
  });
});
