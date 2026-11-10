/**
 * Card de CTA no fim do vídeo "diar.ia.br comentada" (#12571).
 *
 * Decisão do editor (09/11/2026, montagem da 261109): "a partir de agora, por
 * padrão, o CTA será o card." O modelo é o card do fim do corte
 * `modelos-chatgpt-261108`: fundo #111111, "Gostou?" em Georgia negrito com
 * fio teal (#00A0A0), três itens com ícone teal (Curta o vídeo / Compartilhe
 * com quem … / Siga a diar.ia.br), fade-in de ~0,5 s a partir do preto, ~4 s,
 * sem áudio. Até aqui o card entrava à mão no Premiere (um PNG feito por um
 * script avulso fora do repo, `_marca/mkcard.cjs`).
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

/** Quebra gulosa por palavra em linhas de até `maxChars` (palavra maior que o limite fica sozinha na linha). */
export function wrapCardText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

type IconKind = "like" | "share" | "follow";

/** Ícone teal num quadrado de lado `s` com canto em (x, y). */
function iconSvg(kind: IconKind, x: number, y: number, s: number, color: string): string {
  const r = (v: number) => Math.round(v * 100) / 100;
  if (kind === "like") {
    // Coração.
    const cx = x + s / 2;
    return (
      `<path d="M ${r(cx)} ${r(y + s * 0.9)} C ${r(x - s * 0.15)} ${r(y + s * 0.45)}, ${r(x + s * 0.15)} ${r(y + s * 0.02)}, ${r(cx)} ${r(y + s * 0.28)} ` +
      `C ${r(x + s * 0.85)} ${r(y + s * 0.02)}, ${r(x + s * 1.15)} ${r(y + s * 0.45)}, ${r(cx)} ${r(y + s * 0.9)} Z" fill="${color}"/>`
    );
  }
  if (kind === "share") {
    // Três nós ligados (o ícone de compartilhar).
    const a = { x: x + s * 0.78, y: y + s * 0.2 };
    const b = { x: x + s * 0.22, y: y + s * 0.5 };
    const c = { x: x + s * 0.78, y: y + s * 0.8 };
    const nr = s * 0.15;
    const sw = s * 0.08;
    return (
      `<line x1="${r(a.x)}" y1="${r(a.y)}" x2="${r(b.x)}" y2="${r(b.y)}" stroke="${color}" stroke-width="${r(sw)}"/>` +
      `<line x1="${r(c.x)}" y1="${r(c.y)}" x2="${r(b.x)}" y2="${r(b.y)}" stroke="${color}" stroke-width="${r(sw)}"/>` +
      [a, b, c].map((p) => `<circle cx="${r(p.x)}" cy="${r(p.y)}" r="${r(nr)}" fill="${color}"/>`).join("")
    );
  }
  // Seguir: "+" num círculo.
  const cx = x + s / 2;
  const cy = y + s / 2;
  const arm = s * 0.24;
  const sw = s * 0.11;
  return (
    `<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(s * 0.46)}" fill="none" stroke="${color}" stroke-width="${r(s * 0.08)}"/>` +
    `<line x1="${r(cx - arm)}" y1="${r(cy)}" x2="${r(cx + arm)}" y2="${r(cy)}" stroke="${color}" stroke-width="${r(sw)}" stroke-linecap="round"/>` +
    `<line x1="${r(cx)}" y1="${r(cy - arm)}" x2="${r(cx)}" y2="${r(cy + arm)}" stroke="${color}" stroke-width="${r(sw)}" stroke-linecap="round"/>`
  );
}

/** Geometria do card (exportada para teste): tamanhos relativos ao lado menor do quadro (1080 = 1). */
export interface CtaCardLayout {
  unit: number;
  titlePx: number;
  rowPx: number;
  iconPx: number;
  /** Máximo de caracteres por linha num item (largura útil / largura média de um caractere). */
  maxChars: number;
  rows: Array<{ kind: IconKind; lines: string[] }>;
}

export function ctaCardLayout(width: number, height: number, share: string): CtaCardLayout {
  const unit = Math.min(width, height) / 1080;
  const titlePx = 120 * unit;
  const rowPx = 58 * unit;
  const iconPx = 64 * unit;
  const gap = 36 * unit;
  // Largura útil: 84% do quadro (vertical) ou 72% (horizontal), menos o ícone; Georgia ~0,5 em por caractere.
  const usable = width * (height > width ? 0.84 : 0.72) - iconPx - gap;
  const maxChars = Math.max(12, Math.floor(usable / (rowPx * 0.5)));
  const rows: CtaCardLayout["rows"] = [
    { kind: "like", lines: wrapCardText(CTA_CARD.like, maxChars) },
    { kind: "share", lines: wrapCardText(share, maxChars) },
    { kind: "follow", lines: wrapCardText(CTA_CARD.follow, maxChars) },
  ];
  return { unit, titlePx, rowPx, iconPx, maxChars, rows };
}

/**
 * SVG do card no tamanho da sequência (#12571): fundo #111111, "Gostou?"
 * centrado em Georgia negrito com o fio teal embaixo, e os três itens
 * alinhados à esquerda num bloco centrado, ícone teal + texto branco. A fonte
 * tem fallback serif onde a Georgia não existe (o raster é por máquina).
 */
export function ctaCardSvg(input: { width: number; height: number; share?: string | null }): string {
  const { width, height } = input;
  const share = ctaShareLine(input.share);
  const L = ctaCardLayout(width, height, share);
  const lineH = L.rowPx * 1.25;
  const rowGap = 34 * L.unit;
  const titleGap = 90 * L.unit;
  const ruleW = 160 * L.unit;
  const ruleH = 8 * L.unit;
  const rowsH = L.rows.reduce((acc, row) => acc + row.lines.length * lineH, 0) + rowGap * (L.rows.length - 1);
  const blockH = L.titlePx + titleGap + rowsH;
  let y = (height - blockH) / 2;
  const titleBaseline = y + L.titlePx * 0.8;
  const ruleY = titleBaseline + 28 * L.unit;
  y += L.titlePx + titleGap;
  const longest = Math.max(...L.rows.flatMap((row) => row.lines.map((l) => l.length)));
  const textW = longest * L.rowPx * 0.5;
  const gap = 36 * L.unit;
  const left = Math.max(width * 0.06, (width - (L.iconPx + gap + textW)) / 2);
  const r = (v: number) => Math.round(v * 100) / 100;
  const parts: string[] = [];
  for (const row of L.rows) {
    const h = row.lines.length * lineH;
    parts.push(iconSvg(row.kind, left, y + (Math.min(h, lineH) - L.iconPx) / 2, L.iconPx, CTA_CARD.accent));
    row.lines.forEach((line, i) => {
      parts.push(`<text x="${r(left + L.iconPx + gap)}" y="${r(y + i * lineH + lineH * 0.5 + L.rowPx * 0.35)}">${escapeXml(line)}</text>`);
    });
    y += h + rowGap;
  }
  const fontFamily = `${CTA_CARD.font}, 'DejaVu Serif', serif`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${CTA_CARD.background}"/>\n` +
    `<text x="${r(width / 2)}" y="${r(titleBaseline)}" font-family="${fontFamily}" font-size="${Math.round(L.titlePx)}" font-weight="700" fill="${CTA_CARD.text}" text-anchor="middle">${escapeXml(CTA_CARD.title)}</text>\n` +
    `<rect x="${r((width - ruleW) / 2)}" y="${r(ruleY)}" width="${r(ruleW)}" height="${r(ruleH)}" fill="${CTA_CARD.accent}"/>\n` +
    `<g font-family="${fontFamily}" font-size="${Math.round(L.rowPx)}" fill="${CTA_CARD.text}">\n  ${parts.join("\n  ")}\n</g>\n</svg>\n`
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
