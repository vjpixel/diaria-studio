/**
 * lint-checks/secondary-items-have-summary.ts (#2545)
 *
 * Verifica que todo item de seção secundária (LANÇAMENTOS / RADAR / USE MELHOR)
 * tem uma descrição (linha não-vazia abaixo do título). Seção É IA? e VÍDEOS
 * são excluídas — elas têm formato próprio sem descrição obrigatória inline.
 *
 * Problema que este lint resolve: itens non-inbox com `summary` vazio escapam
 * do `enrich-inbox-articles.ts` quando há cache-miss (o body não estava no
 * cache do 1i) e o cap de fallback fetch foi atingido. Sem este lint, o
 * item entra no writer e renderiza só o título pelado no email — editor só
 * percebe no gate do Stage 4 (como aconteceu em 260625, caso OpenClaw).
 *
 * Estratégia: varrer `02-reviewed.md` linha-a-linha. Em cada seção secundária
 * alvo (LANÇAMENTOS/RADAR/USE MELHOR), para cada linha de título de item
 * (inline link), verificar que a próxima linha não-vazia não é outro link,
 * header, separador ou EOF. Se for — descrição ausente → erro.
 *
 * Observação: o checker de formato `section-item-format.ts` já detecta
 * `title_without_description` (link sem linha seguinte). Este lint é mais
 * simples — só acusa descrição vazia/ausente — e roda como check separado
 * pré-gate, facilitando a ação de fix pelo editor (distingue "falta o texto"
 * de "formato errado").
 *
 * Exit via CLI:
 *   0 — todos os itens das seções alvo têm descrição
 *   1 — algum item tem descrição vazia
 *   2 — erro de argumento / arquivo não encontrado
 */

// #3242: state machine de boundary-parsing extraída pro walker compartilhado
// — ver secondary-item-walker.ts para o histórico de duplicação (#2545,
// #2881, #3196) que motivou a extração.
import {
  forEachSecondaryItem,
  type SecondaryItemMissing,
} from "./secondary-item-walker.ts";

// Regex ESPECÍFICA deste lint (#2545): usada só pra decidir, no lookahead de
// um título solo, se a PRÓXIMA linha não-vazia é ela própria outro item
// BOLDED (portanto o item atual não tem descrição). Mais restrita que a
// regex ampla (`SAME_LINE_ITEM_RE`) usada pelos outros 3 lints DE PROPÓSITO
// — regressão #2579: uma descrição que COMEÇA com um link markdown sem bold
// (ex: `[Fonte](url) explica que...`) é uma descrição válida do item
// anterior, não um novo item. Só reconhecemos `**[Título](url)** texto`
// (bold nos 2 lados) como inequivocamente outro item — ver nota de
// divergência 2 em secondary-item-walker.ts.
const BOLDED_ITEM_ONLY_RE =
  /^\s*\*\*\s*\[[^\]]+\]\(https?:\/\/[^\s)]+\)\s*\*\*\s+\S/;

export interface SecondaryItemSummaryError {
  section: string;
  /** Linha do título (1-based). */
  titleLine: number;
  /** Trecho do título (até 80 chars). */
  titleExcerpt: string;
}

export interface SecondaryItemSummaryReport {
  ok: boolean;
  errors: SecondaryItemSummaryError[];
}

/**
 * Varre `md` e retorna erros para cada item de seção secundária sem descrição.
 *
 * "Descrição" = linha não-vazia imediatamente após o título (inline link) que
 * NÃO é outro inline link, header de seção, separador `---` ou é EOF.
 *
 * Para USE MELHOR, itens com formato canônico (link + descrição na mesma linha)
 * também são aceitos como tendo descrição.
 */
export function checkSecondaryItemsHaveSummary(
  md: string,
): SecondaryItemSummaryReport {
  const errors: SecondaryItemSummaryError[] = [];

  forEachSecondaryItem(md, {
    // #2545 preservava um conjunto mais estreito de headers de fechamento de
    // seção (sem É IA?/ERRO INTENCIONAL/SORTEIO/PARA ENCERRAR, ampliado nos
    // outros 3 lints só depois, #2918 bug 2) — ver nota de divergência 1 em
    // secondary-item-walker.ts.
    legacyClosingHeaders: true,
    // Ver nota de divergência 2 em secondary-item-walker.ts / comentário de
    // BOLDED_ITEM_ONLY_RE acima.
    nextLineIsItemRe: BOLDED_ITEM_ONLY_RE,
    onMissing: (item: SecondaryItemMissing) => {
      errors.push({
        section: item.section,
        titleLine: item.titleLine,
        titleExcerpt: item.title.slice(0, 80),
      });
    },
  });

  return { ok: errors.length === 0, errors };
}
