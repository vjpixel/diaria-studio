/**
 * test/codex-path-fallback-11532.test.ts (#11532)
 *
 * Regressão: no 300 o Codex está em `~/.npm-global/bin/codex`, que só entra
 * no PATH da shell interativa (o `.bashrc` retorna antes para shell não
 * interativa). `ssh 300 'codex'` não achava o binário e o Passo A2.4 da
 * `/diaria-publica-video` não rodava lá. Agora:
 *   - `codex-image.js` e `check-video-env.ts` tentam os mesmos caminhos de
 *     instalação conhecidos (paridade travada aqui);
 *   - os frames da capa aceitam o `Final/` como fallback explícito
 *     (`--from-final`: não espelha, avisa da resolução);
 *   - o `--dry-run` do `publish-youtube.ts` lista os pré-requisitos da capa.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — módulo .js sem tipos (mesmo padrão de codex-image-9088.test.ts)
import { codexFallbackPaths } from "../scripts/codex-image.js";
import { assessVideoEnv, codexCandidatePaths, coverPrerequisites } from "../scripts/lib/diaria/video-env-check.ts";
import { framesSourceWarnings, pickFrameNeedsFlop, resolveThumbMirrored } from "../scripts/lib/diaria/youtube-thumb-frames.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("caminhos do Codex fora do PATH (#11532)", () => {
  it("codex-image.js e video-env-check.ts usam a mesma lista", () => {
    for (const home of ["/home/vjpixel", "/home/x/"]) {
      assert.deepEqual(codexFallbackPaths("linux", home.replace(/\/$/, "")), codexCandidatePaths("linux", home));
    }
  });
  it("inclui ~/.npm-global/bin/codex (onde está no 300)", () => {
    assert.ok(codexCandidatePaths("linux", "/home/vjpixel").includes("/home/vjpixel/.npm-global/bin/codex"));
  });
  it("Windows não tem fallback de caminho (lá é o codex.cmd)", () => {
    assert.deepEqual(codexCandidatePaths("win32", "C:/Users/x"), []);
    assert.deepEqual(codexFallbackPaths("win32", "C:/Users/x"), []);
  });
  it("o runner tenta os caminhos quando `codex` dá ENOENT fora do Windows", () => {
    const src = readFileSync(join(ROOT, "scripts", "codex-image.js"), "utf8");
    assert.match(src, /codexFallbackPaths\(\)\.find\(\(p\) => fs\.existsSync\(p\)\)/);
  });
  it("a sonda do check-video-env procura fora do PATH", () => {
    const src = readFileSync(join(ROOT, "scripts", "check-video-env.ts"), "utf8");
    assert.match(src, /codex: probeCodex\(\)/);
  });
});

describe("frames do Final/ como fallback do bruto (#11532 item 2)", () => {
  it("--from-final sem flag explícita não espelha; a flag explícita vence", () => {
    assert.deepEqual(resolveThumbMirrored({ final: true, blocks: { mirrored: true } }), { mirrored: false, from: "final" });
    assert.deepEqual(resolveThumbMirrored({ final: true, flag: true }), { mirrored: true, from: "flag" });
  });
  it("--pick-frame de frames do Final/ nunca espelha, mesmo com a montagem dizendo mirrored", () => {
    assert.equal(pickFrameNeedsFlop(true, { mirrored_applied: false, mirrored_from: "final" }), false);
    assert.equal(pickFrameNeedsFlop(true, { mirrored_applied: false, mirrored_from: "blocks.json" }), true);
  });
  it("avisa da resolução menor no Final/ e de vídeo abaixo do 4K tratado como bruto", () => {
    assert.match(framesSourceWarnings({ fromFinal: true, width: 1920, height: 1080 })[0], /Final\/ \(1920x1080\)/);
    assert.match(framesSourceWarnings({ fromFinal: false, width: 1920, height: 1080 })[0], /--from-final/);
    assert.deepEqual(framesSourceWarnings({ fromFinal: false, width: 3840, height: 2160 }), []);
    assert.deepEqual(framesSourceWarnings({ fromFinal: false }), []);
  });
});

describe("pré-requisitos da capa no --dry-run (#11532 item 3)", () => {
  it("lista ffmpeg, codex, georgia e rembg, com o que falta", () => {
    const report = assessVideoEnv(
      { ffmpeg: { ok: true }, codex: { ok: false, detail: "codex indisponível" }, georgia: { ok: true }, rembg: { ok: true } },
      "linux",
    );
    const c = coverPrerequisites(report);
    assert.equal(c.ready, false);
    assert.deepEqual(c.items.map((i) => i.id), ["ffmpeg", "codex", "georgia", "rembg"]);
    assert.match(c.items[1].fix ?? "", /npm-global/);
    assert.match(c.summary, /falta: codex/);
  });
  it("o dry-run do publish-youtube inclui cover_prerequisites quando falta a capa", () => {
    const src = readFileSync(join(ROOT, "scripts", "publish-youtube.ts"), "utf8");
    assert.match(src, /if \(!plan\.thumbnail\) \{[\s\S]*?coverPrerequisites\(await runVideoEnvCheck\(\)\)/);
    assert.match(src, /cover_prerequisites: coverPrereqs/);
  });
});
