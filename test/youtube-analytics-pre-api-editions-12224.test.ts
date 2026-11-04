/**
 * #12224 — vídeos de 261021/261022 (anteriores ao upload pela API) saíam com
 * edição `?` no `--report`: as pastas dessas edições não têm registro de
 * upload, e o snapshot gravava `edition: null`. Só fixtures locais, sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRE_API_EDITION_VIDEOS,
  YOUTUBE_ANALYTICS_FILES,
  renderAnalyticsReport,
  withPreApiEditionVideos,
  type EditionVideoIndex,
  type VideoSnapshotLine,
} from "../scripts/lib/diaria/youtube-analytics.ts";
import { buildReport, resolveEditionVideoIndex } from "../scripts/youtube-analytics-snapshot.ts";

function line(videoId: string, title: string, kind: VideoSnapshotLine["kind"], gained = 0): VideoSnapshotLine {
  return {
    capturedAt: "2026-11-04T14:14:02.199Z",
    date: "2026-11-04",
    videoId,
    title,
    kind,
    edition: null,
    startDate: "2026-10-21",
    endDate: "2026-11-03",
    views: 100,
    estimatedMinutesWatched: 50,
    averageViewDuration: 40,
    averageViewPercentage: 30,
    subscribersGained: gained,
    subscribersLost: 0,
  };
}

/** As 4 linhas reais do videos.jsonl de 04/11/2026, como foram gravadas (edição null). */
const GRAVADAS = [
  line("QRbXMprk9o0", "Você já viu IA mentir. Já viu roubar?", "horizontal", 7),
  line("nhMUtgPPs4U", "Você já viu IA mentir. Já viu roubar? #Shorts", "short"),
  line("K3GqRK5gFds", "Claude projetou proteínas contra veneno de escorpião #Shorts", "short"),
  line("MMyBVHVQELI", "Claude projetou proteínas contra veneno de escorpião", "short"),
];

describe("#12224 mapa fixo dos vídeos anteriores ao upload pela API", () => {
  it("cobre os 4 vídeos de 261021/261022, com horizontal e Short por edição", () => {
    const byEd = new Map<string, string[]>();
    for (const v of PRE_API_EDITION_VIDEOS) byEd.set(v.edition, [...(byEd.get(v.edition) ?? []), v.kind].sort());
    assert.deepEqual([...byEd.keys()].sort(), ["261021", "261022"]);
    for (const kinds of byEd.values()) assert.deepEqual(kinds, ["horizontal", "short"]);
    assert.equal(new Set(PRE_API_EDITION_VIDEOS.map((v) => v.videoId)).size, PRE_API_EDITION_VIDEOS.length);
  });

  it("registro da pasta vence o mapa fixo", () => {
    const index: EditionVideoIndex = new Map([["QRbXMprk9o0", { edition: "269999", kind: "short" }]]);
    const merged = withPreApiEditionVideos(index);
    assert.deepEqual(merged.get("QRbXMprk9o0"), { edition: "269999", kind: "short" });
    assert.deepEqual(merged.get("K3GqRK5gFds"), { edition: "261022", kind: "short" });
    assert.equal(index.size, 1, "não muta o índice recebido");
  });

  it("relatório atribui edição às linhas já gravadas com edição null (o cenário da issue)", () => {
    const sem = renderAnalyticsReport({ channel: [], daily: [], traffic: [], videos: GRAVADAS });
    assert.match(sem, /\| \? \| Você já viu IA mentir\. Já viu roubar\? \(QRbXMprk9o0\)/);

    const md = renderAnalyticsReport({ channel: [], daily: [], traffic: [], videos: GRAVADAS, index: withPreApiEditionVideos(new Map()) });
    assert.doesNotMatch(md, /\| \? \|/);
    assert.match(md, /\| 261021 \| Você já viu IA mentir\. Já viu roubar\? \(QRbXMprk9o0\)/);
    assert.match(md, /\| 261021 \| Você já viu IA mentir\. Já viu roubar\? #Shorts \(nhMUtgPPs4U\)/);
    assert.match(md, /\| 261022 \| Claude projetou proteínas contra veneno de escorpião #Shorts \(K3GqRK5gFds\)/);
    // MMyBVHVQELI tinha sido gravado como Short pela duração; o mapa o move para Horizontais.
    const horizontais = md.slice(md.indexOf("### Horizontais"));
    assert.match(horizontais, /\| 261022 \| Claude projetou proteínas contra veneno de escorpião \(MMyBVHVQELI\)/);
  });

  it("buildReport (o --report de verdade) usa o índice com o mapa fixo, sem pasta de edição", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yta-12224-"));
    mkdirSync(join(dataRoot, "youtube-analytics"), { recursive: true });
    writeFileSync(join(dataRoot, "youtube-analytics", YOUTUBE_ANALYTICS_FILES.videos), GRAVADAS.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const md = buildReport(dataRoot);
    assert.doesNotMatch(md, /\| \? \|/);
    assert.match(md, /\| 261021 \| .*\(QRbXMprk9o0\)/);
    const { index } = resolveEditionVideoIndex(dataRoot);
    assert.deepEqual(index.get("MMyBVHVQELI"), { edition: "261022", kind: "horizontal" });
  });
});
