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
  assert.equal(bestThumbnail(undefined), null);
});

test("lista de canais tem os dois idiomas e handles únicos", () => {
  const handles = BENCHMARK_CHANNELS.map((c) => c.handle);
  assert.equal(new Set(handles).size, handles.length);
  assert.ok(BENCHMARK_CHANNELS.some((c) => c.lang === "pt") && BENCHMARK_CHANNELS.some((c) => c.lang === "en"));
  assert.ok(handles.every((h) => h.startsWith("@")));
});

test("eligibleVideos ordena por data mesmo com a API fora de ordem e respeita as fronteiras", () => {
  const shuffled = Array.from({ length: VIDEOS_PER_CHANNEL + 5 }, (_, i) => vid(`v${i}`, 1, { publishedAt: daysAgo(8 + i) }))
    .sort((a, b) => (a.id.length * 7 + Number(a.id.slice(1)) * 13) % 11 - (b.id.length * 7 + Number(b.id.slice(1)) * 13) % 11);
  const out = eligibleVideos(shuffled, NOW).map((v) => v.id);
  assert.deepEqual(new Set(out), new Set(Array.from({ length: VIDEOS_PER_CHANNEL }, (_, i) => `v${i}`)));
  assert.equal(out[0], "v0");
  const edge = eligibleVideos([
    vid("7dias", 1, { publishedAt: daysAgo(7) }),
    vid("181s", 1, { durationSeconds: 181 }),
    vid("data-ruim", 1, { publishedAt: "não é data" }),
  ], NOW).map((v) => v.id);
  assert.deepEqual(edge.sort(), ["181s", "7dias"]);
});

test("rankChannel: ratio exatamente 2 é acima da média; típicos têm o tamanho pedido e não repetem outlier", () => {
  const vs = [vid("a", 100), vid("b", 100), vid("c", 100), vid("d", 100), vid("e", 200), vid("z", 0)];
  const r = rankChannel(vs);
  assert.deepEqual(r.outliers.map((v) => v.id), ["e"]);
  assert.equal(r.typical.length, 3);
  assert.ok(!r.typical.some((v) => v.id === "e" || v.id === "z"), "vídeo sem views fica no fim, outlier nunca é típico");
  assert.equal(rankChannel(vs, 0).typical.length, 0);
  assert.equal(rankChannel(vs, -1).typical.length, 0);
});

test("rankChannel com mediana 0 ou lista vazia devolve grupos vazios", () => {
  for (const vs of [[], [vid("a", 0), vid("b", 0), vid("c", 5)]]) {
    const r = rankChannel(vs);
    assert.equal(r.outliers.length + r.typical.length, 0);
  }
});

test("median: ímpar, vazio, um elemento e sem mutar a entrada", () => {
  const xs = [5, 1, 3];
  assert.equal(median(xs), 3);
  assert.deepEqual(xs, [5, 1, 3]);
  assert.equal(median([]), 0);
  assert.equal(median([7]), 7);
});

test("parseIsoDuration rejeita T solto e aceita zero", () => {
  assert.equal(parseIsoDuration("P1DT"), null);
  assert.equal(parseIsoDuration("PT0S"), 0);
  assert.equal(parseIsoDuration("P1D"), 86400);
  assert.equal(parseIsoDuration(""), null);
});

test("bestThumbnail percorre a cadeia e pula url vazia", () => {
  assert.equal(bestThumbnail({ standard: { url: "s" }, high: { url: "h" } }), "s");
  assert.equal(bestThumbnail({ maxres: { url: "" }, high: { url: "h" } }), "h");
  assert.equal(bestThumbnail({}), null);
});

test("handles únicos sem diferenciar maiúsculas", () => {
  const lower = BENCHMARK_CHANNELS.map((c) => c.handle.toLowerCase());
  assert.equal(new Set(lower).size, lower.length);
});
