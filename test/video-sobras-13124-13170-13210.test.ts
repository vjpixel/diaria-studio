/**
 * test/video-sobras-13124-13170-13210.test.ts (#13210)
 *
 * Sobras declaradas pelos fixers das PRs #13124 e #13170:
 *  1. `publish-shorts.ts --update-scheduled`/`--update-published` não
 *     imprimiam o aviso de `roteiro-falas.json` ilegível (o plano de
 *     publicação já avisava; no update a linha da bio sumia em silêncio).
 *  2. `publish-youtube.ts`: o rerun depois da limpeza do MP4 (registro `done`
 *     ou `--accept-period-match`, vídeo apagado) só tinha teste no nível de
 *     `shareForRun`. Agora passa pela fiação do `main()` até o plano
 *     (`prepareHorizontalPlan`); o resto do `main()` é rede (YouTube), que
 *     nenhum teste toca.
 *
 * O item 3 (asserção fixa no lugar de `...readVerticalCta(dir)`) mora em
 * `test/short-cita-horizontal-12191.test.ts`.
 *
 * Hermético: pastas temporárias, edição sintética 991231 nos spawns (nunca
 * existe em data/editions/), dry-run sem `--publish`/`--confirm`, nada de rede.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { horizontalRoteiroWarnings, readHorizontalVideoForShort } from "../scripts/publish-shorts/_shared.ts";
import { prepareHorizontalPlan } from "../scripts/publish-youtube.ts";
import { YOUTUBE_PUBLISHED_FILE } from "../scripts/lib/diaria/youtube-upload.ts";
import { youtubeVideoFileName } from "../scripts/lib/diaria/youtube-video.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SYNTH = "991231";
const SPAWN_TIMEOUT_MS = 60_000;
const REVIEWED = "DESTAQUE 1 | X\n\n[Título do D1](https://example.com/a)\n\nCorpo do D1. Mais.\n\nPor que isso importa: x.\n";
const AVISO_ROTEIRO = /\[aviso\] roteiro-falas\.json ilegível ou inválido: não foi possível conferir cta_vertical/;

const tmps: string[] = [];
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmps.push(d);
  return d;
}

function editionWithBrokenRoteiro(): string {
  const dir = tmp("sobras-13210-shorts-");
  writeFileSync(join(dir, "02-reviewed.md"), REVIEWED);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "roteiro-falas.json"), "{inválido");
  return dir;
}

function runShorts(args: string[]) {
  return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(ROOT, "scripts", "publish-shorts.ts"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
}

describe("#13210 item 1 — aviso do roteiro nas rotas de troca de texto do vertical", () => {
  it("horizontalRoteiroWarnings: devolve o aviso quando há; nada sem aviso ou no corte (null)", () => {
    assert.deepEqual(horizontalRoteiroWarnings({ roteiroWarning: "x" }), ["x"]);
    assert.deepEqual(horizontalRoteiroWarnings({}), []);
    assert.deepEqual(horizontalRoteiroWarnings(null), []);
  });

  it("o leitor da edição traz o aviso fixo do roteiro ilegível", () => {
    const dir = editionWithBrokenRoteiro();
    const h = readHorizontalVideoForShort(dir);
    assert.equal(h.ctaVertical, undefined);
    assert.equal(
      h.roteiroWarning,
      "roteiro-falas.json ilegível ou inválido: não foi possível conferir cta_vertical; comportamento anterior preservado (#13117)",
    );
  });

  it("--update-scheduled (plano, sem --publish) imprime o aviso no stderr", () => {
    const dir = editionWithBrokenRoteiro();
    const r = runShorts([SYNTH, "--edition-dir", dir, "--allow-unwatched-dir", "--update-scheduled"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, AVISO_ROTEIRO);
    assert.match(r.stdout, /"update_scheduled": true/);
  });

  it("--update-published (plano, sem --confirm) imprime o aviso no stderr", () => {
    const dir = editionWithBrokenRoteiro();
    const r = runShorts([SYNTH, "--edition-dir", dir, "--allow-unwatched-dir", "--update-published"]);
    // Registro vazio: "nada a trocar" (exit 1). O aviso sai antes, junto do plano.
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, AVISO_ROTEIRO);
    assert.match(r.stdout, /"update_published": true/);
  });

  it("roteiro legível: nenhuma das duas rotas avisa", () => {
    const dir = editionWithBrokenRoteiro();
    writeFileSync(join(dir, "_internal", "roteiro-falas.json"), JSON.stringify({ falas: [{ bloco: "comentario", texto: "x" }] }));
    const r = runShorts([SYNTH, "--edition-dir", dir, "--allow-unwatched-dir", "--update-scheduled"]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /roteiro-falas\.json ilegível/);
  });
});

describe("#13210 item 2 — rerun do horizontal depois da limpeza do MP4 (fiação do main até o plano)", () => {
  const AAMMDD = "261117";
  const cue = { inicio: "H11", rotulo: "Pra mandar pros seus pais", texto: "Antes de comprar confira quem está falando." };
  const roteiro = {
    falas: [{ id: "H11", texto: cue.texto, videos: ["horizontal"], bloco: "comentario" }],
    porVideo: { horizontal: { trechoCompartilhar: { inicio: cue.inicio, rotulo: cue.rotulo } } },
  };
  const reviewedMd = "DESTAQUE 1 | SEGURANÇA\n\n[Vídeo falso engana famílias](https://example.org/fonte)\n\nUm médico teve a imagem falsificada.\n\nPor que isso importa: é um golpe.\n";

  /** Edição com o trecho compartilhável no roteiro e o MP4 já apagado pela limpeza pós-upload. */
  function editionAfterCleanup(record: object | null): string {
    const dir = tmp("sobras-13210-yt-");
    writeFileSync(join(dir, "02-reviewed.md"), reviewedMd);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "roteiro-falas.json"), JSON.stringify(roteiro));
    if (record) writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), JSON.stringify(record));
    return dir;
  }

  function prepare(dir: string, values: Record<string, string>) {
    const logs: string[] = [];
    const out = prepareHorizontalPlan({
      dir,
      aammdd: AAMMDD,
      values,
      flags: new Set(["upload"]),
      dryRun: false,
      upload: true,
      captionsPath: join(dir, "nao-existe.srt"),
      captionsFromMontage: false,
      log: (l) => logs.push(l),
    });
    return { out, logs };
  }

  it("registro done + vídeo apagado + sem --share-start: o plano sai, sem trecho e sem ler o vídeo, com aviso", () => {
    const dir = editionAfterCleanup({ aammdd: AAMMDD, videoId: "abc123XYZ_9", url: "https://youtu.be/abc123XYZ_9" });
    const { out, logs } = prepare(dir, {});
    assert.ok(out.ok, logs.join("\n"));
    assert.equal(out.canInsert, false);
    assert.equal(out.plan.video.exists, false);
    assert.equal(out.plan.video.path, join(dir, youtubeVideoFileName(AAMMDD)));
    assert.equal(out.plan.share, undefined);
    assert.match(logs.join("\n"), /\[aviso\] trechoCompartilhar H11: este --upload não cria vídeo/);
  });

  it("--accept-period-match + vídeo apagado: o registro nem é lido, o plano sai sem trecho", () => {
    // Registro ilegível de propósito: com --accept-period-match o main não o lê (não pode recusar por ele).
    const dir = editionAfterCleanup(null);
    writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "{ não é json");
    const { out, logs } = prepare(dir, { "accept-period-match": "abc123XYZ_9" });
    assert.ok(out.ok, logs.join("\n"));
    assert.equal(out.canInsert, false);
    assert.equal(out.plan.video.exists, false);
    assert.equal(out.plan.share, undefined);
    assert.match(logs.join("\n"), /este --upload não cria vídeo/);
  });

  it("sem registro e vídeo apagado: pode criar vídeo, mas o trecho fica fora com o aviso de vídeo ausente", () => {
    const dir = editionAfterCleanup(null);
    const { out, logs } = prepare(dir, {});
    assert.ok(out.ok, logs.join("\n"));
    assert.equal(out.canInsert, true);
    assert.equal(out.plan.share, undefined);
    assert.match(logs.join("\n"), /trechoCompartilhar H11: vídeo ausente/);
  });

  it("registro ilegível sem --accept-period-match recusa com exit 1, antes do plano", () => {
    const dir = editionAfterCleanup(null);
    writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "{ não é json");
    const { out, logs } = prepare(dir, {});
    assert.deepEqual(out, { ok: false, exitCode: 1 });
    assert.match(logs.join("\n"), /registro do upload ilegível/);
  });

  it("sem 02-reviewed.md: exit 1", () => {
    const dir = tmp("sobras-13210-yt-vazio-");
    const { out, logs } = prepare(dir, {});
    assert.deepEqual(out, { ok: false, exitCode: 1 });
    assert.match(logs.join("\n"), /02-reviewed\.md não existe/);
  });
});
