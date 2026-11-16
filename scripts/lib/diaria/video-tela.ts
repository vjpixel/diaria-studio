/**
 * Texto de tela no horizontal (#13204, pedido do editor de 15/11/2026, 261116:
 * "o horizontal precisa incluir os textos 'na tela' planejados no roteiro").
 *
 * Até aqui o texto de tela de cada fala (`tela` no `roteiro-falas.json`)
 * entrava no XML só como marcador da sequência (#13140), e a faixa de texto
 * era do editor no Premiere. Agora cada texto vira um PNG transparente do
 * tamanho da sequência, com o box (fundo escuro a 75%, fio teal à esquerda,
 * Georgia, a 1ª linha em negrito quando vem como `**…**`), numa faixa de vídeo
 * acima do bruto e do título, do começo ao fim da fala na sequência (o mesmo
 * intervalo do marcador). Só no horizontal (os verticais saem sem texto de
 * tela, #13186).
 *
 * O box fica no terço da direita, centrado na altura: o rosto do editor no
 * horizontal fica no centro do quadro (`faceX` ~0,5 a 60/85%).
 *
 * Puro: monta SVG, nome de arquivo, faixa do xmeml e argumentos do ffmpeg da
 * prévia. Quem rasteriza (sharp) e grava é o `build` de `video-montagem.ts`.
 */

/** Desenho do box, em px de um quadro de 1920 de largura (escala com a sequência). */
export const TELA_BOX = {
  refWidth: 1920,
  font: "Georgia",
  fontPx: 42,
  headPx: 42,
  lineHeightEm: 1.35,
  padX: 40,
  padY: 30,
  barPx: 8,
  /** Margem direita do quadro. */
  marginRight: 96,
  /** Largura máxima do box (fração do quadro). */
  maxWidthFrac: 0.36,
  /** Largura média de um caractere de Georgia, em em (estimativa para medir o box). */
  avgCharEm: 0.52,
  backgroundOpacity: 0.75,
  teal: "#00A0A0",
} as const;

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** As linhas do texto de tela: uma por `\n`; `**x**` na linha inteira = título do box (negrito). */
export function telaLines(tela: string): Array<{ text: string; head: boolean }> {
  return tela
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^\*\*([^*]+)\*\*$/u.exec(l);
      return m ? { text: m[1].trim(), head: true } : { text: l.replace(/\*\*/g, ""), head: false };
    });
}

/** Largura estimada de uma linha (px), pela largura média do caractere; o título em negrito é mais largo. */
export function telaLineWidth(l: { text: string; head: boolean }, fontPx: number): number {
  return l.text.length * fontPx * TELA_BOX.avgCharEm * (l.head ? 1.08 : 1);
}

/** Quebra nas palavras a linha que passa de `maxPx` (a continuação mantém o negrito do título). */
function wrapLines(lines: Array<{ text: string; head: boolean }>, fontPx: number, maxPx: number) {
  const out: Array<{ text: string; head: boolean }> = [];
  for (const l of lines) {
    let cur = "";
    for (const w of l.text.split(/\s+/)) {
      const next = cur ? `${cur} ${w}` : w;
      if (cur && telaLineWidth({ text: next, head: l.head }, fontPx) > maxPx) {
        out.push({ text: cur, head: l.head });
        cur = w;
      } else cur = next;
    }
    if (cur) out.push({ text: cur, head: l.head });
  }
  return out;
}

/** Geometria do box num quadro `width`x`height`. Linha mais larga que o box quebra nas palavras (#13204). */
export function telaBoxLayout(tela: string, width: number, height: number) {
  const k = width / TELA_BOX.refWidth;
  const fontPx = TELA_BOX.fontPx * k;
  const lineH = fontPx * TELA_BOX.lineHeightEm;
  const maxW = width * TELA_BOX.maxWidthFrac;
  const chrome = 2 * TELA_BOX.padX * k + TELA_BOX.barPx * k;
  const lines = wrapLines(telaLines(tela), fontPx, maxW - chrome);
  const textW = Math.max(...lines.map((l) => telaLineWidth(l, fontPx)), fontPx * 6);
  const w = Math.min(maxW, textW + chrome);
  const h = lines.length * lineH + 2 * TELA_BOX.padY * k;
  const x = width - TELA_BOX.marginRight * k - w;
  const y = (height - h) / 2;
  return { lines, fontPx, lineH, box: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, k };
}

/** SVG do box de tela, transparente fora dele. */
export function telaBoxSvg(tela: string, width: number, height: number): string {
  const { lines, fontPx, lineH, box, k } = telaBoxLayout(tela, width, height);
  const bar = Math.round(TELA_BOX.barPx * k);
  const tx = box.x + bar + Math.round(TELA_BOX.padX * k);
  const first = box.y + Math.round(TELA_BOX.padY * k) + fontPx * 0.95;
  const texts = lines
    .map((l, i) => `<text x="${tx}" y="${Math.round(first + i * lineH)}"${l.head ? ' font-weight="700"' : ""}>${escapeXml(l.text)}</text>`)
    .join("\n  ");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
    `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#000000" fill-opacity="${TELA_BOX.backgroundOpacity}"/>\n` +
    `<rect x="${box.x}" y="${box.y}" width="${bar}" height="${box.h}" fill="${TELA_BOX.teal}"/>\n` +
    `<g font-family="${TELA_BOX.font}, 'DejaVu Serif', serif" font-size="${Math.round(fontPx)}" fill="#FFFFFF">\n  ${texts}\n</g>\n</svg>\n`
  );
}

/** Nome do PNG na pasta da edição: id da fala + hash do conteúdo (um XML antigo segue achando o dele). */
export function telaFileName(edition: string, id: string, hash: string): string {
  return `${edition}_tela_${id.replace(/[^A-Za-z0-9-]/g, "")}-${hash}.png`;
}

/** Um texto de tela já rasterizado, no tempo da sequência (quadros). */
export interface TelaOverlay {
  id: string;
  tela: string;
  /** PNG local (prévia). */
  path: string;
  /** Caminho no XML (a pasta da edição, traduzida para o Premiere no `url()`). */
  xmlPath: string;
  width: number;
  height: number;
  in: number;
  out: number;
}

/**
 * #13239 item 1: os boxes de tela ficam numa faixa só, e dois clipes não se
 * sobrepõem nela. O marcador de uma fala vai do 1º ao último item dela
 * (`telaMarkersFor`), então itens não contíguos, ou uma fala curta que casa
 * com duas linhas, invadem o box seguinte (e a prévia empilha dois boxes).
 * Na ordem de entrada, o `out` de cada um para no `in` do seguinte; o que
 * fica sem duração sai, com aviso.
 */
export function clampTelaOverlaps<T extends { id: string; in: number; out: number }>(xs: readonly T[]): { items: T[]; warnings: string[] } {
  const sorted = [...xs].sort((a, b) => a.in - b.in || a.out - b.out);
  const items: T[] = [];
  const warnings: string[] = [];
  sorted.forEach((x, i) => {
    const next = sorted[i + 1];
    if (!next || x.out <= next.in) {
      items.push(x);
      return;
    }
    const out = next.in;
    if (out <= x.in) {
      warnings.push(`box de tela ${x.id} começa junto com ${next.id} na mesma faixa: fica só o de ${next.id} (#13239)`);
      return;
    }
    warnings.push(`box de tela ${x.id} invadia ${next.id} (quadros ${next.in}–${x.out}): termina no quadro ${out}, onde ${next.id} começa (#13239)`);
    items.push({ ...x, out });
  });
  return { items, warnings };
}

/**
 * A faixa do xmeml com os boxes de tela (um clipe por texto). `fileIdOf` dá o
 * id do `<file>` e diz se já foi definido no documento. A `<duration>` do
 * `<file>` é a do clipe mais longo que usa o mesmo PNG nesta faixa (#13239
 * item 6): a do 1º clipe deixava o 2º, mais longo, passar do fim da mídia.
 */
export function telaTrack(input: {
  overlays: readonly TelaOverlay[];
  rate: string;
  idPrefix: string;
  fileIdOf: (xmlPath: string) => { id: string; defined: boolean };
  url: (p: string) => string;
}): string {
  const valid = input.overlays.filter((o) => o.out > o.in);
  const fileLen = new Map<string, number>();
  for (const o of valid) fileLen.set(o.xmlPath, Math.max(fileLen.get(o.xmlPath) ?? 0, o.out - o.in));
  const clips = valid
    .map((o, i) => {
      const len = o.out - o.in;
      const { id: fileId, defined } = input.fileIdOf(o.xmlPath);
      const name = o.xmlPath.replace(/\\/g, "/").split("/").pop() ?? o.xmlPath;
      const file = defined
        ? `<file id="${fileId}"/>`
        : `<file id="${fileId}"><name>${escapeXml(name)}</name><pathurl>${escapeXml(input.url(o.xmlPath))}</pathurl>\n${input.rate}<duration>${fileLen.get(o.xmlPath) ?? len}</duration>\n` +
          `<media><video><samplecharacteristics><width>${o.width}</width><height>${o.height}</height></samplecharacteristics></video></media></file>`;
      return (
        `<clipitem id="${input.idPrefix}-${i + 1}"><name>tela ${escapeXml(o.id)}</name><enabled>TRUE</enabled><duration>${len}</duration>\n` +
        `${input.rate}<start>${o.in}</start><end>${o.out}</end><in>0</in><out>${len}</out>\n${file}</clipitem>`
      );
    });
  return clips.length ? `\n<track>${clips.join("\n")}</track>` : "";
}

/**
 * ffmpeg da prévia: cada box por cima do trecho dele (quadros da sequência),
 * escalado para o tamanho da prévia, com o áudio copiado.
 */
export function previewTelaArgs(input: { input: string; out: string; width: number; height: number; overlays: ReadonlyArray<{ png: string; in: number; out: number }> }): string[] {
  const ins = input.overlays.flatMap((o) => ["-i", o.png]);
  const parts: string[] = [];
  let last = "0:v";
  input.overlays.forEach((o, i) => {
    parts.push(`[${i + 1}:v]scale=${input.width}:${input.height},format=rgba[t${i}]`);
    const next = i === input.overlays.length - 1 ? "v" : `v${i}`;
    parts.push(`[${last}][t${i}]overlay=0:0:enable='between(n,${o.in},${o.out - 1})'[${next}]`);
    last = next;
  });
  return [
    "-y", "-v", "error",
    "-i", input.input,
    ...ins,
    "-filter_complex", parts.join(";"),
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy",
    input.out,
  ];
}
