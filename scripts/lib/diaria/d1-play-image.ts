/**
 * scripts/lib/diaria/d1-play-image.ts (#10784)
 *
 * Gera `04-d1-2x1-play.jpg`: cópia do hero do D1 com o convite escrito
 * (`buildInviteSvg`, sem ícone de play), só para a newsletter. O hero original
 * (`04-d1-2x1.jpg`) nunca é tocado — as redes seguem usando ele.
 *
 * Artefato derivado: regera quando o hero muda (md5 carimbado em
 * `_internal/04-d1-play.json`), então troca de imagem no Stage 4 não deixa a
 * newsletter com a arte velha. Chamado por `upload-images-public.ts` (modo
 * newsletter/all), antes do upload — é o passo que precede o render do HTML no
 * Stage 4.
 *
 * Fail-soft: falha ao gerar remove a cópia antiga (arte possivelmente
 * defasada) e devolve o motivo — o render cai no hero sem play, ainda com
 * link (`extractContent` só usa a cópia quando ela existe).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { md5OfFile } from "../shared/file-md5.ts";
import { D1_HERO_FILE, D1_INVITE_VERSION, D1_PLAY_HERO_FILE, D1_PLAY_STAMP_FILE, buildInviteSvg } from "./d1-video-hero.ts";

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

/** Compõe o convite sobre o hero e devolve o JPEG. */
export async function renderD1PlayImage(heroBytes: Buffer): Promise<Buffer> {
  const img = sharp(heroBytes);
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error("hero do D1 sem dimensões legíveis");
  const svg = Buffer.from(buildInviteSvg(meta.width, meta.height));
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
