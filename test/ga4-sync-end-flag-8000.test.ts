/**
 * test/ga4-sync-end-flag-8000.test.ts (#8000)
 *
 * Cobre a flag `--end` de `scripts/ga4-sync.ts`: `endDate` era literal
 * ("yesterday" hardcoded) — agora aceita "yesterday" (default, preservado
 * byte a byte), "today", ou data absoluta "YYYY-MM-DD". Cobre também o
 * campo `partial` no snapshot salvo e o guard que impede um snapshot
 * parcial de sobrescrever `data/ga4-cache/latest.json`.
 *
 * Nenhum teste aqui chama a rede — `saveSnapshot` grava num diretório
 * temporário (`mkdtempSync`), nunca em `data/ga4-cache/` real (mesmo padrão
 * de `test/2-destaques-image-pipeline.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSyncRequests, resolveEndDate, saveSnapshot, DEFAULT_END_DATE, type Ga4Snapshot } from "../scripts/ga4-sync.ts";

function makeSnapshot(overrides: Partial<Ga4Snapshot> = {}): Ga4Snapshot {
  return {
    fetched_at: "2026-09-11T12:00:00.000Z",
    property_id: "999",
    window_days: 7,
    end_date: DEFAULT_END_DATE,
    overview: [],
    top_pages: [],
    channel: [],
    channel_group: [],
    ...overrides,
  };
}

describe("#8000 — resolveEndDate", () => {
  it("flag ausente (undefined) resolve pro default 'yesterday'", () => {
    assert.equal(resolveEndDate(undefined), "yesterday");
  });

  it("aceita 'today'", () => {
    assert.equal(resolveEndDate("today"), "today");
  });

  it("aceita data absoluta YYYY-MM-DD", () => {
    assert.equal(resolveEndDate("2026-09-10"), "2026-09-10");
  });

  it("rejeita valor fora dos 3 formatos aceitos", () => {
    assert.throws(() => resolveEndDate("amanha"), /--end inválido/);
  });

  it("rejeita data mal formatada (não bate a regex YYYY-MM-DD)", () => {
    assert.throws(() => resolveEndDate("10-09-2026"), /--end inválido/);
  });
});

describe("#8000 — buildSyncRequests com endDate", () => {
  it("sem 3º argumento, o comportamento é preservado byte a byte (endDate 'yesterday')", () => {
    const { overview, topPages, channel, channelGroup } = buildSyncRequests("999", 7);
    for (const req of [overview, topPages, channel, channelGroup]) {
      assert.deepEqual(req.dateRanges, [{ startDate: "7daysAgo", endDate: "yesterday" }]);
    }
  });

  it("--end today propaga 'today' como endDate nos 4 relatórios", () => {
    const requests = buildSyncRequests("999", 7, "today");
    for (const key of ["overview", "topPages", "channel", "channelGroup"] as const) {
      assert.deepEqual(requests[key].dateRanges, [{ startDate: "7daysAgo", endDate: "today" }]);
    }
  });

  it("--end com data absoluta propaga a data literal", () => {
    const { overview } = buildSyncRequests("999", 7, "2026-09-10");
    assert.deepEqual(overview.dateRanges, [{ startDate: "7daysAgo", endDate: "2026-09-10" }]);
  });
});

describe("#8000 — saveSnapshot: partial nunca sobrescreve latest.json", () => {
  function withTmpDir(fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "ga4-sync-8000-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("snapshot default (não-parcial) grava datado E latest.json", () => {
    withTmpDir((dir) => {
      const snapshot = makeSnapshot();
      const { datedPath, latestPath } = saveSnapshot(snapshot, dir);
      assert.ok(existsSync(datedPath));
      assert.ok(latestPath && existsSync(latestPath));
    });
  });

  it("snapshot partial:true grava só o datado — latest.json não é criado", () => {
    withTmpDir((dir) => {
      const snapshot = makeSnapshot({ end_date: "today", partial: true });
      const { datedPath, latestPath } = saveSnapshot(snapshot, dir);
      assert.ok(existsSync(datedPath));
      assert.equal(latestPath, null);
      assert.equal(existsSync(join(dir, "latest.json")), false);
    });
  });

  it("snapshot partial:true NUNCA sobrescreve um latest.json confiável já existente", () => {
    withTmpDir((dir) => {
      const good = makeSnapshot({ fetched_at: "2026-09-10T12:00:00.000Z" });
      saveSnapshot(good, dir);
      const latestPath = join(dir, "latest.json");
      const before = readFileSync(latestPath, "utf8");

      const partial = makeSnapshot({
        fetched_at: "2026-09-11T16:55:00.000Z",
        end_date: "today",
        partial: true,
      });
      saveSnapshot(partial, dir);

      const after = readFileSync(latestPath, "utf8");
      assert.equal(after, before, "latest.json deve permanecer o snapshot confiável anterior");
    });
  });

  it("o JSON salvo do parcial carrega partial:true e end_date != 'yesterday'", () => {
    withTmpDir((dir) => {
      const snapshot = makeSnapshot({ end_date: "today", partial: true });
      const { datedPath } = saveSnapshot(snapshot, dir);
      const saved = JSON.parse(readFileSync(datedPath, "utf8"));
      assert.equal(saved.partial, true);
      assert.equal(saved.end_date, "today");
    });
  });
});
