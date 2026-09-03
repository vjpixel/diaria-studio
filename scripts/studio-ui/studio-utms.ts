/**
 * studio-utms.ts (#4041, fatia da EPIC "Studio UI" #3554)
 *
 * Camada de leitura/escrita da página `/utms` — a superfície que responde
 * "esse UTM ainda existe?" e "quanto ele converteu?" sem rodar script na mão.
 * Arquivo próprio desta fatia (mesma convenção de `studio-integrations.ts`
 * (#3848), `studio-review.ts`, `studio-apoios.ts`) — `server.ts` só roteia.
 *
 * **Três camadas cruzadas:**
 *
 *   1. **Inventário** — `UTM_EMITTERS` de `lib/shared/utm-registry.ts`, o que
 *      o CÓDIGO emite. Fonte da verdade dos valores.
 *   2. **Conversão (Beehiiv OU Kit)** — `fetchAndAggregate`/`fetchAndAggregateKit`
 *      de `../count-subscriptions-by-utm.ts` (#2457, já testado): assinantes
 *      por `utm_source` e — desde o #4041 — por `utm_campaign`. É o único
 *      lado que fecha o funil ATÉ A CONVERSÃO. Backend escolhido por
 *      `publishing.newsletter.subscriber_backend` (`platform.config.json`,
 *      default `"beehiiv"`, #6051) via
 *      `../lib/shared/newsletter-subscriber-source.ts` — chave PRÓPRIA,
 *      independente de `backend`/`read_backend` (ver docstring do módulo
 *      compartilhado pro racional completo, inclusive a limitação conhecida
 *      da atribuição nativa do Kit).
 *   3. **Clique (Brevo)** — `linksStats` das campanhas do digest mensal, mesma
 *      leitura que o `workers/brevo-dashboard` faz (dois GETs separados:
 *      `?statistics=globalStats` e `?statistics=linksStats`, porque o param
 *      COMBINADO devolve `linksStats` zerado — bug #2177/#2249 documentado lá).
 *      Aqui só o `linksStats` interessa; os cliques são somados por
 *      `utm_campaign` extraído da própria URL do link.
 *
 * **Drift nos dois sentidos** (`computeDrift`, puro):
 *   - `sem_conversao` — o código emite, mas ninguém converteu: link quebrado,
 *     posição morta, ou UTM dropado no caminho (causa raiz do #2613).
 *   - `nao_catalogado` — chegou `utm_source` no Beehiiv que o código NÃO
 *     emite: origem desconhecida ou auto-tag de plataforma (`sendinblue`, o
 *     problema original do #2975).
 *
 * **Fronteira de EDIÇÃO (decisão explícita do #4041, v1).** A UI edita
 * **apenas metadados editoriais** — `description` e `status`
 * (`ativo`/`aposentado`) — persistidos em `data/utm-metadata.json`, um overlay
 * lido por cima do registry. Os VALORES (`source`/`medium`/`campaignPattern`)
 * são **read-only pela UI, sempre**: editá-los ali não mudaria o código do
 * emissor, e o resultado seria uma página que MENTE sobre o que a produção
 * emite — pior do que não ter página. Mudar valor continua sendo PR no
 * registry. `applyMetadata` (puro) é onde essa fronteira é implementada:
 * campos fora da allowlist são ignorados silenciosamente na leitura e
 * REJEITADOS na escrita (`saveUtmMetadata` devolve `{ok:false}`).
 *
 * **Fail-soft total** (mesmo padrão de `studio-apoios.ts`/`studio-integrations.ts`):
 * nenhuma falha de rede/credencial derruba a página — Beehiiv e Brevo viram
 * campos `error` próprios e o inventário continua renderizando. Num clone
 * `cloud` sem credenciais, a página mostra só o inventário, que é o esperado.
 *
 * **Cache + TTL** (10 min default) — o drain de subscriptions do Beehiiv é
 * caro (paginado). `forceRefresh` (botão "Atualizar", `?refresh=1`) bypassa,
 * mesmo padrão de `buildIntegrationsData`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadProjectEnv } from "../lib/env-loader.ts";
import { detectExecMode, type ExecMode } from "../lib/exec-mode.ts";
import {
  UTM_EMITTERS,
  EXTERNAL_UTM_SURFACES,
  buildExternalSurfaceUrl,
  knownUtmSources,
  campaignPatternToRegExp,
  type UtmEmitter,
  type UtmEmitterStatus,
  type ExternalUtmSurface,
} from "../lib/shared/utm-registry.ts";
import { fetchAndAggregate, fetchAndAggregateKit } from "../count-subscriptions-by-utm.ts";
import { resolveBeehiivConfig } from "../lib/beehiiv-config.ts";
import {
  resolveNewsletterSubscriberConfig,
  resolveNewsletterSubscriberBackend,
  type NewsletterSubscriberBackend,
} from "../lib/shared/newsletter-subscriber-source.ts";
import { brevoGet } from "../lib/brevo-client.ts";

// Mesmo racional de `studio-integrations.ts`/`dashboard-clarice.ts`: garante
// `.env` carregado mesmo sem passar por um entrypoint que já
// chamou isso. Idempotente, nunca sobrescreve var já presente.
loadProjectEnv();

// ---------------------------------------------------------------------------
// Metadados editáveis (overlay por cima do registry)
// ---------------------------------------------------------------------------

/** Campos que a UI PODE editar. Qualquer outro é rejeitado — ver header. */
export const EDITABLE_METADATA_FIELDS = ["description", "status", "note"] as const;

export interface UtmMetadataEntry {
  /** Sobrescreve a descrição da posição (texto editorial, não afeta emissão). */
  description?: string;
  /** Sobrescreve o status editorial (`ativo`/`aposentado`). */
  status?: UtmEmitterStatus;
  /** Nota livre do editor (ex: "medido no round CTA-01, ver docs/experiments"). */
  note?: string;
  /** ISO da última edição — carimbado pelo servidor, nunca vem do cliente. */
  updatedAt?: string;
}

export type UtmMetadata = Record<string, UtmMetadataEntry>;

/** Path do overlay de metadados (dentro do junction `data/`, #2643). */
export function utmMetadataPath(rootDir: string): string {
  return join(rootDir, "data", "utm-metadata.json");
}

/** Lê o overlay. Fail-soft: arquivo ausente/corrompido → `{}` (a página
 * renderiza o registry puro em vez de quebrar). @pure-ish (só I/O de leitura) */
export function loadUtmMetadata(rootDir: string): UtmMetadata {
  const path = utmMetadataPath(rootDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as UtmMetadata) : {};
  } catch {
    return {};
  }
}

/**
 * Aplica o overlay sobre uma entrada do registry, respeitando a fronteira: só
 * `description`/`status`/`note` podem vir do overlay. `source`/`medium`/
 * `campaignPattern`/`originFile` SEMPRE vêm do código.
 *
 * @pure
 */
export function applyMetadata(emitter: UtmEmitter, meta: UtmMetadataEntry | undefined): UtmEmitter & {
  note?: string;
  metadataEditedAt?: string;
} {
  if (!meta) return { ...emitter };
  const status: UtmEmitterStatus =
    meta.status === "ativo" || meta.status === "aposentado" ? meta.status : emitter.status;
  return {
    ...emitter,
    description:
      typeof meta.description === "string" && meta.description.trim()
        ? meta.description.trim()
        : emitter.description,
    status,
    note: typeof meta.note === "string" && meta.note.trim() ? meta.note.trim() : undefined,
    metadataEditedAt: meta.updatedAt,
  };
}

export interface SaveMetadataResult {
  ok: boolean;
  error?: string;
  entry?: UtmMetadataEntry;
}

/**
 * Persiste metadados de UM emissor. Rejeita (sem escrever nada):
 *   - id que não existe no registry — a UI não inventa emissor;
 *   - qualquer campo fora de `EDITABLE_METADATA_FIELDS` (em especial
 *     `source`/`medium`/`campaignPattern`, que só mudam por PR no registry).
 */
export function saveUtmMetadata(
  rootDir: string,
  id: string,
  patch: Record<string, unknown>,
  now: () => string = () => new Date().toISOString(),
): SaveMetadataResult {
  if (!UTM_EMITTERS.some((e) => e.id === id)) {
    return { ok: false, error: `emissor desconhecido: ${id}` };
  }
  const allowed = new Set<string>(EDITABLE_METADATA_FIELDS);
  const rejected = Object.keys(patch).filter((k) => !allowed.has(k));
  if (rejected.length > 0) {
    return {
      ok: false,
      error:
        `campo não-editável pela UI: ${rejected.join(", ")}. ` +
        `Os VALORES de UTM (source/medium/campaign) só mudam por PR em ` +
        `scripts/lib/shared/utm-registry.ts — editá-los aqui dessincronizaria a ` +
        `página do que o emissor de fato produz.`,
    };
  }
  if (patch.status !== undefined && patch.status !== "ativo" && patch.status !== "aposentado") {
    return { ok: false, error: `status inválido: ${String(patch.status)}` };
  }

  const all = loadUtmMetadata(rootDir);
  const entry: UtmMetadataEntry = { ...all[id] };
  if (typeof patch.description === "string") entry.description = patch.description;
  if (typeof patch.note === "string") entry.note = patch.note;
  if (patch.status === "ativo" || patch.status === "aposentado") entry.status = patch.status;
  entry.updatedAt = now();
  all[id] = entry;

  const path = utmMetadataPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(all, null, 2) + "\n", "utf8");
  return { ok: true, entry };
}

// ---------------------------------------------------------------------------
// Cliques (Brevo linksStats) — mesma leitura do workers/brevo-dashboard
// ---------------------------------------------------------------------------

/**
 * Extrai o `utm_campaign` de uma URL de link. `null` quando a URL não tem o
 * parâmetro (link de sistema — unsubscribe, view-in-browser — ou link externo
 * sem UTM). @pure
 */
export function campaignFromUrl(url: string): string | null {
  try {
    const c = new URL(url).searchParams.get("utm_campaign");
    return c && c.trim() ? c.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Soma cliques por `utm_campaign` a partir de um mapa `linksStats`
 * (`{url: clicks}`) — o formato exato que a Brevo devolve. Links sem
 * `utm_campaign` são ignorados (não viram bucket "__none__": aqui interessa
 * só o que é atribuível). @pure
 */
export function aggregateClicksByCampaign(
  linksStats: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [url, clicks] of Object.entries(linksStats)) {
    const campaign = campaignFromUrl(url);
    if (!campaign) continue;
    out[campaign] = (out[campaign] ?? 0) + (Number(clicks) || 0);
  }
  return out;
}

export interface BrevoClicksResult {
  clicksByCampaign: Record<string, number>;
  campaignsRead: number;
  error?: string;
}

/**
 * Busca `linksStats` das últimas N campanhas da Brevo e agrega por
 * `utm_campaign`. Fail-soft: sem `BREVO_CLARICE_API_KEY` (ou qualquer falha)
 * devolve `{clicksByCampaign:{}, error}` — a página segue mostrando Beehiiv +
 * inventário.
 *
 * O GET de `linksStats` é SEPARADO do de `globalStats` de propósito: o param
 * combinado devolve `linksStats` zerado (bug #2177, documentado em
 * `workers/brevo-dashboard/src/brevo-api.ts`). Aqui nem pedimos `globalStats`.
 */
export async function fetchBrevoClicks(
  apiKey: string | undefined,
  limit = 20,
  get: typeof brevoGet = brevoGet,
): Promise<BrevoClicksResult> {
  if (!apiKey) {
    return {
      clicksByCampaign: {},
      campaignsRead: 0,
      error: "BREVO_CLARICE_API_KEY ausente — dados de clique indisponíveis neste ambiente.",
    };
  }
  try {
    const list = await get(apiKey, `/emailCampaigns?limit=${limit}&sort=desc&status=sent`);
    const campaigns: Array<{ id: number }> = list.body?.campaigns ?? [];
    const clicksByCampaign: Record<string, number> = {};
    let read = 0;
    for (const c of campaigns) {
      try {
        const detail = await get(apiKey, `/emailCampaigns/${c.id}?statistics=linksStats`);
        const ls: Record<string, number> = detail.body?.statistics?.linksStats ?? {};
        for (const [campaign, clicks] of Object.entries(aggregateClicksByCampaign(ls))) {
          clicksByCampaign[campaign] = (clicksByCampaign[campaign] ?? 0) + clicks;
        }
        read++;
      } catch {
        // Uma campanha que falha (429/404) não derruba as outras — mesma
        // disciplina de try/catch POR GET do brevo-dashboard (#2249).
      }
    }
    return { clicksByCampaign, campaignsRead: read };
  } catch (e) {
    return { clicksByCampaign: {}, campaignsRead: 0, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Drift (puro)
// ---------------------------------------------------------------------------

export interface DriftFinding {
  kind: "sem_conversao" | "nao_catalogado";
  key: string;
  detail: string;
}

/**
 * Cruza inventário × realidade nos dois sentidos (#4041).
 *
 * @param emitters      inventário já com overlay aplicado
 * @param sourceCounts  assinantes por `utm_source` (Beehiiv)
 * @pure
 */
export interface ComputeDriftExtras {
  /** Superfícies externas (#4525) — checadas por `utm_campaign`, ver abaixo. */
  externals?: ReadonlyArray<ExternalUtmSurface>;
  /** Assinantes por `utm_campaign` (Beehiiv). */
  campaignCounts?: Record<string, number>;
}

export function computeDrift(
  emitters: ReadonlyArray<UtmEmitter>,
  sourceCounts: Record<string, number>,
  extras: ComputeDriftExtras = {},
): DriftFinding[] {
  const out: DriftFinding[] = [];
  const seen = new Map<string, number>();
  for (const [k, v] of Object.entries(sourceCounts)) seen.set(k.toLowerCase(), v);

  // Sentido 1: emitido, mas sem nenhuma conversão. `aposentado` é esperado
  // não converter — não é drift, é o estado declarado.
  for (const e of emitters) {
    if (e.status === "aposentado") continue;
    if (!((seen.get(e.source.toLowerCase()) ?? 0) > 0)) {
      out.push({
        kind: "sem_conversao",
        key: e.id,
        detail: `${e.label}: utm_source="${e.source}" não trouxe nenhum assinante — link quebrado, posição morta, ou UTM dropado no caminho.`,
      });
    }
  }

  // Sentido 1b: superfície externa APLICADA que não converteu (#4525). Checada
  // por `utm_campaign`, não por `utm_source`: `twitter`/`facebook`/`threads`
  // são compartilhados com emissores de código (o CTA do post), então o sinal
  // por source já viria positivo por causa deles e esconderia justamente o que
  // interessa aqui — se o CAMPO do perfil salvou e sobreviveu à normalização de
  // URL da plataforma. Superfície sem `appliedAt` é pulada: não converter antes
  // de ser aplicada é o estado correto, não drift.
  const campaignCounts = extras.campaignCounts ?? {};
  const campaignSeen = new Map<string, number>();
  for (const [k, v] of Object.entries(campaignCounts)) campaignSeen.set(k.toLowerCase(), v);
  for (const s of extras.externals ?? []) {
    if (s.status === "aposentado" || !s.appliedAt) continue;
    // `driftKey: "source"` é a exceção das plataformas que truncam a URL e só
    // deixam passar um parâmetro (Apoia.se): lá o campaign nunca chega, e o
    // check por campaign acusaria drift eternamente. Só é válido porque o
    // `utm_source` dessas é exclusivo — travado por teste.
    const bySource = s.driftKey === "source";
    const key = bySource ? s.source : s.campaign;
    const count = bySource
      ? (seen.get(key.toLowerCase()) ?? 0)
      : (campaignSeen.get(key.toLowerCase()) ?? 0);
    if (!(count > 0)) {
      out.push({
        kind: "sem_conversao",
        key: s.id,
        detail: `${s.label}: ${bySource ? "utm_source" : "utm_campaign"}="${key}" não trouxe nenhum assinante desde ${s.appliedAt} — campo não salvou, plataforma removeu a query string, ou o perfil não gera tráfego. Reconferir em ${s.panelUrl}.`,
      });
    }
  }

  // Sentido 2: chegou no Beehiiv, mas o código não emite.
  const known = new Set(knownUtmSources());
  for (const [source, count] of seen) {
    if (source === "__none__" || known.has(source)) continue;
    out.push({
      kind: "nao_catalogado",
      key: source,
      detail: `utm_source="${source}" trouxe ${count} assinante(s) mas nenhum emissor do código produz esse valor — origem não catalogada ou auto-tag de plataforma (ex: sendinblue, #2975).`,
    });
  }

  return out;
}

/**
 * Casa cada emissor com as campanhas concretas que chegaram, via o padrão
 * declarado (`campaignPatternToRegExp`). @pure
 */
export function matchCampaigns(
  emitter: UtmEmitter,
  campaignCounts: Record<string, number>,
): Array<{ campaign: string; count: number }> {
  const re = campaignPatternToRegExp(emitter.campaignPattern);
  return Object.entries(campaignCounts)
    .filter(([campaign]) => re.test(campaign))
    .map(([campaign, count]) => ({ campaign, count }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface UtmEmitterRow extends UtmEmitter {
  note?: string;
  metadataEditedAt?: string;
  /** Assinantes com este `utm_source` (Beehiiv). `null` quando o fetch falhou. */
  subscribers: number | null;
  /** Campanhas concretas que casaram o padrão, com contagem. */
  campaigns: Array<{ campaign: string; count: number }>;
  /** Cliques (Brevo) somados nas campanhas que casaram. `null` sem dados. */
  clicks: number | null;
}

/**
 * Linha de superfície externa (#4525). Mesmas colunas de conversão da tabela de
 * emissores — o valor da página é poder comparar bio × post × e-mail lado a
 * lado — mais o runbook (`panelUrl`/`field`) e a URL pronta pra colar.
 */
export interface ExternalSurfaceRow extends ExternalUtmSurface {
  /** URL exata a colar no painel, derivada do registry (nunca digitada). */
  url: string;
  /** Assinantes com este `utm_source` (Beehiiv). `null` quando o fetch falhou. */
  subscribers: number | null;
  /** Assinantes com este `utm_campaign` — o sinal específico desta superfície. */
  campaignSubscribers: number | null;
  /** Cliques (Brevo) da campanha. `null` sem dados. */
  clicks: number | null;
}

export interface UtmsSnapshot {
  execMode: ExecMode;
  generatedAt: string;
  cached: boolean;
  emitters: UtmEmitterRow[];
  /** Superfícies de bio/perfil preenchidas à mão (#4525). */
  externalSurfaces: ExternalSurfaceRow[];
  drift: DriftFinding[];
  totals: { subscribers: number | null; campaignsRead: number };
  /** Backend resolvido pra leitura de ASSINANTE (#7182 — `publishing.newsletter.
   *  subscriber_backend`, `resolveNewsletterSubscriberBackend`). A tela não
   *  expunha isso antes: `buildUtmsData` já resolvia o backend (é o que decide
   *  Beehiiv vs Kit acima), mas `UtmsSnapshot` não carregava o resultado —
   *  quem olhava `/utms` não tinha como saber qual plataforma estava sendo
   *  contada. Ecoado SEMPRE, mesmo em erro de credencial (é resolução de
   *  CONFIG, não de rede — nunca falha, ver `resolveNewsletterSubscriberBackend`). */
  subscriberBackend: NewsletterSubscriberBackend;
  /** Ressalva de divergência entre `subscriberBackend` (o que esta tela LÊ) e
   *  o backend real de CADASTRO dos 3 workers de assinatura — que é Kit desde
   *  #6048 (rollout worker-a-worker, Gate B 25/08/2026), independente do
   *  valor de `subscriberBackend` (eixos deliberadamente independentes, ver
   *  `docs/kit-creator-network.md` e a docstring de
   *  `newsletter-subscriber-source.ts`). `null` quando `subscriberBackend`
   *  já é `"kit"` (nada a avisar — leitura e cadastro convergem). Quando
   *  `"beehiiv"` (default, #7182): os cadastros feitos via `POST
   *  /v4/subscribers` pelos workers não carregam `KitSubscriberAttribution`
   *  (#6339/#6425 Parte A), então mesmo se este painel lesse o Kit hoje a
   *  agregação por UTM subcontaria — é por isso que a chave NÃO virou
   *  `"kit"` ainda (decisão registrada, não descuido — `platform.config.json`
   *  → `subscriber_backend_note`). */
  subscriberBackendNotice: string | null;
  beehiivError?: string;
  brevoError?: string;
  /** Fronteira de edição, ecoada pra UI não ter que hardcodar. */
  editableFields: ReadonlyArray<string>;
}

interface CacheEntry {
  data: UtmsSnapshot;
  expiresAt: number;
}
const cacheByRoot = new Map<string, CacheEntry>();

/** Limpa o cache — usado só por testes pra isolar casos entre si. */
export function clearUtmsCache(): void {
  cacheByRoot.clear();
}

export interface BuildUtmsOptions {
  now?: () => number;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  /** Injetável pra teste — NUNCA bater no Beehiiv real na suíte. */
  fetchSubscriptions?: typeof fetchAndAggregate;
  /** Injetável pra teste — NUNCA bater no Kit real na suíte (#6051, só
   *  usado quando `publishing.newsletter.subscriber_backend === "kit"`). */
  fetchSubscriptionsKit?: typeof fetchAndAggregateKit;
  /** Override do backend resolvido — só pra teste; produção sempre lê
   *  `publishing.newsletter.subscriber_backend` de `platform.config.json`
   *  real (#6051). */
  subscriberBackend?: "beehiiv" | "kit";
  /** Injetável pra teste — NUNCA bater na Brevo real na suíte. */
  fetchClicks?: typeof fetchBrevoClicks;
  env?: Record<string, string | undefined>;
}

/**
 * Monta o snapshot de `GET /api/utms`. Sempre resolve — Beehiiv e Brevo são
 * avaliados isoladamente e viram campo `error` próprio (fail-soft).
 */
export async function buildUtmsData(
  rootDir: string,
  opts: BuildUtmsOptions = {},
): Promise<UtmsSnapshot> {
  const now = opts.now ?? (() => Date.now());
  const nowMs = now();
  const cacheTtlMs = opts.cacheTtlMs ?? 10 * 60_000;

  if (!opts.forceRefresh) {
    const cached = cacheByRoot.get(rootDir);
    if (cached && cached.expiresAt > nowMs) return { ...cached.data, cached: true };
  }

  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  // #7182: resolução PURA (config, não rede) — nunca falha, ecoa sempre no
  // snapshot mesmo quando a resolução COM credencial (`resolved` abaixo)
  // falhar. `opts.subscriberBackend` (override de teste) tem precedência,
  // mesmo campo que já decide o backend efetivo mais abaixo.
  const subscriberBackend: NewsletterSubscriberBackend =
    opts.subscriberBackend ?? resolveNewsletterSubscriberBackend();
  const subscriberBackendNotice: string | null =
    subscriberBackend === "beehiiv"
      ? "Mas os 3 workers de assinatura (poll, cursos, reativar) cadastram no Kit " +
        "desde #6048 (rollout worker-a-worker, Gate B 25/08/2026), via POST /v4/subscribers (#6339). " +
        "Esse caminho não popula KitSubscriberAttribution, então os cadastros novos feitos pelos " +
        "workers não aparecem aqui — decisão registrada (platform.config.json → subscriber_backend_note), " +
        "não um bug desta tela."
      : null;
  const meta = loadUtmMetadata(rootDir);
  const emittersBase = UTM_EMITTERS.map((e) => applyMetadata(e, meta[e.id]));

  // ── Conversão (assinantes) — Beehiiv OU Kit, conforme
  //    `publishing.newsletter.subscriber_backend` (#6051). Campo de erro
  //    continua se chamando `beehiivError` mesmo no caminho Kit — nome
  //    legado preservado pra não quebrar o client (`revisao.js`/testes) que
  //    já lê esse campo; a flag é default `"beehiiv"` em produção, então o
  //    caminho Kit é hoje inatingível fora de teste explícito (opts.backend).
  let sourceCounts: Record<string, number> = {};
  let campaignCounts: Record<string, number> = {};
  let totalSubscribers: number | null = null;
  let beehiivError: string | undefined;
  try {
    // `loadBeehiivConfig`/`loadKitConfig` fazem `process.exit(2)` quando a
    // credencial falta (helpers de CLI). No studio-server isso derrubaria o
    // processo INTEIRO — então usamos as versões puras (`resolveBeehiivConfig`,
    // #4296 / `resolveNewsletterSubscriberConfig`, #6051) que nunca terminam
    // o processo: ausência vira `beehiivError` direto. Roda SEMPRE (não só
    // quando `!injected`) — é leitura pura de env + arquivo local, nunca
    // rede — pra que testes com fetcher injetado também exerçam o caminho
    // real de resolução (mesma lição do #4296: pular a resolução quando
    // injetado escondia o bug original da suíte).
    const injectedBeehiiv = Boolean(opts.fetchSubscriptions);
    const injectedKit = Boolean(opts.fetchSubscriptionsKit);
    const resolved = resolveNewsletterSubscriberConfig({ env, backend: opts.subscriberBackend });
    if (!resolved.ok) {
      if (!injectedBeehiiv && !injectedKit) throw new Error(resolved.reason);
      // Sem credencial resolvível mas com fetcher injetado (teste): segue
      // com o backend default (beehiiv) — mesmo comportamento pré-#6051.
      const fetcher = opts.fetchSubscriptions ?? fetchAndAggregate;
      const result = await fetcher("", "");
      sourceCounts = result.counts ?? {};
      campaignCounts = result.campaignCounts ?? {};
      totalSubscribers = result.total ?? null;
    } else if (resolved.config.backend === "kit") {
      const fetcher = opts.fetchSubscriptionsKit ?? fetchAndAggregateKit;
      const result = await fetcher(resolved.config.config);
      sourceCounts = result.counts ?? {};
      campaignCounts = result.campaignCounts ?? {};
      totalSubscribers = result.total ?? null;
    } else {
      const fetcher = opts.fetchSubscriptions ?? fetchAndAggregate;
      const { publicationId, apiKey } = resolved.config.config;
      const result = await fetcher(publicationId, apiKey);
      sourceCounts = result.counts ?? {};
      campaignCounts = result.campaignCounts ?? {};
      totalSubscribers = result.total ?? null;
    }
  } catch (e) {
    beehiivError = (e as Error).message;
  }

  // ── Brevo (clique) ───────────────────────────────────────────────────────
  const clicksFetcher = opts.fetchClicks ?? fetchBrevoClicks;
  const clicks = await clicksFetcher(env.BREVO_CLARICE_API_KEY);

  const emitters: UtmEmitterRow[] = emittersBase.map((e) => {
    const matched = matchCampaigns(e, campaignCounts);
    const clickSum = matched.reduce((acc, m) => acc + (clicks.clicksByCampaign[m.campaign] ?? 0), 0);
    return {
      ...e,
      subscribers: beehiivError ? null : (sourceCounts[e.source.toLowerCase()] ?? 0),
      campaigns: matched,
      clicks: clicks.error ? null : clickSum,
    };
  });

  const externalSurfaces: ExternalSurfaceRow[] = EXTERNAL_UTM_SURFACES.map((s) => {
    const campaignKey = s.campaign.toLowerCase();
    return {
      ...s,
      url: buildExternalSurfaceUrl(s),
      subscribers: beehiivError ? null : (sourceCounts[s.source.toLowerCase()] ?? 0),
      campaignSubscribers: beehiivError ? null : (campaignCounts[campaignKey] ?? 0),
      clicks: clicks.error ? null : (clicks.clicksByCampaign[campaignKey] ?? 0),
    };
  });

  const data: UtmsSnapshot = {
    execMode: detectExecMode({ projectRoot: rootDir }),
    generatedAt: new Date(nowMs).toISOString(),
    cached: false,
    emitters,
    externalSurfaces,
    drift: beehiivError
      ? []
      : computeDrift(emittersBase, sourceCounts, {
          externals: EXTERNAL_UTM_SURFACES,
          campaignCounts,
        }),
    totals: { subscribers: totalSubscribers, campaignsRead: clicks.campaignsRead },
    subscriberBackend,
    subscriberBackendNotice,
    beehiivError,
    brevoError: clicks.error,
    editableFields: EDITABLE_METADATA_FIELDS,
  };
  cacheByRoot.set(rootDir, { data, expiresAt: nowMs + cacheTtlMs });
  return data;
}
