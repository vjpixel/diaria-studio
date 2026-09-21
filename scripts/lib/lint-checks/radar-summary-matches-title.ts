/**
 * lint-checks/radar-summary-matches-title.ts (#8594)
 *
 * Item de seção secundária (LANÇAMENTOS/RADAR/USE MELHOR) cuja descrição não
 * tem relação léxica com o título/URL do próprio item — caso 260921: item do
 * RADAR (Exame, golpes com IA) saiu com resumo de digest de OUTRAS matérias.
 * WARN-ONLY: heurística léxica (`summaryMatchesArticle`), o editor decide.
 */

import { forEachSecondaryItem } from "./secondary-item-walker.ts";
import { summaryMatchesArticle, type SummaryMatchReason } from "../summary-matches-title.ts";

export interface RadarSummaryMatchError {
  section: string;
  line: number;
  reason: SummaryMatchReason;
  url: string;
  titleExcerpt: string;
  descriptionExcerpt: string;
}

export interface RadarSummaryMatchReport {
  ok: boolean;
  errors: RadarSummaryMatchError[];
}

export function checkRadarSummaryMatchesTitle(md: string): RadarSummaryMatchReport {
  const errors: RadarSummaryMatchError[] = [];
  forEachSecondaryItem(md, {
    onFound: (item) => {
      const m = summaryMatchesArticle({ title: item.title, url: item.url, summary: item.description });
      if (!m.ok) {
        errors.push({
          section: item.section,
          line: item.descriptionLine,
          reason: m.reason,
          url: item.url,
          titleExcerpt: item.title.slice(0, 80),
          descriptionExcerpt: item.description.slice(0, 120),
        });
      }
    },
  });
  return { ok: errors.length === 0, errors };
}
