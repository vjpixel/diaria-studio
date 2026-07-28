/**
 * select-social-card-image.ts (#4090 item 5)
 *
 * Escolhe qual imagem um publisher de feed (Facebook, Instagram) usa pro post
 * de um destaque: o card 4:5 (1080x1350, título embutido, #4114) quando a
 * edição o gerou, com fallback pro 1:1 legado (sempre presente, #502).
 *
 * Extraído de publish-facebook.ts / publish-instagram.ts, que tinham a MESMA
 * checagem (`existsSync(4x5) ? 4x5 : 1x1`) duplicada em 3 call sites — os 2
 * óbvios (dispatch inicial de cada publisher) e um terceiro que a duplicação
 * deixou pra trás: o fluxo `--reschedule` do Facebook (DELETE + re-publish)
 * nunca checava o 4:5, sempre usava 1x1 mesmo quando o card existia. Um
 * ponto único de seleção, testável com arquivos reais, evita essa divergência
 * silenciosa voltar (o teste anterior da precedência era regex contra o
 * source — passaria mesmo com a ordem da condição invertida).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `editionDir` + `destaque` (ex: "d1") → nome do arquivo (não o path
 * completo) da imagem a usar no post. Prefere `04-{destaque}-4x5.jpg`;
 * cai pro `04-{destaque}-1x1.jpg` quando o 4:5 não existe — silenciosamente
 * por design (edição legada, ou a geração do card falhou/foi pulada nesta
 * edição). Pura: só consulta o filesystem, não decide política de erro (isso
 * é responsabilidade do caller, que já checa `existsSync(imagePath)` depois).
 */
export function selectSocialCardImageFile(editionDir: string, destaque: string): string {
  const card4x5Path = resolve(editionDir, `04-${destaque}-4x5.jpg`);
  return existsSync(card4x5Path) ? `04-${destaque}-4x5.jpg` : `04-${destaque}-1x1.jpg`;
}
