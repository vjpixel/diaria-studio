/**
 * gen-social-invite-icons.ts (#11483)
 *
 * Gera os PNGs dos ícones de rede do convite social do PARA ENCERRAR
 * ("Siga a diar.ia.br:" + ícones) a partir dos SVGs em `assets/social-icons/`
 * e grava em `workers/site/public/icons/social/{rede}.png`, servidos pelo
 * Worker do apex em `https://diar.ia.br/icons/social/{rede}.png` (deploy
 * automático no push em master que toca `workers/site/**`,
 * `.github/workflows/deploy-site.yml`).
 *
 * Por que PNG hospedado e não SVG inline: Gmail e Outlook não renderizam SVG
 * em e-mail. O `alt` de cada `<img>` é o nome da rede, então com imagens
 * bloqueadas o convite continua legível (ver `renderSocialInviteIconsHtml`).
 *
 * Fonte dos SVGs: Simple Icons 13.21.0 (CC0 1.0, https://simpleicons.org),
 * recoloridos aqui para o ink do DS (`COLORS.ink`). Rodar de novo só quando
 * um SVG ou a cor mudar, e commitar os PNGs junto:
 *
 *   npx tsx scripts/gen-social-invite-icons.ts
 */
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { COLORS } from "./lib/shared/design-tokens.ts";
import { SOCIAL_INVITE_ICON_KEYS, SOCIAL_INVITE_ICON_PX } from "./lib/shared/encerramento-snippet.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 3x o tamanho exibido: nítido em tela retina sem pesar no e-mail. */
const SCALE = 3;

/** Põe a cor no `<svg>` e tira o `<title>` (o alt fica no `<img>`). */
export function recolorSvg(svg: string, color: string): string {
  return svg.replace(/<title>[\s\S]*?<\/title>/, "").replace("<svg ", `<svg fill="${color}" `);
}

async function main(): Promise<void> {
  const outDir = join(ROOT, "workers/site/public/icons/social");
  mkdirSync(outDir, { recursive: true });
  const px = SOCIAL_INVITE_ICON_PX * SCALE;
  for (const key of SOCIAL_INVITE_ICON_KEYS) {
    const svg = recolorSvg(readFileSync(join(ROOT, "assets/social-icons", `${key}.svg`), "utf8"), COLORS.ink);
    const out = join(outDir, `${key}.png`);
    await sharp(Buffer.from(svg), { density: 72 * (px / 24) })
      .resize(px, px, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(out);
    console.log(out);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
