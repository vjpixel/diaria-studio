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

/** Domínio checado nas respostas (sem protocolo/path — substring match). */
export const GEO_TARGET_DOMAIN = "diar.ia.br";

export type GeoProviderId = "anthropic" | "openai" | "google";

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
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
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

// ---------------------------------------------------------------------------

export const GEO_PROVIDERS: readonly GeoProviderDef[] = [
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5",
    buildRequest: anthropicRequest,
    extractText: anthropicExtractText,
  },
  {
    id: "openai",
    label: "ChatGPT (OpenAI)",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1",
    buildRequest: openaiRequest,
    extractText: openaiExtractText,
  },
  {
    id: "google",
    label: "Gemini (Google)",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
    buildRequest: googleRequest,
    extractText: googleExtractText,
  },
];

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
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Timeout por chamada de provider — mesma referência de 25s já usada pro
 * fetch in-page do Beehiiv (`DEFAULT_FETCH_TIMEOUT_MS`,
 * `scripts/lib/beehiiv-insert-text.ts`, documentado em
 * `context/publishers/beehiiv-playbook.md` §Fase 3). Sem isso, até 24
 * chamadas seriais (3 providers × 8 perguntas) podiam travar o processo
 * inteiro numa conexão pendurada (achado #4616 do fleet review). */
export const GEO_PROVIDER_TIMEOUT_MS = 25_000;

type QueryProviderResult =
  | { ok: true; text: string }
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
    return { ok: true, text: provider.extractText(json) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), errorKind: "extract" };
  }
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
 */
export async function runGeoCitationMonitor(
  env: Record<string, string | undefined>,
  questions: readonly string[] = GEO_QUESTIONS,
  fetchImpl: FetchLike = fetch,
  now: () => Date = () => new Date(),
  providers: readonly GeoProviderDef[] = GEO_PROVIDERS,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<GeoCitationRecord[]> {
  const records: GeoCitationRecord[] = [];
  for (const provider of providers) {
    const apiKey = env[provider.envKey];
    if (!apiKey) continue; // sem key → pula esse provider, fail-soft
    const model = env[`${provider.envKey}_MODEL`] || provider.defaultModel;
    for (const question of questions) {
      let result = await queryProvider(provider, question, apiKey, model, fetchImpl);
      if (!result.ok && result.errorKind === "http" && result.httpStatus === 429) {
        await sleepFn(GEO_RATE_LIMIT_RETRY_DELAY_MS);
        result = await queryProvider(provider, question, apiKey, model, fetchImpl);
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
}

/** Resume um lote de records — usado pro print de fim de execução. Pure. */
export function summarizeGeoCitationRecords(records: GeoCitationRecord[]): GeoCitationSummary {
  const byProvider: Record<string, { total: number; cited: number }> = {};
  let cited = 0;
  let errors = 0;
  for (const r of records) {
    if (!byProvider[r.provider]) byProvider[r.provider] = { total: 0, cited: 0 };
    byProvider[r.provider].total += 1;
    if (r.cited) {
      byProvider[r.provider].cited += 1;
      cited += 1;
    }
    if (r.error) errors += 1;
  }
  return { total: records.length, cited, errors, byProvider };
}
