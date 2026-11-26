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
  resolveContentFileMtimeMs,
  hashGateContentFile,
  computeGateContentHashes,
  changedGateContentFiles,
  parseGateContentHashes,
  UNREADABLE_CONTENT_HASH,
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

describe("resolveContentFileMtimeMs (#6444 achado do fleet review — erro não-ENOENT nunca vira 'sem sinal')", () => {
  it("ENOENT (arquivo genuinamente ausente) -> mtime 0", () => {
    const fakeStat = () => {
      const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    assert.equal(resolveContentFileMtimeMs("/qualquer/path.md", fakeStat), 0);
  });

  it("EACCES (erro de I/O real, não ausência) -> Infinity, nunca 0", () => {
    const fakeStat = () => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    };
    assert.equal(resolveContentFileMtimeMs("/qualquer/path.md", fakeStat), Infinity);
  });

  it("EBUSY (lock transitório) -> Infinity, nunca 0", () => {
    const fakeStat = () => {
      const err = new Error("EBUSY: resource busy") as NodeJS.ErrnoException;
      err.code = "EBUSY";
      throw err;
    };
    assert.equal(resolveContentFileMtimeMs("/qualquer/path.md", fakeStat), Infinity);
  });

  it("erro sem stat -> retorno flui pra resolveStage4DecisionForConsumption como stale, nunca usable:true", () => {
    // Reproduz o cenário do achado: um content file existe e MUDOU de verdade
    // depois de decided_at, mas o statSync falhou por um motivo não-ENOENT
    // (ex: lock do Windows durante um Write concorrente). O mtime resolvido
    // precisa forçar 'stale' — nunca ser indistinguível de "arquivo ausente".
    const decidedAtMs = new Date("2026-08-28T12:00:00.000Z").getTime();
    const failingStat = () => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    };
    const mtimeMs = resolveContentFileMtimeMs("/edited-but-unreadable.md", failingStat);
    const result = resolveStage4DecisionForConsumption(
      { decision: "approved", decided_at: new Date(decidedAtMs).toISOString(), decided_via: "studio" },
      [mtimeMs],
    );
    assert.equal(result.usable, false, "erro de I/O real nunca deve resultar em usable:true");
    assert.equal(result.reason, "stale");
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

  it("--read com --content-files, arquivo ausente (também ausente quando o painel carregou) -> usable:true", () => {
    writeStage4ApprovedDecision(editionDir, {
      now: () => new Date("2026-08-28T12:00:00.000Z"),
      contentHashes: { "arquivo-que-nao-existe.md": null },
    });
    const { stdout } = runCli(["--edition-dir", editionDir, "--read", "--content-files", "arquivo-que-nao-existe.md"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.usable, true);
  });
});

describe("#14134 — aprovação do painel vale só sobre o conteúdo que o painel mostrou", () => {
  let editionDir: string;

  beforeEach(() => {
    editionDir = mkdtempSync(join(tmpdir(), "stage4-decision-14134-"));
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
  });
  afterEach(() => rmSync(editionDir, { recursive: true, force: true }));

  it("hashGateContentFile: ENOENT -> null; erro de I/O real -> marcador ilegível, nunca null", () => {
    assert.equal(hashGateContentFile(resolve(editionDir, "nao-existe.md")), null);
    const eacces = () => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    };
    assert.equal(hashGateContentFile("/x.md", eacces), UNREADABLE_CONTENT_HASH);
  });

  it("computeGateContentHashes: sha256 estável do conteúdo, muda quando o conteúdo muda", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão A", "utf8");
    const a = computeGateContentHashes(editionDir);
    assert.match(a["02-reviewed.md"] ?? "", /^[0-9a-f]{64}$/);
    assert.equal(a["03-social.md"], null);
    assert.deepEqual(computeGateContentHashes(editionDir), a);
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão B", "utf8");
    assert.notEqual(computeGateContentHashes(editionDir)["02-reviewed.md"], a["02-reviewed.md"]);
  });

  it("changedGateContentFiles: igual -> []; mudou -> nomeia; arquivo novo -> recusa; sem hashes -> todos", () => {
    const shown = { "02-reviewed.md": "aaa", "03-social.md": null };
    assert.deepEqual(changedGateContentFiles(shown, { "02-reviewed.md": "aaa", "03-social.md": null }), []);
    assert.deepEqual(changedGateContentFiles(shown, { "02-reviewed.md": "bbb", "03-social.md": null }), ["02-reviewed.md"]);
    assert.deepEqual(changedGateContentFiles(shown, { "02-reviewed.md": "aaa", "03-social.md": "ccc" }), ["03-social.md"]);
    assert.deepEqual(changedGateContentFiles(null, { "02-reviewed.md": "aaa", "03-social.md": null }), ["02-reviewed.md", "03-social.md"]);
    assert.deepEqual(
      changedGateContentFiles(
        { "02-reviewed.md": UNREADABLE_CONTENT_HASH, "03-social.md": null },
        { "02-reviewed.md": UNREADABLE_CONTENT_HASH, "03-social.md": null },
      ),
      ["02-reviewed.md"],
      "arquivo ilegível nunca conta como igual",
    );
  });

  it("parseGateContentHashes: rejeita shape inválido", () => {
    assert.equal(parseGateContentHashes(undefined), null);
    assert.equal(parseGateContentHashes([]), null);
    assert.equal(parseGateContentHashes({ "02-reviewed.md": 1 }), null);
    assert.deepEqual(parseGateContentHashes({ "02-reviewed.md": "x", "03-social.md": null }), { "02-reviewed.md": "x", "03-social.md": null });
  });

  it("decideGateApproveAction: conteúdo mudou vence o force (nunca aprova versão não mostrada)", () => {
    assert.deepEqual(decideGateApproveAction(null, true, ["02-reviewed.md"]), { kind: "content_changed", files: ["02-reviewed.md"] });
    assert.deepEqual(decideGateApproveAction(null, false, []), { kind: "write" });
  });

  it("write grava content_hashes e read devolve", () => {
    writeStage4ApprovedDecision(editionDir, { contentHashes: { "02-reviewed.md": "abc", "03-social.md": null } });
    assert.deepEqual(readStage4Decision(editionDir)?.content_hashes, { "02-reviewed.md": "abc", "03-social.md": null });
  });

  it("cenário da issue: Studio em outra máquina aprovou a versão anterior com decided_at DEPOIS da mtime local -> stale", () => {
    // Máquina A grava a versão nova às 10:00; o Studio na máquina B ainda
    // serve a anterior e o editor aprova às 10:02. Só por mtime isso passaria.
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão anterior", "utf8");
    const shownByStudio = computeGateContentHashes(editionDir);
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão nova (ajustar na máquina A)", "utf8");
    const ten = new Date("2026-11-26T10:00:00.000Z");
    utimesSync(resolve(editionDir, "02-reviewed.md"), ten, ten);
    writeStage4ApprovedDecision(editionDir, {
      now: () => new Date("2026-11-26T10:02:00.000Z"),
      contentHashes: shownByStudio,
    });
    const decision = readStage4Decision(editionDir);
    const mtimes = [resolveContentFileMtimeMs(resolve(editionDir, "02-reviewed.md"))];
    assert.equal(resolveStage4DecisionForConsumption(decision, mtimes).usable, true, "pré-condição: a mtime sozinha deixava passar");
    const result = resolveStage4DecisionForConsumption(decision, mtimes, computeGateContentHashes(editionDir));
    assert.equal(result.usable, false);
    assert.equal(result.reason, "stale");
    assert.equal(result.stale_cause, "content_hash");
    assert.deepEqual(result.changed_files, ["02-reviewed.md"]);
  });

  it("conteúdo igual ao que o painel mostrou -> usable:true", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão revisada", "utf8");
    writeFileSync(resolve(editionDir, "03-social.md"), "social", "utf8");
    const old = new Date("2026-11-26T09:00:00.000Z");
    utimesSync(resolve(editionDir, "02-reviewed.md"), old, old);
    utimesSync(resolve(editionDir, "03-social.md"), old, old);
    writeStage4ApprovedDecision(editionDir, {
      now: () => new Date("2026-11-26T10:00:00.000Z"),
      contentHashes: computeGateContentHashes(editionDir),
    });
    const result = resolveStage4DecisionForConsumption(
      readStage4Decision(editionDir),
      [old.getTime(), old.getTime()],
      computeGateContentHashes(editionDir),
    );
    assert.equal(result.usable, true);
  });

  it("03-social.md passou a existir depois da aprovação -> stale", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "x", "utf8");
    writeStage4ApprovedDecision(editionDir, {
      now: () => new Date("2099-01-01T00:00:00.000Z"),
      contentHashes: computeGateContentHashes(editionDir),
    });
    writeFileSync(resolve(editionDir, "03-social.md"), "novo", "utf8");
    const result = resolveStage4DecisionForConsumption(readStage4Decision(editionDir), [], computeGateContentHashes(editionDir));
    assert.equal(result.usable, false);
    assert.deepEqual(result.changed_files, ["03-social.md"]);
  });

  it("decisão sem content_hashes (anterior ao #14134) com hashes atuais -> stale no_content_hashes (fail-safe)", () => {
    const legacy = { decision: "approved" as const, decided_at: "2099-01-01T00:00:00.000Z", decided_via: "studio" as const };
    const result = resolveStage4DecisionForConsumption(legacy, [], { "02-reviewed.md": "abc" });
    assert.equal(result.usable, false);
    assert.equal(result.stale_cause, "no_content_hashes");
  });

  it("CLI --content-files: hash divergente -> stale mesmo com decided_at posterior à mtime", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão anterior", "utf8");
    const shown = computeGateContentHashes(editionDir, ["02-reviewed.md", "03-social.md"]);
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão nova", "utf8");
    const old = new Date("2026-11-26T10:00:00.000Z");
    utimesSync(resolve(editionDir, "02-reviewed.md"), old, old);
    writeStage4ApprovedDecision(editionDir, { now: () => new Date("2026-11-26T10:02:00.000Z"), contentHashes: shown });
    const projectRoot = join(import.meta.dirname, "..");
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(projectRoot, "scripts", "lib", "stage4-decision.ts"),
        "--edition-dir",
        editionDir,
        "--read",
        "--content-files",
        "02-reviewed.md,03-social.md",
      ],
      { cwd: projectRoot, encoding: "utf8", timeout: 15000 },
    );
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.usable, false);
    assert.equal(parsed.stale_cause, "content_hash");
  });
});
