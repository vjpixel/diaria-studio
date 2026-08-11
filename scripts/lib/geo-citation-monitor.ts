/**
 * lib/geo-citation-monitor.ts (#4558 Parte C)
 *
 * Núcleo puro/testável do "monitor de citação, feito em casa" pedido pela
 * issue: consulta um conjunto FIXO de perguntas em pt-BR relevantes ao
 * posicionamento da diar.ia.br (newsletter diária de IA, cursos, livros,
 * jogo "É IA?") via API OFICIAL de 3 assistentes — Claude (Anthropic),
 * ChatGPT (OpenAI) e Gemini (Google) — checando se `diar.ia.br` aparece na
 * resposta. NUNCA via scraping da interface de chat (proibido pelo
 * princípio operacional "Nunca correr risco de ToS" do CLAUDE.md).
 *
 * **Perplexity fica de fora do monitor de propósito** — não tem API de chat
 * oficial de baixo custo equivalente (Sonar API é paga por token, sem free
 * tier, e a issue já cita "poucos dólares por mês" como orçamento-alvo;
 * ver #4466 pro teto de CAC). O log de Referer (`ai-referrer-log.ts`) SIM
 * cobre Perplexity — captura tráfego mesmo sem depender da API deles.
 *
 * **Não executado ao vivo nesta sessão** — sem `ANTHROPIC_API_KEY`/
 * `OPENAI_API_KEY`/`GEMINI_API_KEY` reais no worktree isolado (mesma
 * disciplina de scripts operacionais dos #4320/#4382/#4490/#4534). O
 * mecanismo está pronto e testável via injeção de dependência
 * (`fetchImpl`), mesmo padrão de `scripts/gsc-submit-sitemaps.ts`
 * (`fetchImpl: FetchLike = gFetch`). Rodar 1x com credenciais reais é ação
 * pendente do editor.
 *
 * **Shapes de request/response são best-effort** — a API da Anthropic foi
 * verificada contra a skill `claude-api` desta sessão (web_search_20260209,
 * `web_search_tool_result`); as da OpenAI/Google são escritas do
 * conhecimento geral do modelo e PRECISAM ser conferidas contra a
 * documentação oficial atual antes da 1ª execução ao vivo — os testes deste
 * módulo cobrem o CONTRATO interno (parsing determinístico de uma resposta
 * fixture), não a forma exata da API real.
 *
 * **`ANTHROPIC_API_KEY` está ativa desde 11/ago/2026 (#4904).** Chegou a
 * ficar deliberadamente ausente por decisão do editor (evitar o setup de
 * uma key de Console pay-as-you-go — sistema de billing separado da
 * assinatura do Claude Code, mesmo login, mesma identidade), mas a decisão
 * foi revertida no mesmo dia: o editor criou a org no Console
 * (`console.anthropic.com`), comprou
 * US$5 de crédito e gerou a key. Os 3 providers (`OPENAI_API_KEY`,
 * `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, todos no `.env`) rodam de verdade
 * agora. **Achado ao vivo que ainda importa:** a Anthropic tem latência
 * MUITO mais variável que OpenAI/Google — mesma pergunta isolada deu 25s,
 * 60s (timeout), 25s, e depois 180s (timeout, mesmo com `max_uses`
 * reduzido) em tentativas separadas. `GeoProviderDef.timeoutMs` (120s) e
 * `max_uses: 2` (redução de custo, não de latência — ver as duas
 * docstrings) são a resposta pragmática: falhas ocasionais da Anthropic
 * são esperadas e tratadas fail-soft, não um bug a perseguir. Ver
 * `docs/geo-citation-monitor-setup.md` § "Captura de usage e teto de
 * custo" pro raciocínio completo e `GEO_NON_ANTHROPIC_TOKEN_PRICING`
 * (abaixo) pro custo real medido em OpenAI/Google.
 *
 * **Resiliência (#4616, fleet review da PR #4616 que introduziu este
 * módulo):** `queryProvider` tem timeout explícito (`GEO_PROVIDER_TIMEOUT_MS`,
 * 25s — mesma referência de `DEFAULT_FETCH_TIMEOUT_MS` do fetch in-page do
 * Beehiiv), separa o catch de rede do catch de parse/extração, e devolve
 * `errorKind`/`httpStatus` pra tornar a ORIGEM do erro auditável (rede vs.
 * HTTP vs. parse vs. regressão de `extractText`) em vez de um `error: string`
 * solto e indistinguível. `runGeoCitationMonitor` faz 1 retry com backoff
 * curto (`GEO_RATE_LIMIT_RETRY_DELAY_MS`) especificamente pra 429 — outros
 * erros não são retentados de propósito (rede/parse/extract tendem a não ser
 * transitórios da mesma forma que rate-limit, e mais retries alongaria as
 * ~24 chamadas seriais de uma rodada completa sem ganho claro).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { appendFileWithRetry } from "./source-runs.ts";
import { estimateCallCostUsd } from "./pricing.ts";

/** Perguntas fixas, pt-BR, relevantes ao posicionamento da diar.ia.br —
 * newsletter diária de IA, cursos, livros, jogo "É IA?". Fixo de propósito
 * (não gerado dinamicamente): o objetivo é medir a MESMA pergunta ao longo
 * do tempo, não amostrar perguntas diferentes a cada rodada. */
export const GEO_QUESTIONS: readonly string[] = [
  "Qual a melhor newsletter diária sobre inteligência artificial em português?",
  "Existe alguma newsletter brasileira que resume as notícias de IA todo dia?",
  "Onde encontro cursos gratuitos de inteligência artificial em português?",
  "Quais livros sobre inteligência artificial você recomenda em português?",
  "Como faço pra me manter atualizado sobre inteligência artificial gastando pouco tempo?",
  "Quais newsletters de IA em português vale a pena assinar?",
  "Existe algum jogo ou teste pra saber se uma imagem foi feita por IA?",
  "Quais são as melhores fontes de curadoria de notícias de inteligência artificial no Brasil?",
] as const;

/** Painel de perguntas — `"geral"` são as 8 originais acima (posicionamento
 * da diar.ia.br); `"hubs"` é o painel novo (#4900 item a), temático,
 * derivado das perguntas frequentes que as páginas `arquivo.diar.ia.br/temas/{slug}`
 * já respondem (`scripts/lib/hubs/*.ts`). Um registro sem `panel` (escrito
 * antes desta mudança) é lido como `"geral"` por default — ver `panel` em
 * `GeoCitationRecord` e `summarizeGeoCitationRecords`. */
export type GeoQuestionPanel = "geral" | "hubs";

/**
 * Perguntas fixas, pt-BR, do painel TEMÁTICO (#4900 item a) — cobrem
 * exatamente o que as 3 páginas de hub existentes (`scripts/lib/hubs/anthropic-claude.ts`,
 * `openai-chatgpt.ts`, `google-gemini.ts`) respondem: cronologia recente de
 * cada empresa. Deliberadamente um painel SEPARADO de `GEO_QUESTIONS`, não
 * uma adição a ele — trocar o instrumento original depois de já ter visto o
 * resultado da série (24 registros de `GEO_QUESTIONS`, baseline desde 07/ago)
 * invalidaria essa série (achado #4900, citando o comentário de 07/ago na
 * #4558 que já tinha amarrado as 8 perguntas originais à decisão antes do
 * resultado). Baseline/data de início própria deste painel: ver comentário
 * do F-17 (#4558) — registrado lá antes da 1ª rodada real.
 *
 * **Ativo no cron desde 10/08/2026** (#4900). A ativação estava condicionada
 * a fechar o duplo escritor primeiro (item c / épica #4798), senão cada
 * painel novo multiplicaria registro perdido a cada rodada. Condição
 * cumprida: #4806 desarmou as tasks do Windows e #4807 armou as do Linux, e
 * a investigação do item c mostrou que o arquivo de conflito era subconjunto
 * estrito do bom (nenhuma medição perdida) — os dois arquivos de conflito
 * foram removidos.
 *
 * **A lista é escrita à mão de propósito, e NÃO deve ser derivada de
 * `HUB_META`/`HUB_LOADERS`.** É contraintuitivo — o contrato de prosa do
 * #4899 fez exatamente o contrário, iterando o registry pra que hub futuro
 * nascesse coberto —, mas aqui o efeito seria o oposto do desejado:
 * publicar um hub novo passaria a MUTAR o instrumento de medição no meio da
 * série, que é precisamente o que a regra de parada de outubro proíbe
 * (comentário de 07/08 na #4558: trocar as perguntas depois de ver o
 * resultado invalida a comparação). Um lint que ADICIONA pergunta sozinho
 * contamina a série; um que AVISA que falta pergunta, não. Por isso a
 * cobertura é garantida por guard, não por derivação — ver
 * `test/geo-hub-questions-cobrem-hubs-4900.test.ts`, que reprova quando
 * `HUB_META` tem hub sem pergunta correspondente. Quando esse teste
 * quebrar, a decisão é do editor: acrescentar as perguntas e RESETAR o
 * baseline, ou registrar que o hub novo fica fora da série corrente. */
export const GEO_HUB_QUESTIONS: readonly string[] = [
  "O que aconteceu com a Anthropic em 2026?",
  "Quando saiu o Claude Opus 5?",
  "O que aconteceu com a OpenAI e o ChatGPT em 2026?",
  "Quanto vale a OpenAI hoje?",
  "O que aconteceu com o Google Gemini em 2026?",
  "O Gemini já superou o ChatGPT em algum ranking?",
  // #4900: o hub Meta/Meta AI foi publicado em 10/08 (#4926) e o painel
  // ficou sem pergunta pra ele — acrescentadas ANTES da 1ª rodada real, que
  // é a única janela em que dá pra mexer sem invalidar a série.
  "O que aconteceu com a Meta e a IA em 2026?",
  "Por que a Meta abandonou o open source do Llama?",
  "Como está a disputa entre OpenAI, Google e Anthropic em 2026?",
  "Qual foi o maior investimento em infraestrutura de IA anunciado em 2026?",
] as const;

/** Domínio checado nas respostas (sem protocolo/path — substring match). */
export const GEO_TARGET_DOMAIN = "diar.ia.br";

export type GeoProviderId = "anthropic" | "openai" | "google";

/**
 * Usage bruto de UMA chamada, extraído da resposta (#4904). Todos os campos
 * opcionais — cada provider expõe um subconjunto diferente (só a Anthropic
 * foi verificada contra doc oficial ao vivo, ver docstring do módulo).
 * `cacheCreationInputTokens`/`cacheReadInputTokens` existem só pra permitir
 * repassar o usage da Anthropic pra `estimateCallCostUsd` (`pricing.ts`,
 * que já aplica os multiplicadores de cache) sem perder precisão — OpenAI/
 * Google nunca os populam (não têm o conceito de prompt caching na mesma
 * forma), e ficam sempre `undefined` nesses dois.
 */
export interface GeoProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Contagem de buscas server-side executadas nesta chamada, quando o
   * provider expõe (ex: Anthropic `usage.server_tool_use.web_search_requests`
   * — cada chamada habilita até `max_uses: 2`, #4904 — reduzido de 5 por
   * custo, não por latência (ver docstring de `GeoProviderDef.timeoutMs`
   * pra por que reduzir não resolveu os timeouts). Cada busca é cobrada
   * à parte do token (US$10/1000 na Anthropic) — `estimateCallCostUsd`
   * (`pricing.ts`) NÃO inclui esse custo, só token; ver `estimatedCostUsd`
   * em `GeoCitationRecord` pro aviso de que o valor é um PISO. */
  searchCount?: number;
}

export interface GeoProviderDef {
  id: GeoProviderId;
  label: string;
  /** Nome da env var com a API key. */
  envKey: string;
  /** Model ID default — sobrescrevível via env var `{ENVKEY}_MODEL` no CLI (ver main()). */
  defaultModel: string;
  /** Monta a URL + `RequestInit` pra este provider. Pure. */
  buildRequest(question: string, apiKey: string, model: string): { url: string; init: RequestInit };
  /** Extrai o texto concatenado de uma resposta JSON já parseada. Pure,
   * defensivo — nunca lança, retorna string vazia se a forma não bater. */
  extractText(json: unknown): string;
  /** Extrai o usage bruto (#4904) — MESMO contrato de `extractText`: pure,
   * defensivo, nunca lança; retorna `undefined` (não um objeto zerado) se a
   * forma não bater ou nenhum campo estiver presente, pra distinguir "não
   * consegui ler usage desta resposta" de "usage leu como zero". Opcional —
   * um provider sem `extractUsage` simplesmente não tem usage capturado
   * (`queryProvider` trata a ausência como `undefined`, nunca lança). */
  extractUsage?(json: unknown): GeoProviderUsage | undefined;
  /** Override de timeout por provider (#4904 item 4, achado ao vivo
   * 11/ago/2026) — `undefined` usa `GEO_PROVIDER_TIMEOUT_MS`. Existe porque
   * a Anthropic estourou os 25s padrão em 8/8 chamadas de uma rodada real:
   * `web_search` pode encadear buscas server-side antes de responder,
   * sequência bem mais lenta e mais VARIÁVEL que a busca single-shot da
   * OpenAI/Google.
   *
   * **A variância é real e não é explicada só por `max_uses`** — medido ao
   * vivo (11/ago/2026), várias chamadas isoladas com a MESMA pergunta:
   * 25s (sucesso), 60s (timeout), 25s (sucesso, `max_uses:5`), e depois de
   * reduzir pra `max_uses:2` (esperando latência mais previsível): 180s
   * (timeout de novo). Reduzir `max_uses` cortou o teto de buscas
   * sequenciais mas NÃO eliminou os timeouts — a causa provável é
   * variância do lado do servidor (fila, carga, ou fator da conta nova),
   * não proporcional ao número de buscas. **Não há timeout que elimine
   * essa falha com certeza** — a skill `claude-api` documenta o timeout
   * DEFAULT do próprio SDK como 10min exatamente por causa desse padrão em
   * chamadas com tool server-side, e mesmo esse valor é só uma margem, não
   * uma garantia.
   *
   * 120s é a escolha pragmática: succeeds na maioria das chamadas
   * observadas (25-90s), falha rápido o bastante pra não travar a rodada
   * inteira numa única chamada pendurada (roda em background semanal, sem
   * usuário esperando), e o teto de gasto mensal (`--max-monthly-usd`,
   * US$10 configurado no Console) limita o custo de falhas repetidas.
   * **Falhas ocasionais são esperadas e tratadas como fail-soft** (viram
   * `errorKind: "network"` no registro, nunca derrubam a rodada) — não é
   * bug a corrigir, é a natureza da chamada.
   *
   * **O abort do `AbortController` é só do lado do CLIENTE** — o servidor
   * já processou (e cobrou) o que rodou até o corte: só a rodada de 8/8
   * timeouts em 25s gastou US$0,36 em créditos reais sem produzir UM
   * registro de citação sequer, confirmado no dashboard de billing do
   * Console. Timeout curto demais pra esta chamada não é só "falha rápida
   * e barata" como é pra rede/HTTP comuns — é dinheiro queimado por nada. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Anthropic — Messages API + web_search_20260209 (verificado contra a skill
// claude-api desta sessão: shared/tool-use-concepts.md § Server-Side Tools,
// e o Quick Reference "Server Tools" do SKILL.md).
// ---------------------------------------------------------------------------

function anthropicRequest(question: string, apiKey: string, model: string) {
  return {
    url: "https://api.anthropic.com/v1/messages",
    init: {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: question }],
        // max_uses: 2, não 5 — ver docstring de GeoProviderDef.timeoutMs pro
        // histórico completo. Uma rodada real com max_uses:5 (11/ago/2026)
        // gastou até 121k tokens de INPUT numa única chamada (conteúdo de
        // busca). Reduzir pra 2 NÃO eliminou os timeouts (testado ao vivo,
        // ainda falhou) — mas limita o teto de custo por chamada bem-sucedida
        // (menos conteúdo de busca acumulado), sem comprometer o propósito da
        // medição (checar citação, não pesquisa profunda). Mantido como
        // redução de custo, não como fix de latência.
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
      }),
    } satisfies RequestInit,
  };
}

/** Content block da Messages API — só os campos que interessam aqui. */
interface AnthropicContentBlock {
  type?: string;
  text?: string;
  citations?: Array<{ url?: string }>;
}

function anthropicExtractText(json: unknown): string {
  const content = (json as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  const blocks = content as AnthropicContentBlock[];
  // Junta o texto visível E as URLs de citação (#4558: um assistente pode
  // linkar diar.ia.br via citação sem soletrar o domínio na prosa).
  const textParts = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  const citationUrls = blocks.flatMap((b) => (Array.isArray(b.citations) ? b.citations.map((c) => c.url ?? "") : []));
  return [...textParts, ...citationUrls].join("\n");
}

/**
 * Extrai `usage` da Messages API (#4904). `usage.server_tool_use.web_search_requests`
 * é a contagem de buscas server-side desta chamada — verificado contra a
 * skill `claude-api` (Server Tools). Único provider com pricing de TOKEN
 * verificado (`scripts/lib/pricing.ts`) — a busca em si (US$10/1000) não
 * entra na estimativa de custo, ver docstring de `GeoProviderUsage.searchCount`.
 */
function anthropicExtractUsage(json: unknown): GeoProviderUsage | undefined {
  const usage = (json as { usage?: unknown })?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const inputTokens = typeof u.input_tokens === "number" ? u.input_tokens : undefined;
  const outputTokens = typeof u.output_tokens === "number" ? u.output_tokens : undefined;
  const cacheCreationInputTokens = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined;
  const cacheReadInputTokens = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined;
  const serverToolUse = u.server_tool_use;
  const searchCount =
    serverToolUse && typeof serverToolUse === "object" && typeof (serverToolUse as Record<string, unknown>).web_search_requests === "number"
      ? ((serverToolUse as Record<string, unknown>).web_search_requests as number)
      : undefined;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    cacheReadInputTokens === undefined &&
    searchCount === undefined
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens, searchCount };
}

// ---------------------------------------------------------------------------
// OpenAI — Responses API + web_search tool. Shape best-effort (ver docstring
// do módulo) — extractText é defensivo o bastante pra tolerar variação.
// ---------------------------------------------------------------------------

function openaiRequest(question: string, apiKey: string, model: string) {
  return {
    url: "https://api.openai.com/v1/responses",
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: question,
        tools: [{ type: "web_search" }],
      }),
    } satisfies RequestInit,
  };
}

function openaiExtractText(json: unknown): string {
  const obj = json as { output_text?: unknown; output?: unknown };
  // A Responses API expõe uma conveniência `output_text` (string) em
  // versões recentes do SDK/API — usa se presente.
  if (typeof obj.output_text === "string") return obj.output_text;
  // Fallback defensivo: percorre `output[].content[]` procurando blocos de
  // texto (`type: "output_text"` ou `type: "text"`), sem assumir a forma
  // exata (não verificada ao vivo — ver docstring do módulo).
  if (!Array.isArray(obj.output)) return "";
  const parts: string[] = [];
  for (const item of obj.output as unknown[]) {
    const content = (item as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as unknown[]) {
      const b = block as { type?: string; text?: string };
      if (typeof b?.text === "string" && (b.type === "output_text" || b.type === "text")) {
        parts.push(b.text);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Extrai `usage.{input_tokens,output_tokens}` da Responses API (#4904).
 * Shape best-effort — não verificada ao vivo (ver docstring do módulo). Sem
 * `searchCount`: não há campo conhecido/verificado que conte buscas
 * server-side nesta API; melhor ficar `undefined` (honesto) do que inventar
 * um caminho de leitura não confirmado.
 */
function openaiExtractUsage(json: unknown): GeoProviderUsage | undefined {
  const usage = (json as { usage?: unknown })?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const inputTokens = typeof u.input_tokens === "number" ? u.input_tokens : undefined;
  const outputTokens = typeof u.output_tokens === "number" ? u.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Google — Gemini generateContent + google_search tool (grounding). Shape
// best-effort (ver docstring do módulo).
// ---------------------------------------------------------------------------

function googleRequest(question: string, apiKey: string, model: string) {
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: question }] }],
        tools: [{ google_search: {} }],
      }),
    } satisfies RequestInit,
  };
}

function googleExtractText(json: unknown): string {
  const candidates = (json as { candidates?: unknown })?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const parts = (candidates[0] as { content?: { parts?: unknown } })?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return (parts as Array<{ text?: string }>)
    .filter((p) => typeof p?.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

/**
 * Extrai `usageMetadata.{promptTokenCount,candidatesTokenCount}` do
 * `generateContent` (#4904). Shape best-effort — não verificada ao vivo.
 * Sem `searchCount`: `groundingMetadata.webSearchQueries` (quando existe)
 * fica DENTRO de cada `candidates[]`, não em `usageMetadata` — misturar os
 * dois exigiria assumir mais forma não confirmada; melhor deixar
 * `searchCount` `undefined` aqui também (mesmo raciocínio de `openaiExtractUsage`).
 */
function googleExtractUsage(json: unknown): GeoProviderUsage | undefined {
  const usageMetadata = (json as { usageMetadata?: unknown })?.usageMetadata;
  if (!usageMetadata || typeof usageMetadata !== "object") return undefined;
  const u = usageMetadata as Record<string, unknown>;
  const inputTokens = typeof u.promptTokenCount === "number" ? u.promptTokenCount : undefined;
  const outputTokens = typeof u.candidatesTokenCount === "number" ? u.candidatesTokenCount : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------

export const GEO_PROVIDERS: readonly GeoProviderDef[] = [
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5",
    buildRequest: anthropicRequest,
    extractText: anthropicExtractText,
    extractUsage: anthropicExtractUsage,
    // 120s, não os 25s default — ver docstring de GeoProviderDef.timeoutMs.
    timeoutMs: 120_000,
  },
  {
    id: "openai",
    label: "ChatGPT (OpenAI)",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1",
    buildRequest: openaiRequest,
    extractText: openaiExtractText,
    extractUsage: openaiExtractUsage,
  },
  {
    id: "google",
    label: "Gemini (Google)",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
    buildRequest: googleRequest,
    extractText: googleExtractText,
    extractUsage: googleExtractUsage,
  },
];

/**
 * Tabela de pricing de TOKEN pra OpenAI/Google (#4904 item 4). Nasceu como
 * caminho alternativo enquanto a Anthropic ficou de fora do monitor por
 * decisão do editor (revertida no mesmo dia, 11/ago/2026 — ver docstring
 * do módulo) — mantida mesmo com a Anthropic de volta, porque a tabela de
 * pricing do Claude (`pricing.ts`) é Claude-only por design, e OpenAI/
 * Google continuam sem tabela nenhuma sem isto aqui.
 *
 * Separada de `scripts/lib/pricing.ts` de propósito: aquele módulo é
 * SÓ Claude, compartilhado com `capture-stage-usage.ts`/`aggregate-costs.ts`
 * (custo do próprio Claude Code, assunto diferente de custo de provider
 * terceiro consultado por este monitor) — misturar as duas tabelas ali
 * seria conflation, não reuso.
 *
 * Preços por 1M tokens, verificados AO VIVO em 11/ago/2026 (nunca de
 * memória — disciplina #1172):
 * - `developers.openai.com/api/docs/pricing`: gpt-4.1 = $2.00 input /
 *   $8.00 output. Existe também uma taxa fixa de $10.00/1000 chamadas pro
 *   tool `web_search` (cobrada além do token) — **não incluída aqui**, pelo
 *   MESMO motivo que a busca da Anthropic não entra na conta dela: o campo
 *   é um PISO de token, documentado como tal (ver `estimatedCostUsd`).
 * - `ai.google.dev/gemini-api/docs/pricing`: gemini-2.5-flash = $0.30
 *   input (texto) / $2.50 output. Grounding (`google_search`) é gratuito
 *   até 500 (tier free) ou 1.500 (tier pago) requisições/dia, depois
 *   $35.00/1000 — o volume desta rodada (8-16 chamadas/semana) fica bem
 *   abaixo de qualquer um dos dois limiares, então a omissão do custo de
 *   grounding aqui tende a ser exata, não só um piso, mas TRATADA como
 *   piso mesmo assim (mesma disciplina — nunca assumir tier/cota de quem
 *   vai rodar o script).
 *
 * Só estes 2 models (os `defaultModel` de `GEO_PROVIDERS`) — um override
 * via `{ENVKEY}_MODEL` (ver `main()`) pra um model fora desta tabela cai em
 * `undefined`, nunca um preço inventado por aproximação de nome.
 */
const GEO_NON_ANTHROPIC_TOKEN_PRICING: Readonly<Record<string, { inputPer1M: number; outputPer1M: number }>> = {
  "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
};

/** Pure. `undefined` quando o model não está na tabela — nunca um preço
 * aproximado por prefixo/substring (diferente de `resolvePricing` do
 * `pricing.ts`, que casa por tier Claude porque tier Claude É uma família;
 * aqui cada model tem preço próprio, sem família a generalizar). */
function estimateNonAnthropicCostUsd(model: string, inputTokens: number | undefined, outputTokens: number | undefined): number | undefined {
  const pricing = GEO_NON_ANTHROPIC_TOKEN_PRICING[model];
  if (!pricing) return undefined;
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  return (input / 1_000_000) * pricing.inputPer1M + (output / 1_000_000) * pricing.outputPer1M;
}

export interface CitationDetection {
  cited: boolean;
  /** ~160 chars ao redor da 1ª ocorrência do domínio, ou `null` se não citado. */
  snippet: string | null;
}

/** Detecta se `domain` aparece no texto (case-insensitive, substring) e
 * extrai um snippet de contexto. Pure. */
export function detectCitation(text: string, domain: string = GEO_TARGET_DOMAIN): CitationDetection {
  const idx = text.toLowerCase().indexOf(domain.toLowerCase());
  if (idx < 0) return { cited: false, snippet: null };
  const start = Math.max(0, idx - 80);
  const end = Math.min(text.length, idx + domain.length + 80);
  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  return { cited: true, snippet };
}

export interface GeoCitationRecord {
  /** `YYYY-MM-DD`. */
  date: string;
  /** ISO 8601 completo. */
  ts: string;
  provider: GeoProviderId;
  model: string;
  question: string;
  cited: boolean;
  domain: string;
  snippet: string | null;
  /** Presente só quando a chamada falhou (rede/HTTP/parse) — `cited` fica
   * `false` nesse caso, nunca indeterminado. */
  error?: string;
  /** Status HTTP da resposta, quando o erro veio de um HTTP não-2xx.
   * Ausente pra erro de rede/timeout (fetch nunca completou) ou de parse/
   * extração (completou com 2xx, quebrou depois) — ver `errorKind`. */
  httpStatus?: number;
  /** Discrimina a ORIGEM do erro (achado #4616 do fleet review): sem isso,
   * um bug de regressão em `extractText` (documentado como "nunca lança")
   * fica indistinguível de uma falha de rede transitória — ambos viravam o
   * mesmo `error: string` solto. `"http"` = status não-2xx; `"network"` =
   * fetch rejeitou (timeout incluso, `AbortError`); `"parse"` = `res.json()`
   * lançou (corpo não é JSON válido); `"extract"` = `provider.extractText`
   * lançou (regressão de contrato — a função é documentada como pura e
   * defensiva, nunca deveria lançar). */
  errorKind?: "http" | "network" | "parse" | "extract";
  /** Painel de origem da pergunta (#4900 item a) — `"geral"` (`GEO_QUESTIONS`)
   * ou `"hubs"` (`GEO_HUB_QUESTIONS`). **Opcional de propósito**: registros
   * escritos antes desta mudança não têm o campo — leitores tratam ausência
   * como `"geral"` (ver `summarizeGeoCitationRecords`), nunca migram o
   * arquivo. Registros novos sempre vêm com o campo populado
   * (`runGeoCitationMonitor` estampa em todo record que produz). */
  panel?: GeoQuestionPanel;
  /** Usage bruto (#4904) — **opcional de propósito**, mesma disciplina de
   * `panel`: os 40 registros escritos antes desta mudança não têm nenhum
   * destes campos, e leitores (`summarizeGeoCitationRecords`, o alarme de
   * staleness) continuam funcionando sem eles — nunca migram o arquivo.
   * Populados só quando `provider.extractUsage` existir E a resposta bater
   * a forma esperada (ver `GeoProviderUsage`). */
  inputTokens?: number;
  outputTokens?: number;
  /** Contagem de buscas server-side desta chamada, quando o provider expõe
   * (hoje só a Anthropic). */
  searchCount?: number;
  /** Custo estimado em USD desta chamada — token-only, pros 3 providers
   * (#4904 item 4): Anthropic via `estimateCallCostUsd`
   * (`scripts/lib/pricing.ts`), OpenAI/Google via
   * `estimateNonAnthropicCostUsd`/`GEO_NON_ANTHROPIC_TOKEN_PRICING` (acima
   * neste arquivo — módulo separado de `pricing.ts` de propósito, ver
   * docstring da tabela). Model fora de qualquer tabela → `undefined`,
   * nunca um número inventado. **É um PISO, não o custo total**: nenhuma
   * das duas tabelas precifica a busca server-side em si — só o token. Na
   * Anthropic isso é US$10/1000 buscas; na OpenAI, US$10/1000 chamadas de
   * `web_search`; no Google, grátis até 500-1.500 requisições/dia e depois
   * US$35/1000 (ver a tabela pra data de verificação). **A Anthropic roda
   * de verdade desde 11/ago/2026** (#4904, `ANTHROPIC_API_KEY` ativa) —
   * mas com latência bem mais variável que OpenAI/Google (ver docstring de
   * `GeoProviderDef.timeoutMs`), então uma fração das chamadas termina em
   * timeout e não gera este campo (fail-soft, não é bug). Ver
   * `docs/geo-citation-monitor-setup.md` § "Captura de usage e teto de
   * custo" pro raciocínio completo. */
  estimatedCostUsd?: number;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Timeout DEFAULT por chamada de provider (usado por OpenAI/Google) —
 * mesma referência de 25s já usada pro fetch in-page do Beehiiv
 * (`DEFAULT_FETCH_TIMEOUT_MS`, `scripts/lib/beehiiv-insert-text.ts`,
 * documentado em `context/publishers/beehiiv-playbook.md` §Fase 3). Sem
 * isso, até 24 chamadas seriais (3 providers × 8 perguntas) podiam travar
 * o processo inteiro numa conexão pendurada (achado #4616 do fleet
 * review). **Anthropic usa um valor maior** (`GeoProviderDef.timeoutMs`,
 * `GEO_PROVIDERS`) — 25s estourava em 8/8 chamadas reais, ver docstring do
 * campo. */
export const GEO_PROVIDER_TIMEOUT_MS = 25_000;

type QueryProviderResult =
  | { ok: true; text: string; usage?: GeoProviderUsage }
  | { ok: false; error: string; errorKind: "http" | "network" | "parse" | "extract"; httpStatus?: number };

/** Consulta 1 provider com 1 pergunta e devolve o texto extraído (ou erro).
 * Nunca lança — falha de rede/HTTP/parse/extração vira `{ok:false, error,
 * errorKind}`. O catch de rede (`fetchImpl`) é separado do catch de
 * parse/extração (achado #4616): assim uma regressão em `extractText` nunca
 * se disfarça de falha de rede transitória. Timeout explícito via
 * `AbortController` (`GEO_PROVIDER_TIMEOUT_MS`) quando `fetchImpl` não
 * suporta `signal` nativamente do lado do caller — o timeout é aplicado
 * aqui, não deixado a cargo de cada `buildRequest`. */
export async function queryProvider(
  provider: GeoProviderDef,
  question: string,
  apiKey: string,
  model: string,
  fetchImpl: FetchLike,
  timeoutMs: number = GEO_PROVIDER_TIMEOUT_MS,
): Promise<QueryProviderResult> {
  const { url, init } = provider.buildRequest(question, apiKey, model);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), errorKind: "network" };
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}`, errorKind: "http", httpStatus: res.status };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), errorKind: "parse" };
  }
  // Separado do catch de parse de propósito (achado #4616): extractText é
  // documentado como pura/defensiva/nunca-lança — se algum dia regredir,
  // errorKind:"extract" torna essa regressão de código visível em vez de
  // se disfarçar de falha de rede/parse transitória.
  try {
    const text = provider.extractText(json);
    // #4904: extractUsage é instrumentação, não o dado principal desta
    // função (a citação em `text`) — um catch PRÓPRIO, separado do catch de
    // extractText acima, garante que uma regressão em extractUsage nunca
    // derruba a medição de citação que já teve sucesso (mesmo raciocínio de
    // separar rede/parse/extract, achado #4616, aplicado a um 3º extrator
    // opcional).
    let usage: GeoProviderUsage | undefined;
    try {
      usage = provider.extractUsage?.(json);
    } catch {
      usage = undefined;
    }
    return { ok: true, text, usage };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), errorKind: "extract" };
  }
}

/**
 * Pure: converte `GeoProviderUsage` (extraído por `provider.extractUsage`)
 * nos campos de usage de `GeoCitationRecord` (#4904) — `inputTokens`/
 * `outputTokens`/`searchCount` sempre que presentes, e `estimatedCostUsd`
 * pros 3 providers, cada um com sua tabela: Anthropic via
 * `estimateCallCostUsd` (`pricing.ts`, cobre cache read/write), OpenAI e
 * Google via `estimateNonAnthropicCostUsd` (`GEO_NON_ANTHROPIC_TOKEN_PRICING`
 * acima, #4904 item 4 — tabela própria porque `pricing.ts` é Claude-only).
 * Model fora de qualquer tabela → campo fica `undefined`, nunca um preço
 * inventado.
 * `usage === undefined` (provider sem `extractUsage`, ou a resposta não
 * bateu a forma esperada) devolve `{}` — nenhum campo populado, nunca um
 * objeto com zeros inventados.
 *
 * `tsForCost` (ISO 8601) resolve o pricing intro-vs-standard da Anthropic
 * por data (`estimateCallCostUsd` → `resolvePricing`) — mesma data do
 * record (`ts`), nunca `Date.now()` no momento da LEITURA. OpenAI/Google
 * não têm pricing sensível a data nesta tabela, então `tsForCost` não afeta
 * o cálculo deles.
 */
export function buildUsageRecordFields(
  providerId: GeoProviderId,
  usage: GeoProviderUsage | undefined,
  model: string,
  tsForCost: string,
): Pick<GeoCitationRecord, "inputTokens" | "outputTokens" | "searchCount" | "estimatedCostUsd"> {
  if (!usage) return {};
  const out: Pick<GeoCitationRecord, "inputTokens" | "outputTokens" | "searchCount" | "estimatedCostUsd"> = {};
  if (usage.inputTokens !== undefined) out.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) out.outputTokens = usage.outputTokens;
  if (usage.searchCount !== undefined) out.searchCount = usage.searchCount;
  if (providerId === "anthropic") {
    const dateMs = Date.parse(tsForCost);
    const cost = estimateCallCostUsd(
      {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_creation_input_tokens: usage.cacheCreationInputTokens,
        cache_read_input_tokens: usage.cacheReadInputTokens,
      },
      model,
      Number.isFinite(dateMs) ? dateMs : null,
    );
    if (cost !== null) out.estimatedCostUsd = cost;
  } else {
    const cost = estimateNonAnthropicCostUsd(model, usage.inputTokens, usage.outputTokens);
    if (cost !== undefined) out.estimatedCostUsd = cost;
  }
  return out;
}

/** Delay do único retry de rate-limit (item 4 do achado #4616) — curto de
 * propósito, só o bastante pra dar uma segunda chance a um 429 transitório
 * sem alongar sensivelmente as ~24 chamadas seriais de uma rodada completa. */
export const GEO_RATE_LIMIT_RETRY_DELAY_MS = 1_500;

/**
 * Roda TODAS as combinações provider×pergunta pros providers cuja API key
 * está presente em `env` (providers sem key são pulados — fail-soft, nunca
 * erro). Retorna 1 `GeoCitationRecord` por combinação executada.
 *
 * **Rate-limit (#4616 achado 4):** um 429 recebe exatamente 1 retry, após
 * `GEO_RATE_LIMIT_RETRY_DELAY_MS` — o suficiente pra não perder uma
 * combinação inteira por um rate-limit transitório de 1 chamada, sem virar
 * um backoff geral (outros erros — rede/parse/extract — não são retentados;
 * ver docstring do módulo pra rationale de escopo). `sleepFn` é injetável em
 * teste pra não esperar o delay real.
 *
 * `panel` (#4900 item a, default `"geral"`) é estampado em TODO record
 * produzido — não inferido do conteúdo da pergunta, porque `questions` já
 * determina o painel no caller (`GEO_QUESTIONS` vs `GEO_HUB_QUESTIONS`).
 * Parâmetro novo no FIM da lista de propósito, pra não quebrar chamadas
 * posicionais existentes que já passam `undefined` pra pular `now`/`providers`.
 */
export async function runGeoCitationMonitor(
  env: Record<string, string | undefined>,
  questions: readonly string[] = GEO_QUESTIONS,
  fetchImpl: FetchLike = fetch,
  now: () => Date = () => new Date(),
  providers: readonly GeoProviderDef[] = GEO_PROVIDERS,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  panel: GeoQuestionPanel = "geral",
): Promise<GeoCitationRecord[]> {
  const records: GeoCitationRecord[] = [];
  for (const provider of providers) {
    const apiKey = env[provider.envKey];
    if (!apiKey) continue; // sem key → pula esse provider, fail-soft
    const model = env[`${provider.envKey}_MODEL`] || provider.defaultModel;
    for (const question of questions) {
      let result = await queryProvider(provider, question, apiKey, model, fetchImpl, provider.timeoutMs);
      if (!result.ok && result.errorKind === "http" && result.httpStatus === 429) {
        await sleepFn(GEO_RATE_LIMIT_RETRY_DELAY_MS);
        result = await queryProvider(provider, question, apiKey, model, fetchImpl, provider.timeoutMs);
      }
      const ts = now().toISOString();
      const date = ts.slice(0, 10);
      if (!result.ok) {
        records.push({
          date,
          ts,
          provider: provider.id,
          model,
          question,
          cited: false,
          domain: GEO_TARGET_DOMAIN,
          snippet: null,
          error: result.error,
          errorKind: result.errorKind,
          panel,
          ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
        });
        continue;
      }
      const detection = detectCitation(result.text);
      records.push({
        date,
        ts,
        provider: provider.id,
        model,
        question,
        cited: detection.cited,
        domain: GEO_TARGET_DOMAIN,
        snippet: detection.snippet,
        panel,
        ...buildUsageRecordFields(provider.id, result.usage, model, ts),
      });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Persistência — JSONL append-only, mesma disciplina de
// `scripts/lib/source-runs.ts::appendSourceLog` (retry-with-backoff cobre a
// race de OneDrive Files On-Demand no `data/` junction, ver `appendFileWithRetry`).
// ---------------------------------------------------------------------------

/** Path default do log — 1 arquivo único, append-only, cresce ao longo do
 * tempo (mesmo padrão de `data/run-log.jsonl`, não 1 arquivo por dia/ciclo —
 * o volume aqui é baixo: no máximo `providers × questions` linhas por rodada). */
export const DEFAULT_GEO_CITATIONS_LOG_PATH = "data/geo-citations/history.jsonl";

/**
 * Anexa os records ao log JSONL. `logPath`/`appendFn` injetáveis em teste —
 * mesmo padrão de `appendSourceLog`. Cria o diretório se não existir.
 */
export function appendGeoCitationLog(
  records: GeoCitationRecord[],
  logPath: string = DEFAULT_GEO_CITATIONS_LOG_PATH,
  ioFns: {
    mkdirSync: (path: string, opts: { recursive: true }) => void;
    appendFileSync: (path: string, data: string) => void;
  } = {
    mkdirSync: (p, o) => mkdirSync(p, o),
    appendFileSync: (p, d) => appendFileWithRetry(p, d),
  },
): void {
  if (records.length === 0) return;
  ioFns.mkdirSync(dirname(logPath), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r) + "\n").join("");
  ioFns.appendFileSync(logPath, lines);
}

export interface GeoCitationSummary {
  total: number;
  cited: number;
  errors: number;
  byProvider: Record<string, { total: number; cited: number }>;
  /** Quebra por painel (#4900 item a) — chave `"geral"` inclui registros sem
   * `panel` (legado, lido como `"geral"` por default). */
  byPanel: Record<string, { total: number; cited: number }>;
}

/** Resume um lote de records — usado pro print de fim de execução. Pure. */
export function summarizeGeoCitationRecords(records: GeoCitationRecord[]): GeoCitationSummary {
  const byProvider: Record<string, { total: number; cited: number }> = {};
  const byPanel: Record<string, { total: number; cited: number }> = {};
  let cited = 0;
  let errors = 0;
  for (const r of records) {
    if (!byProvider[r.provider]) byProvider[r.provider] = { total: 0, cited: 0 };
    byProvider[r.provider].total += 1;
    const panel = r.panel ?? "geral";
    if (!byPanel[panel]) byPanel[panel] = { total: 0, cited: 0 };
    byPanel[panel].total += 1;
    if (r.cited) {
      byProvider[r.provider].cited += 1;
      byPanel[panel].cited += 1;
      cited += 1;
    }
    if (r.error) errors += 1;
  }
  return { total: records.length, cited, errors, byProvider, byPanel };
}

// ---------------------------------------------------------------------------
// #4900 — provedor que some da rodada não alarma em silêncio (item b) +
// detecção (não-resolução) de conflito de escrita OneDrive (item c).
// ---------------------------------------------------------------------------

/**
 * Agrupa os providers que produziram >=1 registro por `date` (`YYYY-MM-DD`)
 * — reconstrói quais providers RODARAM em cada rodada sem precisar de um
 * arquivo de manifest separado: um provider sem key configurada não produz
 * NENHUM record naquela data (`runGeoCitationMonitor` pula em silêncio,
 * fail-soft), então "provider ausente do dia" já É o sinal de "rodou sem
 * essa key" — faltava uma função que lesse isso de forma automática em vez
 * de contar linha por linha (achado #4900: "24 openai + 16 google + 0
 * anthropic", contado a mão). Pure. */
export function providersByRoundDate(
  records: readonly Pick<GeoCitationRecord, "date" | "provider">[],
): Map<string, Set<GeoProviderId>> {
  const byDate = new Map<string, Set<GeoProviderId>>();
  for (const r of records) {
    if (!byDate.has(r.date)) byDate.set(r.date, new Set());
    byDate.get(r.date)!.add(r.provider);
  }
  return byDate;
}

export interface LatestRoundProviders {
  date: string;
  providers: GeoProviderId[];
}

/** Pure: a partir de um array de records (ordem qualquer), devolve a data
 * mais recente presente e o conjunto de providers que produziram registro
 * nela — a "rodada mais recente conhecida". `null` quando `records` está
 * vazio (nunca mediu nada). Datas `YYYY-MM-DD` ordenam lexicograficamente,
 * então um sort simples basta. */
export function latestRoundProviders(
  records: readonly Pick<GeoCitationRecord, "date" | "provider">[],
): LatestRoundProviders | null {
  if (records.length === 0) return null;
  const byDate = providersByRoundDate(records);
  const dates = [...byDate.keys()].sort();
  const date = dates[dates.length - 1];
  return { date, providers: [...(byDate.get(date) ?? new Set())] };
}

export interface ProviderDropCheck {
  /** `true` quando `currentProviders` é um subconjunto PRÓPRIO de
   * `previousProviders` — a rodada atual rodou com menos providers que a
   * anterior. */
  dropped: boolean;
  /** Providers presentes na rodada anterior e ausentes na atual. */
  droppedProviders: GeoProviderId[];
}

/**
 * Pure: detecta queda de provedor entre duas rodadas (#4900 item b, "o
 * sub-item mais barato e mais valioso" da issue). Não confundir com
 * staleness (`geo-citation-staleness-alarm.ts`, #4755): staleness mede
 * silêncio TOTAL (nenhum registro novo há N dias); isto mede uma rodada que
 * ACONTECEU mas encolheu — o sintoma observado ao vivo em 10/ago (rodada
 * anterior `{openai, google}`, rodada atual `{openai}` porque `GEMINI_API_KEY`
 * ficou vazia numa das duas máquinas) passava em silêncio antes deste guard.
 */
export function detectProviderDrop(
  previousProviders: readonly GeoProviderId[],
  currentProviders: readonly GeoProviderId[],
): ProviderDropCheck {
  const currentSet = new Set(currentProviders);
  const droppedProviders = previousProviders.filter((p) => !currentSet.has(p));
  return { dropped: droppedProviders.length > 0, droppedProviders };
}

/**
 * Pure: filtra nomes de arquivo que batem o padrão de conflito de escrita
 * do cliente OneDrive Linux (abraunegg, `-safeBackup-`) — sinal de que 2+
 * máquinas escreveram o mesmo log JSONL na mesma janela e o OneDrive
 * resolveu RENOMEANDO em vez de mesclar ou avisar (#4900 item c, achado ao
 * vivo: `history-predator-safeBackup-0001.jsonl` com 8 registros órfãos que
 * só existem nesse arquivo). Esta função só DETECTA — reconciliar os dados
 * é operação manual sobre dado real de produção, deliberadamente fora de
 * escopo de qualquer PR de código (ver docstring de `listSafeBackupConflictFiles`
 * em `scripts/geo-citation-monitor.ts` pro wrapper de I/O). */
export function detectSafeBackupConflictFiles(filenames: readonly string[]): string[] {
  return filenames.filter((f) => f.includes("-safeBackup-"));
}
