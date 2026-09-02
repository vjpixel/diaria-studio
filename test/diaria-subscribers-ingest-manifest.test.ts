/**
 * diaria-subscribers-ingest-manifest.test.ts (#6464 fatias 3/4 — #6586/#6587)
 *
 * Cobre o manifest genérico de progresso reusado pelos 2 builders
 * (Kit por-broadcast, Brevo por-conta): bootstrap, merge não-destrutivo
 * (retomada), upsert de resultado, e sumário de cobertura.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialManifest,
  mergeManifestEntries,
  upsertManifestEntry,
  pendingManifestEntries,
  manifestCoverageSummary,
  type IngestManifest,
} from "../scripts/lib/diaria-subscribers-ingest-manifest.ts";

describe("buildInitialManifest", () => {
  it("nasce vazio, sem entries", () => {
    const m = buildInitialManifest("2026-09-01T00:00:00.000Z");
    assert.deepEqual(m.entries, []);
    assert.equal(m.generated_at, "2026-09-01T00:00:00.000Z");
  });
});

describe("mergeManifestEntries — retomada sem regressão de status", () => {
  it("preserva status ok/partial de entries já processadas ao re-descobrir", () => {
    const existing: IngestManifest = {
      generated_at: "2026-08-31T00:00:00.000Z",
      entries: [
        { id: "1", label: "A", status: "ok", counts: { sent: 42 } },
        { id: "2", label: "B", status: "partial", error: "guard" },
      ],
    };
    const merged = mergeManifestEntries(
      existing,
      [{ id: "1", label: "A" }, { id: "2", label: "B" }, { id: "3", label: "Novo" }],
      "2026-09-01T00:00:00.000Z",
    );
    const e1 = merged.entries.find((e) => e.id === "1")!;
    const e2 = merged.entries.find((e) => e.id === "2")!;
    const e3 = merged.entries.find((e) => e.id === "3")!;
    assert.equal(e1.status, "ok", "merge nunca rebaixa uma entry já confirmada");
    assert.equal(e1.counts?.sent, 42);
    assert.equal(e2.status, "partial", "merge preserva partial — retomada depende disso");
    assert.equal(e3.status, "pending");
    assert.equal(e3.label, "Novo");
  });

  it("preenche label que faltava sem tocar o resto da entry", () => {
    const existing: IngestManifest = {
      generated_at: "x",
      entries: [{ id: "1", status: "pending" }],
    };
    const merged = mergeManifestEntries(existing, [{ id: "1", label: "Assunto real" }], "y");
    assert.equal(merged.entries[0].label, "Assunto real");
    assert.equal(merged.entries[0].status, "pending");
  });
});

describe("upsertManifestEntry", () => {
  it("substitui a entry existente por id, preservando as demais", () => {
    const m: IngestManifest = {
      generated_at: "x",
      entries: [
        { id: "1", status: "pending" },
        { id: "2", status: "pending" },
      ],
    };
    const updated = upsertManifestEntry(m, { id: "1", status: "ok", counts: { sent: 10 } });
    assert.equal(updated.entries.length, 2);
    assert.equal(updated.entries.find((e) => e.id === "1")!.status, "ok");
    assert.equal(updated.entries.find((e) => e.id === "2")!.status, "pending");
  });

  it("adiciona a entry se ela ainda não existia", () => {
    const m = buildInitialManifest("x");
    const updated = upsertManifestEntry(m, { id: "novo", status: "error", error: "boom" });
    assert.equal(updated.entries.length, 1);
    assert.equal(updated.entries[0].error, "boom");
  });
});

describe("pendingManifestEntries / manifestCoverageSummary", () => {
  it("pending exclui só 'ok'; partial/error/pending contam como trabalho restante", () => {
    const m: IngestManifest = {
      generated_at: "x",
      entries: [
        { id: "1", status: "ok" },
        { id: "2", status: "partial" },
        { id: "3", status: "error" },
        { id: "4", status: "pending" },
      ],
    };
    const pending = pendingManifestEntries(m);
    assert.deepEqual(pending.map((e) => e.id).sort(), ["2", "3", "4"]);
  });

  it("closed só quando TODAS as entries estão ok", () => {
    const aberto: IngestManifest = {
      generated_at: "x",
      entries: [{ id: "1", status: "ok" }, { id: "2", status: "pending" }],
    };
    assert.equal(manifestCoverageSummary(aberto).closed, false);

    const fechado: IngestManifest = {
      generated_at: "x",
      entries: [{ id: "1", status: "ok" }, { id: "2", status: "ok" }],
    };
    const summary = manifestCoverageSummary(fechado);
    assert.equal(summary.closed, true);
    assert.equal(summary.total, 2);
    assert.equal(summary.ok, 2);
  });

  it("manifest vazio nunca reporta closed (nada foi descoberto ainda)", () => {
    const vazio = buildInitialManifest("x");
    assert.equal(manifestCoverageSummary(vazio).closed, false);
  });
});
