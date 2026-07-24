/**
 * lint-checks/why-matters-length.ts (#3993)
 *
 * Valida que o parágrafo de "Por que isso importa:" de cada destaque tem
 * entre WHY_MATTERS_MIN_CHARS (180) e WHY_MATTERS_MAX_CHARS (300) caracteres
 * — janela mais curta que a spec anterior do writer (~400 chars), pedida
 * pelo editor pra manter o parágrafo objetivo (sessão 260724).
 *
 * Contagem: caracteres totais do texto do parágrafo (após "Por que isso
 * importa:"), incluindo espaços — EXCLUINDO a própria label e o bloco
 * "Aprofunde:" (#3920), que tem regra própria e vem depois.
 *
 * Reusa `parseDestaques` (scripts/extract-destaques.ts) — mesmo parser usado
 * pelo render de produção (`render-newsletter-html.ts`) — pra extrair o campo
 * `why` de cada destaque; já exclui o bloco Aprofunde por construção (ver
 * `whyEnd`/`aprofundeIdx` em `parseDestaques`). Isso evita divergir do que
 * de fato é publicado, ao contrário de reimplementar um parser paralelo.
 *
 * Espelha o padrão de `destaque-chars.ts` (#914/#964): whitespace (incluindo
 * quebras de linha entre parágrafos do "why" multi-frase) é colapsado antes
 * da contagem, e URLs (se alguma vazar pro why, o que não deveria acontecer
 * na prática) são removidas — mesma normalização de `measure-highlights.ts`.
 */

import { parseDestaques } from "../../extract-destaques.ts";

export const WHY_MATTERS_MIN_CHARS = 180;
export const WHY_MATTERS_MAX_CHARS = 300;

const URL_RE = /https?:\/\/[^\s)]+/g;

/**
 * Normaliza o texto do "why" pra contagem: remove URLs (defensivo — não
 * deveria haver URL no parágrafo), colapsa whitespace/quebras de linha em
 * espaço único, trim.
 */
function normalizeWhy(why: string): string {
  return why.replace(URL_RE, "").replace(/\s+/g, " ").trim();
}

export interface WhyMattersLengthError {
  destaque: number;
  category: string;
  chars: number;
  min: number;
  max: number;
  excerpt: string;
}

export interface WhyMattersLengthReport {
  ok: boolean;
  errors: WhyMattersLengthError[];
  highlights: Array<{ destaque: number; category: string; chars: number }>;
}

export function checkWhyMattersLength(md: string): WhyMattersLengthReport {
  const destaques = parseDestaques(md);
  const errors: WhyMattersLengthError[] = [];
  const highlights: WhyMattersLengthReport["highlights"] = [];

  for (const d of destaques) {
    // Destaque sem "Por que isso importa:" detectável (why vazio) é pego por
    // outros checks (destaque-min-chars, estrutura geral) — aqui só medimos
    // quando o parágrafo existe, pra não duplicar erro.
    if (!d.why) continue;

    const normalized = normalizeWhy(d.why);
    const chars = normalized.length;
    highlights.push({ destaque: d.n, category: d.category, chars });

    if (chars < WHY_MATTERS_MIN_CHARS || chars > WHY_MATTERS_MAX_CHARS) {
      errors.push({
        destaque: d.n,
        category: d.category,
        chars,
        min: WHY_MATTERS_MIN_CHARS,
        max: WHY_MATTERS_MAX_CHARS,
        excerpt: normalized.slice(0, 100),
      });
    }
  }

  return { ok: errors.length === 0, errors, highlights };
}
