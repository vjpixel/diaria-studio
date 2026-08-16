/**
 * test/preflight-state.test.ts (#5414)
 *
 * Cobre `scripts/lib/preflight-state.ts` — o requisito central da issue:
 * um stage disparado como sessão nova (Stage 2, Stage 5) precisa conseguir
 * ler os 5 sinais de saúde de dependência externa apurados pelo Stage 0
 * SEM depender de memória de conversa, lendo direto do disco.
 *
 *   1. Lógica pura — fixture de diretório temporário: default fail-soft,
 *      round-trip write/read, upsert parcial não apaga outros campos,
 *      `capturedAt` avança, corpo corrompido/shape errado não lança.
 *   2. Contrato CLI — `--edition-dir` + flags de escrita, `--read`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPreflightState,
  writePreflightState,
  type PreflightState,
} from "../scripts/lib/preflight-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "lib", "preflight-state.ts");

const DEFAULT: PreflightState = {
  chromeMcp: null,
  gmailMcp: null,
  beehiivMcp: null,
  clariceRest: null,
  cloudflareTokenOk: null,
  capturedAt: null,
};

describe("readPreflightState / writePreflightState (#5414, pure)", () => {
  let editionDir: string;

  before(() => {
    editionDir = mkdtempSync(join(tmpdir(), "preflight-state-"));
  });

  after(() => {
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("sem _internal/preflight-state.json -> default (todos null)", () => {
    assert.deepEqual(readPreflightState(editionDir), DEFAULT);
  });

  it("writePreflightState grava e readPreflightState reflete, com capturedAt", () => {
    const written = writePreflightState(
      editionDir,
      { chromeMcp: true, clariceRest: false },
      { now: () => new Date("2026-08-16T10:00:00.000Z") },
    );
    assert.equal(written.chromeMcp, true);
    assert.equal(written.clariceRest, false);
    assert.equal(written.capturedAt, "2026-08-16T10:00:00.000Z");

    const read = readPreflightState(editionDir);
    assert.deepEqual(read, {
      ...DEFAULT,
      chromeMcp: true,
      clariceRest: false,
      capturedAt: "2026-08-16T10:00:00.000Z",
    });
  });

  it("write parcial subsequente faz upsert — não apaga campos já gravados", () => {
    writePreflightState(editionDir, { gmailMcp: true }, { now: () => new Date("2026-08-16T10:05:00.000Z") });
    const read = readPreflightState(editionDir);
    // campos do write anterior continuam presentes
    assert.equal(read.chromeMcp, true);
    assert.equal(read.clariceRest, false);
    // campo novo entrou
    assert.equal(read.gmailMcp, true);
    // capturedAt avançou para o write mais recente
    assert.equal(read.capturedAt, "2026-08-16T10:05:00.000Z");
  });

  it("write posterior sobrescreve um campo já setado", () => {
    writePreflightState(editionDir, { chromeMcp: false }, { now: () => new Date("2026-08-16T10:10:00.000Z") });
    assert.equal(readPreflightState(editionDir).chromeMcp, false);
  });

  it("cria _internal/ se ainda não existir", () => {
    const fresh = mkdtempSync(join(tmpdir(), "preflight-state-nodir-"));
    assert.equal(existsSync(join(fresh, "_internal")), false);
    writePreflightState(fresh, { beehiivMcp: true });
    assert.equal(existsSync(join(fresh, "_internal", "preflight-state.json")), true);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("JSON corrompido -> default fail-soft, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-state-corrupt-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "preflight-state.json"), "{ isso não é json", "utf8");
    assert.deepEqual(readPreflightState(dir), DEFAULT);
    rmSync(dir, { recursive: true, force: true });
  });

  it("shape com campo de tipo errado -> normaliza esse campo pra null, resto ok", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-state-badtype-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(
      join(dir, "_internal", "preflight-state.json"),
      JSON.stringify({ chromeMcp: "sim", gmailMcp: true, capturedAt: 123 }),
      "utf8",
    );
    assert.deepEqual(readPreflightState(dir), { ...DEFAULT, chromeMcp: null, gmailMcp: true, capturedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });

  it("nunca sobrescreve/reaproveita outro arquivo sob _internal/ — path é dedicado", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-state-dedicated-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const other = join(dir, "_internal", "outro-estado.json");
    writeFileSync(other, JSON.stringify({ hello: "world" }), "utf8");
    writePreflightState(dir, { chromeMcp: true });
    assert.equal(JSON.parse(readFileSync(other, "utf8")).hello, "world");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("preflight-state.ts CLI (#5414)", () => {
  let editionDir: string;

  before(() => {
    editionDir = mkdtempSync(join(tmpdir(), "preflight-state-cli-"));
  });

  after(() => {
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("--read sem arquivo -> JSON default", () => {
    const out = execFileSync("npx", ["tsx", SCRIPT, "--edition-dir", editionDir, "--read"], {
      encoding: "utf8",
      cwd: ROOT,
      shell: true,
    });
    assert.deepEqual(JSON.parse(out.trim()), DEFAULT);
  });

  it("escrever via flags e reler via --read", () => {
    execFileSync(
      "npx",
      ["tsx", SCRIPT, "--edition-dir", editionDir, "--chrome-mcp", "true", "--clarice-rest", "false"],
      { cwd: ROOT, shell: true },
    );
    const out = execFileSync("npx", ["tsx", SCRIPT, "--edition-dir", editionDir, "--read"], {
      encoding: "utf8",
      cwd: ROOT,
      shell: true,
    });
    const state = JSON.parse(out.trim());
    assert.equal(state.chromeMcp, true);
    assert.equal(state.clariceRest, false);
    assert.ok(state.capturedAt);
  });

  it("sem --edition-dir -> exit != 0", () => {
    assert.throws(() => {
      execFileSync("npx", ["tsx", SCRIPT, "--read"], { cwd: ROOT, shell: true, stdio: "pipe" });
    });
  });

  it("sem flags de escrita e sem --read -> exit != 0", () => {
    assert.throws(() => {
      execFileSync("npx", ["tsx", SCRIPT, "--edition-dir", editionDir], { cwd: ROOT, shell: true, stdio: "pipe" });
    });
  });
});
