/**
 * #13873 — os arquivos do vertical que o #13867 deixou de fora da exclusão:
 * os registros dos timers do 300 (`06-shorts-published.*-timer.json`), as
 * cópias de conflito do sync do registro e o histórico do
 * `--replace-scheduled` (`06-shorts-replaced.json`). Gravados pela própria
 * cadeia do vídeo, não provam que o gate 4 foi aprovado em outra máquina;
 * antes do fix, recém-gravados sem o sentinel 4 davam `prev_gate_in_transit`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isPublicaVideoFile } from "../scripts/lib/stale-edition-guard.ts";
import { runStaleEditionGuard } from "../scripts/stale-edition-guard.ts";
import {
  SHORTS_INSTAGRAM_TIMER_LEDGER_FILE,
  SHORTS_REPLACED_FILE,
  SHORTS_THREADS_TIMER_LEDGER_FILE,
  SHORTS_TIMER_LEDGER_FILE,
  isShortsRegistryFileName,
} from "../scripts/lib/diaria/shorts-published-store.ts";

const NOW = Date.parse("2026-11-24T10:00:00Z");
const HOURS_AGO = (NOW - 5 * 3_600_000) / 1000;
const MIN_AGO = (NOW - 2 * 60_000) / 1000;

function staleEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "stale-13873-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  for (const f of ["02-reviewed.md", "03-social.md", "_internal/.step-3-done.json"]) {
    writeFileSync(join(dir, f), "x");
    utimesSync(join(dir, f), HOURS_AGO, HOURS_AGO);
  }
  return dir;
}
function touchRecent(dir: string, rel: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), "x");
  utimesSync(join(dir, rel), MIN_AGO, MIN_AGO);
}
const guard = (dir: string) =>
  runStaleEditionGuard(["check", "--edition-dir", dir, "--step", "4", "--caller-stage", "5"], { host: "300", now: NOW });

const TIMER_FILES = [SHORTS_TIMER_LEDGER_FILE, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE, SHORTS_THREADS_TIMER_LEDGER_FILE];
const CONFLICT_COPIES = ["_internal/06-shorts-published-Neo.json", "_internal/06-shorts-published.linkedin-timer-Neo-2.json"];

describe("#13873 registros do vertical (timers, conflito, replaced) não contam como atividade recente", () => {
  for (const f of [...TIMER_FILES, ...CONFLICT_COPIES, SHORTS_REPLACED_FILE]) {
    it(`${f} recém-gravado, gate nunca aprovado → exit 0`, () => {
      const dir = staleEdition();
      touchRecent(dir, f);
      assert.equal(guard(dir), 0);
    });
  }
  it("com arquivo editorial recente junto, segue disparando exit 4", () => {
    const dir = staleEdition();
    touchRecent(dir, SHORTS_THREADS_TIMER_LEDGER_FILE);
    touchRecent(dir, SHORTS_REPLACED_FILE);
    touchRecent(dir, "03-social.md");
    assert.equal(guard(dir), 4);
  });
  it("paridade com isShortsRegistryFileName: todo nome do registro em _internal/ é excluído", () => {
    for (const f of [...TIMER_FILES, ...CONFLICT_COPIES]) {
      assert.ok(isShortsRegistryFileName(basename(f)), f);
      assert.ok(isPublicaVideoFile(f), f);
    }
    assert.ok(isPublicaVideoFile(SHORTS_REPLACED_FILE));
  });
  it("não alarga para fora de _internal/ nem para nomes vizinhos", () => {
    for (const f of ["06-shorts-published.json", "_internal/06-social-published.json", "_internal/06-shorts-published.md", "_internal/sub/06-shorts-published.json"]) {
      assert.equal(isPublicaVideoFile(f), false, f);
    }
  });
});
