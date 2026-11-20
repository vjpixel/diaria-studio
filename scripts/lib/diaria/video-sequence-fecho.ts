/**
 * scripts/lib/diaria/video-sequence-fecho.ts (#13743) — a sequência que
 * termina seca.
 *
 * Na 261119 as três sequências terminavam na última fala do comentário,
 * seguida direto do card: sem a frase de fecho e sem o respiro de
 * `FECHO_HOLD_S` que só o bloco `fecho` (ou um `holdBlocks` do blocks.json)
 * ganha. O conserto foi à mão no `blocks.json`: o bloco `fecho` com a fala de
 * encerramento do roteiro (H14 no horizontal e no vertical 2, o CTA V1-CTA no
 * vertical 1) no fim do `order` de cada sequência.
 *
 * Dois lados:
 * - `falaDeFecho`: a última fala de um vídeo do roteiro que é encerramento
 *   (CTA, ou comentário que chama o público: "me conta nos comentários") vai
 *   para o bloco `fecho` na proposta de blocos (`propostaBlocosDoRoteiro`, que
 *   o `blocks --from-plan` usa);
 * - `sequenceEndingWarning`: o `build` avisa quando o último clipe falado da
 *   sequência não é de um bloco que segura o respiro.
 */

import type { BlockKey } from "./video-montage.ts";

/**
 * Comentário que fecha o vídeo chamando o público: pergunta aos comentários,
 * pedido de inscrição/seguir/compartilhar, despedida. Lista fechada de
 * propósito: comentário comum no fim (a última dica) não vira fecho.
 */
export const FECHO_PATTERNS: readonly RegExp[] = [
  /\bme\s+(?:conta|conte|diz|diga|fala|fale)\b/i,
  /\bnos\s+coment[aá]rios\b/i,
  /\b(?:comenta|comente)\s+a[ií]\b/i,
  /\bse\s+inscrev|\binscreva-se\b|\bse\s+inscreve\b/i,
  /\b(?:segue|siga)\s+(?:a|o)\s+diar\.?ia/i,
  /\bat[eé]\s+(?:amanh[aã]|a\s+pr[oó]xima|o\s+pr[oó]ximo)\b/i,
  /\b(?:tchau|valeu)\b[.!]?\s*$/i,
];

/** A fala fecha o vídeo: um CTA (`cta_*`) ou um comentário de encerramento (`FECHO_PATTERNS`). */
export function falaDeFecho(bloco: BlockKey, texto: string): boolean {
  if (bloco === "fecho") return true;
  if (bloco.startsWith("cta_")) return true;
  if (bloco !== "comentario") return false;
  return FECHO_PATTERNS.some((re) => re.test(texto));
}

/**
 * `[aviso]` do build para a sequência cujo último clipe falado (o `filler` da
 * vinheta não conta) é de um bloco sem o respiro do fecho. `null` = termina no
 * fecho (ou num `holdBlocks`), ou não tem clipe.
 */
export function sequenceEndingWarning(
  name: string,
  clips: ReadonlyArray<{ block: string; filler?: boolean }>,
  holdBlocks: readonly string[] = ["fecho"],
): string | null {
  const last = [...clips].reverse().find((c) => !c.filler);
  if (!last || holdBlocks.includes(last.block)) return null;
  const how = last.block === "comentario" ? "na última fala do comentário" : `no bloco ${last.block}`;
  return `${name} termina ${how}, sem fecho: a sequência sai seca (sem a frase de encerramento e sem o respiro do fecho antes do card); pôr a fala de encerramento/CTA no bloco fecho e "fecho" no fim do order (#13743)`;
}
