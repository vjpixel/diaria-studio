/**
 * #13212 (decisão do editor, 15/11/2026): a legenda do horizontal sai só do
 * export final (`srt --seq youtube --from-final`), nunca da montagem. O `srt`
 * sem `--seq` gera só as verticais e os cortes, `--seq youtube` sem
 * `--from-final` recusa (em `test/video-montage-srt-11957-11960.test.ts`), a
 * prévia do horizontal sai sem legenda (em `video-montage-cta-card-12571-12579`)
 * e o `publish-youtube.ts` não sobe uma cópia da montagem que tenha sobrado na
 * pasta da edição: avisa e pede o comando do export.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YOUTUBE_PUBLISHED_FILE, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import { fromFinalCaptionCommand, isMontageCaptionCopy, youtubeCaptionFileName, youtubeSrtRecordPath } from "../scripts/lib/diaria/youtube-captions.ts";
import { captionCopyIsFromMontage, planYouTubePublish, runCaptionsOnly } from "../scripts/publish-youtube.ts";
import { srtHorizontalRefusal } from "../scripts/video-montagem.ts";

const SRT = "1\n00:00:00,000 --> 00:00:02,500\nOlá, diar.ia.br\n";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const REVIEWED_MD = `DESTAQUE 1 | SEGURANÇA
IA ladra? O cofre que o modelo abriu
https://fonte.exemplo.com/artigo

Pesquisadores mostraram que um agente conseguiu abrir o cofre sem senha.

Por que isso importa:
Porque sim.
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "srt-horizontal-13212-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedCopy(record: Record<string, unknown> | null, srt = SRT): string {
  const path = join(dir, youtubeCaptionFileName("261116"));
  writeFileSync(path, srt);
  if (record) {
    mkdirSync(join(dir, "_internal", "video-montagem"), { recursive: true });
    writeFileSync(youtubeSrtRecordPath(dir), JSON.stringify(record));
  }
  return path;
}

describe("#13212: origem da cópia do horizontal na pasta da edição", () => {
  it("registro com o mesmo sha e sem fromExport = legenda da montagem", () => {
    assert.equal(isMontageCaptionCopy(SRT, { sha256: sha(SRT) }), true);
  });

  it("do --from-final (fromExport), editada à mão (sha outro) ou sem registro: não é da montagem", () => {
    assert.equal(isMontageCaptionCopy(SRT, { sha256: sha(SRT), fromExport: "Diaria comentada horizontal_V1.mp4" }), false);
    assert.equal(isMontageCaptionCopy(SRT + "corrigido\n", { sha256: sha(SRT) }), false);
    assert.equal(isMontageCaptionCopy(SRT, null), false);
    assert.equal(isMontageCaptionCopy(null, { sha256: sha(SRT) }), false);
  });

  it("captionCopyIsFromMontage lê o youtube-srt.json do state dir default da montagem", () => {
    const path = seedCopy({ sha256: sha(SRT) });
    assert.equal(captionCopyIsFromMontage(dir, path), true);
  });

  it("captionCopyIsFromMontage: registro ilegível não bloqueia (fail-soft, com aviso)", () => {
    const path = seedCopy(null);
    mkdirSync(join(dir, "_internal", "video-montagem"), { recursive: true });
    writeFileSync(youtubeSrtRecordPath(dir), "{not json");
    assert.equal(captionCopyIsFromMontage(dir, path), false);
  });

  it("o comando do export é o mesmo que o video-montagem recusa com", () => {
    assert.match(srtHorizontalRefusal("261116"), new RegExp(fromFinalCaptionCommand("261116").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("#13212: publish-youtube não sobe a legenda da montagem", () => {
  function plan(captions: { path: string; exists: boolean; fromMontage?: boolean }) {
    const videoPath = join(dir, "diaria-comentada-261116.mp4");
    writeFileSync(videoPath, Buffer.from("fake-mp4-bytes"));
    return planYouTubePublish({
      aammdd: "261116",
      reviewedMd: REVIEWED_MD,
      now: new Date("2026-11-15T23:00:00Z"),
      episode: 2,
      editionUrl: "https://diar.ia.br/p/ia-ladra",
      video: { path: videoPath, exists: true, sizeBytes: 14 },
      thumb: { path: join(dir, "04-youtube-thumb.jpg"), exists: false },
      captions,
    });
  }

  it("cópia da montagem: o plano não leva legenda e avisa com o comando do --from-final", () => {
    const path = seedCopy({ sha256: sha(SRT) });
    const p = plan({ path, exists: true, fromMontage: true });
    assert.equal(p.captions, null);
    assert.ok(p.warnings.some((w) => w.includes("legenda da montagem") && w.includes("srt 261116 --seq youtube --from-final") && w.includes("#13212")), p.warnings.join("\n"));
  });

  it("cópia do export: o plano leva a legenda como antes", () => {
    const path = seedCopy({ sha256: sha(SRT), fromExport: "x.mp4" });
    const p = plan({ path, exists: true, fromMontage: false });
    assert.equal(p.captions?.path, path);
  });

  it("sem legenda: a premissa aponta o --from-final", () => {
    const p = plan({ path: join(dir, youtubeCaptionFileName("261116")), exists: false });
    assert.equal(p.captions, null);
    assert.ok(p.premises.some((x) => /sem legenda/.test(x) && /--from-final/.test(x)), p.premises.join("\n"));
  });

  it("--captions-only com a cópia da montagem recusa antes de qualquer rede", async () => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), JSON.stringify({ aammdd: "261116", videoId: "abc123XYZ_9", url: "https://youtu.be/abc123XYZ_9" }));
    const path = seedCopy({ sha256: sha(SRT) });
    const deps: YouTubeUploadDeps = {
      fetch: async () => {
        throw new Error("rede não deveria ser chamada");
      },
      now: () => new Date(),
    };
    const logs: string[] = [];
    const out = await runCaptionsOnly(deps, {
      aammdd: "261116",
      editionDir: dir,
      captionsPath: path,
      env: {},
      force: false,
      captionsFromMontage: true,
      readFile: (p) => readFileSync(p),
      log: (l) => logs.push(l),
    });
    assert.equal(out.exitCode, 1);
    assert.ok(logs.some((l) => l.includes("legenda da montagem") && l.includes("Nenhuma legenda enviada")), logs.join("\n"));
  });
});
