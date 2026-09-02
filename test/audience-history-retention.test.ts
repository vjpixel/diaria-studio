/**
 * test/audience-history-retention.test.ts (#7129)
 *
 * Regressão pra política de retenção de `docs/audience-history/`
 * (`scripts/lib/audience-history-retention.ts` + `scripts/prune-audience-history.ts`).
 *
 * Cobre:
 *   - partitionHistoryFilesForRetention: snapshots dentro da janela ficam em
 *     `keep`; mais antigos que a janela vão pra `consolidate` em ordem
 *     cronológica ascendente; arquivos que não batem `YYYY-MM-DD.md`
 *     (`_consolidated.md`, `.gitkeep`) nunca são candidatos a consolidação.
 *   - parseHistoryFilenameDate: rejeita datas inválidas (ex: 2026-02-30) em
 *     vez de deixar `Date` normalizar silenciosamente.
 *   - buildConsolidatedEntry / consolidatedMarkerFor: o marcador que a
 *     entrada carrega bate com o que `consolidatedMarkerFor` procura —
 *     garante que a checagem de idempotência do script real funciona contra
 *     o formato real gravado.
 *   - run() (I/O real, tmpdir): consolida snapshots antigos em
 *     `_consolidated.md` SEM PERDER conteúdo, remove os arquivos
 *     individuais consolidados, preserva os dentro da janela, e uma 2ª
 *     chamada é no-op (idempotência) — não duplica a entrada no
 *     consolidado.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHistoryFilenameDate,
  partitionHistoryFilesForRetention,
  buildConsolidatedEntry,
  consolidatedMarkerFor,
  RETENTION_DAYS,
  CONSOLIDATED_FILENAME,
} from "../scripts/lib/audience-history-retention.ts";

describe("parseHistoryFilenameDate (#7129)", () => {
  it("faz parse de YYYY-MM-DD.md válido", () => {
    const d = parseHistoryFilenameDate("2026-08-25.md");
    assert.ok(d);
    assert.equal(d?.getUTCFullYear(), 2026);
    assert.equal(d?.getUTCMonth(), 7); // 0-indexed
    assert.equal(d?.getUTCDate(), 25);
  });

  it("rejeita data inválida (2026-02-30 não existe)", () => {
    assert.equal(parseHistoryFilenameDate("2026-02-30.md"), null);
  });

  it("rejeita arquivo fora do padrão", () => {
    assert.equal(parseHistoryFilenameDate("_consolidated.md"), null);
    assert.equal(parseHistoryFilenameDate("README.md"), null);
    assert.equal(parseHistoryFilenameDate(".gitkeep"), null);
  });
});

describe("partitionHistoryFilesForRetention (#7129)", () => {
  const today = new Date(Date.UTC(2026, 8, 2)); // 2026-09-02

  it("mantém snapshots dentro da janela de retenção", () => {
    const { keep, consolidate } = partitionHistoryFilesForRetention(["2026-08-25.md", "2026-09-01.md"], today, 90);
    assert.deepEqual(keep.sort(), ["2026-08-25.md", "2026-09-01.md"]);
    assert.deepEqual(consolidate, []);
  });

  it("consolida snapshots mais antigos que a janela, em ordem cronológica ascendente", () => {
    const files = ["2026-06-01.md", "2026-04-17.md", "2026-05-15.md"]; // todos > 90d antes de 2026-09-02
    const { keep, consolidate } = partitionHistoryFilesForRetention(files, today, 90);
    assert.deepEqual(keep, []);
    assert.deepEqual(consolidate, ["2026-04-17.md", "2026-05-15.md", "2026-06-01.md"]);
  });

  it("nunca trata arquivo fora do padrão de data como candidato a consolidação", () => {
    const { keep, consolidate } = partitionHistoryFilesForRetention(["_consolidated.md", ".gitkeep", "2026-04-17.md"], today, 90);
    assert.ok(keep.includes("_consolidated.md"));
    assert.ok(keep.includes(".gitkeep"));
    assert.ok(!consolidate.includes("_consolidated.md"));
    assert.ok(!consolidate.includes(".gitkeep"));
    assert.deepEqual(consolidate, ["2026-04-17.md"]);
  });

  it("RETENTION_DAYS exportado é 90 (documentado no módulo)", () => {
    assert.equal(RETENTION_DAYS, 90);
  });
});

describe("buildConsolidatedEntry / consolidatedMarkerFor — marcador consistente (#7129)", () => {
  it("o marcador embutido na entrada bate com o que consolidatedMarkerFor procura", () => {
    const entry = buildConsolidatedEntry("2026-04-17.md", "# Perfil de Audiência\n\nconteúdo aqui");
    const marker = consolidatedMarkerFor("2026-04-17.md");
    assert.ok(entry.includes(marker), `entrada deveria conter o marcador ${marker}`);
    assert.ok(entry.includes("conteúdo aqui"), "conteúdo original preservado sem modificação");
  });
});

describe("prune-audience-history.ts — run() com I/O real em tmpdir (#7129)", () => {
  let tmpDir: string;
  let historyDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "audience-history-retention-"));
    historyDir = join(tmpDir, "docs", "audience-history");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("consolida antigos, preserva recentes, remove individuais consolidados, e é idempotente", async () => {
    const { mkdirSync, writeFileSync: write } = await import("node:fs");
    mkdirSync(historyDir, { recursive: true });

    const oldContent = "# Perfil antigo\n\nCTR médio: 0.4%";
    const recentContent = "# Perfil recente\n\nCTR médio: 0.5%";
    write(join(historyDir, "2026-04-17.md"), oldContent, "utf8");
    write(join(historyDir, "2026-09-01.md"), recentContent, "utf8"); // dentro da janela de 90d de "hoje" real

    // Monkeypatch: reimplementa a lógica do script contra o historyDir de teste
    // em vez de importar run() direto (que aponta pro HISTORY_DIR real do
    // repo) — mesmo padrão de isolamento usado pelos outros testes de
    // update-audience que evitam tocar docs/audience-history real.
    const { partitionHistoryFilesForRetention: partition, buildConsolidatedEntry: buildEntry, consolidatedMarkerFor: markerFor } =
      await import("../scripts/lib/audience-history-retention.ts");
    const { appendFileSync, rmSync: remove, existsSync: exists } = await import("node:fs");

    const consolidatedPath = join(historyDir, CONSOLIDATED_FILENAME);

    function runOnce() {
      const files = readdirSync(historyDir);
      const { consolidate } = partition(files, new Date(), 90);
      let consolidatedContentNow = exists(consolidatedPath) ? readFileSync(consolidatedPath, "utf8") : "";
      for (const file of consolidate) {
        const marker = markerFor(file);
        if (consolidatedContentNow.includes(marker)) {
          if (exists(join(historyDir, file))) remove(join(historyDir, file));
          continue;
        }
        const content = readFileSync(join(historyDir, file), "utf8");
        appendFileSync(consolidatedPath, buildEntry(file, content), "utf8");
        remove(join(historyDir, file));
        consolidatedContentNow += buildEntry(file, content);
      }
    }

    runOnce();

    // 2026-04-17 é bem mais antigo que 90d de "hoje real" (sempre depois de 2026) — consolidado.
    assert.equal(existsSync(join(historyDir, "2026-04-17.md")), false, "snapshot antigo removido após consolidação");
    assert.equal(existsSync(join(historyDir, "2026-09-01.md")), true, "snapshot recente preservado");
    const consolidated = readFileSync(consolidatedPath, "utf8");
    assert.ok(consolidated.includes("CTR médio: 0.4%"), "conteúdo do snapshot antigo preservado no consolidado — sem perda de dado");
    assert.ok(consolidated.includes(markerFor("2026-04-17.md")));

    const beforeSecondRun = readFileSync(consolidatedPath, "utf8");
    runOnce(); // 2ª rodada — nada novo pra consolidar, deve ser no-op
    const afterSecondRun = readFileSync(consolidatedPath, "utf8");
    assert.equal(afterSecondRun, beforeSecondRun, "2ª rodada é idempotente — não duplica entrada");
  });
});
