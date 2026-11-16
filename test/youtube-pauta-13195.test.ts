/**
 * test/youtube-pauta-13195.test.ts (#13195)
 *
 * Medição por pauta dos horizontais (decisão do editor no briefing do
 * overnight 261116: só instrumentar). Pauta = `pautas.json` do editor, senão a
 * seção do DESTAQUE 1; impressões/CTR da capa e retenção somadas por pauta.
 * Sem rede: o `--report` só lê o store.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAUTA_UNKNOWN,
  aggregateByPauta,
  horizontalEditions,
  parsePautaOverrides,
  pautaRows,
  renderPautaSection,
  resolveEditionPautas,
} from "../scripts/lib/diaria/youtube-pauta.ts";
import { renderAnalyticsReport, type EditionVideoIndex, type VideoSnapshotLine } from "../scripts/lib/diaria/youtube-analytics.ts";
import { buildReport, resolvePautas } from "../scripts/youtube-analytics-snapshot.ts";

function video(p: Partial<VideoSnapshotLine> & { videoId: string }): VideoSnapshotLine {
  return {
    capturedAt: "2026-11-16T10:00:00.000Z",
    date: "2026-11-16",
    title: p.videoId,
    kind: "horizontal",
    edition: null,
    startDate: "2026-10-21",
    endDate: "2026-11-15",
    views: 0,
    estimatedMinutesWatched: 0,
    averageViewDuration: 0,
    averageViewPercentage: 0,
    subscribersGained: 0,
    subscribersLost: 0,
    ...p,
  };
}

describe("#13195 pauta por edição", () => {
  it("pautas.json: AAMMDD → rótulo normalizado; `_nota` ignorada; chave ou valor inválido lança", () => {
    const m = parsePautaOverrides({ "261110": "Fofoca corporativa", _nota: "x", "261112": " 🔐 SEGURANÇA " }, "pautas.json");
    assert.deepEqual([...m], [["261110", "fofoca corporativa"], ["261112", "segurança"]]);
    assert.throws(() => parsePautaOverrides({ "2611": "x" }, "pautas.json"), /não é AAMMDD/);
    assert.throws(() => parsePautaOverrides({ "261110": "" }, "pautas.json"), /pauta vazia/);
    assert.throws(() => parsePautaOverrides([], "pautas.json"), /esperado objeto/);
  });

  it("editor vence o D1; D1 sem emoji e em minúsculas", () => {
    const p = resolveEditionPautas({
      d1Categories: new Map([["261110", "💼 MERCADO"], ["261112", "🔐 SEGURANÇA"]]),
      overrides: new Map([["261110", "fofoca corporativa"]]),
    });
    assert.deepEqual(p.get("261110"), { pauta: "fofoca corporativa", source: "editor" });
    assert.deepEqual(p.get("261112"), { pauta: "segurança", source: "d1" });
  });

  it("horizontalEditions só traz edições de horizontal", () => {
    const index: EditionVideoIndex = new Map([
      ["h1", { edition: "261110", kind: "horizontal" }],
      ["s1", { edition: "261110", kind: "short" }],
      ["s2", { edition: "261111", kind: "short" }],
    ]);
    assert.deepEqual(horizontalEditions(index), ["261110"]);
  });
});

describe("#13195 agregação por pauta", () => {
  const pautas = resolveEditionPautas({
    d1Categories: new Map([["261101", "SEGURANÇA"], ["261102", "SEGURANÇA"], ["261103", "LANÇAMENTO"]]),
    overrides: new Map(),
  });
  const videos = [
    video({ videoId: "a", edition: "261101", views: 100, averageViewPercentage: 60, thumbnailImpressions: 1000, thumbnailCtr: 0.09, subscribersGained: 5 }),
    video({ videoId: "b", edition: "261102", views: 300, averageViewPercentage: 40, thumbnailImpressions: 3000, thumbnailCtr: 0.03, subscribersLost: 1 }),
    video({ videoId: "c", edition: "261103", views: 50, averageViewPercentage: 20, thumbnailImpressions: 700, thumbnailCtr: 0.008 }),
    video({ videoId: "d", edition: "261104", views: 10, averageViewPercentage: 30, thumbnailImpressions: null, thumbnailCtr: null }),
    video({ videoId: "s", edition: "261101", kind: "short", views: 9999, thumbnailImpressions: 1, thumbnailCtr: 1 }),
  ];

  it("CTR ponderado por impressões, retenção ponderada por views, Shorts fora", () => {
    const agg = aggregateByPauta(pautaRows(videos, pautas));
    const seg = agg.find((a) => a.pauta === "segurança")!;
    assert.equal(seg.videos, 2);
    assert.equal(seg.views, 400);
    assert.equal(seg.impressions, 4000);
    // (1000×0,09 + 3000×0,03) / 4000 = 180/4000 = 4,5% — a média simples daria 6%.
    assert.ok(Math.abs(seg.ctr! - 0.045) < 1e-9, String(seg.ctr));
    // (100×60 + 300×40) / 400 = 45
    assert.equal(seg.averageViewPercentage, 45);
    assert.equal(seg.netSubscribers, 4);
    const unknown = agg.find((a) => a.pauta === PAUTA_UNKNOWN)!;
    assert.equal(unknown.impressions, null);
    assert.equal(unknown.ctr, null);
    assert.equal(unknown.withoutReach, 1);
    assert.deepEqual(agg.map((a) => a.pauta), ["segurança", "lançamento", PAUTA_UNKNOWN], "ordem por CTR, sem dado no fim");
  });

  it("seção do relatório: tabela por pauta, por horizontal e lista dos sem pauta", () => {
    const md = renderPautaSection(videos, pautas).join("\n");
    assert.match(md, /## Horizontais por pauta \(#13195\)/);
    assert.match(md, /\| segurança \| 2 \| 400 \| 4\.000 \| 4,5% \| 45,0% \| 4 \|/);
    assert.match(md, /\| lançamento \| 1 \| 50 \| 700 \| 0,8% \| 20,0% \| 0 \|/);
    assert.match(md, /\| segurança \| d1 \| 261101 \| a \(a\) \| 100 \| 1\.000 \| 9,0% \| 60,0% \|/);
    assert.match(md, /Sem pauta: 261104\./);
    assert.ok(!md.includes("(s)"), "Short não entra");
  });

  it("renderAnalyticsReport só mostra a seção com `pautas`", () => {
    const base = { channel: [], daily: [], traffic: [], videos };
    assert.doesNotMatch(renderAnalyticsReport(base), /Horizontais por pauta/);
    assert.match(renderAnalyticsReport({ ...base, pautas }), /Horizontais por pauta/);
  });
});

describe("#13195 --report lê o D1 e o pautas.json do store", () => {
  it("D1 da edição + override do editor; pautas.json ilegível avisa e cai no D1", () => {
    const root = mkdtempSync(join(tmpdir(), "pauta-13195-"));
    try {
      const ed = (aammdd: string, cat: string) => {
        const dir = join(root, "editions", aammdd.slice(0, 4), aammdd);
        mkdirSync(join(dir, "_internal"), { recursive: true });
        writeFileSync(join(dir, "02-reviewed.md"), `DESTAQUE 1 | ${cat}\n\n[Título ${aammdd}](https://example.com/${aammdd})\n\nCorpo.\n\nPor que isso importa: x.\n`);
      };
      ed("261110", "💼 MERCADO");
      ed("261112", "🔐 SEGURANÇA");
      const index: EditionVideoIndex = new Map([
        ["n1", { edition: "261110", kind: "horizontal" }],
        ["c1", { edition: "261112", kind: "horizontal" }],
        ["x1", { edition: "261113", kind: "horizontal" }],
      ]);
      const store = join(root, "youtube-analytics");
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, "pautas.json"), JSON.stringify({ "261110": "fofoca corporativa" }));
      const p = resolvePautas(root, index);
      assert.deepEqual(p.get("261110"), { pauta: "fofoca corporativa", source: "editor" });
      assert.deepEqual(p.get("261112"), { pauta: "segurança", source: "d1" });
      assert.equal(p.get("261113"), undefined, "sem 02-reviewed.md: sem pauta");

      writeFileSync(join(store, "pautas.json"), "{quebrado");
      const warnings: string[] = [];
      const p2 = resolvePautas(root, index, (m) => warnings.push(m));
      assert.deepEqual(p2.get("261110"), { pauta: "mercado", source: "d1" });
      assert.ok(warnings.some((w) => w.includes("#13195")), warnings.join("\n"));

      // buildReport inclui a seção (mesmo sem vídeo gravado).
      assert.match(buildReport(root), /## Horizontais por pauta/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
