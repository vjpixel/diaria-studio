/**
 * #13217 — benchmark visual de capas: duração ISO, filtro de vídeo longo/maduro
 * e separação "acima da média do próprio canal" × "típicos".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BENCHMARK_CHANNELS,
  OUTLIER_RATIO,
  VIDEOS_PER_CHANNEL,
  bestThumbnail,
  eligibleVideos,
  median,
  parseIsoDuration,
  rankChannel,
  type BenchmarkVideo,
} from "../scripts/lib/diaria/youtube-capa-benchmark.ts";

const NOW = new Date("2026-11-16T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();
const vid = (id: string, views: number, over: Partial<BenchmarkVideo> = {}): BenchmarkVideo => ({
  id, title: id, publishedAt: daysAgo(10), durationSeconds: 600, views, thumbnailUrl: `u/${id}`, ...over,
});

test("parseIsoDuration cobre horas, minutos, segundos e dias; formato inválido é null", () => {
  assert.equal(parseIsoDuration("PT1H2M3S"), 3723);
  assert.equal(parseIsoDuration("PT45S"), 45);
  assert.equal(parseIsoDuration("PT3M"), 180);
  assert.equal(parseIsoDuration("P1DT1S"), 86401);
  assert.equal(parseIsoDuration("PT"), null);
  assert.equal(parseIsoDuration("1:00"), null);
});

test("eligibleVideos tira Short (<=3 min), vídeo com menos de 7 dias e corta nos mais recentes", () => {
  const vs = [
    vid("short", 1, { durationSeconds: 180 }),
    vid("novo", 1, { publishedAt: daysAgo(2) }),
    ...Array.from({ length: VIDEOS_PER_CHANNEL + 5 }, (_, i) => vid(`v${i}`, 1, { publishedAt: daysAgo(8 + i) })),
  ];
  const out = eligibleVideos(vs, NOW);
  assert.equal(out.length, VIDEOS_PER_CHANNEL);
  assert.ok(!out.some((v) => v.id === "short" || v.id === "novo"));
  assert.equal(out[0].id, "v0");
});

test("rankChannel mede contra a mediana do PRÓPRIO canal", () => {
  const vs = [vid("a", 100), vid("b", 100), vid("c", 110), vid("d", 90), vid("e", 500), vid("f", 1000)];
  assert.equal(median(vs.map((v) => v.views)), 105);
  const r = rankChannel(vs, 2);
  assert.deepEqual(r.outliers.map((v) => v.id), ["f", "e"]);
  assert.ok(r.outliers.every((v) => v.ratio >= OUTLIER_RATIO));
  assert.ok(r.typical.every((v) => Math.abs(v.ratio - 1) < 0.1));
});

test("canal grande e canal pequeno com o mesmo padrão relativo dão o mesmo ratio", () => {
  const big = rankChannel([vid("x", 1_000_000), vid("y", 1_000_000), vid("z", 3_000_000)]);
  const small = rankChannel([vid("x", 1_000), vid("y", 1_000), vid("z", 3_000)]);
  assert.equal(big.outliers[0].ratio, small.outliers[0].ratio);
});

test("bestThumbnail prefere maxres e cai para a melhor disponível", () => {
  assert.equal(bestThumbnail({ high: { url: "h" }, maxres: { url: "m" } }), "m");
  assert.equal(bestThumbnail({ medium: { url: "md" }, default: { url: "d" } }), "md");
  assert.equal(bestThumbnail(undefined), "");
});

test("lista de canais tem os dois idiomas e handles únicos", () => {
  const handles = BENCHMARK_CHANNELS.map((c) => c.handle);
  assert.equal(new Set(handles).size, handles.length);
  assert.ok(BENCHMARK_CHANNELS.some((c) => c.lang === "pt") && BENCHMARK_CHANNELS.some((c) => c.lang === "en"));
  assert.ok(handles.every((h) => h.startsWith("@")));
});
