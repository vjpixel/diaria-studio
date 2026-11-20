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
 *
 * #13792: como o CTA pode ir para o fecho, `clipsHaveSpokenCta` (o aviso "sai
 * sem CTA nenhum" do #12571) conta também o fecho com texto de CTA.
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
 * #13792: texto de CTA falado, o que manda para fora do vídeo (vídeo completo,
 * canal, link, inscrição, seguir). Chamar para os comentários NÃO entra: antes
 * do #13743 essa fala ficava no `comentario` e não contava como CTA no aviso
 * do #12571, e mover para o fecho não pode mudar isso.
 */
export const CTA_TEXT_PATTERNS: readonly RegExp[] = [
  /\bv[ií]deo\s+completo\b/i,
  /\byoutube\b/i,
  /\bno\s+(?:meu\s+|nosso\s+)?canal\b/i,
  /\blink\b/i,
  /\bse\s+inscrev|\binscreva-se\b|\bse\s+inscreve\b/i,
  /\b(?:segue|siga)\s+(?:a|o)\s+diar\.?ia/i,
];

/** A fala é um CTA pelo texto (`CTA_TEXT_PATTERNS`). */
export function textoDeCta(texto: string | undefined): boolean {
  return !!texto && CTA_TEXT_PATTERNS.some((re) => re.test(texto));
}

/**
 * #12571 + #13792: a sequência tem CTA falado. Conta o clipe de bloco `cta_*`
 * (ou o pedaço `cta_*` de um clipe fundido) e o clipe do `fecho` cujo texto é
 * de CTA: a proposta de blocos (#13743) passa a última fala `cta_*` para o
 * fecho, e sem isso o build avisava "sai sem CTA nenhum" com o CTA falado.
 * Vale também para o clipe fundido que tem o `fecho` em `parts` (#13797).
 */
export function clipsHaveSpokenCta(
  clips: ReadonlyArray<{ block: string; script?: string; filler?: boolean; parts?: ReadonlyArray<{ block: string }> }>,
  ctaBlocks: readonly string[],
): boolean {
  return clips.some((c) => {
    if (c.filler) return false;
    if (ctaBlocks.includes(c.block) || c.parts?.some((p) => ctaBlocks.includes(p.block))) return true;
    // #13797: clipe de outro bloco fundido ao `fecho` seguinte (corte contíguo, `assembleClips`)
    // leva o nome do 1º bloco e só tem o `fecho` em `parts`; o `script` dele junta os textos.
    const hasFecho = c.block === "fecho" || !!c.parts?.some((p) => p.block === "fecho");
    return hasFecho && textoDeCta(c.script);
  });
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
