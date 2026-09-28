/**
 * scripts/lib/manual-cleanup-emails.ts (#8423 fleet review item 3)
 *
 * Extraído de `scripts/studio-ui/studio-metrics.ts`/`scripts/cac-report.ts`
 * — as duas cópias tinham um `catch {}` mudo: arquivo corrompido virava
 * silenciosamente "nenhuma limpeza manual conhecida" (Set vazio), o que faz
 * o churn "orgânico" e "com limpeza" colapsarem pro MESMO número sem
 * nenhum sinal de que a distinção ficou impossível de fazer. Este módulo
 * devolve status explícito (`error`, `skipped`) em vez de engolir a falha —
 * o CALLER decide como degradar (aqui: `computeValorLayer`/`computeLtvSection`
 * tratam `error !== null` como "não dá pra separar orgânico de com-limpeza
 * com segurança" e caem em indeterminado em vez de fingir que colapsaram por
 * coincidência).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCuratedBatch } from "./curated-batch-import.ts";

export interface ManualCleanupEmailsResult {
  /** E-mails normalizados de limpeza manual conhecida — Set vazio quando o
   *  arquivo está ausente (nunca houve limpeza registrada, não é erro) OU
   *  quando `error` é não-nulo (falha real — o caller decide como degradar,
   *  nunca assume "sem limpeza" nesse caso). */
  emails: ReadonlySet<string>;
  /** Não-nulo só quando o arquivo EXISTE mas falhou ler/parsear — diferente
   *  de ausente (que é normal, nunca é erro). */
  error: string | null;
  /** Contagem de entradas puladas por `parseCuratedBatch` dentro de um
   *  arquivo que passou no parse geral (formato de linha inválido) — sinal
   *  pra motivo/diagnóstico quando > 0, nunca silenciado. */
  skipped: number;
}

const MANUAL_CLEANUP_PATH_SEGMENTS = ["data", "analysis", "descadastrados-manuais-2607.json"] as const;

/** Caminho do arquivo de limpeza manual conhecida, a partir de `rootDir` —
 *  exposto pra quem quer citar o path em mensagens de diagnóstico sem
 *  reconstruí-lo. @pure */
export function manualCleanupEmailsPath(rootDir: string): string {
  return resolve(rootDir, ...MANUAL_CLEANUP_PATH_SEGMENTS);
}

/** E-mails normalizados de limpeza manual conhecida (#8423) — status
 *  explícito em vez de fail-soft silencioso (ver docstring do módulo).
 *  Reusa `parseCuratedBatch` (`curated-batch-import.ts`) — mesmo parser que
 *  já entende o formato do arquivo, nenhuma reimplementação. */
export function loadManualCleanupEmails(rootDir: string): ManualCleanupEmailsResult {
  const path = manualCleanupEmailsPath(rootDir);
  if (!existsSync(path)) return { emails: new Set(), error: null, skipped: 0 };
  try {
    const { entries, skipped } = parseCuratedBatch(JSON.parse(readFileSync(path, "utf8")));
    return { emails: new Set(entries.map((e) => e.email)), error: null, skipped: skipped.length };
  } catch (e) {
    const message = (e as Error).message;
    console.error(`[manual-cleanup-emails] falha ao ler/parsear ${path}: ${message} — tratado como indisponível, nunca como "sem limpeza"`);
    return { emails: new Set(), error: message, skipped: 0 };
  }
}
