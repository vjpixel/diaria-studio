/**
 * Rosto automático por tomada (#12560), portado de `vjpixel/edicao-video`
 * (`scripts/montagem.ts` `face`/`gaze` e `scripts/face_detect.py`).
 *
 * O Python (`scripts/video/face_detect.py`, Haar cascade do OpenCV) só DETECTA
 * e devolve todos os rostos de cada frame. A escolha e a agregação ficam aqui,
 * puras e testáveis sem OpenCV:
 *
 *   - `pickFace`: o maior rosto com centro nos 2/3 de cima do quadro (o botão
 *     do microfone no peito vira falso rosto);
 *   - `itemFramings`: 3 frames por item (25/50/75% da fala); a mediana dos
 *     achados dá `faceX` (centro do rosto) e `eyeY` (40% da altura do rosto a
 *     partir do topo), em fração do quadro já desespelhado. Item sem rosto em
 *     nenhum frame não ganha framing (o do arquivo continua valendo).
 *
 * Diferença do edicao-video: lá o `face --write` grava também `zoom` por item;
 * aqui as escalas são por sequência (`scales`, alternância nos cortes), então
 * só o `framing` do item é gravado, e o tamanho do rosto sai no relato.
 */

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameDetection {
  key: string;
  /** Tamanho do frame analisado (px). 0 = frame ilegível. */
  w: number;
  h: number;
  /** Todos os rostos que o cascade achou. */
  faces: FaceBox[];
}

/** O rosto do frame: o maior com centro nos 2/3 de cima; sem nenhum lá em cima, o maior de todos. */
export function pickFace(faces: readonly FaceBox[], frameH: number): FaceBox | null {
  if (!faces.length) return null;
  const up = faces.filter((f) => f.y + f.h / 2 < frameH * 0.66);
  const pool = up.length ? up : faces;
  return pool.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
}

/** Frações da fala em que o `face` mede o rosto. */
export const FACE_SAMPLE_FRACTIONS = [0.25, 0.5, 0.75] as const;

/** Linha dos olhos a 40% da altura da caixa do rosto (Haar), como no edicao-video. */
export const EYE_IN_FACE = 0.4;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface ItemFaceResult {
  key: string;
  /** Frames com rosto achado / frames analisados. */
  found: number;
  total: number;
  framing: { faceX: number; eyeY: number } | null;
  /** Altura do rosto em fração do quadro (mediana); null sem rosto. */
  faceH: number | null;
}

/**
 * Agrega as detecções por item (`key` = `{bloco}#{índice}` do frame). Cada
 * frame entra com o rosto de `pickFace`; a mediana do item descarta o frame
 * que errou (falso positivo isolado).
 */
export function itemFramings(dets: readonly FrameDetection[], keys: readonly string[]): ItemFaceResult[] {
  return keys.map((key) => {
    const mine = dets.filter((d) => d.key === key);
    const hits = mine.flatMap((d) => {
      if (!(d.w > 0 && d.h > 0)) return [];
      const f = pickFace(d.faces, d.h);
      return f ? [{ d, f }] : [];
    });
    if (!hits.length) return { key, found: 0, total: mine.length, framing: null, faceH: null };
    const faceX = median(hits.map(({ d, f }) => (f.x + f.w / 2) / d.w));
    const eyeY = median(hits.map(({ d, f }) => (f.y + f.h * EYE_IN_FACE) / d.h));
    const faceH = median(hits.map(({ d, f }) => f.h / d.h));
    return { key, found: hits.length, total: mine.length, framing: { faceX: r3(faceX), eyeY: r3(eyeY) }, faceH: r3(faceH) };
  });
}

/**
 * Aplica os framings medidos ao `blocks.json` cru (objeto parseado): só o
 * `framing` dos itens com rosto achado muda; item sem rosto fica como estava
 * (nunca apaga um framing medido à mão). Devolve quantos mudaram.
 */
export function applyItemFramings(raw: { blocks: Record<string, Array<Record<string, unknown>>> }, results: readonly ItemFaceResult[]): number {
  let changed = 0;
  for (const r of results) {
    if (!r.framing) continue;
    const [block, idx] = r.key.split("#");
    const it = raw.blocks[block]?.[Number(idx)];
    if (!it) continue;
    const prev = it.framing as { faceX?: number; eyeY?: number } | undefined;
    if (prev && prev.faceX === r.framing.faceX && prev.eyeY === r.framing.eyeY) continue;
    it.framing = { faceX: r.framing.faceX, eyeY: r.framing.eyeY };
    changed++;
  }
  return changed;
}

/** Instantes da folha de olhar (#12560): início, meio e fim de cada fala; na última, também logo depois (o respiro do fecho). */
export function gazeMarks(itemStart: number, itemEnd: number, isLast: boolean, fileEnd = Number.POSITIVE_INFINITY): Array<{ label: string; t: number }> {
  const marks = [
    { label: "início", t: itemStart + 0.12 },
    { label: "meio", t: (itemStart + itemEnd) / 2 },
    { label: "fim", t: Math.max(itemStart, itemEnd - 0.12) },
  ];
  if (isLast) marks.push({ label: "depois", t: Math.min(itemEnd + 0.3, fileEnd - 0.05) }, { label: "depois+1s", t: Math.min(itemEnd + 1, fileEnd - 0.05) });
  return marks.map((m) => ({ label: m.label, t: Math.max(0, Math.round(m.t * 1000) / 1000) }));
}
