/**
 * edition-cache-reader.ts (#6187 item 3 — camada de leitura unificada Beehiiv → Kit)
 *
 * ## O problema que este módulo resolve
 *
 * O cache local de edições publicadas é **híbrido permanente**, não
 * transitório (achado central do #6187): `data/beehiiv-cache/` tem 259
 * posts publicados na Beehiiv até o cutover, congelado e read-only a
 * partir daí; um cache Kit paralelo (`data/kit-cache/broadcasts/`) cresce a
 * partir do cutover. "Reconstruir o cache Beehiiv a partir do Kit" é
 * impossível por construção — a conta Kit foi criada em 2026 e não tem (nem
 * vai ter) as 259 edições antigas.
 *
 * Em vez de fazer os ~38 consumidores que varrem "todas as edições" (dedup,
 * arquivo, hubs, entidades, cobertura de corpus) saberem sobre as DUAS
 * origens, este módulo lê as duas e devolve **uma lista só**, ordenada por
 * data, normalizada pro mesmo shape (`UnifiedCachedPost`) — os consumidores
 * não precisam saber de qual origem veio cada edição.
 *
 * ## O que este módulo NÃO faz
 *
 * - Não escreve nenhum cache (nem Beehiiv nem Kit) — é só leitura. O
 *   escritor do lado Beehiiv já existe (`scripts/beehiiv-sync.ts`); um
 *   escritor equivalente pro lado Kit (`kit-sync.ts`) é trabalho futuro,
 *   fora do escopo desta unidade — `loadKitCache` já está pronto pra ler o
 *   diretório quando esse escritor existir (ver nota abaixo sobre
 *   `data/kit-cache/` ainda não existir na prática).
 * - Não decide QUANDO usar Kit vs Beehiiv pra escrita/publicação — isso é
 *   `platform.config.json` → `publishing.newsletter.backend` (#464),
 *   ortogonal a este módulo de LEITURA histórica.
 * - Não BUSCA cliques por link em nenhuma API — isso continua sendo
 *   `beehiiv-clicks-enricher` (via MCP) do lado Beehiiv e
 *   `getBroadcastClicks` (`kit-client.ts`) do lado Kit. Este módulo só
 *   NORMALIZA o que já está em disco pro shape unificado — ver `stats`
 *   abaixo (#6185, item 2 reescrito).
 *
 * ## Cliques por link (`stats`, #6185)
 *
 * `UnifiedCachedPost.stats.clicks` resolve a ORIGEM da edição (mesma
 * partição do resto da migração — Beehiiv para a base legada congelada no
 * corte, Kit para quem se cadastrou depois) e devolve os cliques por link
 * JÁ NO VOCABULÁRIO BEEHIIV (`NormalizedLinkClick`, ver abaixo) —
 * consumidor não precisa saber de qual origem veio.
 *
 * - **Beehiiv**: `stats.clicks` já vem nesse vocabulário no cache real
 *   (escrito por `apply-mcp-clicks.ts`, que mapeia a resposta do MCP
 *   `list_post_clicks`) — passthrough direto, sem transformação.
 * - **Kit**: `getBroadcastClicks` (`kit-client.ts`, campos confirmados
 *   contra clique real em 26/08/2026, #6185) devolve `{id, url,
 *   unique_clicks, click_to_delivery_rate, click_to_open_rate}` — SEM a
 *   distinção verified/unverified que a Beehiiv tem (bot-filtering).
 *   `normalizeKitClick` aproxima: usa `unique_clicks` pros três campos de
 *   contagem (`unique_clicks`, `unique_verified_clicks`, `verified_clicks`)
 *   e `click_to_open_rate` pros dois campos de taxa. **É uma aproximação
 *   documentada, não um dado que o Kit reporta separado** — se algum
 *   consumidor um dia precisar distinguir "clique verificado" no Kit, a
 *   resposta é "o Kit não tem esse conceito", não um bug de mapeamento
 *   aqui.
 * - **Não há escritor do cache Kit ainda** (mesma ressalva de
 *   `loadKitCache` abaixo) — `normalizeKitBroadcast` já sabe ler `clicks`
 *   se o raw file carregar esse campo (contrato pronto pro futuro
 *   `kit-sync.ts`/`apply-kit-clicks.ts`), mas hoje nenhum arquivo real
 *   tem isso — `stats` fica `undefined` pra todo broadcast Kit até esse
 *   escritor existir.
 *
 * ## Shape normalizado
 *
 * `UnifiedCachedPost` é estruturalmente compatível com `RawCachedPost`
 * (`scripts/generate-arquivo-titles.ts`) — mesmos nomes de campo
 * (`slug`, `title`, `subtitle`, `subject`, `web_url`, `publish_date`,
 * `status`, `thumbnail_url`, `content.free.web`), então qualquer consumidor
 * que já aceita `RawCachedPost[]` aceita `UnifiedCachedPost[]` sem
 * import cruzado (TypeScript estrutural — este módulo mora em `lib/shared/`
 * e não importa nada de `scripts/generate-arquivo-titles.ts`, que é
 * "legado não-classificado" na raiz de `lib/`, ver `test/lib-boundary.test.ts`).
 *
 * ## Normalização Kit → shape unificado (pontos que exigem cuidado)
 *
 * - **`web_url` ausente é esperado, nunca um bug** (achado medido do
 *   #6096/#6184): `KitBroadcastDetail.public_url` é `string | undefined`.
 *   Quando ausente, `slug` também fica `undefined` — os consumidores já
 *   tratam "post sem slug resolvível" como skip-com-warning (mesmo
 *   comportamento que já tinham pra um post Beehiiv sem `web_url`), nunca
 *   um crash.
 * - **Status**: o Kit usa `draft|scheduled|sending|completed|aborted`; a
 *   Beehiiv usa `confirmed` para "publicado" (é o valor que todo consumidor
 *   filtra). Sem mapear, um broadcast Kit `completed` nunca apareceria como
 *   "confirmado" pra nenhum consumidor — bug silencioso que faria a camada
 *   unificada, na prática, continuar só-Beehiiv mesmo depois do cutover.
 *   `KIT_STATUS_TO_BEEHIIV_STATUS` faz esse mapeamento explícito e testado.
 * - **`publish_date`**: Beehiiv usa Unix seconds; Kit usa ISO 8601
 *   (`published_at`/`send_at`). Convertido pra Unix seconds na normalização
 *   — os consumidores (via `beehiiv-publish-date.ts`) só entendem esse
 *   formato.
 * - **`content`**: Kit devolve `content: string | null` (HTML já
 *   renderizado); mapeado pra `content.free.web` pra casar o shape que
 *   `generate-hub-sources.ts`/`entity-page.ts` já leem.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { KitBroadcastClick, KitBroadcastDetail, KitBroadcastSummary } from "../kit-client.ts";

const MODULE_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const ROOT = resolve(MODULE_DIR, "..", "..", "..");

export const DEFAULT_BEEHIIV_POSTS_DIR = resolve(ROOT, "data/beehiiv-cache/posts");
/**
 * Ainda não populado na prática — nenhum `kit-sync.ts` existe até esta
 * unidade (escritor do lado Kit é trabalho futuro, ver docstring do
 * módulo). `loadKitCache` trata diretório ausente como "0 edições Kit
 * ainda", não como erro — ao contrário do lado Beehiiv, onde o diretório
 * ausente É um erro real (é a fonte primária hoje, tem que existir).
 */
export const DEFAULT_KIT_BROADCASTS_DIR = resolve(ROOT, "data/kit-cache/broadcasts");

export type EditionOrigin = "beehiiv" | "kit";

/** Shape normalizado — ver docstring do módulo. Estruturalmente compatível
 * com `RawCachedPost` (`scripts/generate-arquivo-titles.ts`); todo campo
 * além de `origin` é opcional, então um objeto que satisfaz isto satisfaz
 * `RawCachedPost` também (e vice-versa, salvo `origin`). */
export interface UnifiedCachedPost {
  /** De qual cache esta edição veio — nenhum consumidor hoje precisa ler
   *  isto (o objetivo do módulo é justamente esconder a origem), mas fica
   *  disponível pra debug/auditoria e pro tie-break determinístico do sort. */
  origin: EditionOrigin;
  slug?: string;
  title?: string;
  subtitle?: string;
  subject?: string;
  web_url?: string;
  /** Unix seconds — sempre, independente da origem (ver conversão do Kit
   *  na docstring do módulo). */
  publish_date?: number | null;
  /** Normalizado pro vocabulário Beehiiv (`confirmed` = publicado) — ver
   *  `KIT_STATUS_TO_BEEHIIV_STATUS`. */
  status?: string;
  thumbnail_url?: string;
  content?: { free?: { web?: string; email?: string } };
  /** Cliques por link, já resolvidos pra fonte certa — ver seção "Cliques
   *  por link" na docstring do módulo. `undefined` = nunca buscado (mesma
   *  semântica de `never_enriched`, ver `enrichment-state.ts`); presente
   *  com `clicks: []` = buscado e confirmado zero. */
  stats?: UnifiedClickStats;
}

/** Cliques por link no vocabulário Beehiiv — shape estruturalmente
 * compatível com `LegacyClick` (`apply-mcp-clicks.ts`), **incluindo o
 * aninhamento sob `email`**: `build-link-ctr.ts::matchClick` lê
 * `c.email?.verified_clicks` etc., não campos soltos. Duplicado aqui em
 * vez de importado (mesma razão de `slugFromUrl` abaixo: `lib/shared/` não
 * importa de `scripts/` raiz, ver `test/lib-boundary.test.ts` — a fronteira
 * não PROÍBE esse import especificamente, mas manter os módulos de
 * `lib/shared/` sem dependência de scripts CLI da raiz evita que um
 * refactor de CLI arraste este módulo de leitura junto). */
export interface NormalizedLinkClick {
  url: string;
  url_hash?: string;
  email: {
    verified_clicks: number;
    unique_verified_clicks: number;
    unique_clicks: number;
    click_rate?: number;
    click_rate_verified?: number;
  };
  web?: { total_clicked?: number; total_unique_clicked?: number };
}

/** Shape de `stats` no cache normalizado — unique_opens é passthrough do
 *  Beehiiv; o Kit não tem hoje um equivalente lido por este módulo (ver
 *  docstring). `enrichment_state` é passthrough de
 *  `scripts/lib/shared/enrichment-state.ts`. */
export interface UnifiedClickStats {
  email?: { unique_opens?: number };
  clicks?: NormalizedLinkClick[];
  enrichment_state?: string;
}

/** Shape mínimo lido de cada `data/beehiiv-cache/posts/{id}.json` — mesmos
 * campos de `RawCachedPost`, mais `id` (não lido por `RawCachedPost` mas
 * presente no cache real e útil pro tie-break de sort). Passthrough tipado
 * fracamente de propósito (o cache real tem bem mais campos). */
interface RawBeehiivPostFile {
  id?: string;
  slug?: string;
  title?: string;
  subtitle?: string;
  subject?: string;
  web_url?: string;
  publish_date?: number | null;
  status?: string;
  thumbnail_url?: string;
  content?: { free?: { web?: string; email?: string } };
  stats?: UnifiedClickStats;
}

/** Shape de 1 broadcast Kit em cache, estendido com um campo `clicks`
 * FUTURO (ver docstring do módulo — nenhum escritor grava isto ainda).
 * `KitBroadcastSummary`/`KitBroadcastDetail` (`kit-client.ts`) não têm
 * campo de cliques; este é o contrato que um `apply-kit-clicks.ts` futuro
 * seguiria pra anexar cliques ao arquivo de cache do broadcast. */
type RawKitBroadcastFile = KitBroadcastSummary &
  Partial<Pick<KitBroadcastDetail, "content" | "public_url">> & {
    clicks?: KitBroadcastClick[];
  };

/**
 * Normaliza 1 click do Kit (`getBroadcastClicks`, campos confirmados
 * #6185) pro vocabulário Beehiiv. O Kit não distingue clique
 * verificado/não-verificado (bot-filtering) — `unique_clicks` é usado pros
 * três campos de contagem, e `click_to_open_rate` pros dois de taxa. Ver
 * ressalva completa na docstring do módulo ("Cliques por link").
 */
export function normalizeKitClick(c: KitBroadcastClick): NormalizedLinkClick {
  return {
    url: c.url,
    email: {
      unique_clicks: c.unique_clicks,
      unique_verified_clicks: c.unique_clicks,
      verified_clicks: c.unique_clicks,
      click_rate: c.click_to_open_rate,
      click_rate_verified: c.click_to_open_rate,
    },
  };
}

/**
 * Mapeamento de status Kit → vocabulário Beehiiv. Só `completed` (envio
 * concluído) vira `confirmed` (o valor que os consumidores filtram como
 * "edição publicada de verdade"); os demais ficam como estão — nenhum
 * consumidor hoje precisa distinguir `draft`/`scheduled`/`sending`/`aborted`
 * do lado Kit, mas preservar o valor original (em vez de apagá-lo) evita
 * perder informação de debug à toa.
 */
export const KIT_STATUS_TO_BEEHIIV_STATUS: Readonly<Record<KitBroadcastSummary["status"], string>> = {
  completed: "confirmed",
  draft: "draft",
  scheduled: "scheduled",
  sending: "sending",
  aborted: "aborted",
};

/** Extrai o último segmento não-vazio do path de uma URL — mesma lógica de
 * `slugFromUrl` em `generate-arquivo-titles.ts` (não importada de lá — ver
 * nota de fronteira no topo do módulo: duplicada de propósito, é utilitário
 * de 4 linhas, não vale o acoplamento cruzado por isso). Devolve `null` pra
 * URL ausente/inválida — nunca lança. */
function slugFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const path = new URL(url).pathname;
    const parts = path.split("/").filter(Boolean);
    return parts[parts.length - 1] || undefined;
  } catch {
    return undefined;
  }
}

/** ISO 8601 → Unix seconds. `undefined`/inválido devolve `undefined` (nunca
 * `NaN` silencioso — um `publish_date: NaN` passaria despercebido por
 * comparações numéricas e quebraria o sort de forma difícil de notar). */
function isoToUnixSeconds(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return Math.floor(ms / 1000);
}

/** Normaliza 1 arquivo do cache Beehiiv pro shape unificado. Passthrough
 * dos campos já no vocabulário certo — só adiciona `origin`. */
export function normalizeBeehiivPost(raw: RawBeehiivPostFile): UnifiedCachedPost {
  return {
    origin: "beehiiv",
    slug: raw.slug,
    title: raw.title,
    subtitle: raw.subtitle,
    subject: raw.subject,
    web_url: raw.web_url,
    publish_date: raw.publish_date,
    status: raw.status,
    thumbnail_url: raw.thumbnail_url,
    content: raw.content,
    stats: raw.stats,
  };
}

/**
 * Normaliza 1 broadcast do Kit pro shape unificado. `public_url` ausente é
 * tratado explicitamente (ver docstring do módulo) — nunca um `!`/cast que
 * assumiria presença. `stats.clicks` só aparece se o raw file carregar
 * `clicks` (ver `RawKitBroadcastFile`) — hoje isso nunca acontece na
 * prática (sem escritor, ver docstring do módulo), mas o mapeamento já
 * fica pronto.
 */
export function normalizeKitBroadcast(b: RawKitBroadcastFile): UnifiedCachedPost {
  const webUrl = b.public_url; // pode ser undefined — não assumir presença (#6096)
  return {
    origin: "kit",
    slug: slugFromUrl(webUrl),
    // Kit não tem campo "title" separado de "subject". A versão anterior
    // deixava `title: undefined` assumindo que os consumidores fazem
    // `title ?? subject` — **eles não fazem**. `collectHubSources`
    // (`scripts/generate-hub-sources.ts`) monta os destaques como
    // `[post.title, ...subtitle.split("|")].filter(...)`, direto e sem
    // fallback: com `title` undefined, o filter descarta e TODA edição de
    // origem Kit fica invisível pro matching de hubs/entidades — em
    // silêncio, sem erro em lugar nenhum. Hoje o efeito é zero porque o
    // cache Kit está vazio; a falha apareceria exatamente no cutover, que é
    // quando menos se olha pra isso. Mapear `subject` → `title` é a
    // aproximação correta: no Kit o `subject` É a manchete da edição.
    title: b.subject,
    // `preview_text` é o campo mais próximo semanticamente de `subtitle`
    // (texto curto de apoio ao assunto) — usado pelos consumidores só como
    // sinal fraco de keyword match (hubs/entidades), não como verdade
    // estrutural, então uma aproximação é aceitável aqui.
    subtitle: b.description ?? undefined,
    subject: b.subject,
    web_url: webUrl,
    publish_date: isoToUnixSeconds(b.published_at ?? b.send_at),
    status: KIT_STATUS_TO_BEEHIIV_STATUS[b.status] ?? b.status,
    thumbnail_url: b.thumbnail_url ?? undefined,
    content: b.content ? { free: { web: b.content } } : undefined,
    stats: b.clicks ? { clicks: b.clicks.map(normalizeKitClick) } : undefined,
  };
}

/** Lê `data/beehiiv-cache/posts/*.json` (exclui `index.json`, que tem outro
 * shape) e normaliza. Isola falha de parse POR ARQUIVO — um JSON
 * corrompido não pode abortar a leitura inteira sem dizer qual arquivo é o
 * culpado (mesmo padrão de `generate-hub-sources.ts::loadPosts`).
 *
 * Lança se o diretório não existir — é a fonte PRIMÁRIA hoje (259 edições
 * confirmadas), diferente do lado Kit (ver `loadKitCache`).
 */
export function loadBeehiivCache(dir: string = DEFAULT_BEEHIIV_POSTS_DIR): UnifiedCachedPost[] {
  if (!existsSync(dir)) {
    throw new Error(
      `[edition-cache-reader] ${dir} ausente — precisa do junction data/ (OneDrive) populado por ` +
        `beehiiv-sync.ts. Ver CLAUDE.md sobre a junction data/.`,
    );
  }
  const posts: UnifiedCachedPost[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as RawBeehiivPostFile;
      posts.push(normalizeBeehiivPost(raw));
    } catch (e) {
      process.stderr.write(
        `[edition-cache-reader] ⚠ falha ao parsear ${f} (Beehiiv): ${e instanceof Error ? e.message : e}\n`,
      );
    }
  }
  return posts;
}

/**
 * Lê `data/kit-cache/broadcasts/*.json` e normaliza. **Diretório ausente
 * devolve `[]`, nunca lança** — diferente do lado Beehiiv, porque o
 * escritor deste cache (`kit-sync.ts`) ainda não existe (trabalho futuro,
 * ver docstring do módulo); "ainda não há edição Kit" é o estado ESPERADO
 * hoje, não um erro. Mesmo isolamento de falha por-arquivo do lado Beehiiv.
 */
export function loadKitCache(dir: string = DEFAULT_KIT_BROADCASTS_DIR): UnifiedCachedPost[] {
  if (!existsSync(dir)) return [];
  const posts: UnifiedCachedPost[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as RawKitBroadcastFile;
      posts.push(normalizeKitBroadcast(raw));
    } catch (e) {
      process.stderr.write(
        `[edition-cache-reader] ⚠ falha ao parsear ${f} (Kit): ${e instanceof Error ? e.message : e}\n`,
      );
    }
  }
  return posts;
}

/**
 * Funde as duas listas já normalizadas, ordenadas por `publish_date`
 * DESCENDENTE (mais recente primeiro — mesma convenção que
 * `list_posts`/`listBroadcasts` já devolvem por padrão nas duas APIs).
 *
 * **Determinístico mesmo com datas iguais/ausentes** (achado do self-review
 * pedido pelo dispatch): duas edições no mesmo dia, uma de cada origem, não
 * têm uma ordem "correta" única — o que importa é que o resultado seja
 * SEMPRE o mesmo pro mesmo input, independente da ordem de chegada dos
 * arrays. Critério de desempate, em ordem: (1) `publish_date` desc; (2)
 * ausente vai por ÚLTIMO (nunca interpretado como "0" — misturaria com
 * 1970, e nunca no topo — misturaria com "mais recente"); (3) `origin`
 * (beehiiv antes de kit, alfabético); (4) `slug` (alfabético, string vazia
 * por último).
 */
export function mergeEditionsByDate(
  beehiiv: readonly UnifiedCachedPost[],
  kit: readonly UnifiedCachedPost[],
): UnifiedCachedPost[] {
  const all = [...beehiiv, ...kit];
  return all.sort((a, b) => {
    const da = a.publish_date;
    const db = b.publish_date;
    const aMissing = da === null || da === undefined;
    const bMissing = db === null || db === undefined;
    if (aMissing && bMissing) {
      // segue pro desempate abaixo
    } else if (aMissing) {
      return 1; // a sem data vai depois
    } else if (bMissing) {
      return -1; // b sem data vai depois
    } else if (da !== db) {
      return db - da; // desc
    }
    if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
    const sa = a.slug ?? "";
    const sb = b.slug ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
    return 0;
  });
}

export interface LoadUnifiedEditionsOptions {
  beehiivPostsDir?: string;
  kitBroadcastsDir?: string;
}

/**
 * Ponto de entrada único: lê os dois caches em disco e devolve a lista
 * unificada, ordenada por data — a "camada de leitura unificada" do #6187
 * item 3. Todo consumidor que hoje só lê `data/beehiiv-cache/posts/*.json`
 * (via `generate-hub-sources.ts::loadPosts` e vizinhos) migra pra isto sem
 * precisar saber nada sobre a existência do cache Kit.
 */
export function loadUnifiedEditionCache(opts: LoadUnifiedEditionsOptions = {}): UnifiedCachedPost[] {
  const beehiiv = loadBeehiivCache(opts.beehiivPostsDir);
  const kit = loadKitCache(opts.kitBroadcastsDir);
  return mergeEditionsByDate(beehiiv, kit);
}
