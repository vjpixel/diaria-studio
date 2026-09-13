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

  it("rejeita mês/dia fora do calendário real (formato bate, data não existe)", () => {
    assert.throws(() => resolveEndDate("2026-13-40"), /--end inválido/);
    assert.throws(() => resolveEndDate("2026-02-30"), /--end inválido/);
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

  it("end_date != DEFAULT sem 'partial' setado ainda recusa sobrescrever latest.json (guard derivado, robusto a chamador que esqueça o campo)", () => {
    withTmpDir((dir) => {
      const good = makeSnapshot({ fetched_at: "2026-09-10T12:00:00.000Z" });
      saveSnapshot(good, dir);
      const latestPath = join(dir, "latest.json");
      const before = readFileSync(latestPath, "utf8");

      // Chamador hipotético que monta o snapshot com end_date "today" mas
      // esquece de setar partial: true — o guard precisa recusar mesmo assim.
      const noPartialFlag = makeSnapshot({
        fetched_at: "2026-09-11T16:55:00.000Z",
        end_date: "today",
      });
      assert.equal(noPartialFlag.partial, undefined);
      const { datedPath, latestPath: returnedLatestPath } = saveSnapshot(noPartialFlag, dir);

      assert.ok(existsSync(datedPath));
      assert.equal(returnedLatestPath, null);
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

describe("#8015 — snapshot parcial nunca colide com o datado completo do mesmo dia", () => {
  function withTmpDir(fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "ga4-sync-8015-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("cenário exato da issue: sync default (yesterday) seguido de --end today no MESMO dia — os dois arquivos coexistem, nenhum sobrescreve o outro", () => {
    withTmpDir((dir) => {
      // Sync agendado, default --end yesterday, roda 'hoje' (2026-09-11).
      const full = makeSnapshot({
        fetched_at: "2026-09-11T06:00:00.000Z",
        end_date: DEFAULT_END_DATE,
        overview: [{ tag: "full" }],
      });
      const { datedPath: fullDatedPath, latestPath: fullLatestPath } = saveSnapshot(full, dir);

      // Rodada ad-hoc --end today, MESMO dia de execução.
      const partial = makeSnapshot({
        fetched_at: "2026-09-11T16:55:00.000Z",
        end_date: "today",
        partial: true,
        overview: [{ tag: "partial" }],
      });
      const { datedPath: partialDatedPath, latestPath: partialLatestPath } = saveSnapshot(partial, dir);

      // Nomes de arquivo diferentes — nunca colidem.
      assert.notEqual(fullDatedPath, partialDatedPath);
      assert.ok(existsSync(fullDatedPath));
      assert.ok(existsSync(partialDatedPath));

      // O datado completo continua com o conteúdo do sync default —
      // não foi sobrescrito pelo --end today.
      const fullSaved = JSON.parse(readFileSync(fullDatedPath, "utf8"));
      assert.deepEqual(fullSaved.overview, [{ tag: "full" }]);

      // O parcial grava sob nome próprio, com sufixo previsível.
      assert.equal(partialDatedPath, join(dir, "2026-09-11.partial-today.json"));

      // latest.json aponta pro sync completo; nunca pro parcial.
      assert.ok(fullLatestPath && existsSync(fullLatestPath));
      assert.equal(partialLatestPath, null);
      const latestSaved = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
      assert.deepEqual(latestSaved.overview, [{ tag: "full" }]);
    });
  });

  it("ordem inversa: --end today ad-hoc primeiro, sync default depois no MESMO dia — o completo grava normalmente sem ser bloqueado pelo parcial", () => {
    withTmpDir((dir) => {
      const partial = makeSnapshot({
        fetched_at: "2026-09-11T09:00:00.000Z",
        end_date: "today",
        partial: true,
      });
      saveSnapshot(partial, dir);

      const full = makeSnapshot({
        fetched_at: "2026-09-11T18:00:00.000Z",
        end_date: DEFAULT_END_DATE,
      });
      const { datedPath, latestPath } = saveSnapshot(full, dir);

      assert.equal(datedPath, join(dir, "2026-09-11.json"));
      assert.ok(latestPath && existsSync(latestPath));
      // O parcial gravado antes continua intacto, arquivo próprio.
      assert.ok(existsSync(join(dir, "2026-09-11.partial-today.json")));
    });
  });

  it("nome do parcial inclui a data literal quando --end é uma data absoluta (não só 'today')", () => {
    withTmpDir((dir) => {
      const partial = makeSnapshot({
        fetched_at: "2026-09-11T09:00:00.000Z",
        end_date: "2026-09-10",
        partial: true,
      });
      const { datedPath } = saveSnapshot(partial, dir);
      assert.equal(datedPath, join(dir, "2026-09-11.partial-2026-09-10.json"));
    });
  });
});
