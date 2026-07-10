/**
 * sync-intentional-error-record-reveal-fallback.test.ts (#3272)
 *
 * Regressão: o branch de fallback MD de `sync-intentional-error.ts` (linha
 * ~196) chamava `extractIntentionalErrorFromMd(md)` SEM passar o `record`
 * já carregado de `_internal/intentional-error.json`. Isso torna o caminho
 * PRIORIDADE 2 de `extractIntentionalErrorFromMd` (`record.reveal`)
 * estruturalmente inalcançável nesse call site — um `reveal` já preenchido
 * no JSON fica descartado em silêncio quando `checkIntentionalError` recusa
 * o record por faltar outro campo obrigatório (ex: `location`) e o corpo do
 * MD não tem a prosa "Nessa edição, …" batendo.
 *
 * Cenário: record com description/category/correct_value/reveal preenchidos
 * mas SEM `location` (checkIntentionalError exige os 4 campos, `reveal` não
 * conta) → `ok:false` → cai no fallback MD. MD não tem prosa "Nessa edição,
 * …". Antes do fix: `extractIntentionalErrorFromMd(md)` sem record retorna
 * `null` (nem PRIORIDADE 1 nem PRIORIDADE 2 batem) → sync falha (exit 1),
 * JSONL fica sem entry, reveal do JSON é perdido. Depois do fix: `record` é
 * passado, PRIORIDADE 2 usa `record.reveal`, entry é gravada com
 * `source: "prose_block"` e o campo `reveal` propagado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
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

describe("sync-intentional-error fallback MD propaga record.reveal (#3272)", () => {
  it("record incompleto (sem location) + reveal preenchido + MD sem prosa → entry grava reveal do JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-reveal-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const jsonlPath = join(dir, "intentional-errors.jsonl");

      // MD sem a prosa "Nessa edição, …" — só corpo qualquer.
      writeFileSync(
        mdPath,
        ["**DESTAQUE 1**", "", "Texto qualquer sem prosa de erro intencional.", ""].join("\n"),
        "utf8",
      );

      // Record incompleto pro gate de checkIntentionalError (falta `location`),
      // mas com `reveal` já preenchido — o caso que este fix cobre.
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        intentionalErrorJsonPath(dir),
        JSON.stringify({
          description: "Erro factual teste",
          category: "factual",
          correct_value: "1998",
          reveal: "Na última edição, escrevi 1990 onde o correto é 1998.",
        }),
        "utf8",
      );

      const r = runSync(mdPath, "260710", jsonlPath);
      assert.equal(r.status, 0, `esperava exit 0 (reveal do record deveria ser usado), stderr: ${r.stderr}`);
      assert.ok(existsSync(jsonlPath), "jsonl deve ser criado — reveal do record não pode ser descartado");
      const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.edition, "260710");
      assert.equal(entry.source, "prose_block");
      assert.equal(
        entry.reveal,
        "Na última edição, escrevi 1990 onde o correto é 1998.",
        "reveal do _internal/intentional-error.json deve propagar pro JSONL, não ser descartado em silêncio",
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
