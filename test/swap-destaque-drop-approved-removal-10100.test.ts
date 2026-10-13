/**
 * #10100 — `swap-destaque.ts --drop` (e `swap-destaques.ts --drop`) remove o
 * destaque descartado de `01-approved.json` de propósito (#9990). O invariante
 * `approved-item-removed` (#8121) acusava esse drop legítimo, com uma mensagem
 * mandando fazer o oposto. Agora o script registra o descarte em
 * `_internal/stage4-dropped-items.json` e o invariante ignora as URLs
 * declaradas ali — remoção NÃO declarada continua acusando.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkApprovedItemRemoval } from "../scripts/lib/invariant-checks/stage-4.ts";
import {
  appendStage4DroppedItems,
  parseStage4DroppedItems,
  stage4DroppedItemsPath,
} from "../scripts/lib/stage4-dropped-items.ts";
import { analyzeEditionsUnderRoot, summarize } from "../scripts/analyze-bucket-overrides.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runScript(script: string, args: string[]): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts", script), ...args], {
      encoding: "utf8",
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (e) {
    const err = e as { stderr?: string; status?: number };
    return { status: err.status ?? 1, stderr: err.stderr ?? "" };
  }
}

const APPROVED = {
  highlights: [
    { rank: 1, bucket: "radar", url: "https://example.com/deepfake", title: "Deepfake D1" },
    { rank: 2, bucket: "radar", url: "https://example.com/d2", title: "D2" },
    { rank: 3, bucket: "lancamento", url: "https://example.com/d3", title: "D3" },
  ],
  runners_up: [],
  lancamento: [],
  radar: [
    { url: "https://example.com/radar-0", title: "Radar 0" },
    { url: "https://example.com/radar-1", title: "Radar 1" },
  ],
  use_melhor: [],
  video: [],
};

/** Edição com snapshot pós-Stage 1/2 idêntico ao approved atual. */
function makeEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "drop-10100-"));
  const internal = join(dir, "_internal");
  mkdirSync(internal, { recursive: true });
  writeFileSync(join(internal, "01-approved.json"), JSON.stringify(APPROVED, null, 2));
  const snap = join(internal, "editor-request-snapshots", "stage2-post-gate", "_internal");
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, "01-approved.json"), JSON.stringify(APPROVED, null, 2));
  return dir;
}

describe("swap-destaque.ts --drop × approved-item-removed (#10100)", () => {
  it("drop legítimo não acusa e fica registrado em stage4-dropped-items.json", () => {
    const dir = makeEdition();
    try {
      const r = runScript("swap-destaque.ts", [
        "--edition", "261013", "--edition-dir", dir,
        "--promote", "radar:0", "--demote", "d1", "--drop",
      ]);
      assert.equal(r.status, 0, r.stderr);

      // O item saiu mesmo do approved (#9990 continua valendo)...
      const approved = readFileSync(join(dir, "_internal", "01-approved.json"), "utf8");
      assert.ok(!approved.includes("https://example.com/deepfake"));
      // ...mas o descarte está declarado...
      const dropped = parseStage4DroppedItems(readFileSync(stage4DroppedItemsPath(dir), "utf8"));
      assert.equal(dropped.length, 1);
      assert.equal(dropped[0].url, "https://example.com/deepfake");
      assert.equal(dropped[0].position, 1);
      assert.equal(dropped[0].source, "swap-destaque");
      // ...e o invariante não acusa.
      assert.deepEqual(checkApprovedItemRemoval(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem --drop não grava registro (rebaixado volta ao pool, nada sumiu)", () => {
    const dir = makeEdition();
    try {
      const r = runScript("swap-destaque.ts", [
        "--edition", "261013", "--edition-dir", dir,
        "--promote", "radar:0", "--demote", "d1",
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(stage4DroppedItemsPath(dir)));
      assert.deepEqual(checkApprovedItemRemoval(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("remoção NÃO declarada continua acusando, mesmo com um drop declarado na mesma edição", () => {
    const dir = makeEdition();
    try {
      const r = runScript("swap-destaque.ts", [
        "--edition", "261013", "--edition-dir", dir,
        "--promote", "radar:0", "--demote", "d1", "--drop",
      ]);
      assert.equal(r.status, 0, r.stderr);
      // Remoção manual de outro item, sem passar pelo script.
      const p = join(dir, "_internal", "01-approved.json");
      const data = JSON.parse(readFileSync(p, "utf8"));
      data.radar = data.radar.filter((it: { url: string }) => it.url !== "https://example.com/radar-1");
      writeFileSync(p, JSON.stringify(data, null, 2));

      const v = checkApprovedItemRemoval(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "approved-item-removed");
      assert.match(v[0].message, /radar-1/);
      assert.match(v[0].message, /swap-destaque\.ts --drop/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("swap-destaques.ts --drop × approved-item-removed (#10100)", () => {
  it("drop de vários slots não acusa nenhum", () => {
    const dir = makeEdition();
    try {
      const r = runScript("swap-destaques.ts", [
        "--edition", "261013", "--edition-dir", dir,
        "--d1-url", "https://example.com/novo-1", "--d1-title", "Novo 1",
        "--d2-url", "https://example.com/novo-2", "--d2-title", "Novo 2",
        "--drop",
      ]);
      assert.equal(r.status, 0, r.stderr);
      const dropped = parseStage4DroppedItems(readFileSync(stage4DroppedItemsPath(dir), "utf8"));
      assert.deepEqual(dropped.map((d) => d.url).sort(), ["https://example.com/d2", "https://example.com/deepfake"]);
      assert.deepEqual(checkApprovedItemRemoval(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("appendStage4DroppedItems (#10100)", () => {
  it("idempotente por URL — re-registrar substitui em vez de duplicar", () => {
    const entry = {
      url: "https://example.com/x",
      title: "X",
      position: 2,
      source: "swap-destaque" as const,
      dropped_at: "2026-10-13T00:00:00.000Z",
    };
    const once = appendStage4DroppedItems(null, [entry]);
    const twice = appendStage4DroppedItems(once, [{ ...entry, dropped_at: "2026-10-13T01:00:00.000Z" }]);
    const items = parseStage4DroppedItems(twice);
    assert.equal(items.length, 1);
    assert.equal(items[0].dropped_at, "2026-10-13T01:00:00.000Z");
  });

  it("arquivo corrompido → lista vazia (fail-soft)", () => {
    assert.deepEqual(parseStage4DroppedItems("{nao json"), []);
  });
});

describe("analyze-bucket-overrides conta os descartes do Stage 4 (#10100)", () => {
  it("stage4Drops aparece por edição e no resumo", () => {
    const root = mkdtempSync(join(tmpdir(), "abo-10100-"));
    try {
      const ed = join(root, "261013");
      const internal = join(ed, "_internal");
      mkdirSync(internal, { recursive: true });
      writeFileSync(join(internal, "01-categorized.json"), JSON.stringify({ radar: [] }));
      writeFileSync(join(internal, "01-approved.json"), JSON.stringify({ radar: [] }));
      writeFileSync(
        stage4DroppedItemsPath(ed),
        appendStage4DroppedItems(null, [
          { url: "https://example.com/x", title: "X", position: 1, source: "swap-destaque", dropped_at: "2026-10-13T00:00:00.000Z" },
        ]),
      );
      const editions = analyzeEditionsUnderRoot(root);
      assert.equal(editions[0].stage4Drops?.length, 1);
      assert.equal(summarize(editions, 3).destaque.stage4Drops, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
