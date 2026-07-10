/**
 * sync-intentional-error-no-record-contamination.test.ts (#3272 follow-up,
 * code-review consolidado do PR #3293)
 *
 * Regressão: o fix original de #3272 (PR #3293) passava incondicionalmente o
 * `record` (`_internal/intentional-error.json`, mesmo incompleto) pra
 * `extractIntentionalErrorFromMd(md, record)`. Essa função mescla
 * `correct_value`/`reveal` do `record` mesmo quando a PRIORIDADE 1 (prosa
 * "Nessa edição, …" no corpo do MD) já é auto-suficiente — então um record
 * incompleto/desatualizado (ex: `reveal` de uma tentativa anterior que o
 * editor esqueceu de limpar ao reescrever a prosa do MD pra outro erro)
 * contaminava uma declaração de prosa completa e sem relação com o
 * `reveal`/`correct_value` do record errado.
 *
 * Fix (este arquivo): tenta `extractIntentionalErrorFromMd(md)` SEM record
 * primeiro; só passa `record` numa 2ª tentativa quando a prosa sozinha não
 * basta. `category`/`location` do record só são propagados pra entry quando
 * o record foi de fato a FONTE da narrativa (2ª tentativa), nunca quando a
 * prosa do MD já bastou sozinha (1ª tentativa) — evita a mesma classe de
 * contaminação pro par category/location.
 *
 * Testa 3 cenários:
 *  1. MD com prosa completa (erro A) + record incompleto com reveal/
 *     correct_value de outro erro (B) → entry usa SÓ o erro A, sem vazar
 *     reveal/correct_value/category do record.
 *  2. MD sem prosa + record incompleto mas com category/location/reveal
 *     preenchidos → entry usa o record como fonte (comportamento #3272
 *     original preservado) E propaga category/location corretamente.
 *  3. MD sem prosa e SEM record.reveal → continua falhando (exit 1), sem
 *     regressão do caso "nada pra extrair".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { intentionalErrorJsonPath } from "../scripts/lib/intentional-errors.ts";

function runSync(mdPath: string, edition: string, jsonlPath: string) {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "sync-intentional-error.ts");
  return spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--md", mdPath, "--edition", edition, "--jsonl", jsonlPath],
    { encoding: "utf8" },
  );
}

function writeRecord(dir: string, record: Record<string, unknown>): void {
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(intentionalErrorJsonPath(dir), JSON.stringify(record, null, 2), "utf8");
}

describe("sync-intentional-error — record incompleto não contamina prosa auto-suficiente (#3272 follow-up)", () => {
  it("MD com prosa completa (erro A) + record incompleto/desatualizado (erro B) → entry só reflete o erro A", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-no-contam-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const jsonlPath = join(dir, "intentional-errors.jsonl");

      // Erro A: declarado por completo na prosa do MD.
      writeFileSync(
        mdPath,
        [
          "**ERRO INTENCIONAL**",
          "",
          "Nessa edição, atribuímos a citação ao Bill Gates, mas o correto era Satya Nadella.",
          "",
        ].join("\n"),
        "utf8",
      );

      // Erro B: record INCOMPLETO (falta location, então checkIntentionalError
      // recusa) mas com reveal/correct_value/category de um erro totalmente
      // diferente — simula o editor reescrevendo a prosa do MD sem atualizar
      // o JSON.
      writeRecord(dir, {
        description: "Erro numérico teste",
        category: "numeric",
        correct_value: "1998",
        reveal: "Na última edição, escrevi 1990 onde o correto é 1998.",
      });

      const r = runSync(mdPath, "260710", jsonlPath);
      assert.equal(r.status, 0, `esperava exit 0, stderr: ${r.stderr}`);
      const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.edition, "260710");
      assert.match(entry.detail, /Satya Nadella|citação/, "detail deve vir da prosa do MD (erro A)");
      assert.equal(
        entry.reveal,
        undefined,
        "reveal NÃO deve vir do record desatualizado (erro B) — prosa do MD já era auto-suficiente",
      );
      assert.equal(
        entry.correct_value,
        undefined,
        "correct_value NÃO deve vir do record desatualizado (erro B)",
      );
      assert.equal(
        entry.error_type,
        "editor_declared",
        "category NÃO deve vir do record ('numeric', erro B) — deve cair no genérico, já que a prosa (erro A) bastou sozinha",
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("MD sem prosa + record incompleto mas com category/location/reveal → entry usa o record como fonte E propaga category/location", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-no-contam-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const jsonlPath = join(dir, "intentional-errors.jsonl");

      // Sem prosa "Nessa edição, …" no corpo.
      writeFileSync(mdPath, "**DESTAQUE 2**\n\nTexto qualquer sem prosa de erro intencional.\n", "utf8");

      // Record incompleto pro gate (falta `description`), mas com
      // location/category/correct_value/reveal preenchidos.
      writeRecord(dir, {
        location: "DESTAQUE 2",
        category: "numeric",
        correct_value: "42",
        reveal: "Na última edição, o número certo era 42.",
      });

      const r = runSync(mdPath, "260711", jsonlPath);
      assert.equal(r.status, 0, `esperava exit 0 (record.reveal deveria ser usado), stderr: ${r.stderr}`);
      const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.edition, "260711");
      assert.equal(entry.reveal, "Na última edição, o número certo era 42.");
      assert.equal(entry.correct_value, "42");
      assert.equal(
        entry.error_type,
        "numeric",
        "category deve vir do record — ele foi a fonte real da narrativa (sem prosa própria no MD)",
      );
      assert.equal(entry.destaque, 2, "destaque deve ser derivado de record.location quando o record é a fonte");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("MD sem prosa e record sem reveal → continua falhando (exit 1, sem regressão)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-no-contam-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const jsonlPath = join(dir, "intentional-errors.jsonl");
      writeFileSync(mdPath, "**DESTAQUE 1**\n\nTexto qualquer sem prosa de erro intencional.\n", "utf8");
      // Record incompleto (falta location) e sem reveal — nada pra extrair.
      writeRecord(dir, {
        description: "Erro teste",
        category: "factual",
        correct_value: "valor",
      });
      const r = runSync(mdPath, "260712", jsonlPath);
      assert.equal(r.status, 1, "deve falhar quando não há prosa nem record.reveal");
      assert.ok(!existsSync(jsonlPath), "não deve criar jsonl quando falha");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
