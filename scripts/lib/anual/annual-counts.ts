/**
 * annual-counts.ts (#7569)
 *
 * Contagem de publicações do período, para o bloco de aniversário.
 *
 * ## Por que isto não é um `readdirSync().length`
 *
 * A primeira versão contava `data/monthly/` e `data/artigo-especial/`
 * inteiros. Na 1ª rodada anual isso dá certo **por acaso** — a janela cobre a
 * vida inteira do projeto, então "tudo que existe" e "o que saiu no período"
 * são o mesmo conjunto. Da 2ª rodada em diante deixam de ser: a contagem
 * cumulativa inflaria, e o texto ao lado dela continuaria dizendo "no
 * período". É uma afirmação factual errada indo por e-mail para a base
 * inteira — a classe de erro que o `writer-anual` é instruído a nunca
 * cometer ("nunca estime, nunca arredonde").
 *
 * ## A granularidade de cada fonte é diferente, e isso importa
 *
 * - **Digests mensais**: o diretório é `{YYMM-conteúdo}-{MM-envio}`, então dá
 *   para filtrar pelo MÊS do conteúdo com precisão. Só conta o ciclo que tem
 *   `draft.md` — ciclo iniciado e abandonado não é edição publicada.
 * - **Artigos especiais**: o diretório é `{AAAA}-{slug}` e o `published.json`
 *   guarda só `ano` — **não há mês em lugar nenhum**. O filtro é por ANO, e
 *   numa janela que pega parte de um ano (ago–jul) isso pode incluir um
 *   especial publicado fora dela. `especiais_ano_aproximado` sinaliza esse
 *   caso para quem for escrever o texto, em vez de fingir precisão.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface AnnualCounts {
  edicoes_diarias: number;
  digests_mensais: number;
  artigos_especiais: number;
  /**
   * `true` quando a janela não cobre os anos inteiros que a contagem de
   * especiais usou — ou seja, quando o número pode incluir um especial de
   * fora do período. Quem escreve o texto decide o que fazer com isso.
   */
  especiais_ano_aproximado: boolean;
}

/** Ciclos mensais com `draft.md` cujo mês de CONTEÚDO está na janela. */
export function countMonthlyDigests(monthlyBase: string, months: readonly string[]): number {
  if (!existsSync(monthlyBase)) return 0;
  const wanted = new Set(months);
  return readdirSync(monthlyBase).filter((dir) => {
    const conteudo = dir.slice(0, 4);
    return wanted.has(conteudo) && existsSync(join(monthlyBase, dir, "draft.md"));
  }).length;
}

/** Anos (4 dígitos) tocados pela janela. */
export function windowYears(months: readonly string[]): Set<number> {
  return new Set(months.map((m) => 2000 + Number(m.slice(0, 2))));
}

/** Artigos especiais cujo ANO está na janela (o diretório não guarda mês). */
export function countSpecialArticles(specialBase: string, months: readonly string[]): number {
  if (!existsSync(specialBase)) return 0;
  const years = windowYears(months);
  return readdirSync(specialBase).filter((dir) => {
    const m = dir.match(/^(\d{4})-/);
    return m !== null && years.has(Number(m[1]));
  }).length;
}

/**
 * A janela cobre todos os meses dos anos que ela toca? Se não, a contagem de
 * especiais (que é por ano) é aproximada.
 */
export function coversFullYears(months: readonly string[]): boolean {
  const byYear = new Map<number, Set<string>>();
  for (const m of months) {
    const year = 2000 + Number(m.slice(0, 2));
    const set = byYear.get(year) ?? new Set<string>();
    set.add(m.slice(2, 4));
    byYear.set(year, set);
  }
  return [...byYear.values()].every((meses) => meses.size === 12);
}

export function annualCounts(opts: {
  monthlyBase: string;
  specialBase: string;
  months: readonly string[];
  edicoesDiarias: number;
}): AnnualCounts {
  return {
    edicoes_diarias: opts.edicoesDiarias,
    digests_mensais: countMonthlyDigests(opts.monthlyBase, opts.months),
    artigos_especiais: countSpecialArticles(opts.specialBase, opts.months),
    especiais_ano_aproximado: !coversFullYears(opts.months),
  };
}
