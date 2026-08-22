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
 *   - `clarice-wave-plan.ts`/`clarice-plan-wave.ts` (#5405 item 2) — corrige
 *     o texto do aviso de frescor quando a última tentativa abortou.
 *   (O consumidor original #5405 item 1 — streak do alarme de abort — foi
 *   removido no #5922 junto com o próprio alarme: o único status que ele
 *   rastreava, `semaphore-red`, deixou de ser produzido quando o guard D4
 *   saiu do caminho `novos` no #5660.)
 *
 * Fail-soft (mesmo padrão de `clarice-novos-state.ts`/`clarice-novos-cutoff.ts`):
 * leitura tolerante — ausente/corrompido → `null`.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { CLARICE_BASE } from "./clarice-paths.ts";

/**
 * `other-error` — abortou por qualquer motivo (guard de custo MV, teto D13,
 * erro de sub-script) — não é "sucesso" (não confirma envio).
 * `empty`/`sent`/`uncertain` — rodada real, sem abort (0 candidatos, envio
 * confirmado, ou disparo cujo status final não foi confirmado — mesma
 * semântica de exit 2 de `clarice-novos-run.ts`).
 * (`semaphore-red` existiu até #5922 — status produzido pelo guard D4 que o
 * #5660 retirou do caminho `novos`; arquivos antigos com esse valor passam a
 * ler como `null`, que é o tratamento correto pra um status sem significado.)
 */
export type NovosRunStatusValue = "sent" | "empty" | "uncertain" | "other-error";

export interface NovosRunStatus {
  status: NovosRunStatusValue;
  /** ISO — quando esta rodada terminou (mesmo `now()` usado no relatório). */
  checkedAt: string;
  /** Trecho da mensagem de abort (só presente em `other-error`), auditoria. */
  detail?: string;
}

export function novosRunStatusPath(baseDir: string = CLARICE_BASE): string {
  return resolve(baseDir, "last-novos-run-status.json");
}

const KNOWN_STATUSES: readonly NovosRunStatusValue[] = ["sent", "empty", "uncertain", "other-error"];

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

