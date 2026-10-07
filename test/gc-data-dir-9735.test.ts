/**
 * gc-data-dir-9735.test.ts (#9735 item 3)
 *
 * Regressão: a ORDEM das cópias-irmãs dentro da família (quem é "a mais
 * recente", nunca candidata) tem que sair do MESMO timestamp conservador da
 * idade (`siblingTimestamp`), não do mtime cru. Fixture em que as duas ordens
 * divergem: a cópia A herdou um mtime antigo (rename de conflito do OneDrive)
 * mas é a mais recente pelo critério conservador; com o mtime cru, A virava
 * candidata e a cópia B, de fato mais velha, era preservada.
 *
 * Tudo contra tmpdir fixture — NUNCA o `data/` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { collectCandidates } from "../scripts/gc-data-dir.ts";

const DAY_MS = 86_400_000;

function writeAged(path: string, ageDays: number): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  const t = (Date.now() - ageDays * DAY_MS) / 1000;
  utimesSync(path, t, t);
}

describe("#9735 — ordem da família de cópias-irmãs usa o timestamp conservador", () => {
  it("cópia com mtime herdado antigo mas mais recente pelo critério conservador é a preservada", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-9735-order-"));
    const a = resolve(tmp, "logs/run-log-Neo.jsonl"); // mtime cru 400d, conservador 60d
    const b = resolve(tmp, "logs/run-log-Zenbook.jsonl"); // mtime cru 100d, conservador 100d
    writeAged(resolve(tmp, "logs/run-log.jsonl"), 1);
    writeAged(a, 400);
    writeAged(b, 100);

    const now = Date.now();
    // Injetado: a cópia de mtime ~400d "nasceu" há 60d (ctime/birthtime), as demais seguem o mtime.
    const siblingTs = (st: Stats): number => (now - st.mtimeMs > 300 * DAY_MS ? now - 60 * DAY_MS : st.mtimeMs);

    const { candidates } = collectCandidates(tmp, now, { siblingTimestamp: siblingTs });
    const siblings = candidates.filter((c) => c.bucket === "backup-sibling").map((c) => c.relPath);
    assert.deepEqual(
      siblings,
      ["logs/run-log-Zenbook.jsonl"],
      "a candidata é B (mais velha pelo critério conservador); A, a mais recente, é preservada",
    );
  });
});
