/**
 * Legenda das verticais dentro do XML (#13332, pedido do editor de 16/11/2026,
 * 261117: "o que importa é abrir o XML no Premiere com legenda").
 *
 * O Premiere não importa SRT de dentro do xmeml (FCP7). Então cada cue do SRT
 * vira um PNG transparente do tamanho da sequência, no estilo da legenda
 * queimada na prévia, e entra numa faixa de vídeo no topo da sequência, um
 * clipe por cue, do começo ao fim da cue (o padrão da faixa de tela do
 * horizontal, `telaTrack`, #13204).
 *
 * O estilo não é redefinido aqui: sai da string ASS da prévia
 * (`PREVIEW_SUBTITLE_STYLE`, a do `force_style` do ffmpeg), lida por
 * `parseAssStyle`. Mudar a letra da prévia muda a do XML.
 *
 * Puro: SVG, nomes, faixa do xmeml e a troca da faixa no XML já gravado. Quem
 * rasteriza (sharp) e grava é o `srt` de `video-montagem.ts`.
 */
import { telaTrack, type TelaOverlay } from "./video-tela.ts";

/**
 * PlayResY que o ffmpeg dá ao SRT convertido para ASS (o cabeçalho padrão do
 * libavcodec: 384x288). `FontSize`, `MarginV` e `Outline` do `force_style` são
 * nessa escala; no quadro, multiplica pela altura / 288.
 */
export const ASS_PLAY_RES = { x: 384, y: 288 } as const;

/**
 * Largura média de um caractere, em em, para medir a CAIXA (o texto é centrado
 * pelo SVG). Pela DejaVu Sans, mais larga que a Arial: o 300 não tem Arial nem
 * Liberation, e o fallback da rasterização é ela (medido: 0,51 a 0,55 em por
 * linha de legenda). Com Arial a caixa só sobra um pouco dos lados.
 */
export const SUBTITLE_AVG_CHAR_EM = 0.56;
/** A mesma medida para decidir a QUEBRA: a real, para não quebrar uma linha que o libass da prévia não quebra. */
export const SUBTITLE_WRAP_CHAR_EM = 0.5;
/** Altura da linha de Arial (ascendente + descendente), em em. */
export const SUBTITLE_LINE_EM = 1.15;
const DESCENT_EM = 0.21;

export interface AssColour {
  r: number;
  g: number;
  b: number;
  /** 0 = transparente, 1 = opaco (o alfa do ASS é o inverso). */
  opacity: number;
}

/** `&HAABBGGRR` (ou `&HBBGGRR`) do ASS. */
export function parseAssColour(v: string): AssColour {
  const m = /^&H([0-9A-Fa-f]{6,8})&?$/u.exec(v.trim());
  if (!m) throw new Error(`cor ASS inválida: ${v} (#13332)`);
  const hex = m[1].padStart(8, "0");
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return { r: n(6), g: n(4), b: n(2), opacity: Math.round((1 - n(0) / 255) * 1000) / 1000 };
}

export interface SubtitleStyle {
  font: string;
  fontSize: number;
  primary: AssColour;
  back: AssColour;
  /** BorderStyle=3: caixa opaca por linha, com `outline` de margem em volta do texto. */
  box: boolean;
  outline: number;
  marginV: number;
  marginL: number;
  marginR: number;
  /** Alinhamento numpad do ASS (1-3 embaixo, 4-6 no meio, 7-9 em cima). */
  alignment: number;
}

/** Lê a string do `force_style` (ex.: `PREVIEW_SUBTITLE_STYLE`); o que falta fica com o padrão do ASS. */
export function parseAssStyle(style: string): SubtitleStyle {
  const kv = new Map<string, string>();
  for (const part of style.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) kv.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  const num = (k: string, d: number) => {
    const v = kv.get(k);
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${k} inválido no estilo da legenda: ${v} (#13332)`);
    return n;
  };
  return {
    font: kv.get("fontname") ?? "Arial",
    fontSize: num("fontsize", 18),
    primary: parseAssColour(kv.get("primarycolour") ?? "&H00FFFFFF"),
    back: parseAssColour(kv.get("backcolour") ?? "&H80000000"),
    box: num("borderstyle", 1) === 3,
    outline: num("outline", 2),
    marginV: num("marginv", 10),
    marginL: num("marginl", 10),
    marginR: num("marginr", 10),
    alignment: num("alignment", 2),
  };
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const rgb = (c: AssColour) => `rgb(${c.r},${c.g},${c.b})`;

/** Quebra nas palavras a linha mais larga que `maxPx` (o libass faria o mesmo na prévia). */
function wrapToWidth(lines: string[], fontPx: number, maxPx: number): string[] {
  const out: string[] = [];
  const width = (s: string) => s.length * fontPx * SUBTITLE_WRAP_CHAR_EM;
  for (const l of lines) {
    let cur = "";
    for (const w of l.split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${w}` : w;
      if (cur && width(next) > maxPx) {
        out.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Geometria da legenda de uma cue num quadro `width`x`height` (linhas de baixo para cima a partir do MarginV). */
export function subtitleLayout(text: string, width: number, height: number, style: SubtitleStyle) {
  const s = height / ASS_PLAY_RES.y;
  const sx = width / ASS_PLAY_RES.x;
  const fontPx = style.fontSize * s;
  const lineH = fontPx * SUBTITLE_LINE_EM;
  const pad = style.outline * s;
  const left = style.marginL * sx;
  const right = width - style.marginR * sx;
  const lines = wrapToWidth(text.split("\n").map((l) => l.trim()).filter(Boolean), fontPx, right - left - 2 * pad);
  const col = ((style.alignment - 1) % 3) + 1;
  const row = Math.floor((style.alignment - 1) / 3);
  const blockH = lines.length * lineH;
  // row 0 = embaixo (MarginV da base), 1 = meio, 2 = em cima (MarginV do topo).
  const top = row === 0 ? height - style.marginV * s - blockH : row === 1 ? (height - blockH) / 2 : style.marginV * s;
  const anchor = col === 1 ? "start" : col === 3 ? "end" : "middle";
  const x = col === 1 ? left + pad : col === 3 ? right - pad : width / 2;
  return {
    fontPx,
    anchor,
    lines: lines.map((t, i) => {
      const w = t.length * fontPx * SUBTITLE_AVG_CHAR_EM;
      // A caixa nunca passa da borda do quadro (a estimativa larga pode passar numa linha no limite).
      const x0 = Math.max(0, anchor === "start" ? x - pad : anchor === "end" ? x - w - pad : x - w / 2 - pad);
      const x1 = Math.min(width, anchor === "start" ? x + w + pad : anchor === "end" ? x + pad : x + w / 2 + pad);
      const y = top + i * lineH;
      return {
        text: t,
        x: Math.round(x),
        baseline: Math.round(y + lineH - DESCENT_EM * fontPx),
        box: { x: Math.round(x0), y: Math.round(y - pad), w: Math.round(x1 - x0), h: Math.round(lineH + 2 * pad) },
      };
    }),
  };
}

/**
 * Base da caixa da legenda (px) num quadro `width`x`height` (#13333): onde
 * começa o box de tela do vertical, que vai abaixo da legenda. Com a legenda
 * embaixo (alinhamento 1-3), a base não depende do número de linhas.
 */
export function subtitleBottomY(width: number, height: number, style: SubtitleStyle): number {
  const { lines } = subtitleLayout("x", width, height, style);
  return Math.max(...lines.map((l) => l.box.y + l.box.h));
}

/** SVG da legenda de uma cue, transparente fora da caixa (o PNG que entra na faixa do XML). */
export function subtitleCueSvg(text: string, width: number, height: number, style: SubtitleStyle): string {
  const { fontPx, anchor, lines } = subtitleLayout(text, width, height, style);
  const boxes = style.box
    ? lines.map((l) => `<rect x="${l.box.x}" y="${l.box.y}" width="${l.box.w}" height="${l.box.h}" fill="${rgb(style.back)}" fill-opacity="${style.back.opacity}"/>`).join("\n")
    : "";
  const texts = lines.map((l) => `<text x="${l.x}" y="${l.baseline}">${escapeXml(l.text)}</text>`).join("\n  ");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
    (boxes ? `${boxes}\n` : "") +
    `<g font-family="${escapeXml(style.font)}, 'Liberation Sans', 'DejaVu Sans', sans-serif" font-size="${Math.round(fontPx)}" fill="${rgb(style.primary)}" fill-opacity="${style.primary.opacity}" text-anchor="${anchor}">\n  ${texts}\n</g>\n</svg>\n`
  );
}

/**
 * Subpasta dos PNGs na pasta da edição (e no out dir): `legendas-vertical`
 * para a vertical da edição, `legendas-vertical-{corte}` para um corte (o
 * nome que o editor já tinha na 261117: `legendas-vertical-guia`).
 */
export function subtitleDirName(key: string): string {
  return key === "outras-redes" || key === "instagram" ? "legendas-vertical" : `legendas-vertical-${key.replace(/[^A-Za-z0-9-]/g, "")}`;
}

/** Nome do PNG de uma cue: número + hash do conteúdo (um XML antigo segue achando o dele). */
export function subtitleFileName(edition: string, index: number, hash: string): string {
  return `${edition}_legenda_${String(index).padStart(3, "0")}-${hash}.png`;
}

/** Prefixo dos ids da faixa de legenda no XML: é por ele que um `srt` de novo acha e troca a faixa anterior. */
export const SUBTITLE_CLIP_ID_PREFIX = "legenda";

/** Cues (segundos) para quadros da sequência; corta no fim da fala e tira a cue que fica sem duração. */
export function cueFrames(cues: ReadonlyArray<{ start: number; end: number }>, fps: number, durationFrames: number): Array<{ in: number; out: number }> {
  return cues.map((c) => {
    const a = Math.max(0, Math.round(c.start * fps));
    const b = Math.min(durationFrames, Math.round(c.end * fps));
    return { in: a, out: b };
  });
}

/** Um PNG de cue já gravado, no tempo da sequência. */
export interface SubtitleOverlay {
  index: number;
  text: string;
  path: string;
  xmlPath: string;
  width: number;
  height: number;
  in: number;
  out: number;
}

/** A faixa do xmeml com a legenda (um clipe por cue), no formato da faixa de tela (`telaTrack`). */
export function subtitleTrack(input: { overlays: readonly SubtitleOverlay[]; rate: string; url: (p: string) => string }): string {
  const ids = new Map<string, string>();
  const fileIdOf = (xmlPath: string) => {
    const known = ids.get(xmlPath);
    if (known) return { id: known, defined: true };
    const id = `file-${SUBTITLE_CLIP_ID_PREFIX}-${ids.size + 1}`;
    ids.set(xmlPath, id);
    return { id, defined: false };
  };
  const overlays: TelaOverlay[] = input.overlays.map((o) => ({ id: String(o.index), tela: o.text, path: o.path, xmlPath: o.xmlPath, width: o.width, height: o.height, in: o.in, out: o.out }));
  return telaTrack({ overlays, rate: input.rate, idPrefix: SUBTITLE_CLIP_ID_PREFIX, fileIdOf, url: input.url, label: "legenda" });
}

const SEQUENCE_VIDEO_END = "</video>\n<audio><numOutputChannels>";
const OLD_TRACK = new RegExp(`\\n?<track><clipitem id="${SUBTITLE_CLIP_ID_PREFIX}-\\d+">[\\s\\S]*?</track>`, "gu");

/**
 * Põe a faixa de legenda no topo do vídeo da sequência do XML (a última
 * `<track>` antes do `</video>` da sequência, acima de título, tela, vinheta e
 * capa), trocando a de um `srt` anterior. `track` vazio só tira a anterior.
 * XML com mais de uma sequência, ou sem o fim do vídeo da sequência, é erro.
 */
export function withSubtitleTrack(xml: string, track: string): string {
  const clean = xml.replace(OLD_TRACK, "");
  const at = clean.indexOf(SEQUENCE_VIDEO_END);
  if (at < 0) throw new Error("XML sem o fim do vídeo da sequência (</video> antes do <audio> dela): a faixa de legenda não entrou (#13332)");
  if (clean.indexOf(SEQUENCE_VIDEO_END, at + 1) >= 0) throw new Error("XML com mais de uma sequência: a faixa de legenda vai num XML por sequência (#13332)");
  return clean.slice(0, at) + track + clean.slice(at);
}
