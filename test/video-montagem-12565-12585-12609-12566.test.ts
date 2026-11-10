/**
 * Lote video-montagem (overnight 261110):
 * - #12565: a legenda dos recortes do `frame` sai das escalas de verdade (60/85 no horizontal), não de texto fixo.
 * - #12585: o roteiro traz o título de cada vídeo, das mesmas funções do build e dos publicadores.
 * - #12609: o horizontal passa a `Diaria comentada horizontal_V{n}`; o antigo `_Youtube_V{n}` segue valendo.
 * - #12566: avisos de caneca e rosto centrado por arquivo no bruto em vários arquivos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSequences,
  faceCenterWarnings,
  FRAME_PREVIEW_CROPS,
  frameCropLegend,
  framingWarningsByFile,
  horizontalSequenceName,
  mugFramingWarnings,
  YOUTUBE_SCALES,
  type SequencePlan,
  type SourceInfo,
} from "../scripts/lib/diaria/video-montage.ts";
import { selectDriveVideo, videoTargetOf, type DriveVideoFile } from "../scripts/lib/diaria/drive-video-source.ts";
import { roteiroMarkdown, targetLabel } from "../scripts/lib/diaria/video-montage-docs.ts";
import { videoTitlesFor } from "../scripts/video-montagem.ts";

describe("#12565: legenda dos recortes do frame", () => {
  it("diz as escalas do horizontal e das verticais que o frame desenha", () => {
    const legend = frameCropLegend();
    assert.match(legend, new RegExp(`amarelo = horizontal ${YOUTUBE_SCALES[0]}/${YOUTUBE_SCALES[1]}%`));
    assert.match(legend, /ciano = verticais 115\/130%/);
    assert.match(legend, /magenta = caneca/);
    assert.doesNotMatch(legend, /50\/62/, "o texto fixo antigo");
    // Cada recorte desenhado tem a sua entrada na legenda.
    for (const c of FRAME_PREVIEW_CROPS) assert.ok(legend.includes(c.scales.join("/")), `escala ${c.scales.join("/")} na legenda`);
  });
});

describe("#12609: nome do horizontal", () => {
  it("o default é `Diaria comentada horizontal_V{n}`, nos dois formatos", () => {
    assert.equal(horizontalSequenceName("V3"), "Diaria comentada horizontal_V3");
    for (const fmt of ["monologo", "entrevista"] as const) {
      const yt = defaultSequences("V1", fmt).find((s) => s.target === "youtube")!;
      assert.equal(yt.name, "Diaria comentada horizontal_V1");
      assert.equal(videoTargetOf(yt.name), "youtube", "o build aceita o nome que ele mesmo gera");
    }
  });

  it("videoTargetOf aceita o nome novo e o antigo; corte e nome com dois destinos não", () => {
    assert.equal(videoTargetOf("Diaria comentada horizontal_V3.mp4"), "youtube");
    assert.equal(videoTargetOf("Diaria comentada horizontal_FINAL.mp4"), "youtube");
    assert.equal(videoTargetOf("Diaria comentada horizontal_Edição 09_V2.mp4"), "youtube");
    assert.equal(videoTargetOf("Diaria comentada_Youtube_V3.mp4"), "youtube", "edições já exportadas");
    assert.equal(videoTargetOf("Diaria comentada_Vertical_V3.mp4"), "outras-redes");
    assert.equal(videoTargetOf("Diaria comentada horizontal_V1-soberana.mp4"), null, "corte");
    assert.equal(videoTargetOf("Diaria comentada horizontal_Vertical_V1.mp4"), null, "dois destinos");
    assert.equal(videoTargetOf("horizontal-pre-final.mp4"), null, "palavra solta sem versão");
  });

  it("o fetch acha o horizontal com o nome novo e com o antigo em Final/", () => {
    const T = "2026-11-09T22:00:00Z";
    const vid = (name: string, w: number, h: number): DriveVideoFile => ({
      id: `id-${name.replace(/\W+/g, "-")}`,
      name,
      mimeType: "video/mp4",
      createdTime: T,
      modifiedTime: T,
      videoMediaMetadata: { width: w, height: h },
      scope: "final-folder",
    });
    const now = new Date("2026-11-10T12:00:00Z");
    for (const name of ["Diaria comentada horizontal_V2.mp4", "Diaria comentada_Youtube_V2.mp4"]) {
      const files = [vid(name, 1920, 1080), vid("Diaria comentada_Vertical_V2.mp4", 1080, 1920)];
      const h = selectDriveVideo(files, { orientation: "horizontal", now, editionFolderPresent: true });
      assert.equal(h.kind, "found", name);
      if (h.kind === "found") assert.equal(h.file.name, name);
      const v = selectDriveVideo(files, { orientation: "vertical", now, editionFolderPresent: true });
      assert.equal(v.kind, "found");
      if (v.kind === "found") assert.equal(v.file.name, "Diaria comentada_Vertical_V2.mp4");
    }
  });

  it("o roteiro rotula a versão \"Horizontal\"", () => {
    assert.equal(targetLabel({ target: "youtube" }), "Horizontal");
  });
});

describe("#12585: título de cada vídeo no roteiro", () => {
  const specs = defaultSequences("V1", "monologo");
  const corte = { ...specs[1], name: "Diaria comentada_Vertical_V1-soberana", corte: "soberana", screenTitle: "IA soberana no Brasil", target: "instagram" as const };

  it("horizontal = título do D1 do publish-youtube; vertical = screenTitle ou D1; corte = screenTitle da sequência", () => {
    const t = videoTitlesFor([...specs, corte], { blocksTitle: "Nvidia: CEO admite caso", d1Title: "**Nvidia**: CEO admite caso com suposta espiã" });
    assert.equal(t.youtube, "Nvidia: CEO admite caso com suposta espiã (título do D1, o do publish-youtube.ts sem --title)");
    assert.equal(t["outras-redes"], "Nvidia: CEO admite caso (screenTitle do blocks.json)");
    assert.equal(t.soberana, "IA soberana no Brasil (screenTitle da sequência do corte)");
  });

  it("sem screenTitle a vertical sai com o D1; corte sem screenTitle diz que herda o da vertical", () => {
    const { screenTitle: _drop, ...semTitulo } = corte;
    const t = videoTitlesFor([...specs, semTitulo], { d1Title: "Nvidia: CEO admite caso com suposta espiã" });
    assert.match(t["outras-redes"], /^Nvidia: CEO admite caso com suposta espiã \(título do D1/);
    assert.match(t.soberana, /o da vertical da edição: o corte não tem screenTitle/);
    const none = videoTitlesFor(specs, {});
    assert.match(none.youtube, /sem D1/);
    assert.match(none["outras-redes"], /sem título/);
  });

  it("roteiroMarkdown põe a linha logo abaixo do cabeçalho de cada versão", () => {
    const plans = specs.map((spec) => ({ spec, clips: [], durationFrames: 300, script: [], warnings: [], missingBlocks: [] })) as unknown as SequencePlan[];
    const md = roteiroMarkdown("261109", plans, {}, 30, { videoTitles: { youtube: "Título H", "outras-redes": "Título V" } });
    assert.match(md, /## Horizontal 1920x1080: Diaria comentada horizontal_V1 \(00:10\.0\)\n\n\*\*Título do vídeo:\*\* Título H\n/);
    assert.match(md, /## Vertical 1080x1920: Diaria comentada_Vertical_V1 \(00:10\.0\)\n\n\*\*Título do vídeo:\*\* Título V\n/);
    assert.doesNotMatch(roteiroMarkdown("261109", plans, {}, 30), /Título do vídeo/, "sem videoTitles, sem a linha");
  });
});

describe("#12566: caneca e rosto centrado por arquivo", () => {
  const spec = { ...defaultSequences("V1", "monologo")[0] };
  const framing = { faceX: 0.5, eyeY: 0.5, mug: { left: 0.45, right: 0.55, top: 0.7, bottom: 0.8 } };
  const clip = (file: number, scale: number) => ({ block: "comentario", start: 0, end: 30, scale, file });
  const plan = (clips: unknown[]) => ({ spec, clips, durationFrames: 300 }) as unknown as SequencePlan;

  it("bruto único: igual às duas funções de sempre", () => {
    const source: SourceInfo = { path: "G:/x/bruto.mp4", fps: 30, durationS: 30, width: 3840, height: 2160, mirrored: true };
    const off = { faceX: 0.1, eyeY: 0.5 };
    const p = plan([{ ...clip(0, 60), file: undefined }, { ...clip(0, 85), file: undefined }]);
    const got = framingWarningsByFile([p], source, off);
    assert.deepEqual(got.mug, mugFramingWarnings([p], source, off));
    assert.deepEqual(got.face, faceCenterWarnings([p], source, off));
    assert.ok(got.face.length > 0, "o rosto na borda avisa");
  });

  it("vários arquivos: confere o 2º arquivo com o framing dele, com o id à frente; vertical em blur-fill fica de fora", () => {
    const source: SourceInfo = {
      path: "G:/x/A.mp4",
      fps: 30,
      durationS: 90,
      width: 1080,
      height: 1920,
      mirrored: true,
      files: [
        { id: "A", path: "G:/x/A.mp4", offsetFrames: 0, frames: 900, width: 1080, height: 1920 },
        { id: "B", path: "G:/x/B.mp4", offsetFrames: 900, frames: 900, width: 3840, height: 2160 },
      ],
    };
    // A é a vertical gravada antes (caso Nvidia): no horizontal entra em blur-fill, sem recorte.
    const overrides = { A: { framing: { faceX: 0, eyeY: 0.5 } }, B: { framing: { faceX: 0.1, eyeY: 0.5 } } };
    const p = plan([clip(0, 60), clip(1, 60), clip(1, 85)]);
    const got = framingWarningsByFile([p], source, framing, overrides);
    assert.ok(got.face.some((w) => w.startsWith("B: ")), "o mestre horizontal (2º arquivo) agora é conferido");
    assert.ok(got.mug.some((w) => w.startsWith("B: ") && /framing sem mug/.test(w)), "framing de B sem caneca");
    assert.ok([...got.face, ...got.mug].every((w) => !w.startsWith("A: ")), "blur-fill não tem recorte");
    // Sem override, B usa o framing do arquivo inteiro (rosto centrado, caneca dentro): nenhum aviso de rosto.
    const base = framingWarningsByFile([p], source, framing, {});
    assert.deepEqual(base.face, []);
  });
});
