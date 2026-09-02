/**
 * clarice-novos-cutoff.ts (#5410)
 *
 * Fonte ÚNICA do cutoff `created` que particiona a fila de 1º envio entre
 * `novos` (`isNovos`) e `ramp-warm` (`isRampWarm`, clarice-segment.ts) — sem
 * ela, os dois predicados podiam divergir sobre "o que é a janela novos":
 * antes do #5410, `isRampWarm` não tinha corte nenhum por `created` (era
 * superconjunto de `isNovos`, não complementar), e a separação real dependia
 * só de ORDEM DE EXECUÇÃO (o `novos` rodar e marcar os contatos como `sent`
 * antes de o `envio` das 19:00 montar a onda).
 *
 * Persistido em `data/clarice-subscribers/novos-cutoff.json`. Escrito por
 * `clarice-novos-run.ts` logo após o Passo 1 (`clarice-stripe-delta`)
 * resolver `since` — ANTES do semáforo (Passo 3), que é o ponto que aborta a
 * rodada em vermelho. Gravar ali, e não dentro de `clarice-build-segment.ts
 * --group novos` (que só roda se o semáforo estiver verde), é o que garante
 * que o cutoff reflita a janela que `novos` está tentando cobrir MESMO
 * quando a rodada aborta — exatamente o cenário que fazia `ramp-warm`
 * absorver em silêncio os cadastros represados (#5410, onda `d18-dom16`: 68
 * cadastros de agosto engolidos por uma campanha 98,4% de 2021).
 *
 * Decisão do editor (#5410, 16/08/2026): separação ABSOLUTA, sem regra de
 * envelhecimento — um contato dentro da janela `novos` NUNCA cai em
 * `ramp-warm`, por mais tempo que o semáforo fique vermelho. O represamento
 * fica visível pelo alarme do #5405, não por um teto de dias aqui.
 *
 * Fail-soft (mesmo padrão de `clarice-novos-state.ts`/`clarice-envio-enabled.ts`):
 * leitura tolerante — arquivo ausente/corrompido → `null` (sem cutoff
 * conhecido ainda, ex: 1ª rodada de `novos` nunca rodou nesta base) —
 * `isRampWarm` degrada pra "não exclui por recência", o comportamento
 * pré-#5410 (nunca pior que o estado anterior).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { CLARICE_BASE } from "./clarice-paths.ts";

export interface NovosCutoffState {
  /** `YYYY-MM-DD` — o `since` mais recente que `novos` tentou cobrir (Passo 1). */
  cutoffIso: string;
  /** ISO datetime — quando este cutoff foi gravado (auditoria). */
  recordedAt: string;
}

/** Path do state file. `baseDir` opcional — uso interno de teste (mesmo padrão `--data-root` do resto do projeto). */
export function novosCutoffPath(baseDir: string = CLARICE_BASE): string {
  return resolve(baseDir, "novos-cutoff.json");
}

/** Lê o cutoff persistido. Tolerante: ausente/corrompido/shape inesperado → `null` (nunca lança). */
export function readNovosCutoff(baseDir: string = CLARICE_BASE): NovosCutoffState | null {
  const path = novosCutoffPath(baseDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<NovosCutoffState>;
    if (typeof parsed.cutoffIso !== "string" || !parsed.cutoffIso) return null;
    return {
      cutoffIso: parsed.cutoffIso,
      recordedAt: typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
    };
  } catch {
    return null;
  }
}

/** Escreve o cutoff (escrita atômica — mesmo padrão do resto do projeto). Cria o diretório se faltar. */
export function writeNovosCutoff(cutoffIso: string, baseDir: string = CLARICE_BASE, now: Date = new Date()): void {
  mkdirSync(baseDir, { recursive: true });
  const state: NovosCutoffState = { cutoffIso, recordedAt: now.toISOString() };
  writeFileAtomic(novosCutoffPath(baseDir), JSON.stringify(state, null, 2) + "\n");
}
