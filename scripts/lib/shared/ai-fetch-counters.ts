/**
 * scripts/lib/shared/ai-fetch-counters.ts (#4902, F-17 do #4558)
 *
 * Toda a medição de GEO do projeto até aqui era do lado do PROMPT
 * (`scripts/lib/geo-citation-monitor.ts`). Do lado do SERVIDOR não existia
 * nenhuma — nenhum Worker lia o `User-Agent` da request, então não havia
 * como distinguir "um bot de recuperação buscou a página e não citou" de
 * "nenhum bot jamais buscou a página". Este módulo fecha esse buraco pro
 * Worker `arquivo` (`workers/arquivo/src/index.ts`): casa o `User-Agent` de
 * cada request contra os UAs de RECUPERAÇÃO nomeados pelos fabricantes
 * (distintos dos UAs de TREINO — GPTBot/ClaudeBot/CCBot/etc., que são o
 * assunto do F-12, não deste) + `Googlebot`/`bingbot`, e incrementa um
 * contador cumulativo por `(bot, dia)` direto no KV.
 *
 * Fonte de cada UA (doc oficial de fabricante, verificada #4902):
 *   - OpenAI (`developers.openai.com/api/docs/bots`): `OAI-SearchBot` (índice
 *     de busca do ChatGPT), `ChatGPT-User` (ação iniciada por usuário).
 *   - Anthropic (`support.claude.com`, artigo 8896518): `Claude-User`
 *     (usuário perguntou), `Claude-SearchBot` (qualidade de busca).
 *   - Perplexity (`docs.perplexity.ai/guides/bots`): `PerplexityBot` (indexa
 *     e linka), `Perplexity-User` (ação do usuário).
 *   - `Googlebot`/`bingbot`: motores de busca tradicionais, incluídos porque
 *     também governam elegibilidade a AI Overviews/Copilot.
 *
 * Molde exato de `scripts/lib/shared/cursos-alarm-counters.ts` (#4382) e
 * `scripts/lib/shared/reativar-alarm-counters.ts` (#4551) — cada módulo de
 * contador tem sua PRÓPRIA função de incremento (não importa de um módulo
 * "irmão"), fail-soft por construção (nunca lança) e assumidamente
 * NÃO-atômico (get então put — sob concorrência real uma corrida pode
 * perder um incremento; aceitável aqui pelo mesmo raciocínio dos módulos
 * irmãos: o volume é baixo e o uso é medição de tendência, não contagem
 * exata auditável).
 *
 * **Sem path/query na chave** (decisão explícita da issue, #4902 item 1):
 * mantém a cardinalidade de chaves baixa e evita qualquer risco de PII via
 * query string (`?email=` do gate de `cursos`, mesma disciplina de
 * `AiReferrerHit.path` em `ai-referrer-log.ts`, que documenta o mesmo
 * cuidado). O contador é por `(bot, dia)` — não por página.
 *
 * KV: reusa o binding `CURSOS_SUBSCRIBERS` já existente (id
 * `a3415c3bf4b840d6975dbac290b99153`, `workers/cursos/wrangler.toml`), com
 * prefixo próprio `counter:ai-fetch:` — não colide com `subscriber:{hash}`
 * nem `rl:`/`cooldown:` (`cursos`) nem `counter:cursos-alarm:` (mesmo
 * namespace, prefixo distinto). Ver `scripts/sync-cursos-subscribers-kv.ts`:
 * o sync diário lista só `--prefix "subscriber:"` antes do diff de delete —
 * é essa cláusula que impede o sync de apagar as chaves deste módulo.
 */

/** Os 8 UAs de recuperação nomeados (issue #4902) — 6 de assistente + 2 de
 * busca tradicional. Nenhum destes tokens é substring de outro (verificado:
 * "PerplexityBot" não contém nem é contido por "Perplexity-User"; "Claude-User"
 * não contém nem é contido por "Claude-SearchBot"), então o casamento abaixo
 * não depende de ordem nem produz ambiguidade entre eles. */
export const AI_FETCH_BOTS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Googlebot",
  "bingbot",
] as const;
export type AiFetchBot = (typeof AI_FETCH_BOTS)[number];

/**
 * Casa o header `User-Agent` de uma request contra os 8 UAs nomeados —
 * case-insensitive, substring match. Retorna `null` se ausente ou se não
 * bater com nenhum. Nunca lança.
 *
 * Deliberadamente NÃO casa os UAs de TREINO (`GPTBot`, `ClaudeBot`, `CCBot`,
 * `Google-Extended`, `Bytespider`, `meta-externalagent`, `Applebot-Extended`,
 * `Amazonbot`) — são um assunto diferente (F-12), e nenhum desses tokens é
 * substring de nenhum dos 8 nomeados aqui (`"GPTBot"` não contém nem está
 * contido em `"OAI-SearchBot"`/`"ChatGPT-User"`; `"ClaudeBot"` não contém
 * nem está contido em `"Claude-User"`/`"Claude-SearchBot"`), então um UA de
 * treino puro nunca é mal-contado como UA de recuperação.
 */
export function matchAiFetchBot(userAgent: string | null | undefined): AiFetchBot | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  for (const bot of AI_FETCH_BOTS) {
    if (ua.includes(bot.toLowerCase())) return bot;
  }
  return null;
}

/** Chave KV do contador de FETCH por bot nomeado — 1 chave por `(bot, dia)`.
 * `day` é `YYYY-MM-DD` (mesmo formato de `GeoCitationRecord.date`). */
export function aiFetchBotCounterKey(bot: AiFetchBot, day: string): string {
  return `counter:ai-fetch:bot:${bot}:${day}`;
}

/** Chave KV do contador de hit de REFERER de assistente (#4902 item 2) —
 * persiste o que `ai-referrer-log.ts::matchAiReferrerHost` já detecta mas só
 * loga via `console.log` (sem retenção). `host` é um dos `AI_REFERRER_HOSTS`
 * (`chatgpt.com`, `perplexity.ai`, `claude.ai`, `gemini.google.com`); tipado
 * como `string` aqui (em vez de importar `AiReferrerHost`) pra este módulo
 * não depender de `ai-referrer-log.ts` — os 2 módulos ficam desacoplados,
 * o call site (`workers/arquivo/src/index.ts`) já importa ambos. */
export function aiFetchReferrerCounterKey(host: string, day: string): string {
  return `counter:ai-fetch:referrer:${host}:${day}`;
}

/**
 * Incrementa o contador cumulativo em `key` — lê o valor atual (string int,
 * ausente = 0), soma 1, escreve de volta. **Fail-soft por construção**:
 * nunca lança — via lateral de alarme/medição, não o caminho principal do
 * request. `kv` pode ser `undefined` (binding ainda não propagado em algum
 * ambiente) — nesse caso é NO-OP silencioso, mesmo padrão de
 * `incrementReativarAlarmCounter` (`reativar-alarm-counters.ts`).
 */
export async function incrementAiFetchCounter(kv: KVNamespace | undefined, key: string): Promise<void> {
  if (!kv) return;
  try {
    const raw = await kv.get(key);
    const current = raw ? parseInt(raw, 10) || 0 : 0;
    await kv.put(key, String(current + 1));
  } catch (err) {
    console.error(
      `[ai-fetch-counters] incrementAiFetchCounter('${key}') falhou — contador pode ficar levemente desatualizado (fail-soft, #4902):`,
      err,
    );
  }
}
