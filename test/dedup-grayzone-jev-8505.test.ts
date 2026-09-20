import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedup } from "../scripts/dedup.ts";
import {
  GRAYZONE_MIN_CONFIDENCE,
  buildGrayZoneResolver,
  collectGrayZonePairs,
  createGrayZoneResolver,
  inGrayZone,
  pairKey,
  prefetchGrayZoneVerdicts,
  readDedupGrayzoneMode,
  type GrayZoneVerdict,
} from "../scripts/lib/dedup-grayzone-jev.ts";
import type { askJevBatch } from "../scripts/lib/jev.ts";

const PAST = "OpenAI lança novo modelo de raciocínio para desenvolvedores";
// Jaccard vs PAST (medido): 0.714 (heurística: mesma), 0.5 (heurística: distinta), 0.09 (fora da zona), 0.857 (acima do teto)
const Z_SAME = "OpenAI lança novo modelo de raciocínio para empresas";
const Z_DIFF = "Modelo de raciocínio da OpenAI chega aos desenvolvedores agora";
const FAR = "Google apresenta ferramenta de agentes para empresas e desenvolvedores";
const HIGH = "OpenAI lança novo modelo de raciocínio para desenvolvedores brasileiros";

const arts = (titles: string[]) => titles.map((t, i) => ({ url: `https://ex.com/${i}`, title: t, summary: "s", source: "Ex" }));
const runDedup = (titles: string[], gz?: ReturnType<typeof createGrayZoneResolver>) =>
  dedup(arts(titles), new Set(), 0.85, [], 0.7, [PAST], 0.6, undefined, 0.55, new Set(), [], gz);
const verdict = (sameStory: boolean, confidence = 0.95): GrayZoneVerdict => ({ sameStory, probability: sameStory ? 0.9 : 0.1, confidence });
const asAsk = (fn: unknown) => fn as typeof askJevBatch;

describe("zona cinzenta — pares", () => {
  it("inGrayZone: [0.35, 0.85)", () => {
    assert.equal(inGrayZone(0.34), false);
    assert.equal(inGrayZone(0.35), true);
    assert.equal(inGrayZone(0.849), true);
    assert.equal(inGrayZone(0.85), false);
  });
  it("collectGrayZonePairs só devolve pares na zona", () => {
    const { pairs } = collectGrayZonePairs(arts([Z_SAME, Z_DIFF, FAR, HIGH]), [PAST]);
    assert.deepEqual(pairs.map((p) => p.candidate.title).sort(), [Z_DIFF, Z_SAME].sort());
  });
});

describe("dedup com flag OFF — idêntico byte-a-byte", () => {
  const titles = [Z_SAME, Z_DIFF, FAR, HIGH];
  const baseline = JSON.stringify(runDedup(titles));
  it("resolver ausente = resolver em modo off", () => {
    const off = createGrayZoneResolver({ mode: "off", verdicts: new Map([[pairKey(Z_SAME, PAST), verdict(false)]]) });
    assert.equal(JSON.stringify(runDedup(titles, off)), baseline);
  });
  it("heurística histórica preservada (Z_SAME removida, Z_DIFF mantida)", () => {
    const r = runDedup(titles);
    assert.ok(r.removed.some((x) => x.title === Z_SAME));
    assert.ok(r.kept.some((x) => x.title === Z_DIFF));
  });
  it("buildGrayZoneResolver devolve undefined com flag false e não toca a rede", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gz-"));
    try {
      writeFileSync(join(dir, "platform.config.json"), JSON.stringify({ jev: { features: { dedup_grayzone: false } } }));
      let called = false;
      const r = await buildGrayZoneResolver(arts(titles), [PAST], {
        rootDir: dir,
        apiKey: "k",
        askBatchImpl: asAsk(async () => {
          called = true;
          throw new Error("nope");
        }),
      });
      assert.equal(r, undefined);
      assert.equal(called, false);
      assert.equal(readDedupGrayzoneMode(join(dir, "nao-existe.json")), "off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("modos shadow e active", () => {
  const titles = [Z_SAME, Z_DIFF, FAR, HIGH];
  const verdicts = new Map<string, GrayZoneVerdict>([
    [pairKey(Z_SAME, PAST), verdict(false)], // Jev discorda: heurística diz mesma
    [pairKey(Z_DIFF, PAST), verdict(true)], // Jev discorda: heurística diz distinta
    [pairKey(FAR, PAST), verdict(true)], // fora da zona: nunca deve valer
  ]);
  it("shadow não altera o resultado, mas registra as decisões lado a lado", () => {
    const gz = createGrayZoneResolver({ mode: "shadow", verdicts });
    assert.equal(JSON.stringify(runDedup(titles, gz)), JSON.stringify(runDedup(titles)));
    const recs = gz.records();
    assert.equal(recs.length, 2);
    assert.ok(recs.every((r) => r.decidedBy === "heuristic" && r.jevSame !== r.heuristicSame));
  });
  it("active: Jev decide na zona (mantém Z_SAME, remove Z_DIFF) e anota na nota", () => {
    const gz = createGrayZoneResolver({ mode: "active", verdicts });
    const r = runDedup(titles, gz);
    assert.ok(r.kept.some((x) => x.title === Z_SAME));
    const rem = r.removed.find((x) => x.title === Z_DIFF);
    assert.ok(rem && /Jev/.test(rem.dedup_note));
    assert.ok(r.kept.some((x) => x.title === FAR), "fora da zona segue determinístico");
    assert.ok(r.removed.some((x) => x.title === HIGH), "acima do teto segue determinístico");
  });
  it("confiança abaixo do limiar: a heurística decide", () => {
    const low = new Map([[pairKey(Z_SAME, PAST), verdict(false, GRAYZONE_MIN_CONFIDENCE - 0.01)]]);
    const gz = createGrayZoneResolver({ mode: "active", verdicts: low });
    assert.equal(JSON.stringify(runDedup(titles, gz)), JSON.stringify(runDedup(titles)));
    assert.equal(gz.records()[0].decidedBy, "heuristic");
  });
  it("par fora da zona nunca é consultado nem registrado", () => {
    const gz = createGrayZoneResolver({ mode: "active", verdicts });
    gz.decide(FAR, PAST, 0.09, false);
    gz.decide(HIGH, PAST, 0.857, true);
    assert.equal(gz.records().length, 0);
  });
});

describe("prefetch — cliente injetado, fail-soft", () => {
  const pairs = collectGrayZonePairs(arts([Z_SAME, Z_DIFF, FAR, HIGH]), [PAST]).pairs;
  it("só os pares da zona vão pro Jev", async () => {
    let sent = 0;
    const ask = asAsk(async (items: unknown[]) => {
      sent = items.length;
      return { results: [], errors: new Map() };
    });
    await prefetchGrayZoneVerdicts(pairs, { apiKey: "k", askBatchImpl: ask, rootDir: tmpdir() });
    assert.equal(sent, 2);
  });
  it("traduz noul em veredito", async () => {
    const ask = asAsk(async (items: { id: string }[]) => ({
      results: items.map((it) => ({ id: it.id, answers: [{ id: "same_story", type: "noul", probability: 0.8, confidence: 0.9 }] })),
      errors: new Map(),
    }));
    const v = await prefetchGrayZoneVerdicts(pairs, { apiKey: "k", askBatchImpl: ask, rootDir: tmpdir() });
    assert.equal(v.size, 2);
    assert.equal(v.get(pairKey(Z_SAME, PAST))?.sameStory, true);
  });
  it("erro do Jev: mapa vazio, sem lançar, warn no run-log; dedup igual ao atual", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gz-"));
    try {
      const ask = asAsk(async () => {
        throw new Error("HTTP 500");
      });
      const v = await prefetchGrayZoneVerdicts(pairs, { apiKey: "k", askBatchImpl: ask, rootDir: dir });
      assert.equal(v.size, 0);
      const log = join(dir, "data", "run-log.jsonl");
      assert.ok(existsSync(log));
      assert.match(readFileSync(log, "utf8"), /Jev indisponível/);
      const gz = createGrayZoneResolver({ mode: "active", verdicts: v });
      const t = [Z_SAME, Z_DIFF, FAR, HIGH];
      assert.equal(JSON.stringify(runDedup(t, gz)), JSON.stringify(runDedup(t)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("chave ausente: mapa vazio sem chamar o cliente", async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    const dir = mkdtempSync(join(tmpdir(), "gz-"));
    try {
      let called = false;
      const ask = asAsk(async () => {
        called = true;
        return { results: [], errors: new Map() };
      });
      const v = await prefetchGrayZoneVerdicts(pairs, { askBatchImpl: ask, rootDir: dir });
      assert.equal(v.size, 0);
      assert.equal(called, false);
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("prefetch — falha parcial e respostas malformadas (fleet review #8508)", () => {
  const pairs = collectGrayZonePairs(arts([Z_SAME, Z_DIFF, FAR, HIGH]), [PAST]).pairs;
  const good = (id: string) => ({ id, answers: [{ id: "same_story", type: "noul", probability: 0.8, confidence: 0.9 }] });

  it("errors.size>0: preserva os vereditos bons dos demais pares", async () => {
    const ask = asAsk(async (items: { id: string }[]) => ({
      results: [good(items[0].id)],
      errors: new Map([[items[1].id, new Error("HTTP 500")]]),
    }));
    const dir = mkdtempSync(join(tmpdir(), "gz-"));
    try {
      const v = await prefetchGrayZoneVerdicts(pairs, { apiKey: "k", askBatchImpl: ask, rootDir: dir });
      assert.equal(v.size, 1);
      assert.match(readFileSync(join(dir, "data", "run-log.jsonl"), "utf8"), /1\/2 par/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("1 resposta malformada não descarta as boas; warn com contagem e exemplo", async () => {
    const ask = asAsk(async (items: { id: string }[]) => ({
      results: [
        good(items[0].id),
        { id: items[1].id, answers: [{ id: "same_story", type: "noul", probability: Number.NaN, confidence: 0.9 }] },
      ],
      errors: new Map(),
    }));
    const dir = mkdtempSync(join(tmpdir(), "gz-"));
    try {
      const v = await prefetchGrayZoneVerdicts(pairs, { apiKey: "k", askBatchImpl: ask, rootDir: dir });
      assert.equal(v.size, 1);
      const log = readFileSync(join(dir, "data", "run-log.jsonl"), "utf8");
      assert.match(log, /1 resposta\(s\) malformada\(s\)/);
      assert.match(log, /Exemplo/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers ausente num item não lança nem afeta os demais", async () => {
    const ask = asAsk(async (items: { id: string }[]) => ({
      results: [good(items[0].id), { id: items[1].id }],
      errors: new Map(),
    }));
    const v = await prefetchGrayZoneVerdicts(pairs, { apiKey: "k", askBatchImpl: ask, rootDir: tmpdir() });
    assert.equal(v.size, 1);
  });

  it("buildGrayZoneResolver expõe stats de pares", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gz-"));
    try {
      writeFileSync(join(dir, "platform.config.json"), JSON.stringify({ jev: { features: { dedup_grayzone: true } } }));
      const ask = asAsk(async (items: { id: string }[]) => ({ results: [good(items[0].id)], errors: new Map() }));
      const r = await buildGrayZoneResolver(arts([Z_SAME, Z_DIFF, FAR, HIGH]), [PAST], { rootDir: dir, apiKey: "k", askBatchImpl: ask });
      assert.deepEqual(r?.stats, { pairsInZone: 2, pairsConsulted: 2, pairsWithVerdict: 1, truncated: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("platform.config.json real (#8505)", () => {
  it("commitado com a flag OFF; ligar sem tocar shadow resulta em shadow, nunca active", () => {
    const real = join(import.meta.dirname, "..", "platform.config.json");
    assert.equal(readDedupGrayzoneMode(real), "off");
    const cfg = JSON.parse(readFileSync(real, "utf8"));
    assert.equal(cfg.jev.features.dedup_grayzone, false);
    assert.equal(cfg.jev.shadow, true);
    const dir = mkdtempSync(join(tmpdir(), "gz-"));
    try {
      cfg.jev.features.dedup_grayzone = true;
      const p = join(dir, "c.json");
      writeFileSync(p, JSON.stringify(cfg));
      assert.equal(readDedupGrayzoneMode(p), "shadow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readDedupGrayzoneMode", () => {
  it("off / shadow (default) / active", () => {
    const dir = mkdtempSync(join(tmpdir(), "gz-"));
    try {
      const p = join(dir, "c.json");
      writeFileSync(p, JSON.stringify({ jev: { features: { dedup_grayzone: true } } }));
      assert.equal(readDedupGrayzoneMode(p), "shadow");
      writeFileSync(p, JSON.stringify({ jev: { shadow: false, features: { dedup_grayzone: true } } }));
      assert.equal(readDedupGrayzoneMode(p), "active");
      writeFileSync(p, JSON.stringify({ jev: { shadow: false, features: { dedup_grayzone: false } } }));
      assert.equal(readDedupGrayzoneMode(p), "off");
      writeFileSync(p, "{quebrado");
      assert.equal(readDedupGrayzoneMode(p), "off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
