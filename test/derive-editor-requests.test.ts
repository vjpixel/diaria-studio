/**
 * test/derive-editor-requests.test.ts (#5731)
 *
 * Cobre scripts/derive-editor-requests.ts — derivação determinística de
 * pedidos editoriais a partir do diff entre snapshots (pós-Stage 2 vs
 * estado no gate do Stage 4/6), em vez de depender de log manual
 * (log-editor-request.ts, #4966) que quase nunca rodava na prática.
 *
 * Padrão de teste espelha test/log-editor-request.test.ts: CLI via
 * spawnSync + --editions-dir para isolamento.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const SCRIPT_PATH = join(PROJECT_ROOT, "scripts", "derive-editor-requests.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 15000,
  });
}

function readEntries(editionDir: string): Array<Record<string, unknown>> {
  const outPath = join(editionDir, "_internal", "editor-requests.jsonl");
  if (!existsSync(outPath)) return [];
  return readFileSync(outPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** 01-approved.json com 2 highlights, URLs distintas por posição (d1/d2). */
function approvedJson(urlD1: string, titleD1: string, urlD2 = "https://example.com/fixo-d2"): string {
  return JSON.stringify({
    highlights: [
      { article: { url: urlD1, title: titleD1 } },
      { article: { url: urlD2, title: "Fixo D2" } },
    ],
  });
}

describe("derive-editor-requests.ts (#5731)", () => {
  it("snapshot-stage2 grava o snapshot corretamente", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-snap-"));
    try {
      const editionDir = join(dir, "260811");
      mkdirSync(editionDir, { recursive: true });
      const content = "**DESTAQUE 1 | 🚀 LANÇAMENTO**\nconteúdo original\n";
      writeFileSync(join(editionDir, "02-reviewed.md"), content, "utf8");

      const r = runCli(["snapshot-stage2", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r.status, 0, r.stderr);

      const snapPath = join(
        editionDir,
        "_internal",
        "editor-request-snapshots",
        "stage2-post-gate",
        "02-reviewed.md",
      );
      assert.ok(existsSync(snapPath), "snapshot deveria existir em disco");
      assert.equal(readFileSync(snapPath, "utf8"), content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diff entre dois snapshots idênticos não gera pedido nenhum", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-noop-"));
    try {
      const editionDir = join(dir, "260811");
      mkdirSync(editionDir, { recursive: true });
      writeFileSync(join(editionDir, "02-reviewed.md"), "**DESTAQUE 1 | 🚀 LANÇAMENTO**\nsem mudança\n", "utf8");

      assert.equal(runCli(["snapshot-stage2", "--edition", "260811", "--editions-dir", dir]).status, 0);

      const r = runCli(["derive-stage4", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /0 pedidos derivados/);
      assert.deepEqual(readEntries(editionDir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diff com troca de destaque em 01-approved.json é classificado como destaque-swap, source derived", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-swap-"));
    try {
      const editionDir = join(dir, "260811");
      const internalDir = join(editionDir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(
        join(internalDir, "01-approved.json"),
        approvedJson("https://example.com/artigo-antigo", "Artigo antigo"),
        "utf8",
      );

      assert.equal(runCli(["snapshot-stage2", "--edition", "260811", "--editions-dir", dir]).status, 0);

      // Editor troca o D1 por outro artigo — mesma posição, URL diferente.
      writeFileSync(
        join(internalDir, "01-approved.json"),
        approvedJson("https://example.com/artigo-novo", "Artigo novo"),
        "utf8",
      );

      const r = runCli(["derive-stage4", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /1 pedidos derivados/);

      const entries = readEntries(editionDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].request_type, "destaque-swap");
      assert.equal(entries[0].target, "d1");
      assert.equal(entries[0].source, "derived");
      assert.equal(entries[0].edition, "260811");
      assert.equal(entries[0].stage, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diff com mudança de título em 02-reviewed.md é classificado como title-choice, source derived", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-title-"));
    try {
      const editionDir = join(dir, "260811");
      mkdirSync(editionDir, { recursive: true });
      const build = (title: string) =>
        [
          "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
          `**[${title}](https://example.com/mesmo-link)**`,
          "Por que isso importa: motivo estável, idêntico nas duas versões.",
          "https://example.com/mesmo-link",
          "",
        ].join("\n");

      writeFileSync(join(editionDir, "02-reviewed.md"), build("Título original aqui hoje"), "utf8");

      assert.equal(runCli(["snapshot-stage2", "--edition", "260811", "--editions-dir", dir]).status, 0);

      // Só o título muda — URL e "Por que isso importa" ficam idênticos.
      writeFileSync(join(editionDir, "02-reviewed.md"), build("Novo título mais objetivo"), "utf8");

      const r = runCli(["derive-stage4", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r.status, 0, r.stderr);

      const entries = readEntries(editionDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].request_type, "title-choice");
      assert.equal(entries[0].target, "d1");
      assert.equal(entries[0].source, "derived");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derive-stage4 refresca o checkpoint — derive-stage6 só vê mudanças NOVAS pós-Stage 4, sem duplicar", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-checkpoint-"));
    try {
      const editionDir = join(dir, "260811");
      const internalDir = join(editionDir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(join(internalDir, "01-approved.json"), approvedJson("https://example.com/v1", "V1"), "utf8");

      assert.equal(runCli(["snapshot-stage2", "--edition", "260811", "--editions-dir", dir]).status, 0);

      // Mudança 1, detectada e logada no gate do Stage 4.
      writeFileSync(join(internalDir, "01-approved.json"), approvedJson("https://example.com/v2", "V2"), "utf8");
      const r4 = runCli(["derive-stage4", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r4.status, 0, r4.stderr);
      assert.equal(readEntries(editionDir).length, 1, "Stage 4 loga a 1ª troca");

      // Sem mudança adicional: Stage 6 não deveria re-derivar a mesma troca.
      const r6NoChange = runCli(["derive-stage6", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r6NoChange.status, 0, r6NoChange.stderr);
      assert.match(r6NoChange.stdout, /0 pedidos derivados/);
      assert.equal(readEntries(editionDir).length, 1, "sem duplicar a troca já logada pelo Stage 4");

      // Mudança 2, feita DEPOIS da aprovação do gate Stage 4 (ex: edição via Studio durante Stage 5).
      writeFileSync(join(internalDir, "01-approved.json"), approvedJson("https://example.com/v3", "V3"), "utf8");
      const r6 = runCli(["derive-stage6", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r6.status, 0, r6.stderr);
      assert.match(r6.stdout, /1 pedidos derivados/);

      const entries = readEntries(editionDir);
      assert.equal(entries.length, 2, "Stage 6 loga só a mudança nova, sem duplicar a do Stage 4");
      assert.equal(entries[1].stage, 6);
      assert.equal(entries[1].source, "derived");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejeita comando desconhecido / edição inexistente", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-errs-"));
    try {
      const rNoDir = runCli(["derive-stage4", "--edition", "999999", "--editions-dir", dir]);
      assert.equal(rNoDir.status, 2);
      assert.match(rNoDir.stderr, /não existe/);

      const editionDir = join(dir, "260811");
      mkdirSync(editionDir, { recursive: true });
      const rBadCmd = runCli(["bogus-command", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(rBadCmd.status, 2);
      assert.match(rBadCmd.stderr, /Comando desconhecido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
