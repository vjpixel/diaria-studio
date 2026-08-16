/**
 * clarice-novos-run-status.ts (#5405)
 *
 * Snapshot do desfecho da ÚLTIMA invocação de `clarice-novos-run.ts` — não
 * confundir com `clarice-novos-state.ts` (`novos-state.json`), que só
 * avança em envio CONFIRMADO (Passos 4-7): uma rodada que aborta no
 * semáforo (Passo 3, D4) nunca toca aquele state, então `lastRunAt` de lá
 * reflete o último ENVIO bem-sucedido, não a última TENTATIVA — exatamente o
 * gap que fazia o aviso do `plan-wave` dizer "considere rodar" quando o
 * `novos` tinha rodado e abortado (#5405).
 *
 * Persistido em `data/clarice-subscribers/last-novos-run-status.json`,
 * escrito por `clarice-novos-run.ts` em TODA invocação real (não em
 * `--dry-run` nem quando o kill switch está pausado — nenhum dos dois é uma
 * tentativa de produção). Consumido por:
 *   - `clarice-novos-abort-alarm.ts` (#5405 item 1) — streak de aborts
 *     consecutivos com o MESMO motivo (`semaphore-red`).
 *   - `clarice-wave-plan.ts`/`clarice-plan-wave.ts` (#5405 item 2) — corrige
 *     o texto do aviso de frescor quando a última tentativa abortou.
 *
 * Fail-soft (mesmo padrão de `clarice-novos-state.ts`/`clarice-novos-cutoff.ts`):
 * leitura tolerante — ausente/corrompido → `null`.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { CLARICE_BASE } from "./clarice-paths.ts";

/**
 * `semaphore-red` — abortou especificamente no guard `clarice-check-semaphore`
 * (D4, #4347) — é o motivo que o alarme do #5405 item 1 rastreia em streak.
 * `other-error` — abortou por qualquer OUTRO motivo (guard de custo MV, teto
 * D13, erro de sub-script) — não conta pro streak de semáforo, mas também
 * não é "sucesso" (não zera o streak nem confirma envio).
 * `empty`/`sent`/`uncertain` — rodada real, sem abort (0 candidatos, envio
 * confirmado, ou disparo cujo status final não foi confirmado — mesma
 * semântica de exit 2 de `clarice-novos-run.ts`).
 */
export type NovosRunStatusValue = "sent" | "empty" | "uncertain" | "semaphore-red" | "other-error";

export interface NovosRunStatus {
  status: NovosRunStatusValue;
  /** ISO — quando esta rodada terminou (mesmo `now()` usado no relatório). */
  checkedAt: string;
  /** Trecho da mensagem de abort (só presente em `semaphore-red`/`other-error`), auditoria. */
  detail?: string;
}

export function novosRunStatusPath(baseDir: string = CLARICE_BASE): string {
  return resolve(baseDir, "last-novos-run-status.json");
}

const KNOWN_STATUSES: readonly NovosRunStatusValue[] = ["sent", "empty", "uncertain", "semaphore-red", "other-error"];

/** Lê o status persistido. Tolerante: ausente/corrompido/shape inesperado → `null` (nunca lança). */
export function readNovosRunStatus(baseDir: string = CLARICE_BASE): NovosRunStatus | null {
  const path = novosRunStatusPath(baseDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<NovosRunStatus>;
    if (typeof parsed.status !== "string" || !KNOWN_STATUSES.includes(parsed.status as NovosRunStatusValue)) return null;
    if (typeof parsed.checkedAt !== "string") return null;
    return {
      status: parsed.status as NovosRunStatusValue,
      checkedAt: parsed.checkedAt,
      detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
    };
  } catch {
    return null;
  }
}

/** Escreve o status (escrita atômica). Cria o diretório se faltar. */
export function writeNovosRunStatus(status: NovosRunStatus, baseDir: string = CLARICE_BASE): void {
  mkdirSync(baseDir, { recursive: true });
  writeFileAtomic(novosRunStatusPath(baseDir), JSON.stringify(status, null, 2) + "\n");
}

/**
 * O motivo do abort foi especificamente o semáforo (D4, `clarice-check-
 * semaphore.ts`)? Pura — inspeciona a mensagem de `NovosAbort` (que sempre
 * prefixa com o label do passo, via `step()` em `clarice-novos-run.ts`) em
 * vez de recodificar o guard aqui — fonte única do texto real.
 */
export function isSemaphoreAbortMessage(message: string): boolean {
  return message.includes("clarice-check-semaphore");
}
