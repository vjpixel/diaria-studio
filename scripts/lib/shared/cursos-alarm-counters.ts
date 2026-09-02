/**
 * scripts/lib/shared/cursos-alarm-counters.ts (#4382, redesign do #4320)
 *
 * #4382: `scripts/cursos-error-alarm.ts` consultava a Cloudflare GraphQL
 * Analytics API (dataset `workersInvocationsAdaptiveGroups`) tentando grep de
 * texto de log — CONFIRMADO ao vivo (com credenciais reais) que esse campo
 * não existe no schema exposto: `unknown field "workersInvocationsAdaptiveGroups"`,
 * mesmo numa query mínima sem a sub-seleção `logs{}`. Não é erro de
 * permissão — o campo genuinamente não existe. A API pública GraphQL
 * Analytics parece expor só métricas AGREGADAS (requests, erros por status,
 * CPU time), não o conteúdo de mensagens de log individuais.
 *
 * Redesign: em vez de tentar ler o CONTEÚDO dos logs de fora via Analytics
 * API, o worker `cursos` incrementa 4 contadores cumulativos DIRETO no KV
 * `CURSOS_SUBSCRIBERS` (mesmo namespace do sync de assinantes, #4052) nos
 * mesmos pontos onde já loga via `console.error`/`console.warn`/`console.log`
 * — o log textual continua existindo (útil pra `wrangler tail`/Workers Logs),
 * mas o ALARME passa a ler os contadores, não o texto.
 *
 * Este módulo é o ÚNICO ponto que define as chaves KV e a lógica de
 * incremento — importado pelo worker (`workers/cursos/src/index.ts`,
 * `subscribe.ts`, via path relativo, mesmo padrão de
 * `scripts/lib/shared/rate-limit.ts`/`subscriber-verify.ts`). Até #6798
 * (01/09/2026) também tinha um leitor indireto (só as chaves) em
 * `scripts/cursos-error-alarm.ts` (lado Node, via `getTextFromWorkerKV` —
 * HTTP fetch injetável, não o binding KV nativo do runtime Workers); esse
 * leitor foi removido nessa issue (279 execuções, 0 disparos, ver
 * `docs/cursos-worker-alarm-setup.md`). Os contadores continuam sendo
 * gravados sem leitor hoje — removê-los exigiria deploy do worker sem
 * ganho claro (decisão do editor, #6798).
 */

/** Chaves KV dos 4 contadores cumulativos — nunca resetam sozinhas, só somam.
 * Prefixo `counter:cursos-alarm:` pra não colidir com `subscriber:{hash}`
 * (verificação de assinante) nem `rl:`/`cooldown:` (rate-limit/cooldown) já
 * usados neste mesmo namespace. */
export const CURSOS_ALARM_COUNTER_KEYS = {
  /** Qualquer ocorrência de "COOKIE_HMAC_SECRET ausente" — `handleIndex`,
   * `handleGateVerify` (index.ts) e `handleGateSubscribe` (subscribe.ts). */
  fatalCookieHmacSecretAusente: "counter:cursos-alarm:fatal:cookie-hmac-secret-ausente",
  /** Qualquer ocorrência de "cadastro na Beehiiv falhou" — `handleGateSubscribe`
   * (subscribe.ts), só quando a Beehiiv respondeu e a resposta não foi ok
   * (não conta `not_configured`/secrets ausentes, que é uma condição distinta). */
  fatalCadastroBeehiivFalhou: "counter:cursos-alarm:fatal:cadastro-beehiiv-falhou",
  /** `?email=` confirmado como assinante ativo — branch de SUCESSO de `handleIndex`. */
  emailGateConfirmed: "counter:cursos-alarm:email-gate:confirmed",
  /** `?email=` NÃO confirmado como assinante ativo (negativo confirmado, NÃO
   * `verification_failed` — ver #4321) — branch de falha de `handleIndex`. */
  emailGateNotConfirmed: "counter:cursos-alarm:email-gate:not-confirmed",
} as const;

/**
 * Incrementa o contador cumulativo em `key` — lê o valor atual (string int,
 * ausente = 0), soma 1, escreve de volta. **Fail-soft por construção**: nunca
 * lança. Esta é uma via lateral de ALARME, não o caminho principal do
 * request — um KV instável não pode transformar uma degradação já tratada
 * (teaser, 502, 503 — todos already fail-soft) num throw não capturado que
 * derruba a resposta ao visitante. Mesmo raciocínio de `RemoteKvNamespace`
 * (`scripts/lib/cloudflare-kv-upload.ts`, #4165/#4173).
 *
 * Não-atômico (get então put) — sob concorrência real, uma corrida pode
 * perder um incremento (2 requests simultâneos leem o mesmo valor antes de
 * qualquer um escrever). Aceitável aqui: o worker `cursos` é baixo tráfego, o
 * uso é um ALARME de limiar (a diferença entre "12 erros" e "11 erros" nunca
 * muda a decisão de disparar), e o mesmo trade-off de consistência eventual
 * já é aceito em `checkKvRateLimit` (`scripts/lib/shared/rate-limit.ts`).
 */
export async function incrementKvCounter(kv: KVNamespace, key: string): Promise<void> {
  try {
    const raw = await kv.get(key);
    const current = raw ? parseInt(raw, 10) || 0 : 0;
    await kv.put(key, String(current + 1));
  } catch (err) {
    console.error(
      `[cursos-alarm-counters] incrementKvCounter('${key}') falhou — contador de alarme pode ficar levemente desatualizado (fail-soft, #4382):`,
      err,
    );
  }
}
