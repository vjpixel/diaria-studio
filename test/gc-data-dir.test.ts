/**
 * gc-data-dir.test.ts (#7278)
 *
 * Integração ponta-a-ponta do script contra um `data/` fixture em tmpdir —
 * NUNCA contra o `data/` real (junction pro OneDrive do editor). Cobre:
 * dry-run (default) nunca escreve nada no disco, `--apply` remove só os
 * candidatos esperados, os dois layouts de `editions/`, edição aberta
 * (nunca tocada) vs fechada, e o guard de exclusão sobrevivendo mesmo
 * quando um arquivo excluído está DENTRO de uma pasta que também contém
 * candidatos legítimos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { collectCandidates, main } from "../scripts/gc-data-dir.ts";
import { writeSentinel } from "../scripts/lib/pipeline-state.ts";

const DAY_MS = 86_400_000;

function ageFile(path: string, ageDays: number): void {
  const t = (Date.now() - ageDays * DAY_MS) / 1000;
  utimesSync(path, t, t);
}

function writeAged(path: string, content: string, ageDays: number): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content);
  ageFile(path, ageDays);
}

describe("collectCandidates — ponta a ponta contra fixture de disco", () => {
  it("edição ABERTA (sem Stage 6): _forensic/tmp/embedded nunca viram candidato, mesmo velhos", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-data-dir-open-"));
    const editionDir = resolve(tmp, "editions/2609/260901");
    writeAged(resolve(editionDir, "_internal/_forensic/abc123.html"), "<html></html>", 999);
    writeAged(resolve(editionDir, "_internal/tmp-articles-raw.json"), "[]", 999);
    // NÃO grava .step-6-done.json — edição em andamento.

    const candidates = collectCandidates(tmp);
    assert.deepEqual(candidates, [], "edição aberta nunca é tocada, por mais velha que esteja");
  });

  it("edição FECHADA (Stage 6 concluído): _forensic/tmp/embedded viram candidatos", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-data-dir-closed-"));
    const editionDir = resolve(tmp, "editions/2609/260901");
    writeAged(resolve(editionDir, "_internal/_forensic/abc123.html"), "<html>corpo bruto</html>", 5);
    writeAged(resolve(editionDir, "_internal/tmp-articles-raw.json"), "[]", 5);
    writeAged(resolve(editionDir, "_internal/newsletter-final-embedded.html"), "<html></html>", 5);
    writeAged(resolve(editionDir, "01-categorized.md"), "conteúdo final — nunca tocar", 5);
    writeSentinel(editionDir, 6, []);

    const candidates = collectCandidates(tmp);
    const byBucket = new Map(candidates.map((c) => [c.bucket, c]));
    assert.equal(byBucket.get("forensic-cache")?.relPath, "editions/2609/260901/_internal/_forensic");
    assert.equal(byBucket.get("tmp-intermediate")?.relPath, "editions/2609/260901/_internal/tmp-articles-raw.json");
    assert.equal(byBucket.get("embedded-html")?.relPath, "editions/2609/260901/_internal/newsletter-final-embedded.html");
    assert.equal(
      candidates.some((c) => c.relPath.includes("01-categorized.md")),
      false,
      "output final da edição nunca é candidato",
    );
  });

  it("enxerga os DOIS layouts de editions/ (nested {YYMM}/{AAMMDD} e flat {AAMMDD} residual)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-data-dir-layouts-"));
    const nested = resolve(tmp, "editions/2607/260710");
    const flat = resolve(tmp, "editions/260713");
    for (const dir of [nested, flat]) {
      writeAged(resolve(dir, "_internal/tmp-x.json"), "{}", 5);
      writeSentinel(dir, 6, []);
    }

    const candidates = collectCandidates(tmp);
    const paths = candidates.filter((c) => c.bucket === "tmp-intermediate").map((c) => c.relPath);
    assert.deepEqual(
      new Set(paths),
      new Set(["editions/2607/260710/_internal/tmp-x.json", "editions/260713/_internal/tmp-x.json"]),
    );
  });

  it("cópia-irmã de conflito do OneDrive (bucket 4) — em qualquer lugar sob data/, não só editions/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-data-dir-siblings-"));
    writeAged(resolve(tmp, "clarice-subscribers/clarice-users.db"), "canônico", 400); // nunca candidato
    writeAged(resolve(tmp, "clarice-subscribers/clarice-users-predator-safeBackup-0001.db"), "velho", 400);
    writeAged(resolve(tmp, "clarice-subscribers/clarice-users-Neo.db"), "recente", 1); // mais novo do diretório

    const candidates = collectCandidates(tmp);
    const siblingPaths = candidates.filter((c) => c.bucket === "backup-sibling").map((c) => c.relPath);
    assert.deepEqual(siblingPaths, ["clarice-subscribers/clarice-users-predator-safeBackup-0001.db"]);
  });

  it("guard (#7137): arquivo excluído nunca aparece, mesmo dentro de um diretório com candidatos legítimos ao lado", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-data-dir-guard-"));
    const editionDir = resolve(tmp, "editions/2609/260901");
    // 04-d1-2x1.jpg tem "-2x1.jpg" — não bate nenhum padrão de bucket, mas
    // simula um nome de arquivo excluído perto de candidatos legítimos.
    writeAged(resolve(editionDir, "04-d1-2x1.jpg"), "capa publicada", 999);
    writeAged(resolve(editionDir, "_internal/tmp-x.json"), "{}", 5);
    writeSentinel(editionDir, 6, []);
    writeAged(resolve(tmp, "beehiiv-backup/subscriber-engagement/manifest.json"), "{}", 999);

    const candidates = collectCandidates(tmp);
    assert.equal(
      candidates.some((c) => c.relPath.includes("04-d1-2x1.jpg")),
      false,
    );
    assert.equal(
      candidates.some((c) => c.relPath.startsWith("beehiiv-backup/")),
      false,
    );
    assert.equal(
      candidates.some((c) => c.relPath.includes("tmp-x.json")),
      true,
      "candidato legítimo ao lado do excluído continua sendo listado",
    );
  });
});

describe("main() — dry-run NUNCA escreve, --apply remove só os candidatos", () => {
  it("dry-run (default, sem --apply): lista mas não remove nada do disco", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-data-dir-dryrun-"));
    const editionDir = resolve(tmp, "editions/2609/260901");
    const forensicFile = resolve(editionDir, "_internal/_forensic/abc.html");
    writeAged(forensicFile, "x", 5);
    writeSentinel(editionDir, 6, []);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      main(["--data-root", tmp]);
    } finally {
      console.log = originalLog;
    }

    assert.equal(existsSync(forensicFile), true, "dry-run não pode remover nada");
    assert.ok(logs.some((l) => l.includes("dry-run")), "banner de dry-run presente no output");
  });

  it("--apply remove os candidatos e preserva tudo mais (edição aberta, guard, mais recente do diretório)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-data-dir-apply-"));

    const closedEdition = resolve(tmp, "editions/2609/260901");
    const forensicFile = resolve(closedEdition, "_internal/_forensic/abc.html");
    const tmpFile = resolve(closedEdition, "_internal/tmp-x.json");
    const finalOutput = resolve(closedEdition, "01-categorized.md");
    writeAged(forensicFile, "x", 5);
    writeAged(tmpFile, "{}", 5);
    writeAged(finalOutput, "conteúdo final", 5);
    writeSentinel(closedEdition, 6, []);

    const openEdition = resolve(tmp, "editions/2609/260902");
    const openTmpFile = resolve(openEdition, "_internal/tmp-y.json");
    writeAged(openTmpFile, "{}", 999);
    // sem sentinel — edição aberta

    const excludedImg = resolve(closedEdition, "04-d1-2x1.jpg");
    writeAged(excludedImg, "capa", 999);

    const dbDir = resolve(tmp, "clarice-subscribers");
    const oldBackup = resolve(dbDir, "clarice-users-predator-safeBackup-0001.db");
    const newestBackup = resolve(dbDir, "clarice-users-Neo.db");
    const canonicalDb = resolve(dbDir, "clarice-users.db");
    writeAged(oldBackup, "velho", 400);
    writeAged(newestBackup, "recente", 1);
    writeAged(canonicalDb, "canônico", 400);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      main(["--data-root", tmp, "--apply"]);
    } finally {
      console.log = originalLog;
    }

    // Removidos:
    assert.equal(existsSync(forensicFile), false, "_forensic da edição fechada removido");
    assert.equal(existsSync(resolve(closedEdition, "_internal/_forensic")), false, "diretório _forensic inteiro removido");
    assert.equal(existsSync(tmpFile), false, "tmp-* da edição fechada removido");
    assert.equal(existsSync(oldBackup), false, "cópia-irmã velha removida");

    // Preservados:
    assert.equal(existsSync(finalOutput), true, "output final da edição fechada NUNCA é tocado");
    assert.equal(existsSync(openTmpFile), true, "edição ABERTA nunca é tocada, mesmo com tmp- velho");
    assert.equal(existsSync(excludedImg), true, "04-d1-2x1.jpg é guard — nunca removido");
    assert.equal(existsSync(newestBackup), true, "cópia mais recente do diretório é preservada");
    assert.equal(existsSync(canonicalDb), true, "arquivo canônico nunca é candidato");

    assert.ok(logs.some((l) => l.includes("removido")));
  });
});
