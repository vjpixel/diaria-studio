/**
 * scripts/lib/diaria/d1-video-hero.ts (#10784)
 *
 * Miolo PURO da "imagem do D1 vira link pro vídeo do YouTube" na newsletter.
 * Sem I/O, sem rede.
 *
 * Decisão do editor (22/10/2026, #10784):
 *   - só o D1: a imagem hero vira link pro vídeo do dia, com UTM
 *     `utm_source=newsletter&utm_medium=email&utm_campaign=video-d1-{AAMMDD}`;
 *   - o convite vai ESCRITO NA IMAGEM ("Clique e assista a notícia comentada" com o
 *     símbolo de play ao lado, no canto inferior direito), sem play no centro (decisão do editor, 22/10/2026,
 *     revisa a legenda-convite do #10784); com isso a legenda abaixo da imagem
 *     volta a ser o crédito padrão da ferramenta de imagem, como no D2 e no D3;
 *   - a imagem do link é uma CÓPIA do hero com o convite desenhado
 *     (`04-d1-2x1-play.jpg`, nome mantido), só para a newsletter — o hero
 *     original segue intacto para as redes;
 *   - vídeo ainda sem URL quando a newsletter é montada → a imagem aponta pro
 *     canal @diariabr. Nunca link quebrado, nunca imagem sem link.
 *
 * Fonte da URL do vídeo: `_internal/05-video-url.txt` (`D1_VIDEO_URL_FILE`,
 * #10772), gravado por `scripts/link-video-d1.ts --save` — o mesmo arquivo que
 * põe o link no post do D1 nas redes, já atrás do portão de vídeo público do
 * #10858. Este módulo não relê o registro do upload: quem grava o arquivo já
 * passou pelo portão.
 */

import { DIARIA_YOUTUBE_URL } from "../canonical-urls.ts";

/** Hero 2:1 do D1 (gerado no Stage 3, usado também pelas redes). */
export const D1_HERO_FILE = "04-d1-2x1.jpg";

/** Cópia do hero do D1 com o convite escrito — só a newsletter usa. */
export const D1_PLAY_HERO_FILE = "04-d1-2x1-play.jpg";

/** Carimbo do md5 do hero de origem da cópia com o convite (regera quando o hero muda). */
export const D1_PLAY_STAMP_FILE = "_internal/04-d1-play.json";

/** Chave do cache `06-public-images.json` da cópia com o convite. */
export const D1_PLAY_IMAGE_KEY = "d1_play";

/** Canal do YouTube — destino quando o vídeo do dia ainda não tem URL. */
export const D1_VIDEO_FALLBACK_URL = DIARIA_YOUTUBE_URL;

/**
 * Convite escrito na imagem (texto do editor, 22/10/2026). Um texto só para o
 * vídeo e para o fallback do canal: a cópia da imagem é gerada no upload, antes
 * de a URL do vídeo existir, então ela não pode depender de qual dos dois vale.
 */
export const D1_INVITE_LINES = ["Clique e assista", "a notícia comentada"] as const;
export const D1_INVITE_TEXT = D1_INVITE_LINES.join(" ");

/**
 * Versão do desenho do convite, carimbada junto do md5 do hero: mudar o desenho
 * (texto, faixa, posição) sem mudar o hero também regera a cópia. Subir a versão
 * a cada mudança em `buildInviteSvg`/`D1_INVITE_LINES`.
 */
export const D1_INVITE_VERSION = "invite-v3";

/** `alt` da imagem do D1 quando ela é link: a imagem é o único conteúdo do link e o convite está só nos pixels. */
export function d1HeroAlt(title: string): string {
  return `${title}. ${D1_INVITE_TEXT}.`;
}

export const D1_VIDEO_UTM_SOURCE = "newsletter";
export const D1_VIDEO_UTM_MEDIUM = "email";

/** `utm_campaign` do link da imagem do D1. */
export function d1VideoUtmCampaign(aammdd: string): string {
  return `video-d1-${aammdd}`;
}

export interface D1VideoLink {
  /** URL final do link da imagem (com UTM). */
  href: string;
  /** `video` = vídeo do dia; `channel` = fallback pro canal. */
  kind: "video" | "channel";
}

/**
 * Link da imagem do D1. `videoUrl` nulo (vídeo ainda sem URL) → canal. A UTM
 * entra nos dois casos — o clique na imagem é medido igual. `aammdd` fora do
 * formato lança: a campanha da UTM sairia errada em silêncio.
 */
export function buildD1VideoLink(videoUrl: string | null, aammdd: string): D1VideoLink {
  if (!/^\d{6}$/.test(aammdd)) {
    throw new Error(`buildD1VideoLink: edição inválida ${JSON.stringify(aammdd)} (esperado AAMMDD, #10784)`);
  }
  const kind: D1VideoLink["kind"] = videoUrl ? "video" : "channel";
  const u = new URL(videoUrl ?? D1_VIDEO_FALLBACK_URL);
  u.searchParams.set("utm_source", D1_VIDEO_UTM_SOURCE);
  u.searchParams.set("utm_medium", D1_VIDEO_UTM_MEDIUM);
  u.searchParams.set("utm_campaign", d1VideoUtmCampaign(aammdd));
  return { href: u.toString(), kind };
}

/** Edição (AAMMDD) a partir do diretório (`data/editions/2610/261022` ou `.../261022/`). */
export function editionFromDir(editionDir: string): string | null {
  const m = editionDir.replace(/[\\/]+$/, "").match(/(\d{6})$/);
  return m ? m[1] : null;
}

/**
 * Geometria do convite: faixa no CANTO INFERIOR DIREITO com o símbolo de play à
 * esquerda e o texto em duas linhas à direita dele. Separada do SVG para o
 * teste conferir que o texto cabe na faixa. A largura reservada ao texto tem
 * folga sobre Georgia e sobre a fonte de reserva do rasterizador (a medição
 * local deu +10%; DejaVu Serif no servidor Linux não foi medida).
 */
export function inviteGeometry(width: number, height: number) {
  if (!(width > 0 && height > 0)) throw new Error(`buildInviteSvg: dimensões inválidas ${width}x${height}`);
  const fontSize = width * 0.034;
  const margin = width * 0.03;
  const padX = fontSize * 0.9;
  const iconD = fontSize * 1.7;
  const gap = fontSize * 0.6;
  const textW = fontSize * 12.2;
  const w = padX * 2 + iconD + gap + textW;
  const h = fontSize * 3;
  const x = width - margin - w;
  const y = height - margin - h;
  return { fontSize, padX, iconD, gap, pill: { x, y, w, h } };
}

/**
 * SVG do convite, do tamanho da imagem, para compor sobre o hero: faixa na cor
 * de tinta do design system (#171411, 82% de opacidade) no canto inferior
 * direito, com círculo branco e triângulo de play à esquerda e o texto branco
 * em duas linhas. Fica fora do centro para não cobrir o assunto da arte.
 * `textLength` não é usado: o rasterizador (librsvg) o ignora.
 */
export function buildInviteSvg(width: number, height: number): string {
  const g = inviteGeometry(width, height);
  const f = (n: number) => n.toFixed(1);
  const { pill } = g;
  const cyMid = pill.y + pill.h / 2;
  const iconCx = pill.x + g.padX + g.iconD / 2;
  const r = g.iconD / 2;
  const tri = r * 0.8;
  const tx1 = iconCx - tri * 0.35;
  const tx2 = iconCx + tri * 0.65;
  const textX = pill.x + g.padX + g.iconD + g.gap;
  const lineGap = g.fontSize * 1.25;
  const y1 = cyMid - lineGap / 2 + g.fontSize * 0.35;
  const text = (y: number, line: string) =>
    `<text x="${f(textX)}" y="${f(y)}" font-family="Georgia, 'DejaVu Serif', serif" font-weight="bold" font-size="${f(g.fontSize)}" fill="#FFFFFF">${line}</text>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="${f(pill.x)}" y="${f(pill.y)}" width="${f(pill.w)}" height="${f(pill.h)}" rx="${f(pill.h * 0.28)}" fill="#171411" fill-opacity="0.82"/>` +
    `<circle cx="${f(iconCx)}" cy="${f(cyMid)}" r="${f(r)}" fill="#FFFFFF"/>` +
    `<polygon points="${f(tx1)},${f(cyMid - tri / 2)} ${f(tx2)},${f(cyMid)} ${f(tx1)},${f(cyMid + tri / 2)}" fill="#171411"/>` +
    text(y1, D1_INVITE_LINES[0]) +
    text(y1 + lineGap, D1_INVITE_LINES[1]) +
    `</svg>`
  );
}
