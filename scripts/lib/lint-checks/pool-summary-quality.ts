/**
 * lint-checks/pool-summary-quality.ts (#9358)
 *
 * Guard determinístico de QUALIDADE do resumo dos itens do pool
 * (LANÇAMENTOS / RADAR / USE MELHOR / VÍDEO — e os legados PESQUISAS /
 * OUTRAS NOTÍCIAS; `POOL_SECTION_RE` do `secondary-item-walker`). Complementa, sem
 * duplicar, `no-untranslated-summary` (#3196 — `[TRADUZIR]`/inglês) e
 * `secondary-items-have-summary` (#2545 — descrição ausente).
 *
 * Motivação (#9358, medição 260801→261001): o editor reescreveu o resumo de
 * ~3 itens de pool por edição. O resumo que chega ao gate costuma ser o
 * teaser/lede da fonte (1ª frase do RSS, gancho do artigo), cortado pela
 * fonte, ou texto de outra página (boilerplate do YouTube, rodapé do
 * WordPress, "links relacionados"). O writer não tem WebFetch e é instruído a
 * ser fiel ao `summary` bruto (#4000/#5663) — então quando o `summary` já vem
 * ruim ninguém na pipeline consegue consertar sem abrir a fonte, e o editor
 * faz isso à mão.
 *
 * Calibração contra dado real (scratch #9358, 42 edições 260801→261001,
 * comparando o último arquivo da pipeline com o `02-reviewed.md` final): de
 * cada sinal abaixo, a fração de itens flagrados que o editor reescreveu ou
 * cortou foi
 *   - trailing-ellipsis       63/66
 *   - no-final-punctuation    85/100
 *   - too-short (<80 chars)   46/48
 *   - space-before-punctuation 17/17
 *   - wordpress-footer         6/6
 *   - emoji-noise              1/1
 * e os "falsos positivos" restantes são, na leitura, defeitos que passaram
 * (ex: "…proteger edifícios corporativos e " — corte da fonte sem
 * reticências), não texto bom.
 *
 * Severidade por estágio (decisão de implementação #9358, registrada aqui):
 *   - Stage 2 (`check-invariants --stage 2` → `reviewed-pool-summary-quality`,
 *     severity error): BLOQUEIA o sentinel da Etapa 2 — o orchestrator
 *     (top-level, que tem WebFetch) reescreve o resumo a partir da fonte
 *     ANTES do editor ver a edição. Mesmo padrão do `carousel-text-overflow`
 *     (#6439): pegar cedo, enquanto o conserto é barato.
 *   - Stage 4 (`lint-newsletter-md --stage 4 --json`): WARN-ONLY. No gate o
 *     texto já pode ser do EDITOR — medido: 21 itens do `02-reviewed.md`
 *     FINAL (aprovado) ainda terminam sem ponto final. Bloquear ali seria
 *     travar a edição manual do editor por um check mecânico (#7401).
 */

import {
  forEachSecondaryItem,
  POOL_SECTION_RE,
  type SecondaryItemFound,
} from "./secondary-item-walker.ts";
import { stripTrailingTimeSuffix } from "./no-trailing-ellipsis.ts";

export type PoolSummaryDefectKind =
  | "trailing-ellipsis"
  | "no-final-punctuation"
  | "too-short"
  | "space-before-punctuation"
  | "wordpress-footer"
  | "youtube-boilerplate"
  | "emoji-noise";

/** Mínimo de caracteres (sem o sufixo "(N min)") de um resumo de pool. */
export const POOL_SUMMARY_MIN_CHARS = 80;

/**
 * Reticências finais em todas as formas medidas: `…`, `...`, e a forma entre
 * colchetes `[…]`/`[...]` que o WordPress põe no fim do excerpt do RSS.
 */
const TRAILING_ELLIPSIS_ANY_RE = /(?:\.{2,}|…|\[\s*(?:…|\.{3})\s*\])\s*$/u;

/** Fim de frase: `.`/`!`/`?`, opcionalmente seguido de aspas/parêntese de fechamento. */
const FINAL_PUNCTUATION_RE = /[.!?]["”’»)\]]*$/u;

/** Espaço antes de pontuação ("palavra ." / "palavra ,"). Ignora reticências. */
const SPACE_BEFORE_PUNCTUATION_RE = /\S[ \t]+(?:[,;:!?]|\.(?!\.))(?=\s|$)/u;

/** Rodapé do feed WordPress: "O post X apareceu primeiro em Y." / "The post X appeared first on Y." */
const WORDPRESS_FOOTER_RE = /\bapareceu primeiro em\b|\bappeared first on\b/iu;

/** Descrição padrão de página do YouTube (não é a descrição do vídeo). */
const YOUTUBE_BOILERPLATE_RE =
  /v[íi]deos e m[úu]sicas que voc[êe] ama|enjoy the videos and music you love/iu;

/** Emoji em resumo = "links relacionados"/navegação colados (ex: "📝Como usar… 🔎…"). */
const EMOJI_RE = /\p{Extended_Pictographic}/u;

/** Prefixo `[TRADUZIR]` é escopo do `no-untranslated-summary` — removido antes de medir. */
const TRADUZIR_PREFIX_RE = /^\s*\[TRADUZIR\]\s*/u;

/**
 * Normaliza a descrição pra medição: tira o prefixo `[TRADUZIR]` e o sufixo
 * de tempo de leitura "(N min)" do USE MELHOR. @pure
 */
export function normalizePoolSummary(description: string): string {
  return stripTrailingTimeSuffix(description.replace(TRADUZIR_PREFIX_RE, "")).trim();
}

/**
 * Lista os defeitos de um resumo de item de pool. Vazio = resumo OK.
 * Descrição vazia não é reportada aqui (é escopo de
 * `secondary-items-have-summary`, #2545). @pure
 */
export function detectPoolSummaryDefects(description: string): PoolSummaryDefectKind[] {
  const text = normalizePoolSummary(description);
  if (!text) return [];
  const defects: PoolSummaryDefectKind[] = [];
  if (TRAILING_ELLIPSIS_ANY_RE.test(text)) defects.push("trailing-ellipsis");
  else if (!FINAL_PUNCTUATION_RE.test(text)) defects.push("no-final-punctuation");
  if (text.length < POOL_SUMMARY_MIN_CHARS) defects.push("too-short");
  if (SPACE_BEFORE_PUNCTUATION_RE.test(text)) defects.push("space-before-punctuation");
  if (WORDPRESS_FOOTER_RE.test(text)) defects.push("wordpress-footer");
  if (YOUTUBE_BOILERPLATE_RE.test(text)) defects.push("youtube-boilerplate");
  if (EMOJI_RE.test(text)) defects.push("emoji-noise");
  return defects;
}

/** Instrução curta por defeito — impressa pelo CLI e lida pelo orchestrator. */
export const POOL_SUMMARY_DEFECT_HINT: Record<PoolSummaryDefectKind, string> = {
  "trailing-ellipsis": "resumo cortado (termina em reticências) — reescrever com a frase completa",
  "no-final-punctuation": "sem ponto final — provável corte da fonte; completar a frase",
  "too-short": `curto/vago (<${POOL_SUMMARY_MIN_CHARS} caracteres) — incluir o fato central (número, nome, o que mudou)`,
  "space-before-punctuation": "espaço antes de pontuação",
  "wordpress-footer": "rodapé do WordPress (\"O post … apareceu primeiro em …\") no lugar do resumo",
  "youtube-boilerplate": "descrição padrão do YouTube no lugar da descrição do vídeo",
  "emoji-noise": "emoji/links relacionados da página colados no resumo",
};

export interface PoolSummaryQualityError {
  section: string;
  line: number;
  url: string;
  titleExcerpt: string;
  descriptionExcerpt: string;
  defects: PoolSummaryDefectKind[];
}

export interface PoolSummaryQualityReport {
  ok: boolean;
  errors: PoolSummaryQualityError[];
}

/** Varre `md` e reporta 1 erro por item de pool com ≥1 defeito. @pure */
export function checkPoolSummaryQuality(md: string): PoolSummaryQualityReport {
  const errors: PoolSummaryQualityError[] = [];
  forEachSecondaryItem(md, {
    targetSectionRe: POOL_SECTION_RE,
    onFound: (item: SecondaryItemFound) => {
      const defects = detectPoolSummaryDefects(item.description);
      if (defects.length === 0) return;
      errors.push({
        section: item.section,
        line: item.descriptionLine,
        url: item.url,
        titleExcerpt: item.title.slice(0, 80),
        descriptionExcerpt: item.description.slice(0, 160),
        defects,
      });
    },
  });
  return { ok: errors.length === 0, errors };
}
