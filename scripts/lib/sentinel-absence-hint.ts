/**
 * scripts/lib/sentinel-absence-hint.ts (#11729)
 *
 * Quando uma skill `/diaria-*` não acha o sentinel `_internal/.step-N-done.json`
 * (ou os arquivos esperados) de uma etapa, a leitura "etapa não aprovada" só é
 * certa na máquina onde a etapa rodou. `data/` é sincronizado pelo OneDrive
 * entre as máquinas do projeto (Neo, `300`): o gate aprovado no Neo leva um
 * tempo para aparecer no `300`, e às vezes não aparece (#5548, #7083). Na
 * edição 261030 o Stage 4 foi aprovado no Neo e o `/diaria-publica-video` no
 * `300` recusou como se a etapa não tivesse sido aprovada.
 *
 * Este módulo monta a mensagem que substitui essa conclusão: diz "possível
 * defasagem de sync do OneDrive" e mostra a idade do arquivo mais recente da
 * pasta da edição nesta máquina. A idade é o que deixa o editor decidir: se o
 * arquivo mais novo é de horas atrás e a etapa foi aprovada há minutos em outra
 * máquina, o sync não chegou; se a pasta está em dia, a etapa provavelmente
 * não foi aprovada mesmo.
 *
 * Mesma classe de erro do item 23 de `context/overnight-dispatch-rules.md` e de
 * `scripts/lib/replicated-absence.ts`: ausência de arquivo replicado não prova
 * nada sozinha.
 *
 * `buildSentinelAbsenceHint` e `formatAgeMs` são puros. `findNewestFile` e
 * `describeSentinelAbsence` leem o disco e nunca lançam.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const SYNC_LAG_PHRASE = "possível defasagem de sync do OneDrive";

export interface NewestFile {
  /** Caminho relativo à pasta da edição, com `/`. */
  relPath: string;
  mtimeMs: number;
}

export interface SentinelAbsenceHintInput {
  editionId: string;
  /** Pasta da edição como aparece na mensagem (relativa ou absoluta). */
  editionDirLabel: string;
  /** Arquivos esperados que não foram encontrados (relativos à pasta da edição). */
  missing: string[];
  /** Arquivo mais recente da pasta da edição; `null` = pasta ausente ou vazia. */
  newest: NewestFile | null;
  nowMs: number;
}

/**
 * Pura: idade legível em português ("agora", "12 min", "3 h 05 min",
 * "2 d 4 h"). Valor negativo (relógio de outra máquina adiantado) vira
 * "agora": o mtime veio do futuro, o arquivo é recente.
 */
export function formatAgeMs(ms: number): string {
  if (!Number.isFinite(ms)) return "idade desconhecida";
  if (ms < 60_000) return "agora";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const totalH = Math.floor(totalMin / 60);
  if (totalH < 24) {
    const min = totalMin % 60;
    return `${totalH} h ${String(min).padStart(2, "0")} min`;
  }
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  return `${d} d ${h} h`;
}

/**
 * Pura: mensagem para sentinel/arquivo esperado ausente. Nunca afirma
 * "etapa não aprovada"; diz que pode ser defasagem de sync e dá a idade do
 * arquivo mais recente da edição nesta máquina.
 */
export function buildSentinelAbsenceHint(input: SentinelAbsenceHintInput): string {
  const missingList = input.missing.length > 0 ? input.missing.join(", ") : "(arquivos esperados)";
  const head =
    `${missingList} ausente nesta máquina para a edição ${input.editionId} (${input.editionDirLabel}). ` +
    `Isso não prova que a etapa não foi aprovada: ${SYNC_LAG_PHRASE} ` +
    `(a etapa pode ter rodado em outra máquina e o data/ ainda não ter chegado aqui).`;
  let evidence: string;
  if (input.newest === null) {
    evidence = `Pasta da edição ausente ou vazia nesta máquina: ou a edição não começou, ou o sync ainda não trouxe nada dela.`;
  } else {
    const age = formatAgeMs(input.nowMs - input.newest.mtimeMs);
    const iso = new Date(input.newest.mtimeMs).toISOString();
    evidence = `Arquivo mais recente da edição aqui: ${input.newest.relPath}, modificado há ${age} (${iso}).`;
  }
  const action =
    `Se a etapa foi aprovada em outra máquina depois disso, espere o sync (ou confira o sentinel lá) e rode de novo; ` +
    `se não foi, rode a etapa.`;
  return `${head} ${evidence} ${action}`;
}

/**
 * Lê o disco: arquivo de mtime mais recente sob `dir` (recursivo, até
 * `maxDepth` níveis). `null` se a pasta não existe, está vazia ou não pode
 * ser lida. Nunca lança.
 */
export function findNewestFile(dir: string, maxDepth = 4): NewestFile | null {
  let best: NewestFile | null = null;
  const walk = (current: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(current, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (best === null || st.mtimeMs > best.mtimeMs) {
        best = { relPath: relative(dir, full).replaceAll("\\", "/"), mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(dir, 0);
  return best;
}

/** Lê o disco e monta a mensagem. Nunca lança. */
export function describeSentinelAbsence(
  editionDir: string,
  editionId: string,
  missing: string[],
  nowMs: number = Date.now(),
  cwd: string = process.cwd(),
): string {
  const label = relative(cwd, editionDir).replaceAll("\\", "/") || editionDir;
  return buildSentinelAbsenceHint({
    editionId,
    editionDirLabel: label,
    missing,
    newest: findNewestFile(editionDir),
    nowMs,
  });
}
