/**
 * #13570: na 261118 o `gen-youtube-thumb.ts --short-cover --srt` do vertical V2
 * escolheu `--at 4.5` contando com o lettering do título em 0–3,5 s fixos, e a
 * capa saiu com a caixa do título do D1 ainda no alto e nenhuma legenda,
 * enquanto o `[premissa]` afirmava a legenda "no frame". Agora o fim do
 * lettering sai do plan.json da montagem (o `screenTitleSpan` que monta o
 * título no XML) e a legenda é conferida nos pixels do frame.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import sharp from "sharp";
import {
  captionBoxStats,
  captionVisibleInFrame,
  letteringEndForSrt,
  letteringEndFromPlanFile,
  montagemPlanPathsDefault,
  parseSrtCues,
  planShortCoverCaption,
  sequenceNameFromSrtPath,
} from "../scripts/lib/diaria/short-cover-caption.ts";
import { PREVIEW_SUBTITLE_STYLE } from "../scripts/lib/diaria/video-montage.ts";
import { parseAssStyle, subtitleLayout } from "../scripts/lib/diaria/video-legenda-xml.ts";
import { planShortCoverFrame, SHORT_COVER_H, SHORT_COVER_LETTERING_WINDOW_S, SHORT_COVER_W } from "../scripts/lib/diaria/youtube-thumb.ts";

const SEQ = "Diaria comentada_Vertical_V2";
const SRT_PATH = `/drive/261118/${SEQ} - legendas.srt`;

// Forma da 261118 no V2: a 1ª legenda acaba antes de 3,5 s, a 2ª cobre 4,5 s, e
// o título fica na tela até ~5,4 s (o bloco de abertura).
const srt261118 = [
  "1\n00:00:00,400 --> 00:00:03,200\nO governo vai exigir licença\n",
  "2\n00:00:03,200 --> 00:00:05,300\npara exportar chips de IA.\n",
  "3\n00:00:05,300 --> 00:00:08,600\nEu falei disso semana passada.\n",
].join("\n");

const FPS = 30;
/** plan.json mínimo da montagem: o título vai até o fim do bloco de abertura (`gancho`, 0–162 quadros = 5,4 s). */
function planFile(seqName = SEQ) {
  const clip = (block: string, seqStart: number, seqEnd: number) => ({ block, seqStart, seqEnd, srcIn: 0, srcOut: 0, frameIn: 0, frameOut: 0, scale: 115 });
  return {
    source: { fps: FPS },
    plans: [
      { spec: { name: "Diaria comentada horizontal_V1", width: 1920, height: 1080 }, clips: [clip("titulo", 0, 90)] },
      { spec: { name: seqName, width: 1080, height: 1920 }, clips: [clip("gancho", 0, 100), clip("gancho", 100, 162), clip("resumo", 162, 600)] },
    ],
  };
}

describe("#13570: fim do lettering medido no plan.json da montagem", () => {
  it("o nome da sequência sai do SRT da montagem (legendas e legendas do export)", () => {
    assert.equal(sequenceNameFromSrtPath(SRT_PATH), SEQ);
    assert.equal(sequenceNameFromSrtPath(`/x/${SEQ} - legendas do export.srt`), SEQ);
    assert.equal(sequenceNameFromSrtPath("/x/legendas.srt"), null);
  });

  it("lettering = o trecho do título da sequência (screenTitleSpan), em segundos", () => {
    assert.equal(letteringEndFromPlanFile(planFile(), SEQ), 5.4);
    assert.equal(letteringEndFromPlanFile(planFile(), "outra"), null);
    assert.equal(letteringEndFromPlanFile({ plans: planFile().plans }, SEQ), null, "sem fps não mede");
    assert.equal(letteringEndFromPlanFile("lixo", SEQ), null);
  });

  it("regressão 261118: com 3,5 s fixos o frame cai em 4,5 s (título na tela); medido, cai depois do título", () => {
    const cues = parseSrtCues(srt261118);
    const fixo = planShortCoverCaption(cues);
    assert.ok(fixo);
    assert.equal(fixo.at, 4.5, "o --at da 261118, dentro do título");
    const lettering = letteringEndForSrt(SRT_PATH, ["/work/plan.json"], () => planFile());
    assert.equal(lettering.endS, 5.4);
    const medido = planShortCoverCaption(cues, { letteringS: lettering.endS! });
    assert.ok(medido);
    assert.ok(medido.at > 5.4, `at ${medido.at} depois do título`);
    assert.equal(medido.cue.text, "Eu falei disso semana passada.");
  });

  it("sem plan.json com a sequência, diz por quê (o CLI avisa e cai nos 3,5 s)", () => {
    const r = letteringEndForSrt(SRT_PATH, ["/a/plan.json", "/b/plan.json"], (p) => (p === "/b/plan.json" ? planFile("outra") : undefined));
    assert.equal(r.endS, null);
    assert.ok("reason" in r && /\/a\/plan\.json \(ausente ou ilegível\); \/b\/plan\.json \(sem a sequência/.test(r.reason));
    const nome = letteringEndForSrt("/x/meu.srt", ["/a/plan.json"], () => planFile());
    assert.ok("reason" in nome && /nome do SRT/.test(nome.reason));
  });

  it("plan.json default: o work dir do modo API (cache) e o do modo local (tmp)", () => {
    const paths = montagemPlanPathsDefault("261118", { tmp: "/tmp", home: "/home/u" });
    assert.ok(paths.includes(join("/tmp", "diaria-video-montagem", "261118", "plan.json")));
    assert.ok(paths.some((p) => p.endsWith(join("261118", "work", "plan.json"))));
  });

  it("planShortCoverFrame avisa pelo lettering medido, não pelos 3,5 s", () => {
    assert.deepEqual(planShortCoverFrame("v.mp4", 4.5, "o.jpg", { withHook: true }).warnings, []);
    assert.match(planShortCoverFrame("v.mp4", 4.5, "o.jpg", { withHook: true, letteringS: 5.4 }).warnings.join("\n"), /dentro da janela do lettering do título \(0–5.4s\)/);
    assert.equal(SHORT_COVER_LETTERING_WINDOW_S, 3.5);
  });
});

describe("#13570: a legenda conferida nos pixels do frame", () => {
  const style = parseAssStyle(PREVIEW_SUBTITLE_STYLE);
  const texto = "Eu falei disso semana passada.";
  const boxes = subtitleLayout(texto, SHORT_COVER_W, SHORT_COVER_H, style).lines.map((l) => l.box);

  /** Frame sintético: fundo em degradê (o vídeo), com ou sem a caixa escura + texto branco da legenda. */
  async function frame(comLegenda: boolean, w = SHORT_COVER_W, h = SHORT_COVER_H): Promise<Buffer> {
    const s = w / SHORT_COVER_W;
    const rects = comLegenda
      ? boxes
          .map((b) => {
            const [x, y, bw, bh] = [b.x * s, b.y * s, b.w * s, b.h * s];
            const stripes = Array.from({ length: 8 }, (_, i) => `<rect x="${x + (bw / 8) * i + 4 * s}" y="${y + bh * 0.3}" width="${(bw / 8) * 0.4}" height="${bh * 0.4}" fill="#fff"/>`).join("");
            return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="#141c22" fill-opacity="0.92"/>${stripes}`;
          })
          .join("")
      : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c9a27e"/><stop offset="1" stop-color="#5a6b7c"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${rects}</svg>`;
    return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  }

  it("frame com a legenda queimada: visível", async () => {
    const r = await captionVisibleInFrame(await frame(true), texto);
    assert.equal(r.visible, true, JSON.stringify(r));
  });

  it("regressão 261118: frame sem legenda queimada (só o vídeo): não visível, o CLI avisa em vez de afirmar", async () => {
    const r = await captionVisibleInFrame(await frame(false), texto);
    assert.equal(r.visible, false, JSON.stringify(r));
  });

  it("frame em outra resolução (720x1280): a geometria escala", async () => {
    assert.equal((await captionVisibleInFrame(await frame(true, 720, 1280), texto)).visible, true);
    assert.equal((await captionVisibleInFrame(await frame(false, 720, 1280), texto)).visible, false);
  });

  it("caixa toda clara (fundo branco) ou toda escura sem texto: não visível", () => {
    const w = 100;
    const h = 100;
    const box = [{ x: 0, y: 0, w: 100, h: 100 }];
    assert.equal(captionBoxStats(new Uint8Array(w * h).fill(255), w, h, box).visible, false);
    assert.equal(captionBoxStats(new Uint8Array(w * h).fill(20), w, h, box).visible, false);
    assert.equal(captionBoxStats(new Uint8Array(w * h), w, h, []).visible, false);
  });
});
