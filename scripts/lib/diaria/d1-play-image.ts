/**
 * scripts/lib/diaria/d1-play-image.ts (#10784)
 *
 * Gera `04-d1-2x1-play.jpg`: cópia do hero do D1 com o convite escrito
 * (`buildInviteSvg`: "Clique para assistir meus comentários" com o símbolo de
 * play ao lado, no canto inferior direito, sem play no centro), só para a
 * newsletter. O hero original
 * (`04-d1-2x1.jpg`) nunca é tocado — as redes seguem usando ele.
 *
 * Artefato derivado: regera quando o hero muda (md5 carimbado em
 * `_internal/04-d1-play.json`), então troca de imagem no Stage 4 não deixa a
 * newsletter com a arte velha. Chamado por `upload-images-public.ts` (modo
 * newsletter/all), antes do upload — é o passo que precede o render do HTML no
 * Stage 4.
 *
 * Fail-soft: falha ao gerar remove a cópia antiga (arte possivelmente
 * defasada) e devolve o motivo — o render cai no hero original SEM link pro
 * vídeo/canal (`d1VideoHeroFields` devolve `{}` quando a cópia não existe:
 * imagem pura levando ao YouTube, sem o convite, seria link escondido).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { md5OfFile } from "../shared/file-md5.ts";
import { D1_HERO_FILE, D1_INVITE_VERSION, D1_PLAY_HERO_FILE, D1_PLAY_STAMP_FILE, D1_INVITE_FONT_FAMILY, D1_INVITE_LINES, buildInviteSvg, inviteFontSize, type InviteTextMetrics } from "./d1-video-hero.ts";

export type D1PlayImageResult =
  | { status: "generated" | "fresh"; path: string }
  | { status: "no_hero"; path: null }
  | { status: "failed"; path: null; reason: string };

function readStamp(stampPath: string): { md5: string | null; overlay: string | null } {
  if (!existsSync(stampPath)) return { md5: null, overlay: null };
  try {
    const raw = JSON.parse(readFileSync(stampPath, "utf8")) as { source_md5?: unknown; overlay?: unknown };
    return {
      md5: typeof raw.source_md5 === "string" ? raw.source_md5 : null,
      overlay: typeof raw.overlay === "string" ? raw.overlay : null,
    };
  } catch {
    return { md5: null, overlay: null }; // carimbo ilegível = regerar
  }
}

/**
 * Mede o texto do convite na fonte que o rasterizador (librsvg) realmente usar:
 * desenha o texto sozinho numa tela maior e corta (`trim`) o espaço vazio. Mede
 * com o mesmo motor que vai desenhar, então vale para Georgia no Windows e para
 * a fonte de reserva do servidor Linux.
 *
 * Mede cada linha do convite (#12747, duas linhas) e devolve a largura da mais
 * larga, o quanto a 1ª sobe da linha de base e o quanto a última desce.
 *
 * As linhas são medidas uma de cada vez, e toda medição do processo passa pela
 * mesma fila (`serializeTextRender`, #12833): nunca há dois rasters de texto do
 * librsvg (pango + fontconfig) rodando ao mesmo tempo em threads do libuv.
 */
export async function measureInviteText(width: number, fontFamily: string = D1_INVITE_FONT_FAMILY): Promise<InviteTextMetrics> {
  const fontSize = inviteFontSize(width);
  const lines: Array<{ width: number; ascent: number; descent: number }> = [];
  for (const line of D1_INVITE_LINES) lines.push(await serializeTextRender(() => measureLine(line, fontSize, fontFamily)));
  return {
    textW: Math.max(...lines.map((l) => l.width)),
    ascent: lines[0].ascent,
    descent: lines[lines.length - 1].descent,
  };
}

let textRenderTail: Promise<unknown> = Promise.resolve();

/**
 * Fila de um lugar só para o raster de texto do librsvg no processo (#12833).
 *
 * No CI (run 42945012091, PR #12795) o processo do
 * `test/d1-invite-mobile-size-12747.test.ts` morreu calado no meio do 1º teste
 * que mede texto: os dois testes síncronos passaram, os seguintes nunca
 * reportaram, e o node:test só disse `'test failed'` em 1:1, sem erro de JS nem
 * stack nativo, que é exatamente o que ele imprime quando o filho morre por
 * sinal (SIGSEGV/SIGKILL). O único código nativo daquele teste é este raster,
 * e até aqui ele rodava as duas linhas em paralelo (`Promise.all`): duas
 * threads do libuv inicializando pango + fontconfig ao mesmo tempo, no 1º uso
 * do processo, o ponto historicamente frágil dessas bibliotecas. Medir em fila
 * tira essa concorrência; custa ~2 rasters pequenos em sequência.
 *
 * Erro de uma medição não trava a fila: a próxima espera só o término, não o
 * sucesso, da anterior.
 */
export function serializeTextRender<T>(render: () => Promise<T>): Promise<T> {
  const run = textRenderTail.then(render, render);
  textRenderTail = run.catch(() => undefined);
  return run;
}

async function measureLine(text: string, fontSize: number, fontFamily: string): Promise<{ width: number; ascent: number; descent: number }> {
  const W = Math.ceil(fontSize * 30);
  const H = Math.ceil(fontSize * 4);
  const baseline = Math.round(fontSize * 2.5);
  const x0 = Math.round(fontSize);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#000000"/>` +
    `<text x="${x0}" y="${baseline}" font-family="${fontFamily}" font-weight="bold" font-size="${fontSize.toFixed(1)}" fill="#FFFFFF">${text}</text>` +
    `</svg>`;
  const { info } = await sharp(Buffer.from(svg)).trim({ background: "#000000", threshold: 40 }).toBuffer({ resolveWithObject: true });
  const top = -(info.trimOffsetTop ?? 0);
  return { width: info.width, ascent: baseline - top, descent: top + info.height - baseline };
}

/** Compõe o convite sobre o hero e devolve o JPEG. */
export async function renderD1PlayImage(heroBytes: Buffer): Promise<Buffer> {
  const img = sharp(heroBytes);
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error("hero do D1 sem dimensões legíveis");
  const metrics = await measureInviteText(meta.width);
  const svg = Buffer.from(buildInviteSvg(meta.width, meta.height, metrics));
  return img.composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
}

export async function ensureD1PlayImage(editionDir: string): Promise<D1PlayImageResult> {
  const heroPath = join(editionDir, D1_HERO_FILE);
  const playPath = join(editionDir, D1_PLAY_HERO_FILE);
  const stampPath = join(editionDir, D1_PLAY_STAMP_FILE);
  if (!existsSync(heroPath)) {
    // Sem hero não há o que copiar; cópia órfã de outro hero não pode sobrar.
    if (existsSync(playPath)) rmSync(playPath, { force: true });
    return { status: "no_hero", path: null };
  }
  try {
    const heroMd5 = md5OfFile(heroPath);
    const stamp = readStamp(stampPath);
    // Fresca só se o hero E o desenho do convite são os mesmos (#10784: cópia
    // antiga com ícone de play, sem `overlay`, regera).
    if (existsSync(playPath) && stamp.md5 === heroMd5 && stamp.overlay === D1_INVITE_VERSION) {
      return { status: "fresh", path: playPath };
    }
    const out = await renderD1PlayImage(readFileSync(heroPath));
    writeFileSync(playPath, out);
    mkdirSync(dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, `${JSON.stringify({ source: D1_HERO_FILE, source_md5: heroMd5, overlay: D1_INVITE_VERSION }, null, 2)}\n`, "utf8");
    return { status: "generated", path: playPath };
  } catch (e) {
    rmSync(playPath, { force: true });
    return { status: "failed", path: null, reason: (e as Error).message };
  }
}
