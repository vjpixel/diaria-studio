/**
 * scripts/lib/shared/reativar-alarm-counters.ts (#4551)
 *
 * Espelha `scripts/lib/shared/cursos-alarm-counters.ts` (#4382, redesign do
 * #4320) pro worker `reativar` (`workers/reativar/src/index.ts`): em vez de
 * um alarme baseado em texto de log (`console.error`/`console.warn`), o
 * worker incrementa contadores CUMULATIVOS direto num KV nos mesmos pontos
 * onde `checkNativeUnsubscribePending` já loga cada um dos 3 motivos de
 * fail-open (#4538 item B / #4545 review).
 *
 * Este módulo é o ÚNICO ponto que define as chaves KV e a lógica de
 * incremento — importado tanto pelo worker (`workers/reativar/src/index.ts`,
 * via path relativo) quanto, indiretamente (só as chaves), por um futuro
 * script de alarme leitor (mesmo papel de `scripts/cursos-error-alarm.ts`
 * pro par acima — **não implementado nesta unidade**, ver PR #4551: só o
 * MECANISMO de contagem entra aqui, a task agendada + 1ª execução ao vivo
 * ficam pendentes do editor, mesma disciplina já normalizada em CLAUDE.md
 * pros #4320/#4382/#4490/#4534).
 *
 * ## 4 contadores, 3 motivos (#4551 — pedido explícito da issue)
 *
 * `checkNativeUnsubscribePending` tem 3 branches de fail-open
 * (`NativeUnsubscribeCheck["reason"]`): `no_api_key`, `http_error`,
 * `network_error`. O pedido da issue detalha uma SUB-contagem dentro de
 * `http_error` pra 401/403 (credencial inválida/revogada — bug persistente,
 * não hiccup transitório da Brevo): por isso 4 chaves, não 3 — todo
 * `http_error` incrementa `httpError`, e quando o status é 401/403 ele
 * TAMBÉM incrementa `httpErrorAuthDenied` (não é mutuamente exclusivo — é um
 * refinamento aditivo do mesmo bucket, permitindo o alarme distinguir "409
 * genérico" de "quase certamente credencial morta" sem perder a contagem
 * agregada).
 */

/** Chaves KV dos 4 contadores cumulativos — nunca resetam sozinhas, só somam.
 * Prefixo `counter:reativar-alarm:fail-open:` pra ficar auto-descritivo e não
 * colidir com nenhuma outra chave que venha a existir no mesmo namespace. */
export const REATIVAR_ALARM_COUNTER_KEYS = {
  /** `BREVO_DIARIA_API_KEY` ausente — esperado/documentado (secret novo,
   * armamento pendente do editor), não um bug. */
  noApiKey: "counter:reativar-alarm:fail-open:no-api-key",
  /** Qualquer resposta HTTP não-2xx da Brevo (`GET /v3/contacts/{email}`),
   * incluindo 401/403 (ver `httpErrorAuthDenied` abaixo, sub-contagem). */
  httpError: "counter:reativar-alarm:fail-open:http-error",
  /** Sub-contagem de `httpError` — especificamente 401/403. Incrementado
   * JUNTO com `httpError` (aditivo, não substitui) quando o status é um
   * desses dois — sinal de credencial revogada/inválida, não hiccup. */
  httpErrorAuthDenied: "counter:reativar-alarm:fail-open:http-error-401-403",
  /** Exceção de rede (timeout, DNS, conexão recusada etc.) ao consultar a Brevo. */
  networkError: "counter:reativar-alarm:fail-open:network-error",
} as const;

export type ReativarAlarmCounterKey = (typeof REATIVAR_ALARM_COUNTER_KEYS)[keyof typeof REATIVAR_ALARM_COUNTER_KEYS];

/**
 * Incrementa o contador cumulativo em `key` — lê o valor atual (string int,
 * ausente = 0), soma 1, escreve de volta. **Fail-soft por construção**: nunca
 * lança, e é NO-OP silencioso quando `kv` é `undefined` (binding
 * `REATIVAR_ALARM` ainda não criado/declarado — ver `workers/reativar/wrangler.toml`).
 * Esta é uma via lateral de ALARME/observabilidade, não o caminho principal
 * do request — nem a ausência do binding nem uma falha do KV podem
 * transformar uma degradação já tratada (fail-open, 502/503 — todos já
 * fail-soft) num throw não capturado que derruba a resposta ao visitante.
 * Mesmo raciocínio de `incrementKvCounter` em `cursos-alarm-counters.ts` (#4382).
 *
 * Não-atômico (get então put) — mesmo trade-off aceito lá: o worker
 * `reativar` é baixo tráfego (população cap 300) e o uso é um ALARME de
 * limiar, não uma contagem exata.
 */
export async function incrementReativarAlarmCounter(kv: KVNamespace | undefined, key: ReativarAlarmCounterKey): Promise<void> {
  if (!kv) return; // binding ainda não criado — ver docstring do módulo.
  try {
    const raw = await kv.get(key);
    const current = raw ? parseInt(raw, 10) || 0 : 0;
    await kv.put(key, String(current + 1));
  } catch (err) {
    console.error(
      `[reativar-alarm-counters] incrementReativarAlarmCounter('${key}') falhou — contador de alarme pode ficar levemente desatualizado (fail-soft, #4551):`,
      err,
    );
  }
}
