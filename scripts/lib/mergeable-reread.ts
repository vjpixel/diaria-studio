/**
 * mergeable-reread.ts (#12950)
 *
 * O GitHub calcula `mergeable` sob demanda e volta a `UNKNOWN` a cada push na
 * base. Com o master recebendo merges o tempo todo, uma leitura única cai em
 * `UNKNOWN` com frequência: é estado transitório, não bloqueio. Antes deste
 * módulo, `check-continuo-merge-gate.ts` lia uma vez e escalava; #12896 e
 * #12897 (aprovadas, CI verde) ficaram 1-2 dias escaladas com
 * `mergeable=UNKNOWN`, e uma segunda leitura segundos depois devolvia
 * `MERGEABLE`.
 *
 * Regra: só `UNKNOWN` (ou valor ilegível) dispara nova leitura, com espera
 * curta entre as tentativas. `MERGEABLE` e `CONFLICTING` são definitivos e
 * param na hora. `UNKNOWN` que persiste depois de todas as tentativas segue
 * `UNKNOWN`: o chamador continua fail-closed (escala).
 *
 * Puro: leitura e espera são injetadas, para o teste rodar sem rede nem
 * relógio.
 */

export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** Normaliza o campo `mergeable` do `gh pr view --json mergeable`. */
export function normalizeMergeable(raw: unknown): MergeableState | null {
  return raw === "MERGEABLE" || raw === "CONFLICTING" || raw === "UNKNOWN" ? raw : null;
}

/** Tentativas EXTRAS (além da leitura inicial) e espera entre elas. */
export const MERGEABLE_REREAD_ATTEMPTS = 3;
export const MERGEABLE_REREAD_DELAY_MS = 5_000;

export interface MergeableRereadResult {
  mergeable: MergeableState | null;
  /** Quantas leituras extras foram feitas (0 = a inicial já decidiu). */
  rereads: number;
}

/**
 * Relê `mergeable` enquanto vier `UNKNOWN`/ilegível. `read` devolve o valor
 * cru (ou lança: leitura que falha conta como mais um `null`, nunca vira
 * `MERGEABLE`).
 */
export function rereadMergeableWhileUnknown(
  initial: unknown,
  read: () => unknown,
  sleep: (ms: number) => void,
  attempts: number = MERGEABLE_REREAD_ATTEMPTS,
  delayMs: number = MERGEABLE_REREAD_DELAY_MS,
): MergeableRereadResult {
  let current = normalizeMergeable(initial);
  let rereads = 0;
  while ((current === "UNKNOWN" || current === null) && rereads < attempts) {
    sleep(delayMs);
    rereads++;
    try {
      current = normalizeMergeable(read());
    } catch {
      current = null;
    }
  }
  return { mergeable: current, rereads };
}

/** Espera síncrona real (`Atomics.wait`), mesmo padrão de `file-lock.ts`. */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
