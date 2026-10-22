/**
 * scripts/lib/diaria/d1-video-hero.ts (#10784)
 *
 * Miolo PURO da "imagem do D1 vira link pro vídeo do YouTube" na newsletter.
 * Sem I/O, sem rede.
 *
 * Decisão do editor (22/10/2026, #10784):
 *   - só o D1: a imagem hero vira link pro vídeo do dia, com UTM
 *     `utm_source=newsletter&utm_medium=email&utm_campaign=video-d1-{AAMMDD}`;
 *   - a legenda do D1 passa a ser SÓ o convite ("Clique na imagem para
 *     assistir ao vídeo no YouTube"); o crédito da ferramenta de imagem fica no
 *     rodapé (#10783). D2 e D3 seguem com o crédito na legenda;
 *   - a imagem do link é uma CÓPIA do hero com um ícone de play desenhado
 *     (`04-d1-2x1-play.jpg`), só para a newsletter — o hero original segue
 *     intacto para as redes;
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

/** Cópia do hero do D1 com o ícone de play — só a newsletter usa. */
export const D1_PLAY_HERO_FILE = "04-d1-2x1-play.jpg";

/** Carimbo do md5 do hero de origem da cópia com play (regera quando o hero muda). */
export const D1_PLAY_STAMP_FILE = "_internal/04-d1-play.json";

/** Chave do cache `06-public-images.json` da cópia com play. */
export const D1_PLAY_IMAGE_KEY = "d1_play";

/** Canal do YouTube — destino quando o vídeo do dia ainda não tem URL. */
export const D1_VIDEO_FALLBACK_URL = DIARIA_YOUTUBE_URL;

/** Legenda quando a imagem leva ao vídeo do dia (texto do editor, #10784). */
export const D1_VIDEO_CAPTION = "Clique na imagem para assistir ao vídeo no YouTube";

/**
 * Legenda quando a imagem leva ao canal. A issue pede "legenda equivalente"
 * sem fixar o texto; premissa: a sugestão registrada na própria issue.
 */
export const D1_CHANNEL_CAPTION = "Clique na imagem para ver os vídeos no YouTube";

export const D1_VIDEO_UTM_SOURCE = "newsletter";
export const D1_VIDEO_UTM_MEDIUM = "email";

/** `utm_campaign` do link da imagem do D1. */
export function d1VideoUtmCampaign(aammdd: string): string {
  return `video-d1-${aammdd}`;
}

export interface D1VideoLink {
  /** URL final do link da imagem (com UTM). */
  href: string;
  /** Legenda abaixo da imagem. */
  caption: string;
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
  return { href: u.toString(), caption: kind === "video" ? D1_VIDEO_CAPTION : D1_CHANNEL_CAPTION, kind };
}

/** Edição (AAMMDD) a partir do diretório (`data/editions/2610/261022` ou `.../261022/`). */
export function editionFromDir(editionDir: string): string | null {
  const m = editionDir.replace(/[\\/]+$/, "").match(/(\d{6})$/);
  return m ? m[1] : null;
}

/**
 * SVG do ícone de play, do tamanho da imagem, para compor sobre o hero.
 * Premissa (sugestão registrada no #10784): círculo branco a 90% de opacidade,
 * diâmetro de 18% da largura, centralizado, com triângulo `#171411` (tinta do
 * design system). O triângulo é deslocado para a direita para ficar
 * opticamente centrado no círculo.
 */
export function buildPlayIconSvg(width: number, height: number): string {
  if (!(width > 0 && height > 0)) throw new Error(`buildPlayIconSvg: dimensões inválidas ${width}x${height}`);
  const cx = width / 2;
  const cy = height / 2;
  const r = (width * 0.18) / 2;
  const tri = r * 0.75; // altura do triângulo (lado vertical)
  const x1 = cx - tri * 0.35;
  const x2 = cx + tri * 0.65;
  const f = (n: number) => n.toFixed(1);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="#FFFFFF" fill-opacity="0.9"/>` +
    `<polygon points="${f(x1)},${f(cy - tri / 2)} ${f(x2)},${f(cy)} ${f(x1)},${f(cy + tri / 2)}" fill="#171411"/>` +
    `</svg>`
  );
}
