/**
 * test/video-montage-cache-retention-12365.test.ts (#12365)
 *
 * O cache do `/diaria-video-montagem` no modo API não tinha retenção e chegou
 * a 33 GB no raiz do 300. Cobre: a política pura (idade da edição, janela,
 * em uso, upload pendente, publicação, teto sem publicação), o script contra
 * um tmpdir (sinais, symlink nunca seguido, dry-run não apaga, duas raízes),
 * os exit codes do CLI, o guard de `DIARIA_VIDEO_CACHE_DIR` num HD desmontado
 * (fiação por modo no `main` da montagem) e a task agendada.
 * Nada aqui toca o cache real nem o `data/` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CACHE_IN_USE_HOURS,
  DEFAULT_CACHE_KEEP_DAYS,
  DEFAULT_CACHE_UNPUBLISHED_MAX_DAYS,
  planCacheRetention,
  type CacheEntry,
} from "../scripts/lib/diaria/video-montage-cache-retention.ts";
import {
  VideoCacheRootMissingError,
  checkCacheRootDevice,
  driveCacheDir,
  videoCacheRoot,
} from "../scripts/lib/diaria/video-montage-drive.ts";
import {
  cacheRootsToPrune,
  editionDirUnder,
  editionPendingUpload,
  editionVideoPublished,
  pruneVideoMontageCache,
  todayBrt,
} from "../scripts/prune-video-montage-cache.ts";
import { montageCacheRoot } from "../scripts/check-video-env.ts";
import { main as montageMain } from "../scripts/video-montagem.ts";
import { editionDir } from "../scripts/lib/edition-paths.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date(Date.UTC(2026, 10, 7)); // 07/11/2026, o dia do achado
const LONG_AGO = TODAY.getTime() - 30 * 86_400_000;
const NOW = TODAY.getTime() + 15 * 3_600_000;

const dir = (name: string, published: boolean | null, extra: Partial<CacheEntry> = {}): CacheEntry => ({
  name,
  kind: "dir",
  sizeBytes: 1000,
  published,
  pendingUpload: false,
  lastModifiedMs: LONG_AGO,
  ...extra,
});
const plan = (entries: CacheEntry[]) => planCacheRetention(entries, TODAY, { nowMs: NOW });

describe("#12365 política de retenção do cache da montagem", () => {
  it("defaults: 3 dias de janela, 14 de teto sem publicação, 6h de em-uso", () => {
    assert.equal(DEFAULT_CACHE_KEEP_DAYS, 3);
    assert.equal(DEFAULT_CACHE_UNPUBLISHED_MAX_DAYS, 14);
    assert.equal(DEFAULT_CACHE_IN_USE_HOURS, 6);
  });

  it("cenário real da issue (261030, 261103, 261105 publicados): saem as duas com mais de 3 dias", () => {
    const p = plan([dir("261030", true, { sizeBytes: 6_500 }), dir("261103", true, { sizeBytes: 10_000 }), dir("261105", true, { sizeBytes: 17_000 })]);
    assert.deepEqual(p.remove.map((r) => [r.edition, r.reason, r.ageDays]), [
      ["261030", "publicado", 8],
      ["261103", "publicado", 4],
    ]);
    assert.deepEqual(p.keep.map((k) => [k.edition, k.reason]), [["261105", "na-janela"]]);
    assert.equal(p.removeBytes, 16_500);
  });

  it("fronteira da janela: 3 dias fica, 4 sai; data futura fica", () => {
    const p = plan([dir("261104", true), dir("261103", true), dir("261108", true)]);
    assert.deepEqual(p.remove.map((r) => r.edition), ["261103"]);
    assert.deepEqual(p.keep.map((k) => [k.edition, k.reason]), [["261104", "na-janela"], ["261108", "na-janela"]]);
  });

  it("fronteira do teto sem publicação: 14 dias fica, 15 sai", () => {
    const p = plan([dir("261024", false), dir("261023", false)]);
    assert.deepEqual(p.keep.map((k) => [k.edition, k.ageDays, k.reason]), [["261024", 14, "aguardando-publicacao"]]);
    assert.deepEqual(p.remove.map((r) => [r.edition, r.ageDays, r.reason]), [["261023", 15, "teto-sem-publicacao"]]);
  });

  it("em uso (modificada há menos de 6h) fica, mesmo publicada e velha; 6h ou mais não segura", () => {
    const p = plan([
      dir("261020", true, { lastModifiedMs: NOW - 2 * 3_600_000 }),
      dir("261021", true, { lastModifiedMs: NOW - 6 * 3_600_000 }),
    ]);
    assert.deepEqual(p.keep.map((k) => [k.edition, k.reason]), [["261020", "em-uso"]]);
    assert.deepEqual(p.remove.map((r) => r.edition), ["261021"]);
  });

  it("upload para o Drive pendente nunca sai; registro ilegível também não", () => {
    const p = plan([dir("261001", true, { pendingUpload: true }), dir("260901", false, { pendingUpload: null })]);
    assert.equal(p.remove.length, 0);
    assert.deepEqual(p.keep.map((k) => [k.edition, k.reason]), [
      ["260901", "registro-de-upload-ilegivel"],
      ["261001", "upload-pendente"],
    ]);
  });

  it("publicação desconhecida nunca sai, nem velha", () => {
    const p = plan([dir("260901", null)]);
    assert.equal(p.remove.length, 0);
    assert.equal(p.keep[0].reason, "publicacao-desconhecida");
  });

  it("symlink, arquivo solto, nome fora de AAMMDD e data impossível ficam de fora", () => {
    const p = plan([
      { name: "261001", kind: "symlink", sizeBytes: 0, published: true },
      { name: "notas.txt", kind: "other", sizeBytes: 0, published: null },
      dir("_marca", true),
      dir("261399", true),
      dir("2610301", true),
    ]);
    assert.equal(p.remove.length, 0);
    assert.deepEqual(p.skipped.map((s) => [s.name, s.reason]), [
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

  it("hoje é a data BRT: 01:30 UTC de 08/11 ainda é 07/11 em Brasília", () => {
    assert.equal(todayBrt(new Date("2026-11-08T01:30:00Z")).toISOString(), "2026-11-07T00:00:00.000Z");
    assert.equal(todayBrt(new Date("2026-11-08T03:30:00Z")).toISOString(), "2026-11-08T00:00:00.000Z");
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

/** Envelhece a árvore inteira (o em-uso olha o mtime mais recente). */
function age(path: string, ms = LONG_AGO): void {
  const t = new Date(ms);
  for (const ent of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) age(p, ms);
    else utimesSync(p, t, t);
  }
  utimesSync(path, t, t);
}

function cacheEdition(cache: string, edition: string, bytes = 100): void {
  for (const sub of ["bruto", "work", "out", "final"]) mkdirSync(join(cache, edition, sub), { recursive: true });
  writeFileSync(join(cache, edition, "bruto", "bruto.mp4"), Buffer.alloc(bytes));
  age(join(cache, edition));
}

function editionInternal(data: string, edition: string): string {
  const d = editionDirUnder(data, edition);
  mkdirSync(join(d, "_internal", "video-montagem"), { recursive: true });
  return d;
}

const publish = (data: string, edition: string) =>
  writeFileSync(join(editionInternal(data, edition), "_internal/05-youtube-published.json"), JSON.stringify({ aammdd: edition, videoId: "x1" }));

describe("#12365 sinais lidos em data/editions", () => {
  it("o caminho da edição é o do editionDir() do projeto", () => {
    assert.equal(editionDirUnder("/d/data", "261030"), join("/d/data", "editions", "2610", "261030"));
    assert.ok(editionDir("261030").endsWith(join("editions", "2610", "261030")));
  });

  it("publicação: registro com videoId desta edição ou link do D1 contam; pasta ausente é desconhecida; ilegível avisa", () => {
    const { base, data } = fixture();
    try {
      const a = editionInternal(data, "261030");
      writeFileSync(join(a, "_internal/05-youtube-published.json"), JSON.stringify({ aammdd: "261030", videoId: "CMdeWkiZG1Y" }));
      assert.deepEqual(editionVideoPublished(a, "261030"), { value: true, warning: null });

      const b = editionInternal(data, "261103");
      writeFileSync(join(b, "_internal/05-video-url.txt"), "https://youtu.be/CMdeWkiZG1Y\n");
      assert.equal(editionVideoPublished(b, "261103").value, true);

      const c = editionInternal(data, "261104");
      writeFileSync(join(c, "_internal/05-youtube-published.json"), JSON.stringify({ aammdd: "261030", videoId: "CMdeWkiZG1Y" }));
      const other = editionVideoPublished(c, "261104");
      assert.equal(other.value, false, "registro de OUTRA edição não vale");
      assert.match(other.warning ?? "", /edição 261030/);

      const d = editionInternal(data, "261105");
      writeFileSync(join(d, "_internal/05-youtube-published.json"), "{ quebrado");
      const broken = editionVideoPublished(d, "261105");
      assert.equal(broken.value, false);
      assert.match(broken.warning ?? "", /ilegível/);

      const e = editionInternal(data, "261106");
      writeFileSync(join(e, "_internal/05-youtube-published.json"), JSON.stringify({ aammdd: "261106", videoId: "" }));
      assert.equal(editionVideoPublished(e, "261106").value, false);

      assert.equal(editionVideoPublished(editionDirUnder(data, "261107"), "261107").value, null);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("upload pendente: pending não vazio = true; vazio/ausente = false; ilegível = null", () => {
    const { base, data } = fixture();
    try {
      const d = editionInternal(data, "261030");
      const reg = join(d, "_internal/video-montagem/drive-uploads.json");
      assert.equal(editionPendingUpload(d, "261030").value, false);
      writeFileSync(reg, JSON.stringify({ files: {}, pending: ["/cache/261030/out/x.srt"] }));
      assert.equal(editionPendingUpload(d, "261030").value, true);
      writeFileSync(reg, JSON.stringify({ files: {}, pending: [] }));
      assert.equal(editionPendingUpload(d, "261030").value, false);
      writeFileSync(reg, "{");
      const bad = editionPendingUpload(d, "261030");
      assert.equal(bad.value, null);
      assert.match(bad.warning ?? "", /ilegível/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("#12365 prune-video-montage-cache contra um tmpdir", () => {
  const opts = (cache: string, data: string) => ({ cacheRoot: cache, dataRoot: data, today: TODAY, nowMs: NOW, keepDays: 3, unpublishedMaxDays: 14 });

  it("dry-run lista e não apaga; --apply apaga só a publicada fora da janela", () => {
    const { base, cache, data } = fixture();
    try {
      cacheEdition(cache, "261030", 300);
      cacheEdition(cache, "261031", 50); // fora da janela, sem publicação, abaixo do teto
      cacheEdition(cache, "261105");
      publish(data, "261030");
      editionInternal(data, "261031");

      const dry = pruneVideoMontageCache({ ...opts(cache, data), apply: false });
      assert.deepEqual(dry.plan.remove.map((r) => r.edition), ["261030"]);
      assert.equal(dry.plan.removeBytes, 300);
      assert.deepEqual(dry.deleted, []);
      assert.ok(existsSync(join(cache, "261030")), "dry-run não apaga");

      const real = pruneVideoMontageCache({ ...opts(cache, data), apply: true });
      assert.deepEqual(real.deleted, ["261030"]);
      assert.deepEqual(real.failed, []);
      assert.ok(!existsSync(join(cache, "261030")));
      assert.ok(existsSync(join(cache, "261031")));
      assert.ok(existsSync(join(cache, "261105")));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("edição com upload pendente ou mexida há pouco fica, mesmo publicada", () => {
    const { base, cache, data } = fixture();
    try {
      cacheEdition(cache, "261020");
      cacheEdition(cache, "261021");
      publish(data, "261020");
      publish(data, "261021");
      writeFileSync(join(editionDirUnder(data, "261020"), "_internal/video-montagem/drive-uploads.json"), JSON.stringify({ pending: ["x"] }));
      writeFileSync(join(cache, "261021", "work", "agora.wav"), "x"); // mtime de agora
      const r = pruneVideoMontageCache({ ...opts(cache, data), nowMs: Date.now(), apply: true });
      assert.deepEqual(r.deleted, []);
      assert.deepEqual(r.plan.keep.map((k) => [k.edition, k.reason]), [["261020", "upload-pendente"], ["261021", "em-uso"]]);
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
      age(join(cache, "261002"));
      for (const e of ["261001", "261002"]) writeFileSync(join(editionInternal(data, e), "_internal/05-video-url.txt"), "https://youtu.be/CMdeWkiZG1Y\n");
      const r = pruneVideoMontageCache({ ...opts(cache, data), apply: true });
      assert.deepEqual(r.plan.skipped, [{ name: "261001", reason: "symlink" }]);
      assert.deepEqual(r.deleted, ["261002"]);
      assert.ok(existsSync(join(cache, "261001")), "o link da raiz não é apagado");
      assert.ok(existsSync(join(outside, "precioso.mp4")), "o alvo de nenhum link é apagado");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("sem data/editions, ou sem a pasta da edição nele, nada fora da janela sai", () => {
    const { base, cache, data } = fixture();
    try {
      cacheEdition(cache, "260901");
      const noData = pruneVideoMontageCache({ ...opts(cache, join(base, "sem-data")), apply: true });
      assert.deepEqual(noData.deleted, []);
      assert.equal(noData.plan.keep[0].reason, "publicacao-desconhecida");
      const noEdition = pruneVideoMontageCache({ ...opts(cache, data), apply: true });
      assert.deepEqual(noEdition.deleted, []);
      assert.equal(noEdition.plan.keep[0].reason, "publicacao-desconhecida");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("raízes: configurada + padrão, sem repetir a mesma pasta; ausentes ficam de fora", () => {
    const { base } = fixture();
    try {
      const home = join(base, "home");
      const def = join(home, ".cache", "diaria-video-montagem");
      const hd = join(base, "hd", "diaria-video-cache");
      mkdirSync(def, { recursive: true });
      mkdirSync(hd, { recursive: true });
      const ok = (): "ok" => "ok";
      assert.deepEqual(cacheRootsToPrune(undefined, hd, home, ok).map((r) => [r.root, r.source]), [[hd, "configurada"], [def, "padrao"]]);
      assert.deepEqual(cacheRootsToPrune(undefined, undefined, home, ok).map((r) => r.source), ["padrao"]);
      assert.deepEqual(cacheRootsToPrune(def, undefined, home, ok).map((r) => r.source), ["configurada"], "mesma pasta não se repete");
      rmSync(def, { recursive: true });
      assert.deepEqual(cacheRootsToPrune(undefined, undefined, home, ok), []);
      assert.throws(() => cacheRootsToPrune(undefined, join(base, "desmontado"), home), VideoCacheRootMissingError);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("#12365 CLI: exit codes", () => {
  const run = (args: string[], env: Record<string, string | undefined>) => {
    const e: NodeJS.ProcessEnv = { ...process.env, ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
    return spawnSync(process.execPath, ["--import", "tsx", join(REPO, "scripts/prune-video-montage-cache.ts"), ...args], { cwd: REPO, env: e, encoding: "utf8" });
  };

  it("HD desmontado (variável apontando para diretório inexistente) → exit 1", () => {
    const { base } = fixture();
    try {
      const r = run([], { HOME: join(base, "home"), DIARIA_VIDEO_CACHE_DIR: join(base, "desmontado") });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /HD desmontado/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("raiz padrão ausente sem a variável → exit 0, nada a fazer", () => {
    const { base } = fixture();
    try {
      const r = run([], { HOME: join(base, "home"), DIARIA_VIDEO_CACHE_DIR: undefined });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /nada a fazer/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("falha ao apagar → exit 1", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
    const { base, cache, data } = fixture();
    try {
      cacheEdition(cache, "250101");
      publish(data, "250101");
      chmodSync(cache, 0o555); // sem escrita na raiz: o rmSync da edição falha
      const r = run(["--apply", "--cache-dir", cache, "--data-root", data], { HOME: join(base, "home"), DIARIA_VIDEO_CACHE_DIR: undefined });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /falha ao apagar 250101/);
    } finally {
      chmodSync(cache, 0o755);
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("#12365 DIARIA_VIDEO_CACHE_DIR em HD desmontado", () => {
  const missing = (): "missing" => "missing";
  it("variável apontando para diretório inexistente falha alto, sem criar nada", () => {
    assert.throws(() => videoCacheRoot(undefined, "/mnt/hd-sata/diaria-video-cache", "/home/u", missing), (e: unknown) => {
      assert.ok(e instanceof VideoCacheRootMissingError);
      assert.equal(e.name, "VideoCacheRootMissingError");
      assert.equal(e.path, "/mnt/hd-sata/diaria-video-cache");
      assert.equal(e.reason, "missing");
      assert.match(e.message, /aponta para \/mnt\/hd-sata\/diaria-video-cache, que não existe — HD desmontado\?/);
      assert.match(e.message, /COM O HD MONTADO/);
      return true;
    });
    assert.throws(() => driveCacheDir("261105", undefined, "/mnt/hd-sata/diaria-video-cache", "/home/u", missing), VideoCacheRootMissingError);
  });

  it("diretório no mesmo disco do home (ponto de montagem vazio) também é recusado", () => {
    const base = mkdtempSync(join(tmpdir(), "vm-dev-12365-"));
    try {
      const mountpoint = join(base, "hd-sata");
      mkdirSync(mountpoint);
      assert.equal(checkCacheRootDevice(mountpoint, base), "same-device-as-home");
      assert.equal(checkCacheRootDevice(join(base, "nao-existe"), base), "missing");
      assert.throws(() => videoCacheRoot(undefined, mountpoint, base), (e: unknown) => {
        assert.ok(e instanceof VideoCacheRootMissingError);
        assert.equal(e.reason, "same-device-as-home");
        assert.match(e.message, /mesmo disco do home — HD desmontado\?/);
        return true;
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("--cache-dir explícito e o default em ~/.cache seguem sem checagem; variável vazia = ausente", () => {
    assert.equal(videoCacheRoot("/x", "/mnt/hd-sata/c", "/home/u", missing), resolve("/x"));
    assert.equal(videoCacheRoot(undefined, undefined, "/home/u", missing), resolve("/home/u/.cache/diaria-video-montagem"));
    assert.equal(videoCacheRoot(undefined, "  ", "/home/u", missing), resolve("/home/u/.cache/diaria-video-montagem"));
    assert.equal(videoCacheRoot(undefined, "/mnt/hd-sata/c", "/home/u", () => "ok"), resolve("/mnt/hd-sata/c"));
  });

  it("check-video-env reprova o disco em vez de medir o raiz", () => {
    const r = montageCacheRoot("/mnt/hd-sata/diaria-video-cache", "/home/u", missing);
    assert.ok("probe" in r);
    if ("probe" in r) {
      assert.equal(r.probe.ok, false);
      assert.match(r.probe.detail ?? "", /HD desmontado/);
      assert.match(r.probe.fix ?? "", /#12352/);
    }
    assert.deepEqual(montageCacheRoot(undefined, "/home/u", missing), { root: resolve("/home/u/.cache/diaria-video-montagem") });
  });

  it("main da montagem: modo API recusa antes de tocar o Drive; modo local não é afetado", async () => {
    const base = mkdtempSync(join(tmpdir(), "vm-main-12365-"));
    const prev = process.env.DIARIA_VIDEO_CACHE_DIR;
    process.env.DIARIA_VIDEO_CACHE_DIR = join(base, "desmontado");
    let driveCalls = 0;
    const deps = {
      driveFetch: async () => {
        driveCalls++;
        throw new Error("não devia chamar o Drive");
      },
      uploadFetch: async () => {
        driveCalls++;
        throw new Error("não devia chamar o Drive");
      },
    };
    try {
      const stateDir = join(base, "state");
      await assert.rejects(
        montageMain(["transcribe", "261105", "--from-drive", "--state-dir", stateDir, "--folder-id", "x"], deps),
        VideoCacheRootMissingError,
      );
      assert.equal(driveCalls, 0);
      assert.ok(!existsSync(join(base, "desmontado")), "nada criado");

      const driveRoot = join(base, "drive");
      mkdirSync(join(driveRoot, "261105"), { recursive: true });
      let localErr: unknown = null;
      try {
        await montageMain(["decupagem", "261105", "--no-drive-api", "--drive-root", driveRoot, "--state-dir", stateDir], deps);
      } catch (e) {
        localErr = e;
      }
      assert.ok(!(localErr instanceof VideoCacheRootMissingError), "modo local ignora a variável");
      assert.equal(driveCalls, 0);
    } finally {
      if (prev === undefined) delete process.env.DIARIA_VIDEO_CACHE_DIR;
      else process.env.DIARIA_VIDEO_CACHE_DIR = prev;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("#12365 task agendada", () => {
  it("Diaria-Video-Montage-Cache-Prune roda o prune com --apply, diária, habilitada", () => {
    const t = getScheduledTaskByName("Diaria-Video-Montage-Cache-Prune");
    assert.ok(t);
    assert.deepEqual(t.steps, [{ key: "prune", script: "scripts/prune-video-montage-cache.ts", args: ["--apply"] }]);
    assert.equal(t.schedule.kind, "daily");
    assert.notEqual(t.enabled, false);
  });
});
