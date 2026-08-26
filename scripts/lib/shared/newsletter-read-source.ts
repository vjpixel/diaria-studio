/**
 * newsletter-read-source.ts (#6184 — migração Beehiiv → Kit, fatia
 * metadados+conteúdo do épico #463; #6362 fecha o bloqueio de merge da
 * revisão do #6184)
 *
 * ## O problema que este módulo resolve
 *
 * `refresh-dedup.ts` e `fetch-monthly-posts.ts` leem metadados e conteúdo
 * (HTML) de edições publicadas **ao vivo via REST**, direto contra a
 * Beehiiv ou o Kit. `refresh-past-editions.ts` processa o `Post[]` que
 * `refresh-dedup.ts` já buscou — não faz nenhuma chamada de rede pra
 * DESCOBRIR posts novos — mas **faz sim** uma chamada de rede própria por
 * padrão (item 9, #6362): `resolveBeehiivTracking`/`populateLinksFromTracking`
 * resolve URLs de tracking *dentro* do HTML via `HEAD` request, chamada por
 * `refresh-dedup.ts` a menos que `--no-resolve-tracking` seja passado. Essa
 * chamada é sobre links *dentro* do conteúdo já buscado, não sobre "onde
 * procurar por posts novos" — por isso `refresh-past-editions.ts` não migra
 * pra este módulo (ver "O que este módulo NÃO faz" abaixo).
 *
 * ## Dois backends, DUAS chaves de flag, prontidões diferentes (item 1, #6362)
 *
 * `publishing.newsletter.backend` (`platform.config.json`) controla o
 * backend de **ENVIO** — migrou pra `"kit"` no switchover do #6114
 * (26/08/2026). Este módulo controla o backend de **LEITURA**, sob a chave
 * PRÓPRIA `publishing.newsletter.read_backend` (default `"beehiiv"`) — as
 * duas prontidões são independentes: o envio já tem confiança pra rodar em
 * produção no Kit, mas a LEITURA (dedup incremental, digest mensal) só pode
 * migrar quando o Kit tiver histórico real de edições publicadas. Medido ao
 * vivo no bloqueio de merge da PR #6362 (26/08/2026): a conta Kit tinha 11
 * broadcasts `completed` no total, **todos `public: false`** (8
 * probes/testes, 1 piloto, 2 test-sends carregando o HTML real da edição do
 * dia seguinte) — zero edições reais publicadas. Se a leitura usasse a
 * mesma chave do envio, o merge desta PR teria virado a leitura pro Kit
 * IMEDIATAMENTE, e os test-sends teriam entrado em `data/past-editions.md`
 * fazendo a edição seguinte ver os próprios links como já publicados (dedup
 * mutila a edição em silêncio). Usar uma chave separada com default
 * `"beehiiv"` torna o merge desta PR **no-op comportamental** até alguém
 * virar `read_backend` pra `"kit"` de propósito, depois de haver histórico
 * real (`public: true`) suficiente pra confiar na leitura.
 *
 * ## Desenho
 *
 * Resolve o backend de leitura (`publishing.newsletter.read_backend`,
 * default `"beehiiv"`) e as credenciais UMA vez (`resolveNewsletterReadConfig`),
 * devolvendo um objeto discriminado (`NewsletterReadConfig`) que os 3
 * pontos de leitura abaixo aceitam sem precisar saber qual backend está por
 * trás:
 *
 *   - `listRecentNewsletterPosts` — bootstrap/incremental (refresh-dedup.ts:
 *     "N mais recentes" ou "mais novos que um cutoff").
 *   - `listNewsletterPostsInWindow` — janela de datas (fetch-monthly-posts.ts:
 *     "tudo publicado no mês X").
 *   - `fetchNewsletterPostContent` — HTML + URL pública de 1 post/broadcast.
 *
 * Ambas as funções de listagem devolvem apenas METADADOS (`NormalizedNewsletterPost`)
 * — nunca HTML —, mesma separação que o código Beehiiv original já tinha
 * (listar é barato, buscar conteúdo por item é caro; os 2 backends paginam
 * diferente: Beehiiv por `page`, Kit por cursor `after`).
 *
 * ## Kit: `public: true` é o discriminador de edição real (item 2, #6362)
 *
 * Toda edição real publicada é `public: true` (vira página pública em
 * `{slug}.kit.com`/domínio customizado — confirmado no #6323: "Kit broadcast
 * real precisa de `public: true` pra virar página pública"). Probe, teste e
 * test-send são sempre `public: false`. As 3 funções Kit abaixo filtram
 * `public !== true` ANTES de normalizar — nunca deixam um broadcast de
 * teste chegar em `data/past-editions.md` ou no digest mensal.
 *
 * ## Kit: ordenação de `GET /v4/broadcasts` NÃO é por `published_at` (item 3, #6362)
 *
 * Ver docstring de `collectAllCompletedKitPosts` abaixo — a versão anterior
 * deste módulo (PR #6362 original) assumia "mais recente primeiro" por
 * analogia com a Beehiiv; medição ao vivo em 26/08/2026 provou o contrário
 * (a API pagina por criação/id decrescente, não por `published_at`), e o
 * caso que isso quebra — edição agendada, publicada só na manhã seguinte —
 * é o caminho NORMAL de toda edição diária, não uma borda.
 *
 * ## `webUrl` explicitamente `string | null` — nunca assumido (#6096/#6184)
 *
 * `KitBroadcastDetail.public_url` (`lib/kit-client.ts`) é `string | undefined`
 * porque nunca foi confirmado que o Kit sempre popula esse campo. Este
 * módulo formaliza a mesma ausência em TODO ponto de saída como `null`
 * explícito (nunca `undefined` silencioso, nunca um cast/`!` que assumiria
 * presença) — `NormalizedNewsletterPost.webUrl` e
 * `NewsletterPostContent.webUrl` são sempre `string | null`. O teste
 * dedicado (`test/newsletter-read-source.test.ts`) cobre exatamente esse
 * caminho: `getBroadcast` sem `public_url` não lança, não vira string vazia,
 * devolve `null`.
 *
 * `listBroadcasts` (resumo, usado pelas 2 funções de listagem) não devolve
 * `public_url` — só `getBroadcast` (detalhe) devolve. Por isso
 * `NormalizedNewsletterPost.webUrl` do lado Kit é sempre `null` na LISTAGEM;
 * o valor real só existe depois de `fetchNewsletterPostContent`. Mesmo
 * padrão que o código Beehiiv original já tinha (`toCanonicalPost` em
 * `refresh-dedup.ts` faz `web_url ?? summary.web_url` — o valor "bom" vem do
 * detalhe, o da listagem é só um fallback).
 *
 * ## Kit: links do conteúdo NÃO vêm embrulhados em domínio de tracking
 * (item 10, #6362 — investigado, não escopo de fix)
 *
 * `extractBeehiivTrackingLinks`/`resolveBeehiivTracking`
 * (`refresh-past-editions.ts`) só casam host `*.beehiiv.com` — com conteúdo
 * Kit, viram no-op silencioso e o código cai direto em `extractLinks`. Isso
 * só importaria se o Kit embrulhasse os `href` do broadcast num domínio de
 * tracking próprio (nesse caso `links[]` do dedup conteria URL de tracking
 * em vez da URL real, e a dedup pararia de casar repetição, em silêncio —
 * mesma família dos itens 2/3/7). **Verificado ao vivo em 26/08/2026**:
 * inspecionado o HTML completo de um broadcast Kit real (`getBroadcast` do
 * test-send da edição 260827, 39 `href`s) — todos os links de artigo
 * (theguardian.com, canaltech.com.br, theregister.com, huggingface.co,
 * claude.com, openai.com, exame.com, etc.) aparecem como URL original, sem
 * nenhum domínio de tracking do Kit no meio. Veredito: **não embrulha** —
 * `extractLinks` (fallback genérico) já é suficiente pro caminho Kit, e o
 * no-op do resolver Beehiiv-only é inofensivo. Não abrir issue nova por
 * este item.
 *
 * ## O que este módulo NÃO faz
 *
 * - Não decide QUANDO trocar de backend — só LÊ a flag já decidida em
 *   `publishing.newsletter.read_backend`.
 * - Não escreve nenhum cache em disco — puro round-trip de rede,
 *   normalizado. `edition-cache-reader.ts` continua sendo quem lê cache já
 *   materializado.
 * - Não migra `gen-archive-pages.ts` (shape `ArchivePost` próprio, com
 *   campos fora do normalizado aqui, e testado direto por fixture de
 *   arquivo) — registrado como pendente na issue #6184, fora desta unidade.
 * - Não migra `refresh-past-editions.ts` (ver seção acima) — chamada de
 *   rede que ele faz é sobre URLs *dentro* do conteúdo, não sobre listar
 *   posts novos.
 */

import { resolveBeehiivConfig, beehiivApiBase, type BeehiivConfig } from "../beehiiv-config.ts";
import { resolveKitConfig, type KitConfig } from "../kit-config.ts";
import { listBroadcasts, getBroadcast, type KitBroadcastSummary } from "../kit-client.ts";
// #6362 item 11: extractPublishedDate/extractPublishedAtIso nasceram
// Beehiiv-only (ver docstring de beehiiv-timestamp.ts), mas esta migração os
// tornou load-bearing pra broadcasts Kit também (via
// `{ published_at: b.published_at ?? b.send_at }` abaixo) — quem editar
// aquele arquivo mexe nos dois backends, não só na Beehiiv.
import { extractPublishedDate, extractPublishedAtIso } from "../beehiiv-timestamp.ts";
import { parseListPostsResponse, parseBeehiivPost } from "../schemas/beehiiv.ts";
import { parseListBroadcastsResponse, parseKitBroadcastDetail } from "../schemas/kit.ts"; // #6362 item 7
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_CONFIG_PATH = resolve(ROOT, "platform.config.json");

export type NewsletterBackend = "beehiiv" | "kit";

/**
 * Lê `platform.config.json` → `publishing.newsletter.read_backend` (item 1,
 * #6362 — chave DEDICADA de leitura, separada de `publishing.newsletter.backend`,
 * que é o backend de ENVIO; ver docstring do módulo). Distingue (item 6,
 * #6362) arquivo AUSENTE (default silencioso correto — projeto nunca
 * configurou a chave) de arquivo PRESENTE mas ilegível (JSON corrompido —
 * `ok: false`, o caller decide como reagir, nunca mascarado como
 * `"beehiiv"` default). Valor da chave é parseado de forma tolerante
 * (trim + lowercase, mesmo padrão de `resolveBackend` em
 * `workers/poll/src/subscribe.ts`, #6291) e loga antes de cair no default
 * quando é um typo/case/espaço não reconhecido (item 4).
 */
function resolveReadBackendChecked(
  configPath: string,
): { ok: true; backend: NewsletterBackend } | { ok: false; reason: string } {
  if (!existsSync(configPath)) return { ok: true, backend: "beehiiv" };
  let cfg: { publishing?: { newsletter?: { read_backend?: string } } };
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    return { ok: false, reason: `platform.config.json inválido: ${(e as Error).message}` };
  }
  const raw = cfg.publishing?.newsletter?.read_backend;
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "kit") return { ok: true, backend: "kit" };
  if (normalized && normalized !== "beehiiv") {
    console.error(
      `[newsletter-read-source] publishing.newsletter.read_backend desconhecido: ${JSON.stringify(raw)} — caindo em beehiiv`,
    );
  }
  return { ok: true, backend: "beehiiv" };
}

/**
 * Convenience pura sobre `resolveReadBackendChecked` — SEMPRE devolve um
 * backend usável, nunca lança, nunca propaga o erro de JSON inválido (só
 * degrada pro default `"beehiiv"`). Use quando "beehiiv" no erro é
 * aceitável (ex: só quer saber "qual backend hoje", sem side-effect de
 * abortar processo). `resolveNewsletterReadConfig` abaixo usa a versão
 * CHECADA internamente — é ela quem de fato precisa propagar o erro (item 6).
 */
export function resolveNewsletterBackend(configPath: string = DEFAULT_CONFIG_PATH): NewsletterBackend {
  const result = resolveReadBackendChecked(configPath);
  return result.ok ? result.backend : "beehiiv";
}

/** Config resolvida e discriminada por backend — o que as 3 funções de
 *  leitura abaixo recebem. Nunca reconstruída internamente a partir do
 *  ambiente — sempre passada explicitamente pelo caller (mesmo padrão de
 *  `config?: KitConfig`/`config?: BeehiivConfig` já usado em
 *  `kit-client.ts`/`beehiiv-config.ts` — injeção facilita teste). */
export type NewsletterReadConfig =
  | { backend: "beehiiv"; config: BeehiivConfig }
  | { backend: "kit"; config: KitConfig };

export type NewsletterReadConfigResult =
  | { ok: true; config: NewsletterReadConfig }
  | { ok: false; reason: string };

/**
 * Resolve backend + credenciais correspondentes, sem nunca lançar ou chamar
 * `process.exit` (mesmo contrato de `resolveBeehiivConfig`/`resolveKitConfig`,
 * que este módulo delega — não reimplementa resolução de credencial).
 *
 * **Item 6 (#6362):** ao contrário do antigo `resolveNewsletterBackend` cru
 * (que mascarava `platform.config.json` corrompido como `"beehiiv"` default
 * em silêncio), esta função usa a variante CHECADA e propaga `ok: false`
 * quando o arquivo existe mas é JSON inválido. Antes desta correção,
 * `fetch-monthly-posts.ts` perdia a própria validação de config que tinha
 * pré-#6184 (JSON.parse + erro claro) e ficava assimétrico com
 * `refresh-dedup.ts` (que preserva a própria checagem em `loadConfig()`) —
 * o caso normal (`BEEHIIV_PUBLICATION_ID` já no env de qualquer setup que
 * seguiu o `.env.example`) fazia o erro de config corrompido nunca aparecer.
 *
 * @param opts.backend      Override do backend resolvido de
 *                           `platform.config.json` — útil pra teste ou pra
 *                           um caller que já sabe o backend por outro meio.
 * @param opts.env           Fonte do env — default `process.env`.
 * @param opts.configPath    Path de `platform.config.json` — default o real.
 */
export function resolveNewsletterReadConfig(opts: {
  backend?: NewsletterBackend;
  env?: Record<string, string | undefined>;
  configPath?: string;
} = {}): NewsletterReadConfigResult {
  let backend: NewsletterBackend;
  if (opts.backend) {
    backend = opts.backend;
  } else {
    const resolved = resolveReadBackendChecked(opts.configPath ?? DEFAULT_CONFIG_PATH);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    backend = resolved.backend;
  }
  if (backend === "kit") {
    const result = resolveKitConfig(opts.env);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, config: { backend: "kit", config: result.config } };
  }
  const result = resolveBeehiivConfig(opts.env, opts.configPath ?? DEFAULT_CONFIG_PATH);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, config: { backend: "beehiiv", config: result.config } };
}

/** Shape normalizado de 1 post/broadcast, backend-agnóstico. `webUrl` é
 *  explicitamente `string | null` — ver docstring do módulo sobre por que
 *  nunca assumir presença. `publishedAtIso` é `string` NÃO-nulo (item 5,
 *  #6362): `normalizeBeehiivSummary`/`normalizeKitSummary` abaixo resolvem
 *  o timestamp (`string | null`, via `extractPublishedAtIso`) e retornam
 *  `null` (o post inteiro, não o campo) ANTES de montar este objeto quando
 *  o timestamp não é parseável — o `string | null` pré-filtro nunca escapa
 *  pra fora dessas duas funções internas. */
export interface NormalizedNewsletterPost {
  id: string;
  title: string;
  webUrl: string | null;
  publishedAtIso: string;
}

/** Conteúdo (HTML) + URL pública de 1 post/broadcast — resultado de
 *  `fetchNewsletterPostContent`. */
export interface NewsletterPostContent {
  html: string | null;
  webUrl: string | null;
}

// ---------------------------------------------------------------------------
// Beehiiv — extraído de refresh-dedup.ts / fetch-monthly-posts.ts (comportamento
// preservado 1:1; só a casca de tipo/local mudou). NÃO TOCAR sem revalidar
// paridade — o fleet review do #6362 confirmou 1:1 exatamente por não mexer
// aqui.
// ---------------------------------------------------------------------------

interface BeehiivPostSummaryRaw {
  id: string;
  status?: string;
  publish_date?: number | null;
  published_at?: string | null;
  scheduled_at?: string | null;
  updated_at?: string | null;
  web_url?: string;
  title?: string;
  subject?: string;
}

async function beehiivApiFetch<T>(path: string, config: BeehiivConfig): Promise<T> {
  const res = await fetch(`${beehiivApiBase()}${path}`, {
    headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Beehiiv API ${res.status} ${path}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function normalizeBeehiivSummary(p: BeehiivPostSummaryRaw, now: Date): NormalizedNewsletterPost | null {
  const publishedAtIso = extractPublishedAtIso(p, now);
  if (!publishedAtIso) return null;
  return {
    id: p.id,
    title: p.title ?? p.subject ?? "(sem título)",
    webUrl: p.web_url ?? null,
    publishedAtIso,
  };
}

async function listRecentBeehiivPosts(
  config: BeehiivConfig,
  opts: { limit: number; stopBeforeMs?: number },
): Promise<NormalizedNewsletterPost[]> {
  const collected: NormalizedNewsletterPost[] = [];
  const now = new Date();
  let page = 1;

  while (collected.length < opts.limit) {
    // #972: `order_by=newest_first` retorna ordem invertida na Beehiiv API v2 —
    // a query correta é `publish_date` + `direction=desc`.
    const params = new URLSearchParams({
      per_page: "50",
      order_by: "publish_date",
      direction: "desc",
      page: String(page),
    });
    const raw = await beehiivApiFetch<unknown>(`/publications/${config.publicationId}/posts?${params}`, config);
    const data = parseListPostsResponse(raw);
    const posts = (data.data ?? []) as BeehiivPostSummaryRaw[];
    if (posts.length === 0) break;

    let stoppedAtCutoff = false;
    for (const p of posts) {
      const dt = extractPublishedDate(p, now);
      if (!dt) continue; // agendado futuro ou sem timestamp parseável — pula
      const ms = dt.getTime();
      if (opts.stopBeforeMs !== undefined && ms <= opts.stopBeforeMs) {
        stoppedAtCutoff = true;
        break;
      }
      const normalized = normalizeBeehiivSummary(p, now);
      if (normalized) collected.push(normalized);
      if (collected.length >= opts.limit) break;
    }

    if (stoppedAtCutoff) break;
    if (data.total_pages && page >= data.total_pages) break;
    page++;
  }

  return collected;
}

async function listBeehiivPostsInWindow(
  config: BeehiivConfig,
  opts: { startMs: number; endMs: number },
): Promise<NormalizedNewsletterPost[]> {
  const collected: NormalizedNewsletterPost[] = [];
  const now = new Date();
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      per_page: "50",
      order_by: "publish_date",
      direction: "desc",
      page: String(page),
    });
    const raw = await beehiivApiFetch<unknown>(`/publications/${config.publicationId}/posts?${params}`, config);
    const data = parseListPostsResponse(raw);
    const posts = (data.data ?? []) as BeehiivPostSummaryRaw[];
    if (posts.length === 0) break;

    let anyInWindow = false;
    let allBefore = true;
    for (const p of posts) {
      const dt = extractPublishedDate(p);
      const ms = dt ? dt.getTime() : (p.publish_date ? p.publish_date * 1000 : undefined);
      if (ms === undefined) continue;
      if (ms >= opts.startMs && ms < opts.endMs) {
        const normalized = normalizeBeehiivSummary(p, now);
        if (normalized) collected.push(normalized);
        anyInWindow = true;
        allBefore = false;
      } else if (ms >= opts.endMs) {
        allBefore = false;
      }
    }

    if (!anyInWindow && allBefore) break; // toda a página é anterior à janela
    if (data.total_pages && page >= data.total_pages) break;
    page++;
  }

  return collected;
}

async function fetchBeehiivPostContent(config: BeehiivConfig, id: string): Promise<NewsletterPostContent> {
  const params = new URLSearchParams();
  params.append("expand[]", "free_web_content");
  params.append("expand[]", "free_email_content");
  const raw = await beehiivApiFetch<{ data: unknown }>(
    `/publications/${config.publicationId}/posts/${id}?${params}`,
    config,
  );
  const detail = parseBeehiivPost(raw.data) as {
    html?: string;
    free_web_content?: string;
    free_email_content?: string;
    web_url?: string;
    content?: { free?: { web?: string; email?: string } };
  };
  const html =
    detail.html ||
    detail.free_email_content ||
    detail.content?.free?.email ||
    detail.free_web_content ||
    detail.content?.free?.web ||
    null;
  return { html: html ?? null, webUrl: detail.web_url ?? null };
}

// ---------------------------------------------------------------------------
// Kit
// ---------------------------------------------------------------------------

/** Teto de segurança pra `collectAllCompletedKitPosts` — 40 páginas × 50 =
 *  2000 broadcasts `completed`. Ver docstring dessa função pra por que a
 *  paginação precisa ser exaustiva (não early-stop) em vez de um número
 *  arbitrário menor. Hoje (26/08/2026) a conta tem 11 broadcasts `completed`
 *  no total — folga enorme. Se o volume real algum dia se aproximar do
 *  teto, subir o valor (o custo de paginar tudo é 1 request HTTP a cada 50
 *  itens — barato mesmo em milhares) em vez de reintroduzir early-stop por
 *  ordem assumida. */
const KIT_LIST_MAX_PAGES = 40;

/** Só os campos que este módulo de fato lê — deixa `normalizeKitSummary`
 *  aceitar tanto `KitBroadcastSummary` (`kit-client.ts`) quanto o shape
 *  validado por Zod (`ParsedKitBroadcastSummary` inferido dentro de
 *  `ListBroadcastsResponseSchema`, #6362 item 7) sem cast. */
type KitSummaryForNormalize = Pick<KitBroadcastSummary, "id" | "subject" | "send_at" | "published_at">;

function normalizeKitSummary(b: KitSummaryForNormalize, now: Date): NormalizedNewsletterPost | null {
  const publishedAtIso = extractPublishedAtIso({ published_at: b.published_at ?? b.send_at }, now);
  if (!publishedAtIso) return null;
  return {
    id: String(b.id),
    title: b.subject,
    // `listBroadcasts` (resumo) nunca devolve `public_url` — só `getBroadcast`
    // (detalhe) devolve. `null` aqui é o valor real da listagem, não uma
    // ausência anômala — ver docstring do módulo.
    webUrl: null,
    publishedAtIso,
  };
}

/**
 * Busca TODOS os broadcasts Kit `status: completed` (até `KIT_LIST_MAX_PAGES`
 * páginas), filtra pra `public === true` (item 2, #6362 — só edição real,
 * nunca probe/teste/test-send) e devolve ordenado por `publishedAtIso`
 * DESCENDENTE — calculado no CLIENTE, nunca assumido do servidor.
 *
 * **Por que paginar tudo em vez de early-stop (item 3, #6362 — bloqueio de
 * merge original):** a versão anterior deste módulo assumia
 * "GET /v4/broadcasts vem mais-recente-primeiro" (por analogia com a
 * Beehiiv) e parava de paginar assim que via um item mais antigo que o
 * cutoff. **Falso, medido ao vivo em 26/08/2026:**
 *
 *   id 25609361  criado 25/08 23:06  published_at 25/08 23:08:02Z
 *   id 25609304  criado 25/08 23:00  published_at 26/08 09:02:40Z  ← MAIS NOVO por published_at, mas vem DEPOIS na resposta
 *
 * O id 25609304 é o piloto dos Patronos: criado às 23:00 do dia anterior,
 * AGENDADO, e só enviado (`published_at`) às 09:02 da manhã seguinte. A API
 * pagina por criação/id decrescente, não por `published_at` — e "criado na
 * véspera, publicado de manhã" é o padrão de TODA edição diária (Stage 6
 * agenda 06:00 BRT), não uma borda. Um early-stop nessa ordem pularia
 * edições agendadas sistematicamente, em silêncio.
 *
 * A correção: nunca parar cedo por causa de um cutoff/janela — paginar até
 * esgotar (ou até o teto de segurança `KIT_LIST_MAX_PAGES`) e só then
 * ordenar/filtrar no cliente. Custo aceito: hoje (11 broadcasts completed no
 * total) isso é 1 única página.
 */
async function collectAllCompletedKitPosts(config: KitConfig, now: Date): Promise<NormalizedNewsletterPost[]> {
  const collected: NormalizedNewsletterPost[] = [];
  let after: string | undefined;
  let pages = 0;

  while (pages < KIT_LIST_MAX_PAGES) {
    const raw = await listBroadcasts({ status: "completed", perPage: 50, after, config });
    const { broadcasts, pagination } = parseListBroadcastsResponse(raw); // #6362 item 7
    pages++;
    if (broadcasts.length === 0) break;

    for (const b of broadcasts) {
      // item 2 (bloqueio de merge, #6362): edição real é sempre
      // `public: true`; probe/teste/test-send são `public: false` — medido
      // ao vivo, 11/11 broadcasts completed hoje são não-públicos (8
      // probes, 1 piloto, 2 test-sends da edição do dia seguinte carregando
      // o HTML real dela). Sem este filtro, os test-sends entrariam em
      // `data/past-editions.md` e a edição seguinte veria os próprios links
      // como já publicados — dedup mutila a edição em silêncio (#6323
      // confirma `public: true` como discriminador de página pública real).
      if (b.public !== true) continue;
      const normalized = normalizeKitSummary(b, now);
      if (normalized) collected.push(normalized);
    }

    if (!pagination.has_next_page || !pagination.end_cursor) break;
    after = pagination.end_cursor;
  }

  collected.sort((a, b) => new Date(b.publishedAtIso).getTime() - new Date(a.publishedAtIso).getTime());
  return collected;
}

async function listRecentKitPosts(
  config: KitConfig,
  opts: { limit: number; stopBeforeMs?: number },
): Promise<NormalizedNewsletterPost[]> {
  const now = new Date();
  const all = await collectAllCompletedKitPosts(config, now);
  const filtered =
    opts.stopBeforeMs !== undefined
      ? all.filter((p) => new Date(p.publishedAtIso).getTime() > opts.stopBeforeMs!)
      : all;
  return filtered.slice(0, opts.limit);
}

async function listKitPostsInWindow(
  config: KitConfig,
  opts: { startMs: number; endMs: number },
): Promise<NormalizedNewsletterPost[]> {
  const now = new Date();
  const all = await collectAllCompletedKitPosts(config, now);
  return all.filter((p) => {
    const ms = new Date(p.publishedAtIso).getTime();
    return ms >= opts.startMs && ms < opts.endMs;
  });
}

async function fetchKitPostContent(config: KitConfig, id: string): Promise<NewsletterPostContent> {
  const raw = await getBroadcast(Number(id), config);
  const detail = parseKitBroadcastDetail(raw); // #6362 item 7
  // `public_url` é `string | undefined` no tipo (#6096) — nunca confirmado
  // que o Kit sempre popula. `?? null` é o tratamento explícito exigido
  // pela docstring do módulo — nunca um `!`/cast que assumiria presença.
  if (!detail.content) {
    // item 8 (#6362): `fetchBeehiivPostContent` tenta 5 campos em cascata
    // antes de desistir; o lado Kit só tem `content` — sem fallback e, até
    // esta correção, sem log quando vem vazio. O post ainda entra em
    // `data/past-editions.md` (com `html: undefined`), mas sem HTML a
    // extração de links[] fica vazia e a dedup para de detectar repetição
    // pra esse post especificamente — em silêncio, até virar URL repetida
    // numa edição futura. O log nomeia o id na hora, não depois.
    console.error(
      `[newsletter-read-source] broadcast Kit ${id}: content vazio — links[] desta edição pode sair vazio no dedup`,
    );
  }
  return { html: detail.content ?? null, webUrl: detail.public_url ?? null };
}

// ---------------------------------------------------------------------------
// API pública — dispatch por backend
// ---------------------------------------------------------------------------

/** Bootstrap ("N mais recentes") ou incremental ("mais novos que
 *  `stopBeforeMs`") — usado por `refresh-dedup.ts`. */
export async function listRecentNewsletterPosts(
  readConfig: NewsletterReadConfig,
  opts: { limit: number; stopBeforeMs?: number },
): Promise<NormalizedNewsletterPost[]> {
  return readConfig.backend === "kit"
    ? listRecentKitPosts(readConfig.config, opts)
    : listRecentBeehiivPosts(readConfig.config, opts);
}

/** Janela de datas (`[startMs, endMs)`) — usado por `fetch-monthly-posts.ts`. */
export async function listNewsletterPostsInWindow(
  readConfig: NewsletterReadConfig,
  opts: { startMs: number; endMs: number },
): Promise<NormalizedNewsletterPost[]> {
  return readConfig.backend === "kit"
    ? listKitPostsInWindow(readConfig.config, opts)
    : listBeehiivPostsInWindow(readConfig.config, opts);
}

/** HTML + URL pública de 1 post/broadcast, pelo `id` normalizado (string —
 *  Kit é convertido de volta pra `number` internamente). */
export async function fetchNewsletterPostContent(
  readConfig: NewsletterReadConfig,
  id: string,
): Promise<NewsletterPostContent> {
  return readConfig.backend === "kit"
    ? fetchKitPostContent(readConfig.config, id)
    : fetchBeehiivPostContent(readConfig.config, id);
}
