/**
 * select-weekly-d1.ts (#4101)
 *
 * Aritmética de janela semanal (segunda a sexta) pro post semanal do
 * Instagram — extraído do restante do arquivo original, que também fazia a
 * SELEÇÃO dos itens ("os 5 D1, sem ranking por clique").
 *
 * **#4483 SUPERSEDE a seleção original.** A função `selectWeeklyD1` (e o
 * tipo `WeeklyD1Item`) que viviam aqui foram REMOVIDOS — a seleção agora é
 * por taxa de clique verificado, de qualquer posição elegível (D1/D2/D3),
 * não mais "1 item por edição, sempre o D1". Ver
 * `scripts/lib/weekly-instagram-select.ts` (`extractInstagramCandidates` +
 * `selectInstagramWeekly`) para a seleção atual. Este arquivo mantém só a
 * aritmética de calendário pura — `computeWeekdayEditionDates` e
 * `resolveWeeklyEditionDirs` continuam válidas (a janela de conteúdo em si
 * não mudou, só o critério de escolha DENTRO dela) e seguem usadas por
 * `scripts/publish-weekly-social.ts`.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveEditionDir } from "./find-current-edition.ts";

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
 * Não lança — dirs ausentes viram `exists: false`, filtrados pelo caller
 * antes de extrair candidatos (`extractInstagramCandidates`).
 *
 * Usa `resolveEditionDir` (dual flat/nested, #2463) em vez de montar
 * `resolve(editionsRoot, date)` à mão — edições criadas depois da migração
 * pro layout nested (`data/editions/{AAMM}/{AAMMDD}`, #3024) nunca eram
 * encontradas antes deste fix (mesma classe de bug do #3030/#3031;
 * `select-linkedin-weekly.ts` já usava `resolveEditionDir` corretamente).
 */
export function resolveWeeklyEditionDirs(
  saturday: Date,
  editionsRoot: string,
): WeeklyEditionCandidate[] {
  return computeWeekdayEditionDates(saturday).map((date) => {
    const dir = resolveEditionDir(editionsRoot, date);
    const exists = existsSync(resolve(dir, "02-reviewed.md"));
    return { date, dir, exists };
  });
}
