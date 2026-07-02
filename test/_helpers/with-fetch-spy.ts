/**
 * test/_helpers/with-fetch-spy.ts (#2812 item 3)
 *
 * Espiona `globalThis.fetch`: registra toda chamada externa e lança (falha o
 * caller imediatamente) — usado para PROVAR "nenhuma chamada externa
 * aconteceu" em testes de caminho fail-closed / KV-only (ex: #2779).
 * Restaura o `fetch` original ao final, sucesso ou erro.
 *
 * Extraído de test/dashboard-coupons-tab.test.ts e test/brevo-dashboard-2733.test.ts,
 * onde a mesma maquinaria estava duplicada (precedente: make-tracked-kv.ts).
 */
export async function withFetchSpy(
  fn: (calls: string[]) => Promise<void>,
): Promise<void> {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    throw new Error("chamada externa proibida neste teste");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}
