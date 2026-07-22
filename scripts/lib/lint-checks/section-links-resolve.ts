/**
 * lint-checks/section-links-resolve.ts (#3821)
 *
 * Roda o parser REAL (`parseSections`, de `../newsletter-parse.ts` — o mesmo
 * consumido por `render-newsletter-html.ts` pra gerar o HTML final da edição)
 * contra `02-reviewed.md` e falha se algum item de seção secundária
 * (LANÇAMENTOS/RADAR/USE MELHOR/VÍDEOS) sair do parse com `url: ""`.
 *
 * Motivação (#3821): os lints existentes que tocam seções secundárias
 * (`video-links-are-youtube`, `secondary-items-have-summary`,
 * `section-item-format`) usam extração mais permissiva — regex linha-a-linha
 * ou `extractUrlsBySection` — e NÃO detectam o caso em que o item inteiro
 * degrada pro fallback legado do parser real. Caso concreto que motivou esta
 * issue: um item de VÍDEOS escrito como `**[Título]** — [Canal](URL)` (2
 * pares `[texto](...)` na mesma linha, o primeiro sem URL própria) não bate
 * em nenhum branch de `parseListItems` — cada linha do bloco vira um item
 * quebrado (`title` = texto cru com asteriscos/colchetes literais,
 * `description: ""`, `url: ""`). Os 3 lints citados acima passaram "ok" nesse
 * item quebrado na edição real (260722) que motivou a issue — nenhum deles
 * roda o parser de verdade, só regex sobre a superfície do texto.
 *
 * Este lint fecha essa lacuna rodando o parser de produção diretamente: não é
 * uma re-implementação paralela das regras de formato (que arriscaria driftar
 * do parser real, o mesmo problema #1737 já resolveu pra nomes de seção) —
 * é o PRÓPRIO `parseSections` importado, então qualquer degradação futura do
 * mesmo tipo (não só o caso específico de VÍDEOS) é pega automaticamente.
 *
 * Escopo intencionalmente contido (#3821 item 2): só verifica `url` vazia em
 * itens de seções que o parser CONSEGUIU reconhecer. Não tenta detectar uma
 * seção inteira "sumindo" do resultado (header presente no MD cru mas ausente
 * de `parseSections`) — isso exigiria duplicar a lógica de split-por-bloco +
 * normalização de nome que já vive em `parseSections`/`section-naming.ts`,
 * risco de drift que #1737 justamente eliminou. Ver PR #3821 pra follow-up.
 *
 * Exit via CLI:
 *   0 — todo item de seção secundária reconhecida tem url não-vazia
 *   1 — algum item com url vazia
 *   2 — erro de argumento / arquivo não encontrado
 */

import { parseSections } from "../newsletter-parse.ts";

export interface SectionLinkUnresolvedError {
  section: string;
  /** Trecho do título (até 100 chars) do item com url vazia. */
  titleExcerpt: string;
}

export interface SectionLinksResolveReport {
  ok: boolean;
  errors: SectionLinkUnresolvedError[];
}

/**
 * Varre `md` via `parseSections` (parser real) e retorna um erro pra cada
 * item de seção secundária cuja `url` saiu vazia do parse — sintoma de um
 * item que degradou pro fallback legado (formato não reconhecido por
 * nenhum branch de `parseListItems`).
 */
export function checkSectionLinksResolve(md: string): SectionLinksResolveReport {
  const errors: SectionLinkUnresolvedError[] = [];
  const sections = parseSections(md);

  for (const section of sections) {
    for (const item of section.items) {
      if (!item.url) {
        errors.push({
          section: section.name,
          titleExcerpt: item.title.slice(0, 100),
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
