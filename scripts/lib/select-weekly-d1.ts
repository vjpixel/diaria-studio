/**
 * select-weekly-d1.ts (#4101)
 *
 * Seleção determinística dos "5 D1" que compõem o post semanal de destaques
 * (issue #4101, decisão do editor 260727): o post de sábado leva o DESTAQUE 1
 * de cada edição da semana (segunda a sexta) — sem ranking por clique, sem
 * re-scoring, sem backfill com D2/D3 quando uma edição falta.
 *
 * Reusa `parseDestaques` de `extract-destaques.ts` (mesmo parser que já lê
 * `02-reviewed.md` no Stage 2/4/5 diários) — nada de parser novo (#172).
 *
 * Fonte por edição (ver issue #4101): `02-reviewed.md` local. A edição de
 * sexta é produzida na quinta (regra D+1) e ainda não foi publicada no
 * momento da montagem do post semanal — o disco é a ÚNICA fonte possível
 * pra ela, então usamos disco pras 5 uniformemente (nunca Beehiiv).
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseDestaques } from "../extract-destaques.ts";

export interface WeeklyD1Item {
  /** AAMMDD da edição de origem deste D1. */
  editionDate: string;
  title: string;
  url: string;
  category: string;
}

export interface WeeklyEditionCandidate {
  /** AAMMDD (segunda a sexta, ordem cronológica). */
  date: string;
  /** Diretório absoluto da edição (`{editionsRoot}/{date}`). */
  dir: string;
  /** true se `{dir}/02-reviewed.md` existe. */
  exists: boolean;
}

/**
 * Pure: dado o Date do sábado de publicação, retorna as 5 datas AAMMDD de
 * segunda a sexta IMEDIATAMENTE anteriores, em ordem cronológica.
 *
 * Usa apenas os componentes de calendário (ano/mês/dia) do `saturday`
 * recebido — a hora do dia é ignorada. A aritmética de `Date` do JS resolve
 * corretamente virada de mês e de ano (ex: sábado 2026-08-01 → segunda
 * 2026-07-27 .. sexta 2026-07-31; sábado 2026-01-03 → segunda 2025-12-29 ..
 * sexta 2026-01-02) sem lógica de calendário manual.
 *
 * Não valida que `saturday` seja de fato um sábado — quem monta a data (CLI)
 * é responsável por passar a data correta; esta função é pura aritmética de
 * calendário.
 */
export function computeWeekdayEditionDates(saturday: Date): string[] {
  const dates: string[] = [];
  // offset 5 = segunda, ..., offset 1 = sexta (imediatamente antes do sábado).
  for (let offset = 5; offset >= 1; offset--) {
    const d = new Date(saturday.getFullYear(), saturday.getMonth(), saturday.getDate() - offset);
    dates.push(formatAAMMDD(d));
  }
  return dates;
}

function formatAAMMDD(d: Date): string {
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Resolve os 5 diretórios de edição (segunda a sexta) candidatos para o
 * sábado dado, marcando quais de fato têm `02-reviewed.md` no disco.
 * Não lança — dirs ausentes viram `exists: false`, filtrados depois por
 * `selectWeeklyD1`.
 */
export function resolveWeeklyEditionDirs(
  saturday: Date,
  editionsRoot: string,
): WeeklyEditionCandidate[] {
  return computeWeekdayEditionDates(saturday).map((date) => {
    const dir = resolve(editionsRoot, date);
    const exists = existsSync(resolve(dir, "02-reviewed.md"));
    return { date, dir, exists };
  });
}

/**
 * Seleciona o DESTAQUE 1 de cada diretório de edição em `editionDirs`
 * (assumido em ordem cronológica pelo caller — segunda a sexta).
 *
 * Regras (teste de regressão da issue #4101):
 *   - Exatamente 1 item por edição (nunca mais que 1).
 *   - Sempre o DESTAQUE 1 — nunca D2/D3 como fallback quando D1 está ausente
 *     ou malformado (o editor prefere um post mais curto a um item errado).
 *   - Edição sem `02-reviewed.md`, ilegível, ou sem DESTAQUE 1 parseável (ou
 *     sem URL) é PULADA com um warning — nunca lança, nunca completa a
 *     semana com um D2/D3 de outra edição.
 *   - Semana com 0 edições válidas → `[]` (o caller nunca despacha
 *     publicação com lista vazia).
 *   - Ordem de saída = ordem de `editionDirs` (chamador garante cronológica).
 */
export function selectWeeklyD1(editionDirs: string[]): WeeklyD1Item[] {
  const items: WeeklyD1Item[] = [];

  for (const dir of editionDirs) {
    const mdPath = resolve(dir, "02-reviewed.md");
    if (!existsSync(mdPath)) {
      console.warn(`[select-weekly-d1] SKIP ${dir} — 02-reviewed.md ausente`);
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(mdPath, "utf8");
    } catch (e: any) {
      console.warn(`[select-weekly-d1] SKIP ${dir} — falha ao ler 02-reviewed.md: ${e.message}`);
      continue;
    }

    const destaques = parseDestaques(raw);
    const d1 = destaques.find((d) => d.n === 1);
    if (!d1 || !d1.url || !d1.title) {
      console.warn(
        `[select-weekly-d1] SKIP ${dir} — DESTAQUE 1 ausente, sem título ou sem URL em 02-reviewed.md`,
      );
      continue;
    }

    const editionDate = basename(dir.replace(/[/\\]+$/, ""));
    items.push({ editionDate, title: d1.title, url: d1.url, category: d1.category });
  }

  return items;
}
