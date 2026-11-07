/**
 * test/video-montage-cache-retention-12365.test.ts (#12365)
 *
 * O cache do `/diaria-video-montagem` no modo API não tinha retenção e chegou
 * a 33 GB no raiz do 300. Cobre: a política pura (data da edição, janela,
 * publicação, teto sem publicação), o script contra um tmpdir (sinal de
 * publicação, symlink nunca seguido, dry-run não apaga), o guard de
 * `DIARIA_VIDEO_CACHE_DIR` apontando para um HD desmontado e a task agendada.
 * Nada aqui toca o cache real nem o `data/` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_CACHE_KEEP_DAYS,
  DEFAULT_CACHE_UNPUBLISHED_MAX_DAYS,
  planCacheRetention,
  type CacheEntry,
} from "../scripts/lib/diaria/video-montage-cache-retention.ts";
import { VideoCacheRootMissingError, driveCacheDir, videoCacheRoot } from "../scripts/lib/diaria/video-montage-drive.ts";
import { editionVideoPublished, pruneVideoMontageCache } from "../scripts/prune-video-montage-cache.ts";
import { montageCacheRoot } from "../scripts/check-video-env.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const TODAY = new Date(Date.UTC(2026, 10, 7, 15)); // 07/11/2026, o dia do achado

const dir = (name: string, published: boolean | null, sizeBytes = 1000): CacheEntry => ({ name, kind: "dir", sizeBytes, published });

describe("#12365 política de retenção do cache da montagem", () => {
  it("defaults: 3 dias de janela, 14 de teto sem publicação", () => {
    assert.equal(DEFAULT_CACHE_KEEP_DAYS, 3);
    assert.equal(DEFAULT_CACHE_UNPUBLISHED_MAX_DAYS, 14);
  });

  it("cenário real da issue (261030, 261103, 261105 publicados): saem as duas mais velhas que 3 dias", () => {
    const plan = planCacheRetention(
      [dir("261030", true, 6_500), dir("261103", true, 10_000), dir("261105", true, 17_000)],
      TODAY,
    );
    assert.deepEqual(plan.remove.map((r) => [r.edition, r.reason, r.ageDays]), [
      ["261030", "publicado", 8],
      ["261103", "publicado", 4],
    ]);
    assert.deepEqual(plan.keep.map((k) => [k.edition, k.reason]), [["261105", "na-janela"]]);
    assert.equal(plan.removeBytes, 16_500);
  });

  it("dentro da janela fica mesmo publicado; data futura também fica", () => {
    const plan = planCacheRetention([dir("261104", true), dir("261108", true)], TODAY);
    assert.equal(plan.remove.length, 0);
    assert.deepEqual(plan.keep.map((k) => k.reason), ["na-janela", "na-janela"]);
  });

  it("sem publicação: fica até o teto, sai depois dele", () => {
    const plan = planCacheRetention([dir("261030", false), dir("261020", false)], TODAY);
    assert.deepEqual(plan.keep.map((k) => [k.edition, k.reason]), [["261030", "aguardando-publicacao"]]);
    assert.deepEqual(plan.remove.map((r) => [r.edition, r.reason]), [["261020", "teto-sem-publicacao"]]);
  });

  it("publicação desconhecida (sem data/editions) nunca sai, nem velha", () => {
    const plan = planCacheRetention([dir("260901", null)], TODAY);
    assert.equal(plan.remove.length, 0);
    assert.equal(plan.keep[0].reason, "publicacao-desconhecida");
  });

  it("symlink, arquivo solto, nome fora de AAMMDD e data impossível ficam de fora", () => {
    const plan = planCacheRetention(
      [
        { name: "261001", kind: "symlink", sizeBytes: 0, published: true },
        { name: "notas.txt", kind: "other", sizeBytes: 0, published: null },
        dir("_marca", true),
        dir("261399", true),
        dir("2610301", true),
      ],
      TODAY,
    );
    assert.equal(plan.remove.length, 0);
    assert.deepEqual(plan.skipped.map((s) => [s.name, s.reason]), [
      ["_marca", "nome-invalido"],
      ["261001", "symlink"],
      ["2610301", "nome-invalido"],
      ["261399", "nome-invalido"],
      ["notas.txt", "nao-diretorio"],
    ]);
  });

  it("recusa janela < 1 e teto menor que a janela", () => {
    assert.throws(() => planCacheRetention([], TODAY, { keepDays: 0 }), /keepDays/);
    assert.throws(() => planCacheRetention([], TODAY, { keepDays: 5, unpublishedMaxDays: 4 }), /unpublishedMaxDays/);
  });
});

function fixture(): { base: string; cache: string; data: string } {
  const base = mkdtempSync(join(tmpdir(), "vm-cache-12365-"));
  const cache = join(base, "cache");
  const data = join(base, "data");
  mkdirSync(cache, { recursive: true });
  mkdirSync(join(data, "editions"), { recursive: true });
  return { base, cache, data };
}

function cacheEdition(cache: string, edition: string, bytes = 100): void {
  for (const sub of ["bruto", "work", "out", "final"]) mkdirSync(join(cache, edition, sub), { recursive: true });
  writeFileSync(join(cache, edition, "bruto", "bruto.mp4"), Buffer.alloc(bytes));
}

function editionInternal(data: string, edition: string): string {
  const d = join(data, "editions", edition.slice(0, 4), edition);
  mkdirSync(join(d, "_internal"), { recursive: true });
  return d;
}

describe("#12365 sinal de publicação do vídeo da edição", () => {
  it("registro do upload com videoId desta edição, ou link do D1, contam; o resto não", () => {
    const { base, data } = fixture();
    try {
      const a = editionInternal(data, "261030");
      writeFileSync(join(a, "_internal/05-youtube-published.json"), JSON.stringify({ aammdd: "261030", videoId: "CMdeWkiZG1Y" }));
      assert.equal(editionVideoPublished(a, "261030"), true);

      const b = editionInternal(data, "261103");
      writeFileSync(join(b, "_internal/05-video-url.txt"), "https://youtu.be/CMdeWkiZG1Y\n");
      assert.equal(editionVideoPublished(b, "261103"), true);

      const c = editionInternal(data, "261104");
      writeFileSync(join(c, "_internal/05-youtube-published.json"), JSON.stringify({ aammdd: "261030", videoId: "CMdeWkiZG1Y" }));
      assert.equal(editionVideoPublished(c, "261104"), false, "registro de OUTRA edição não vale");

      const d = editionInternal(data, "261105");
      writeFileSync(join(d, "_internal/05-youtube-published.json"), "{ quebrado");
      assert.equal(editionVideoPublished(d, "261105"), false);

      const e = editionInternal(data, "261106");
      writeFileSync(join(e, "_internal/05-youtube-published.json"), JSON.stringify({ aammdd: "261106", videoId: "" }));
      assert.equal(editionVideoPublished(e, "261106"), false);

      assert.equal(editionVideoPublished(join(data, "editions/2611/261107"), "261107"), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("#12365 prune-video-montage-cache contra um tmpdir", () => {
  it("dry-run lista e não apaga; --apply apaga só a publicada fora da janela", () => {
    const { base, cache, data } = fixture();
    try {
      cacheEdition(cache, "261030", 300);
      cacheEdition(cache, "261031", 50); // fora da janela, sem publicação, abaixo do teto
      cacheEdition(cache, "261105");
      const pub = editionInternal(data, "261030");
      writeFileSync(join(pub, "_internal/05-youtube-published.json"), JSON.stringify({ aammdd: "261030", videoId: "x1" }));
      editionInternal(data, "261031");

      const opts = { cacheRoot: cache, dataRoot: data, today: TODAY, keepDays: 3, unpublishedMaxDays: 14 };
      const dry = pruneVideoMontageCache({ ...opts, apply: false });
      assert.deepEqual(dry.plan.remove.map((r) => r.edition), ["261030"]);
      assert.equal(dry.plan.removeBytes, 300);
      assert.deepEqual(dry.deleted, []);
      assert.ok(existsSync(join(cache, "261030")), "dry-run não apaga");

      const real = pruneVideoMontageCache({ ...opts, apply: true });
      assert.deepEqual(real.deleted, ["261030"]);
      assert.deepEqual(real.failed, []);
      assert.ok(!existsSync(join(cache, "261030")));
      assert.ok(existsSync(join(cache, "261031")));
      assert.ok(existsSync(join(cache, "261105")));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("symlink na raiz é ignorado e o alvo dele fica intacto; link dentro da edição apagada não leva o alvo", () => {
    const { base, cache, data } = fixture();
    try {
      const outside = join(base, "fora");
      mkdirSync(outside);
      writeFileSync(join(outside, "precioso.mp4"), "x");
      symlinkSync(outside, join(cache, "261001"));
      cacheEdition(cache, "261002");
      symlinkSync(outside, join(cache, "261002", "work", "link-para-fora"));
      for (const e of ["261001", "261002"]) {
        const d = editionInternal(data, e);
        writeFileSync(join(d, "_internal/05-video-url.txt"), "https://youtu.be/CMdeWkiZG1Y\n");
      }
      const r = pruneVideoMontageCache({ cacheRoot: cache, dataRoot: data, today: TODAY, keepDays: 3, unpublishedMaxDays: 14, apply: true });
      assert.deepEqual(r.plan.skipped, [{ name: "261001", reason: "symlink" }]);
      assert.deepEqual(r.deleted, ["261002"]);
      assert.ok(existsSync(join(cache, "261001")), "o link da raiz não é apagado");
      assert.ok(existsSync(join(outside, "precioso.mp4")), "o alvo de nenhum link é apagado");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("sem data/editions nesta máquina nada fora da janela sai", () => {
    const { base, cache } = fixture();
    try {
      cacheEdition(cache, "260901");
      const r = pruneVideoMontageCache({ cacheRoot: cache, dataRoot: join(base, "sem-data"), today: TODAY, keepDays: 3, unpublishedMaxDays: 14, apply: true });
      assert.deepEqual(r.deleted, []);
      assert.equal(r.plan.keep[0].reason, "publicacao-desconhecida");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("#12365 DIARIA_VIDEO_CACHE_DIR em HD desmontado", () => {
  const none = () => false;
  it("variável apontando para diretório inexistente falha alto, sem criar nada", () => {
    assert.throws(() => videoCacheRoot(undefined, "/mnt/hd-sata/diaria-video-cache", "/home/u", none), (e: unknown) => {
      assert.ok(e instanceof VideoCacheRootMissingError);
      assert.match((e as Error).message, /DIARIA_VIDEO_CACHE_DIR aponta para \/mnt\/hd-sata\/diaria-video-cache, que não existe — HD desmontado\?/);
      return true;
    });
    assert.throws(() => driveCacheDir("261105", undefined, "/mnt/hd-sata/diaria-video-cache", "/home/u", none), VideoCacheRootMissingError);
  });

  it("--cache-dir explícito e o default em ~/.cache seguem sem checagem; variável vazia = ausente", () => {
    assert.equal(videoCacheRoot("/x", "/mnt/hd-sata/c", "/home/u", none), resolve("/x"));
    assert.equal(videoCacheRoot(undefined, undefined, "/home/u", none), resolve("/home/u/.cache/diaria-video-montagem"));
    assert.equal(videoCacheRoot(undefined, "  ", "/home/u", none), resolve("/home/u/.cache/diaria-video-montagem"));
    assert.equal(videoCacheRoot(undefined, "/mnt/hd-sata/c", "/home/u", () => true), resolve("/mnt/hd-sata/c"));
  });

  it("check-video-env reprova o disco em vez de medir o raiz pelo pai existente", () => {
    const r = montageCacheRoot("/mnt/hd-sata/diaria-video-cache", "/home/u", none);
    assert.ok("probe" in r);
    if ("probe" in r) {
      assert.equal(r.probe.ok, false);
      assert.match(r.probe.detail ?? "", /HD desmontado/);
      assert.match(r.probe.fix ?? "", /#12352/);
    }
    assert.deepEqual(montageCacheRoot(undefined, "/home/u", none), { root: resolve("/home/u/.cache/diaria-video-montagem") });
  });
});

describe("#12365 task agendada", () => {
  it("Diaria-Video-Montage-Cache-Prune roda o prune com --apply, diária 03:50, habilitada", () => {
    const t = getScheduledTaskByName("Diaria-Video-Montage-Cache-Prune");
    assert.ok(t);
    assert.deepEqual(t.steps, [{ key: "prune", script: "scripts/prune-video-montage-cache.ts", args: ["--apply"] }]);
    assert.deepEqual(t.schedule, { kind: "daily", hour: 3, minute: 50 });
    assert.notEqual(t.enabled, false);
  });
});
