/**
 * Card de CTA no fim do vídeo "diar.ia.br comentada" (#12571).
 *
 * Decisão do editor (09/11/2026, montagem da 261109): "a partir de agora, por
 * padrão, o CTA será o card." O modelo é o card do fim do corte
 * `modelos-chatgpt-261108`: fundo #111111, "Gostou?" em Georgia negrito com
 * fio teal (#00A0A0), três itens com ícone teal (Curta o vídeo / Compartilhe
 * com quem … / Siga a diar.ia.br), fade-in de ~0,5 s a partir do preto, ~4 s,
 * sem áudio.
 *
 * Desenho (#12701): o card aprovado é o PNG de `YouTube/_marca/`
 * (`cta-card-vertical.png`, `cta-card-horizontal.png`), feito pelo script
 * avulso `_marca/mkcard.cjs`. A 1ª versão deste módulo desenhava outro card
 * (Georgia 58 px, ícone de "share" de 3 nós, bloco compacto); agora as medidas
 * são as do `mkcard.cjs`, num quadro de desenho 1080x1920: "Gostou?" 124 px
 * negrito com baseline em 560, fio 200x10 em (440, 610), itens em Georgia
 * 66 px com o texto em x = 300 e os ícones centrados em x = 200 (coração,
 * seta de envio, "+" no círculo), baselines 822 / 1030 (+80 por linha a mais
 * do compartilhar) / 1322. O horizontal é o mesmo desenho (y 430..1360)
 * escalado a 0,85 e centrado, como no `mkcard.cjs`. A linha de compartilhar
 * vira "Compartilhe com" + o complemento, quebrado pela largura estimada da
 * Georgia (tabela de avanços abaixo).
 *
 * Este módulo é puro (só monta texto: SVG, argumentos de ffmpeg, o clipitem do
 * xmeml). Quem renderiza (sharp + ffmpeg) é o `build` de `video-montagem.ts`,
 * que grava um MP4 por formato com o fade já embutido: o fade vai no arquivo,
 * não num efeito do FCP7, para não depender de o Premiere traduzir a
 * transição no import.
 */

/** Estilo e tempos do card (#12571). */
export const CTA_CARD = {
  /** Duração do card na sequência, em segundos. */
  durationS: 4,
  /** Fade-in a partir do preto, em segundos (embutido no MP4). */
  fadeInS: 0.5,
  background: "#111111",
  accent: "#00A0A0",
  text: "#FFFFFF",
  font: "Georgia",
  title: "Gostou?",
  like: "Curta o vídeo",
  follow: "Siga a diar.ia.br",
} as const;

/**
 * Medidas do card aprovado (#12701), no quadro de desenho 1080x1920 do
 * `YouTube/_marca/mkcard.cjs`. Tudo em px desse quadro.
 */
export const CTA_CARD_DESIGN = {
  width: 1080,
  height: 1920,
  titlePx: 124,
  titleBaseline: 560,
  rule: { x: 440, y: 610, w: 200, h: 10 },
  itemPx: 66,
  /** x do início do texto dos itens. */
  textX: 300,
  /** x do centro dos ícones. */
  iconCx: 200,
  /** Distância entre as linhas do item de compartilhar. */
  lineStep: 80,
  like: { iconCy: 800, baseline: 822 },
  /** Com 2 linhas; cada linha a mais desce o ícone 40 e o item seguinte 80. */
  share: { iconCy: 1010, baseline: 1030 },
  follow: { iconCy: 1300, baseline: 1322 },
  /** Âncora do encolhimento do bloco de itens (borda esquerda dos ícones, centro vertical). */
  itemsAnchor: { x: 155, y: 1060 },
  /**
   * Borda direita máxima do texto dos itens. Premissa (#12701): o PNG aprovado
   * do `_marca/` tem "quem se interessa por IA" chegando a x ≈ 1022, sem
   * encolher; o limite fica um pouco além disso (40 px de margem no quadro).
   */
  textRight: 1040,
  /** Horizontal: o trecho y 430..1360 do desenho, escalado a 0,85 num quadro 1920x1080. */
  horizontal: { scale: 0.85, top: 430, span: 930, refWidth: 1920, refHeight: 1080 },
} as const;

/** Linha de compartilhar quando o `blocks.json` não traz `ctaShare` (a da 261109, genérica). */
export const CTA_CARD_DEFAULT_SHARE = "Compartilhe com quem se interessa por IA";

/**
 * A linha de compartilhar do card. `ctaShare` do `blocks.json` (ou da
 * sequência) pode vir inteira ("Compartilhe com quem usa o ChatGPT") ou só o
 * complemento ("quem usa o ChatGPT"), que ganha o "Compartilhe com " na
 * frente. Vazio ou ausente = o default genérico.
 */
export function ctaShareLine(raw?: string | null): string {
  const t = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!t) return CTA_CARD_DEFAULT_SHARE;
  return /^compartilhe\b/i.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : `Compartilhe com ${t}`;
}

export type CtaCardOrientation = "vertical" | "horizontal";

export function ctaCardOrientation(width: number, height: number): CtaCardOrientation {
  return height > width ? "vertical" : "horizontal";
}

/** Quadros do card numa sequência de `fps`. */
export function ctaCardFrames(fps: number, durationS: number = CTA_CARD.durationS): number {
  return Math.max(1, Math.round(durationS * fps));
}

/**
 * Avanço de cada caractere da Georgia regular, em milésimos do corpo (medido
 * em 10/11/2026 renderizando a georgia.ttf pelo sharp/librsvg, #12701).
 * Acento sai pela letra base; caractere fora da tabela conta 560.
 */
const GEORGIA_ADVANCE: Readonly<Record<string, number>> = {
  " ": 242, a: 504, b: 560, c: 455, d: 575, e: 483, f: 325, g: 509, h: 582, i: 293, j: 292, k: 536, l: 287, m: 881,
  n: 591, o: 539, p: 571, q: 560, r: 410, s: 433, t: 346, u: 576, v: 497, w: 737, x: 505, y: 493, z: 444,
  A: 671, B: 654, C: 643, D: 749, E: 653, F: 600, G: 725, H: 815, I: 390, J: 518, K: 694, L: 604, M: 927, N: 768,
  O: 745, P: 610, Q: 745, R: 702, S: 561, T: 619, U: 756, V: 667, W: 975, X: 711, Y: 615, Z: 602,
  "0": 614, "1": 430, "2": 559, "3": 552, "4": 565, "5": 528, "6": 566, "7": 502, "8": 597, "9": 566,
  ".": 270, ",": 270, ":": 313, ";": 313, "!": 331, "?": 479, "-": 374, "'": 215, '"': 412, "(": 375, ")": 375,
  "/": 469, "&": 711, "@": 929, "#": 643, "%": 817, "+": 643, "*": 473,
};

/** Largura estimada de `text` em Georgia regular de `px` (soma dos avanços). */
export function georgiaTextWidth(text: string, px: number): number {
  let w = 0;
  for (const ch of text.normalize("NFD").replace(/[̀-ͯ]/g, "")) w += GEORGIA_ADVANCE[ch] ?? 560;
  return (w * px) / 1000;
}

/** Quebra gulosa por palavra em linhas de até `maxWidth` px em Georgia de `px` (palavra maior que o limite fica sozinha na linha). */
export function wrapCardTextByWidth(text: string, px: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if (georgiaTextWidth(`${cur} ${w}`, px) <= maxWidth) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * As linhas do item de compartilhar: "Compartilhe com" sozinho na 1ª linha
 * (como no card aprovado) e o complemento quebrado pela largura que sobra até
 * `CTA_CARD_DESIGN.textRight`. Frase que não começa com "Compartilhe com"
 * quebra inteira.
 */
export function ctaCardShareLines(share: string): string[] {
  const D = CTA_CARD_DESIGN;
  const maxW = D.textRight - D.textX;
  const m = /^(compartilhe com)\s+(\S.*)$/i.exec(share.trim());
  if (!m) return wrapCardTextByWidth(share, D.itemPx, maxW);
  return [m[1], ...wrapCardTextByWidth(m[2], D.itemPx, maxW)];
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Ícones do card aprovado (#12701), desenhados em torno de (0, 0), ~90 px. */
export const CTA_CARD_ICONS = {
  /** Coração. */
  like: (c: string) => `<path d="M0,-28 C-10,-48 -42,-46 -42,-18 C-42,4 -18,22 0,40 C18,22 42,4 42,-18 C42,-46 10,-48 0,-28 Z" fill="${c}"/>`,
  /** Seta de envio (avião de papel), não o "share" de 3 nós. */
  share: (c: string) => `<path d="M-42,-38 L46,0 L-42,38 L-26,0 Z" fill="${c}"/>`,
  /** "+" num círculo. */
  follow: (c: string) =>
    `<circle r="45" fill="none" stroke="${c}" stroke-width="9"/><rect x="-25" y="-5" width="50" height="10" fill="${c}"/><rect x="-5" y="-25" width="10" height="50" fill="${c}"/>`,
} as const;

/** Geometria do card (exportada para teste). */
export interface CtaCardLayout {
  /** Escala do quadro de desenho 1080x1920 para o quadro da sequência. */
  scale: number;
  /** Translação do desenho no quadro (px do quadro). */
  tx: number;
  ty: number;
  /** Encolhimento do bloco de itens (1 = sem encolher), só quando uma palavra não cabe mesmo quebrando. */
  itemScale: number;
  /** Linhas do item de compartilhar. */
  shareLines: string[];
  /** Borda direita estimada do texto dos itens no desenho, antes do encolhimento. */
  itemsRight: number;
}

export function ctaCardLayout(width: number, height: number, share: string): CtaCardLayout {
  const D = CTA_CARD_DESIGN;
  const shareLines = ctaCardShareLines(share);
  const texts = [CTA_CARD.like, ...shareLines, CTA_CARD.follow];
  const itemsRight = D.textX + Math.max(...texts.map((t) => georgiaTextWidth(t, D.itemPx)));
  const itemScale = Math.min(1, (D.textRight - D.itemsAnchor.x) / (itemsRight - D.itemsAnchor.x));
  let scale: number;
  let tx: number;
  let ty: number;
  if (ctaCardOrientation(width, height) === "vertical") {
    scale = Math.min(width / D.width, height / D.height);
    tx = (width - D.width * scale) / 2;
    ty = (height - D.height * scale) / 2;
  } else {
    // O trecho centrado cresce com as linhas a mais do compartilhar (o item de seguir desce junto).
    const H = D.horizontal;
    const span = H.span + (shareLines.length - 2) * D.lineStep;
    scale = H.scale * Math.min(width / H.refWidth, height / H.refHeight);
    tx = (width - D.width * scale) / 2;
    ty = (height - span * scale) / 2 - H.top * scale;
  }
  return { scale, tx, ty, itemScale, shareLines, itemsRight };
}

/**
 * SVG do card no tamanho da sequência (#12571, desenho #12701): o card
 * aprovado do `_marca/` (fundo #111111, "Gostou?" centrado em Georgia
 * negrito com o fio teal embaixo, e os três itens com ícone teal + texto
 * branco a partir de x = 300). A fonte tem fallback serif onde a Georgia não
 * existe (o raster é por máquina).
 */
export function ctaCardSvg(input: { width: number; height: number; share?: string | null }): string {
  const { width, height } = input;
  const D = CTA_CARD_DESIGN;
  const L = ctaCardLayout(width, height, ctaShareLine(input.share));
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const fontFamily = `${CTA_CARD.font}, 'DejaVu Serif', serif`;
  const accent = CTA_CARD.accent;
  const extra = (L.shareLines.length - 2) * D.lineStep;
  const text = (y: number, s: string) => `<text x="${D.textX}" y="${r(y)}">${escapeXml(s)}</text>`;
  const icon = (cy: number, svg: string) => `<g transform="translate(${D.iconCx},${r(cy)})">${svg}</g>`;
  const items = [
    icon(D.like.iconCy, CTA_CARD_ICONS.like(accent)),
    text(D.like.baseline, CTA_CARD.like),
    icon(D.share.iconCy + extra / 2, CTA_CARD_ICONS.share(accent)),
    ...L.shareLines.map((l, i) => text(D.share.baseline + i * D.lineStep, l)),
    icon(D.follow.iconCy + extra, CTA_CARD_ICONS.follow(accent)),
    text(D.follow.baseline + extra, CTA_CARD.follow),
  ];
  const A = D.itemsAnchor;
  const itemsTransform = L.itemScale < 1 ? ` transform="translate(${A.x},${A.y}) scale(${r(L.itemScale)}) translate(${-A.x},${-A.y})"` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${CTA_CARD.background}"/>\n` +
    `<g transform="translate(${r(L.tx)},${r(L.ty)}) scale(${r(L.scale)})">\n` +
    `<text x="${D.width / 2}" y="${D.titleBaseline}" font-family="${fontFamily}" font-size="${D.titlePx}" font-weight="700" fill="${CTA_CARD.text}" text-anchor="middle">${escapeXml(CTA_CARD.title)}</text>\n` +
    `<rect x="${D.rule.x}" y="${D.rule.y}" width="${D.rule.w}" height="${D.rule.h}" fill="${accent}"/>\n` +
    `<g font-family="${fontFamily}" font-size="${D.itemPx}" fill="${CTA_CARD.text}"${itemsTransform}>\n  ${items.join("\n  ")}\n</g>\n</g>\n</svg>\n`
  );
}

/** Nome do MP4 do card na pasta da edição; `hash` identifica o conteúdo (um XML antigo segue achando o card dele). */
export function ctaCardFileName(edition: string, orientation: CtaCardOrientation, hash: string): string {
  return `${edition}_cta_card_${orientation}-${hash}.mp4`;
}

/** ffmpeg: o PNG do card em MP4 de `durationS`, fade-in do preto embutido, sem áudio, no fps da sequência. */
export function ctaCardRenderArgs(input: { png: string; out: string; fps: number; durationS?: number; fadeInS?: number }): string[] {
  const d = input.durationS ?? CTA_CARD.durationS;
  const fade = input.fadeInS ?? CTA_CARD.fadeInS;
  return [
    "-y", "-v", "error",
    "-loop", "1", "-framerate", String(input.fps), "-i", input.png,
    "-t", d.toFixed(3),
    "-vf", `fade=t=in:st=0:d=${fade},format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", String(input.fps),
    "-an", input.out,
  ];
}

/**
 * ffmpeg: o clipe do card na prévia (#12571), no tamanho e no fps da prévia e
 * com uma faixa de áudio em silêncio no mesmo formato dos outros clipes (AAC
 * 48 kHz estéreo), para entrar no `concat -c copy` da prévia. `pixFmt` = o
 * formato de pixel dos clipes do bruto (bruto de 10 bits sai em yuv420p10le, e
 * o concat sem recodificar exige o mesmo nos dois); ausente = o do MP4 do card.
 */
export function ctaCardPreviewClipArgs(input: { src: string; out: string; fps: number; width: number; height: number; durationS?: number; pixFmt?: string }): string[] {
  const d = (input.durationS ?? CTA_CARD.durationS).toFixed(3);
  return [
    "-y", "-v", "error",
    "-i", input.src,
    "-f", "lavfi", "-t", d, "-i", "anullsrc=r=48000:cl=stereo",
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", `scale=${input.width}:${input.height},setsar=1,fps=${input.fps}${input.pixFmt && /^[a-z0-9_]+$/.test(input.pixFmt) ? `,format=${input.pixFmt}` : ""}`,
    "-t", d,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-ar", "48000", "-ac", "2",
    input.out,
  ];
}

/** O card que o XML de uma sequência leva (gravado no `plan.json`, em `xmlAssets`). */
export interface CtaCardAsset {
  /** MP4 no out dir desta máquina (o que a prévia lê). */
  path: string;
  /** O mesmo MP4 no caminho que o Premiere abre (a pasta da edição, ao lado do bruto). */
  xmlPath: string;
  width: number;
  height: number;
  fps: number;
  /** Quadros do card na sequência. */
  frames: number;
  /** A linha de compartilhar usada. */
  share: string;
}

/**
 * O clipitem do card no fim da faixa V1 (#12571): começa no último quadro da
 * montagem (`startFrame` = `durationFrames` do plano) e dura `asset.frames`.
 * Sem áudio (nenhum clipitem de áudio): o `verify-xml` segue conferindo a
 * fala só nos clipes do bruto. `fileDefined` = o `<file>` deste MP4 já saiu
 * antes no documento (referência curta). `pathurl` vem pronto do `pathUrl` do
 * xmeml (o mesmo formato do bruto).
 */
export function ctaCardClipItem(input: { asset: CtaCardAsset; startFrame: number; rate: string; id: string; fileId: string; fileDefined: boolean; pathurl: string }): string {
  const { asset, startFrame, rate, id, fileId } = input;
  const len = asset.frames;
  const name = asset.xmlPath.replace(/\\/g, "/").split("/").pop() ?? asset.xmlPath;
  const file = input.fileDefined
    ? `<file id="${fileId}"/>`
    : `<file id="${fileId}"><name>${escapeXml(name)}</name><pathurl>${escapeXml(input.pathurl)}</pathurl>\n${rate}<duration>${len}</duration>\n` +
      `<media><video><samplecharacteristics><width>${asset.width}</width><height>${asset.height}</height></samplecharacteristics></video></media></file>`;
  return (
    `<clipitem id="${id}"><name>cta-card</name><enabled>TRUE</enabled><duration>${len}</duration>\n` +
    `${rate}<start>${startFrame}</start><end>${startFrame + len}</end><in>0</in><out>${len}</out>\n${file}</clipitem>`
  );
}

/** Lê do XML o card no fim da V1 (`<clipitem id="cta-card-…">`): início e fim em quadros; ausente = null. */
export function parseCtaCardClip(xml: string): { start: number; end: number } | null {
  const m = /<clipitem id="cta-card-[^"]*">[\s\S]*?<start>(\d+)<\/start><end>(\d+)<\/end>/.exec(xml);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

/** A `<duration>` da 1ª `<sequence>` do XML; ausente = null. */
export function parseSequenceDuration(xml: string): number | null {
  const m = /<sequence id="[^"]*"><name>[\s\S]*?<\/name><duration>(\d+)<\/duration>/.exec(xml);
  return m ? Number(m[1]) : null;
}

/**
 * `verify-xml` com o card (#12571): o card precisa estar logo depois da fala
 * (início = fim da montagem no plano), com a duração do plano, e a sequência
 * precisa durar a montagem + o card. Sem card esperado (build sem card, ou
 * anterior ao #12571), um card no XML também é problema: o XML não é o do
 * plano. Puro.
 */
export function ctaCardXmlIssues(xml: string, plan: { durationFrames: number; cardFrames: number | null }): string[] {
  const card = parseCtaCardClip(xml);
  const seqDur = parseSequenceDuration(xml);
  const out: string[] = [];
  if (plan.cardFrames === null) {
    if (card) out.push("card de CTA no XML, mas o plano não tem card (XML de outro build?)");
    return out;
  }
  if (!card) {
    out.push("card de CTA ausente no XML (o plano tem card): rode build de novo");
    return out;
  }
  if (Math.abs(card.start - plan.durationFrames) > 1) out.push(`card de CTA começa no quadro ${card.start}, a montagem termina no ${plan.durationFrames}`);
  if (Math.abs(card.end - card.start - plan.cardFrames) > 1) out.push(`card de CTA com ${card.end - card.start} quadros no XML, ${plan.cardFrames} no plano`);
  const total = plan.durationFrames + plan.cardFrames;
  if (seqDur !== null && Math.abs(seqDur - total) > 1) out.push(`sequência com <duration> ${seqDur} quadros, montagem + card = ${total}`);
  return out;
}
