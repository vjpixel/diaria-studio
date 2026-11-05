/**
 * select-social-card-image.ts (#4090 item 5, #12226)
 *
 * Escolhe qual imagem um publisher de feed (Facebook, Instagram) usa pro post
 * de um destaque: o card 4:5 (1080x1350, título embutido, #4114).
 *
 * Extraído de publish-facebook.ts / publish-instagram.ts, que tinham a MESMA
 * checagem (`existsSync(4x5) ? 4x5 : 1x1`) duplicada em 3 call sites — os 2
 * óbvios (dispatch inicial de cada publisher) e um terceiro que a duplicação
 * deixou pra trás: o fluxo `--reschedule` do Facebook (DELETE + re-publish).
 * Um ponto único de seleção evita essa divergência silenciosa voltar.
 *
 * #12226 (decisão do editor, 05/11/2026): o 1:1 (`04-{d}-1x1.jpg`) deixou de
 * ser gerado, e o fallback pra ele saiu daqui. 4:5 ausente agora FALHA ALTO
 * no caller (que já checa `existsSync(imagePath)` e grava a entry `failed`
 * com `missingSocialCardReason`) em vez de publicar um 1:1 sem título — o
 * Stage 3 já trata 4:5 ausente como bloqueante (#4090), então chegar aqui sem
 * ele é falha a corrigir, não caso a degradar em silêncio.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Nome do card 4:5 do destaque (ex: "d1" → "04-d1-4x5.jpg"). */
export function socialCardImageFile(destaque: string): string {
  return `04-${destaque}-4x5.jpg`;
}

/**
 * `editionDir` + `destaque` (ex: "d1") → nome do arquivo (não o path
 * completo) da imagem a usar no post: sempre `04-{destaque}-4x5.jpg`, sem
 * fallback (#12226). Não decide política de erro — o caller confere
 * `existsSync` e usa `missingSocialCardReason` na falha.
 */
export function selectSocialCardImageFile(_editionDir: string, destaque: string): string {
  return socialCardImageFile(destaque);
}

/** true quando o card 4:5 do destaque existe na edição. */
export function hasSocialCardImage(editionDir: string, destaque: string): boolean {
  return existsSync(resolve(editionDir, socialCardImageFile(destaque)));
}

/**
 * Motivo legível pra entry `failed` quando o card 4:5 falta. Diz o que rodar
 * e que não há mais fallback pro 1:1 (#12226).
 */
export function missingSocialCardReason(destaque: string): string {
  return (
    `${socialCardImageFile(destaque)} not found — card 4:5 ausente; rode ` +
    `scripts/gen-social-card-4x5.ts (Stage 3). Sem fallback pro 1:1 desde o #12226.`
  );
}
