/**
 * test/video-montage-cache-experiments-13137.test.ts (#13137)
 *
 * No 300, `~/.cache/m12089` guardava 7,9 GB de cópias do bruto da 261104
 * (experimento da #12089), fora da raiz do cache da montagem: o
 * `prune-video-montage-cache.ts` só olhava `{raiz}/{AAMMDD}/` e nunca o via.
 * Cobre: o local padrão `{raiz}/_experimentos/{nome}/` com retenção por tempo
 * sem uso, e o aviso (só aviso, nunca apaga) de cópia de mídia direto no
 * `~/.cache`. Tudo contra tmpdir; nada toca o cache real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_EXPERIMENTS_DIR,
  DEFAULT_EXPERIMENT_MAX_IDLE_DAYS,
  ORPHAN_MEDIA_MIN_BYTES,
  isMediaFileName,
  planExperimentRetention,
  type ExperimentEntry,
} from "../scripts/lib/diaria/video-montage-cache-retention.ts";
import { findOrphanMediaDirs, pruneVideoMontageCache, readExperimentEntries } from "../scripts/prune-video-montage-cache.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 15, 12);
const TODAY = new Date(Date.UTC(2026, 10, 15));

const exp = (name: string, idleDays: number | null, extra: Partial<ExperimentEntry> = {}): ExperimentEntry => ({
  name,
  kind: "dir",
  sizeBytes: 100,
  lastModifiedMs: idleDays === null ? null : NOW - idleDays * DAY,
  ...extra,
});

/** Envelhece a árvore inteira (arquivos e diretórios), de baixo para cima. */
function ageTree(paths: string[], days: number): void {
  const t = new Date(NOW - days * DAY);
  for (const p of paths) utimesSync(p, t, t);
}

describe("#13137 política dos experimentos", () => {
  it("default de 30 dias; local padrão `_experimentos`", () => {
    assert.equal(DEFAULT_EXPERIMENT_MAX_IDLE_DAYS, 30);
    assert.equal(CACHE_EXPERIMENTS_DIR, "_experimentos");
  });

  it("fronteira: 30 dias sem uso fica, 31 sai; recente fica", () => {
    const p = planExperimentRetention([exp("m12089", 31, { sizeBytes: 7900 }), exp("borda", 30), exp("novo", 0)], NOW);
    assert.deepEqual(p.remove.map((r) => [r.name, r.idleDays]), [["m12089", 31]]);
    assert.deepEqual(p.keep.map((k) => k.name), ["borda", "novo"]);
    assert.equal(p.removeBytes, 7900);
  });

  it("symlink, arquivo solto e diretório sem mtime nunca saem", () => {
    const p = planExperimentRetention(
      [exp("link", 90, { kind: "symlink" }), exp("solto.mp4", 90, { kind: "other" }), exp("sem-data", null)],
      NOW,
    );
    assert.deepEqual(p.remove, []);
    assert.deepEqual(p.skipped, [
      { name: "link", reason: "symlink" },
      { name: "sem-data", reason: "sem-mtime" },
      { name: "solto.mp4", reason: "nao-diretorio" },
    ]);
  });

  it("maxIdleDays inválido é erro", () => {
    assert.throws(() => planExperimentRetention([], NOW, { maxIdleDays: 0 }));
    assert.throws(() => planExperimentRetention([], NOW, { maxIdleDays: 1.5 }));
  });

  it("isMediaFileName: mp4/wav em qualquer caixa; json e txt não", () => {
    assert.ok(isMediaFileName("20261104_124252.MP4"));
    assert.ok(isMediaFileName("audio.wav"));
    assert.ok(!isMediaFileName("plan.json"));
    assert.ok(!isMediaFileName("mp4.txt"));
  });
});

describe("#13137 prune cobre `{raiz}/_experimentos/`", () => {
  const fixture = () => {
    const base = mkdtempSync(join(tmpdir(), "prune-exp-13137-"));
    const cache = join(base, "cache");
    mkdirSync(cache, { recursive: true });
    return { base, cache, data: join(base, "data") };
  };
  const opts = (cache: string, data: string) => ({ cacheRoot: cache, dataRoot: data, today: TODAY, nowMs: NOW, keepDays: 3, unpublishedMaxDays: 14 });
  const experiment = (cache: string, name: string, idleDays: number) => {
    const d = join(cache, CACHE_EXPERIMENTS_DIR, name);
    mkdirSync(d, { recursive: true });
    const f = join(d, "bruto.mp4");
    writeFileSync(f, "x".repeat(50));
    ageTree([f, d], idleDays);
    return d;
  };

  it("`_experimentos` não entra como edição de nome inválido; dry-run não apaga; --apply apaga só o parado há mais de 30 dias", () => {
    const { base, cache, data } = fixture();
    try {
      const old = experiment(cache, "m12089", 45);
      const recent = experiment(cache, "voz-teste", 2);
      const dry = pruneVideoMontageCache({ ...opts(cache, data), apply: false });
      assert.deepEqual(dry.plan.skipped, [], "a pasta de experimentos tem política própria");
      assert.deepEqual(dry.experiments.remove.map((r) => [r.name, r.idleDays]), [["m12089", 45]]);
      assert.deepEqual(dry.experiments.keep.map((k) => k.name), ["voz-teste"]);
      assert.equal(dry.experiments.removeBytes, 50);
      assert.deepEqual(dry.deletedExperiments, []);
      assert.ok(existsSync(old), "dry-run não apaga");

      const real = pruneVideoMontageCache({ ...opts(cache, data), apply: true });
      assert.deepEqual(real.deletedExperiments, ["m12089"]);
      assert.deepEqual(real.failed, []);
      assert.ok(!existsSync(old));
      assert.ok(existsSync(recent));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("experimentMaxIdleDays sobrepõe o default", () => {
    const { base, cache, data } = fixture();
    try {
      experiment(cache, "e1", 45);
      const r = pruneVideoMontageCache({ ...opts(cache, data), experimentMaxIdleDays: 60, apply: true });
      assert.deepEqual(r.deletedExperiments, []);
      assert.deepEqual(r.experiments.keep.map((k) => k.name), ["e1"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("`_experimentos` como symlink nunca é seguido: alvo intacto, nada listado", () => {
    const { base, cache, data } = fixture();
    try {
      const outside = join(base, "fora", "precioso");
      mkdirSync(outside, { recursive: true });
      const f = join(outside, "bruto.mp4");
      writeFileSync(f, "x");
      ageTree([f, outside], 90);
      symlinkSync(join(base, "fora"), join(cache, CACHE_EXPERIMENTS_DIR));
      assert.deepEqual(readExperimentEntries(cache), []);
      const r = pruneVideoMontageCache({ ...opts(cache, data), apply: true });
      assert.deepEqual(r.experiments.remove, []);
      assert.deepEqual(r.deletedExperiments, []);
      assert.deepEqual(r.plan.skipped, [{ name: CACHE_EXPERIMENTS_DIR, reason: "symlink" }]);
      assert.ok(existsSync(f));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("symlink dentro de `_experimentos` fica de fora e o alvo intacto", () => {
    const { base, cache, data } = fixture();
    try {
      const outside = join(base, "fora");
      mkdirSync(outside);
      writeFileSync(join(outside, "precioso.wav"), "x");
      mkdirSync(join(cache, CACHE_EXPERIMENTS_DIR));
      symlinkSync(outside, join(cache, CACHE_EXPERIMENTS_DIR, "link"));
      const r = pruneVideoMontageCache({ ...opts(cache, data), apply: true });
      assert.deepEqual(r.experiments.skipped, [{ name: "link", reason: "symlink" }]);
      assert.ok(existsSync(join(outside, "precioso.wav")));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("#13137 cópia de mídia órfã direto no ~/.cache: só aviso", () => {
  it("cenário real (m12089: dois .mp4 e dois .wav, 2 GB esparsos) é achado; a raiz do cache e pasta sem mídia não; nada é apagado", () => {
    const base = mkdtempSync(join(tmpdir(), "orphan-13137-"));
    try {
      const dotCache = join(base, ".cache");
      const root = join(dotCache, "diaria-video-montagem");
      mkdirSync(join(root, "261104", "bruto"), { recursive: true });
      writeFileSync(join(root, "261104", "bruto", "a.mp4"), "");
      truncateSync(join(root, "261104", "bruto", "a.mp4"), 2 * ORPHAN_MEDIA_MIN_BYTES);
      const orphan = join(dotCache, "m12089");
      mkdirSync(orphan);
      for (const [n, size] of [["20261104_124252.mp4", 0.6], ["20261104_130010.mp4", 0.6], ["a.wav", 0.4], ["b.wav", 0.4]] as const) {
        const p = join(orphan, n);
        writeFileSync(p, "");
        truncateSync(p, Math.round(size * ORPHAN_MEDIA_MIN_BYTES));
      }
      mkdirSync(join(dotCache, "pip"));
      writeFileSync(join(dotCache, "pip", "wheel.json"), "x".repeat(100));

      const found = findOrphanMediaDirs(dotCache, [root]);
      assert.deepEqual(found.map((o) => o.path), [orphan]);
      assert.equal(found[0].mediaBytes, Math.round(0.6 * ORPHAN_MEDIA_MIN_BYTES) * 2 + Math.round(0.4 * ORPHAN_MEDIA_MIN_BYTES) * 2);
      assert.ok(existsSync(join(orphan, "a.wav")), "só lê, nunca apaga");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("abaixo do limiar não avisa; mídia além da profundidade não conta; symlink no ~/.cache não é seguido", () => {
    const base = mkdtempSync(join(tmpdir(), "orphan-13137-"));
    try {
      const dotCache = join(base, ".cache");
      mkdirSync(join(dotCache, "pequeno"), { recursive: true });
      writeFileSync(join(dotCache, "pequeno", "x.mp4"), "x".repeat(10));
      mkdirSync(join(dotCache, "fundo", "a", "b"), { recursive: true });
      writeFileSync(join(dotCache, "fundo", "a", "b", "x.mp4"), "x".repeat(500));
      mkdirSync(join(dotCache, "raso", "a"), { recursive: true });
      writeFileSync(join(dotCache, "raso", "a", "x.mov"), "x".repeat(500));
      const outside = join(base, "fora");
      mkdirSync(outside);
      writeFileSync(join(outside, "x.mp4"), "x".repeat(500));
      symlinkSync(outside, join(dotCache, "link"));

      const found = findOrphanMediaDirs(dotCache, [], { minBytes: 100 });
      assert.deepEqual(found.map((o) => o.path), [join(dotCache, "raso")]);
      assert.deepEqual(findOrphanMediaDirs(join(base, "nao-existe"), []), []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
