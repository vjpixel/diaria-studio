/**
 * scripts/lib/purge-score-counter-do.ts (#4474)
 *
 * Lógica PURA de assinatura + fetch pro endpoint `POST /admin/purge-score-do`
 * (workers/poll/src/index.ts → handleAdminPurgeScoreDo) — extraída de
 * `scripts/purge-leaderboard.ts` pra ser testável com fetch mockado, sem
 * precisar de wrangler nem rede real. Mesmo padrão de extração de
 * `scripts/lib/purge-leaderboard-plan.ts` (#4433) — `purge-leaderboard.ts`
 * faz parsing de CLI + `process.exit` no TOP-LEVEL do módulo, o que
 * inviabilizaria import direto em teste.
 *
 * ## Por que isso precisa existir (#4474)
 * `purge-leaderboard.ts` apaga o KV inteiro de uma identidade (score,
 * score-by-month, vote, counted, seq) mas nunca tocava o storage interno do
 * Durable Object `ScoreCounter` (`workers/poll/src/score-counter.ts`), que
 * persiste indefinidamente fora do namespace KV que o purge varre. Uma
 * identidade purgada que vote de novo numa edição do MESMO mês civil já
 * purgado ressuscita o dado supostamente apagado — ver rationale completo no
 * header de `score-counter.ts` (bloco "Purge").
 */

import { createHmac } from "node:crypto";
import type { DohFetchInit, DohFetchResponse } from "./doh-fetch.ts";

/** Assinatura injetável de fetch — em produção `dohFetch`, em teste um mock
 * sem rede real. Aceita tanto `DohFetchResponse` quanto `Response` nativo
 * (ambos expõem `ok`/`status`/`json()`). */
export type PurgeScoreCounterFetchFn = (
  url: string,
  init?: DohFetchInit,
) => Promise<DohFetchResponse | Response>;

/**
 * Assina `purge-score-do:{brand}:{email}` com `secret` (ADMIN_SECRET) —
 * mesmo padrão HMAC de `adminSig`/`adminEiaMetaSig` em `close-poll.ts`.
 * Espelhado em `workers/poll/src/index.ts` (`handleAdminPurgeScoreDo`) —
 * mudar um lado sem o outro quebra a verificação.
 */
export function purgeScoreCounterDoSig(secret: string, brand: string, email: string): string {
  return createHmac("sha256", secret).update(`purge-score-do:${brand}:${email}`).digest("hex");
}

export interface PurgeScoreCounterDoResult {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * Chama `POST /admin/purge-score-do` no Worker `poll` — apaga o storage
 * interno do DO `ScoreCounter` da identidade `{brand}:{email}`. `fetchFn` é
 * injetado pelo caller (produção: `dohFetch`; teste: mock sem rede/wrangler).
 *
 * Nunca lança — falhas de rede/parse viram `{ ok: false, error }`, o caller
 * decide se isso é fatal (mesma filosofia fail-soft do resto do purge:
 * `kvDelete` já trata 404 como idempotente, aqui uma falha de purge do DO
 * vira warning printado pelo caller, não aborta o resto do purge de KV).
 */
export async function purgeScoreCounterDo(
  email: string,
  brand: string,
  secret: string,
  workerUrl: string,
  fetchFn: PurgeScoreCounterFetchFn,
): Promise<PurgeScoreCounterDoResult> {
  const sig = purgeScoreCounterDoSig(secret, brand, email);
  let res: DohFetchResponse | Response;
  try {
    res = await fetchFn(`${workerUrl}/admin/purge-score-do`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, brand, sig }),
    });
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }

  let data: { ok?: boolean; error?: string } = {};
  try {
    data = (await res.json()) as { ok?: boolean; error?: string };
  } catch {
    // corpo não-JSON — trata como falha sem lançar.
  }

  const ok = res.ok && data.ok === true;
  return { ok, status: res.status, error: ok ? undefined : (data.error ?? `HTTP ${res.status}`) };
}
