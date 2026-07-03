/**
 * newsletter-capture-failure.ts (#2878)
 *
 * Sentinel shared between `scripts/fetch-newsletter-threads.ts` (Stage 0
 * step 0b-bis) and `scripts/inject-inbox-urls.ts` (Stage 1 step 1h) to
 * distinguish "0 real" (editor genuinely sent 0 newsletter emails) from
 * "0b-bis falhou" (OAuth invalid_client / network — 0 is an artifact of the
 * failure, not a fact about the editor's day).
 *
 * Bug (#2878): edição 260703 saiu com "enviei 0 submissões" na coverage
 * line, mas a causa real era `fetch-newsletter-threads.ts` saindo exit 1
 * por `invalid_client` (OAuth quebrado nesta máquina). O passo 0b-bis é
 * "skip silencioso" por design (#1756) quando a falha é de auth/rede — mas
 * o skip não deixava rastro pro resto da pipeline, que seguia tratando 0
 * como contagem legítima.
 *
 * Fluxo:
 * 1. `fetch-newsletter-threads.ts` grava este sentinel (via
 *    `writeCaptureFailedSentinel`) ao lado do seu `--out`
 *    (`captured-newsletters.json`) quando sai por erro fatal (auth/rede).
 * 2. `inject-inbox-urls.ts` lê o sentinel (via `readCaptureFailedSentinel`)
 *    ao montar o marker `.marker-inject-inbox-urls.json` e propaga
 *    `capture_failed`/`capture_error` pros `details` do marker.
 * 3. `sync-coverage-line.ts` e o invariant check de Stage 4
 *    (`checkCaptureFailedSubmissionCount`) leem o marker e evitam afirmar
 *    "0 submissões" quando `capture_failed` é `true`.
 *
 * Path do sentinel: sempre um arquivo pontinho (`.capture-newsletter-failed.json`)
 * dentro do MESMO diretório onde `fetch-newsletter-threads.ts` escreveria seu
 * `--out` — tipicamente `data/editions/{AAMMDD}/_internal/`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface CaptureFailureSentinel {
  failed: true;
  error: string;
  at: string; // ISO timestamp
}

/** Resolve o path do sentinel a partir do diretório `_internal` da edição. */
export function captureFailedSentinelPath(internalDir: string): string {
  return join(internalDir, ".capture-newsletter-failed.json");
}

/**
 * Grava o sentinel de falha ao lado de `outPath` (o `--out` de
 * `fetch-newsletter-threads.ts`). Best-effort: uma falha ao escrever o
 * sentinel nunca deve mascarar o erro original que o chamou — engolir e
 * seguir.
 */
export function writeCaptureFailedSentinel(outPath: string, err: unknown): void {
  try {
    const internalDir = dirname(resolve(process.cwd(), outPath));
    mkdirSync(internalDir, { recursive: true });
    const msg = err instanceof Error ? err.message : String(err);
    const sentinel: CaptureFailureSentinel = {
      failed: true,
      error: msg.slice(0, 300),
      at: new Date().toISOString(),
    };
    writeFileSync(
      captureFailedSentinelPath(internalDir),
      JSON.stringify(sentinel, null, 2) + "\n",
      "utf8",
    );
  } catch {
    /* best-effort — nunca mascarar o erro original */
  }
}

/**
 * Lê o sentinel de `internalDir` (diretório `_internal` da edição). Retorna
 * `null` quando ausente, corrompido, ou com shape inesperado (defensive —
 * ausência de sinal nunca deve virar `capture_failed: true` por engano).
 */
export function readCaptureFailedSentinel(internalDir: string): CaptureFailureSentinel | null {
  const p = captureFailedSentinelPath(internalDir);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    if (data && data.failed === true && typeof data.error === "string") {
      return data as CaptureFailureSentinel;
    }
    return null;
  } catch {
    return null;
  }
}
