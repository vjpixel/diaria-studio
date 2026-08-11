/**
 * test/log-editor-request.test.ts (#4966)
 *
 * Cobre log-editor-request.ts (CLI + helper) e a integração com
 * collect-edition-signals (signalsFromRecurringEditorRequests). Espelha
 * test/log-runtime-fix.test.ts (#1210).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { appendEditorRequest } from "../scripts/log-editor-request.ts";
import { signalsFromRecurringEditorRequests } from "../scripts/collect-edition-signals.ts";

describe("appendEditorRequest (#4966)", () => {
  it("cria diretório _internal e escreve JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "editor-request-"));
    try {
      const editionDir = join(dir, "260811");
      mkdirSync(editionDir);
      appendEditorRequest(editionDir, {
        edition: "260811",
        stage: 4,
        request_type: "title-length",
        target: "d2",
        description: "título tá longo demais pro assunto",
        resolution: "accepted",
      });
      const outPath = join(editionDir, "_internal", "editor-requests.jsonl");
      assert.ok(existsSync(outPath));
      const lines = readFileSync(outPath, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.request_type, "title-length");
      assert.equal(entry.target, "d2");
      assert.equal(entry.resolution, "accepted");
      assert.ok(entry.timestamp);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("multiple appends viram múltiplas linhas (append-only)", () => {
    const dir = mkdtempSync(join(tmpdir(), "editor-request-multi-"));
    try {
      const editionDir = join(dir, "260811");
      mkdirSync(editionDir);
      appendEditorRequest(editionDir, {
        edition: "260811", stage: 4, request_type: "title-length",
        target: "d2", description: "título longo", resolution: "accepted",
      });
      appendEditorRequest(editionDir, {
        edition: "260811", stage: 4, request_type: "lead-rewrite",
        target: "d1", description: "lead sem gancho", resolution: "partial",
      });
      const lines = readFileSync(
        join(editionDir, "_internal", "editor-requests.jsonl"),
        "utf8",
      ).trim().split("\n");
      assert.equal(lines.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("log-editor-request CLI (#4966)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "log-editor-request.ts");
    return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 15000,
    });
  }

  it("rejeita uso sem flags obrigatórias", () => {
    const r = runCli([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Uso:|Faltam/);
  });

  it("rejeita request-type fora da taxonomia", () => {
    const r = runCli([
      "--edition", "260811",
      "--stage", "4",
      "--request-type", "invalid-type",
      "--target", "d1",
      "--description", "test",
      "--resolution", "accepted",
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /request-type inválido/);
  });

  it("rejeita target inválido", () => {
    const r = runCli([
      "--edition", "260811",
      "--stage", "4",
      "--request-type", "title-length",
      "--target", "d99",
      "--description", "test",
      "--resolution", "accepted",
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /target inválido/);
  });

  it("rejeita resolution inválida", () => {
    const r = runCli([
      "--edition", "260811",
      "--stage", "4",
      "--request-type", "title-length",
      "--target", "d1",
      "--description", "test",
      "--resolution", "maybe",
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /resolution inválida/);
  });

  it("rejeita edition dir ausente", () => {
    const dir = mkdtempSync(join(tmpdir(), "editor-request-missing-"));
    try {
      const r = runCli([
        "--edition", "999999",
        "--stage", "4",
        "--request-type", "title-length",
        "--target", "d1",
        "--description", "test",
        "--resolution", "accepted",
        "--editions-dir", dir,
      ]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /não existe/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respeita --editions-dir (isolamento de teste, layout FLAT)", () => {
    const dir = mkdtempSync(join(tmpdir(), "editor-request-flat-"));
    try {
      const flatEditionDir = join(dir, "260811");
      mkdirSync(flatEditionDir, { recursive: true });
      const r = runCli([
        "--edition", "260811",
        "--stage", "4",
        "--request-type", "title-length",
        "--target", "d2",
        "--description", "test flat layout",
        "--resolution", "accepted",
        "--editions-dir", dir,
      ]);
      assert.equal(r.status, 0, r.stderr);
      const outPath = join(flatEditionDir, "_internal", "editor-requests.jsonl");
      assert.ok(existsSync(outPath));
      const entry = JSON.parse(readFileSync(outPath, "utf8").trim());
      assert.equal(entry.target, "d2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respeita --editions-dir (isolamento de teste, layout NESTED)", () => {
    const dir = mkdtempSync(join(tmpdir(), "editor-request-nested-"));
    try {
      const nestedEditionDir = join(dir, "2608", "260811");
      mkdirSync(nestedEditionDir, { recursive: true });
      const r = runCli([
        "--edition", "260811",
        "--stage", "4",
        "--request-type", "destaque-promote",
        "--target", "radar",
        "--description", "test nested layout",
        "--resolution", "partial",
        "--editions-dir", dir,
      ]);
      assert.equal(r.status, 0, r.stderr);
      const outPath = join(nestedEditionDir, "_internal", "editor-requests.jsonl");
      assert.ok(existsSync(outPath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("signalsFromRecurringEditorRequests (#4966)", () => {
  it("3-em-7 dispara", () => {
    const entriesByEdition: Record<string, Array<{
      timestamp: string; edition: string; stage: number; request_type: string;
      target: string; description: string; resolution: "accepted" | "partial" | "declined";
    }>> = {
      "260811": [{ timestamp: "t1", edition: "260811", stage: 4, request_type: "title-length", target: "d1", description: "título longo A", resolution: "accepted" }],
      "260810": [{ timestamp: "t2", edition: "260810", stage: 4, request_type: "title-length", target: "d2", description: "título longo B", resolution: "accepted" }],
      "260809": [{ timestamp: "t3", edition: "260809", stage: 4, request_type: "title-length", target: "d3", description: "título longo C", resolution: "partial" }],
    };
    const signals = signalsFromRecurringEditorRequests(entriesByEdition);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, "recurring_editor_request");
    assert.equal(signals[0].details.request_type, "title-length");
    assert.equal(signals[0].details.edition_count, 3);
  });

  it("2-em-7 NÃO dispara", () => {
    const entriesByEdition = {
      "260811": [{ timestamp: "t1", edition: "260811", stage: 4, request_type: "title-length", target: "d1", description: "A", resolution: "accepted" as const }],
      "260810": [{ timestamp: "t2", edition: "260810", stage: 4, request_type: "title-length", target: "d2", description: "B", resolution: "accepted" as const }],
    };
    const signals = signalsFromRecurringEditorRequests(entriesByEdition);
    assert.equal(signals.length, 0);
  });

  it("3 pedidos na MESMA edição contam como 1 edição — não dispara sozinho", () => {
    const entriesByEdition = {
      "260811": [
        { timestamp: "t1", edition: "260811", stage: 4, request_type: "title-length", target: "d1", description: "A", resolution: "accepted" as const },
        { timestamp: "t2", edition: "260811", stage: 4, request_type: "title-length", target: "d2", description: "B", resolution: "accepted" as const },
        { timestamp: "t3", edition: "260811", stage: 4, request_type: "title-length", target: "d3", description: "C", resolution: "accepted" as const },
      ],
    };
    const signals = signalsFromRecurringEditorRequests(entriesByEdition);
    assert.equal(signals.length, 0, "1 edição só, mesmo com 3 ocorrências, não conta como 3 edições distintas");
  });

  it("declined NÃO conta", () => {
    const entriesByEdition = {
      "260811": [{ timestamp: "t1", edition: "260811", stage: 4, request_type: "title-length", target: "d1", description: "A", resolution: "declined" as const }],
      "260810": [{ timestamp: "t2", edition: "260810", stage: 4, request_type: "title-length", target: "d2", description: "B", resolution: "accepted" as const }],
      "260809": [{ timestamp: "t3", edition: "260809", stage: 4, request_type: "title-length", target: "d3", description: "C", resolution: "accepted" as const }],
    };
    const signals = signalsFromRecurringEditorRequests(entriesByEdition);
    assert.equal(signals.length, 0, "só 2 edições com resolution accepted/partial — declined não conta");
  });

  it("other NUNCA dispara mesmo com muitas edições", () => {
    const entriesByEdition: Record<string, Array<{
      timestamp: string; edition: string; stage: number; request_type: string;
      target: string; description: string; resolution: "accepted" | "partial" | "declined";
    }>> = {};
    for (const ed of ["260811", "260810", "260809", "260808", "260807"]) {
      entriesByEdition[ed] = [{ timestamp: ed, edition: ed, stage: 4, request_type: "other", target: "d1", description: "algo não classificado", resolution: "accepted" }];
    }
    const signals = signalsFromRecurringEditorRequests(entriesByEdition);
    assert.equal(signals.length, 0);
  });

  it("título é estável entre chamadas com contagens diferentes (dedup do auto-reporter não fura)", () => {
    const three: Record<string, Array<{ timestamp: string; edition: string; stage: number; request_type: string; target: string; description: string; resolution: "accepted" | "partial" | "declined" }>> = {
      "260811": [{ timestamp: "t1", edition: "260811", stage: 4, request_type: "tone", target: "d1", description: "A", resolution: "accepted" }],
      "260810": [{ timestamp: "t2", edition: "260810", stage: 4, request_type: "tone", target: "d1", description: "B", resolution: "accepted" }],
      "260809": [{ timestamp: "t3", edition: "260809", stage: 4, request_type: "tone", target: "d1", description: "C", resolution: "accepted" }],
    };
    const four = {
      ...three,
      "260808": [{ timestamp: "t4", edition: "260808", stage: 4, request_type: "tone", target: "d1", description: "D", resolution: "accepted" as const }],
    };
    const sig3 = signalsFromRecurringEditorRequests(three);
    const sig4 = signalsFromRecurringEditorRequests(four);
    assert.equal(sig3.length, 1);
    assert.equal(sig4.length, 1);
    assert.equal(sig3[0].title, sig4[0].title);
    assert.doesNotMatch(sig3[0].title, /\d×/);
    assert.equal(sig3[0].details.edition_count, 3);
    assert.equal(sig4[0].details.edition_count, 4);
  });

  it("traz artefato candidato + descrições literais como evidência", () => {
    const entriesByEdition = {
      "260811": [{ timestamp: "t1", edition: "260811", stage: 4, request_type: "destaque-promote", target: "radar", description: "promover item do radar pra D2", resolution: "accepted" as const }],
      "260810": [{ timestamp: "t2", edition: "260810", stage: 4, request_type: "destaque-promote", target: "radar", description: "promover outro item", resolution: "accepted" as const }],
      "260809": [{ timestamp: "t3", edition: "260809", stage: 4, request_type: "destaque-promote", target: "radar", description: "de novo promoção", resolution: "partial" as const }],
    };
    const signals = signalsFromRecurringEditorRequests(entriesByEdition);
    assert.equal(signals.length, 1);
    assert.match(signals[0].details.artifact_candidate as string, /scorer/);
    assert.match(signals[0].suggested_action, /promover item do radar pra D2/);
  });
});
