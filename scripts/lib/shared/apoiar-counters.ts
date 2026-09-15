/**
 * scripts/lib/shared/apoiar-counters.ts (#7915)
 *
 * Instrumentação MÍNIMA (log-based, não é dashboard) da página `/apoiar`
 * (`workers/site/public/apoiar/index.html`, gerada por `site-apoiar-page.ts`):
 * conta VISUALIZAÇÃO da oferta e CLIQUE pra apoiar, separadamente — nenhum
 * dos dois é receita. A confirmação de pagamento em si continua vindo da
 * fonte de apoio (apoia.se/Stripe) por fora deste repo; a atribuição por
 * coorte (visualização/clique → 1º apoio confirmado) é escopo da issue
 * companheira #7916, não deste módulo.
 *
 * Mesmo molde de `ai-fetch-counters.ts`/`cursos-alarm-counters.ts`/
 * `reativar-alarm-counters.ts` — cada módulo de contador tem sua PRÓPRIA
 * função de incremento (fail-soft por construção, não-atômico get-então-put,
 * volume baixo o suficiente pra isso ser aceitável — ver docstring de
 * `ai-fetch-counters.ts` pro racional completo já registrado uma vez).
 *
 * KV: reusa o binding `CURSOS_SUBSCRIBERS` que `workers/site/wrangler.toml`
 * já declara (mesmo namespace que `ai-fetch-counters.ts` usa lá), prefixo
 * próprio `counter:apoiar:` — não colide com `counter:ai-fetch:site:` nem
 * com `subscriber:`/`rl:`/`cooldown:` de outros Workers que também apontam
 * pro mesmo id de namespace.
 */

/** Chave do contador de VISUALIZAÇÃO — 1 chave cumulativa por dia. */
export function apoiarViewCounterKey(day: string): string {
  return `counter:apoiar:view:${day}`;
}

/** Chave do contador de CLIQUE pra apoiar (`/apoiar/ir` → apoia.se) — 1 chave
 * cumulativa por dia, nunca compartilha namespace com a de visualização. */
export function apoiarClickCounterKey(day: string): string {
  return `counter:apoiar:click:${day}`;
}

/**
 * Incrementa o contador cumulativo em `key` — lê o valor atual (string int,
 * ausente = 0), soma 1, escreve de volta. **Fail-soft por construção**:
 * nunca lança — via lateral de medição, nunca deve atrasar/derrubar a
 * resposta real (a página serve normal, o redirect pra apoia.se acontece,
 * mesmo se o KV estiver indisponível). `kv` pode ser `undefined` (binding
 * ausente em algum ambiente) — nesse caso é NO-OP silencioso.
 */
export async function incrementApoiarCounter(kv: KVNamespace | undefined, key: string): Promise<void> {
  if (!kv) return;
  try {
    const raw = await kv.get(key);
    const current = raw ? parseInt(raw, 10) || 0 : 0;
    await kv.put(key, String(current + 1));
  } catch (err) {
    console.error(
      `[apoiar-counters] incrementApoiarCounter('${key}') falhou — contador pode ficar levemente desatualizado (fail-soft, #7915):`,
      err,
    );
  }
}
