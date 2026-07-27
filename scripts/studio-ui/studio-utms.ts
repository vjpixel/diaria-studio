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
 *   2. **Conversão (Beehiiv)** — `fetchAndAggregate` de
 *      `../count-subscriptions-by-utm.ts` (#2457, já testado): assinantes por
 *      `utm_source` e — desde o #4041 — por `utm_campaign`. É o único lado que
 *      fecha o funil ATÉ A CONVERSÃO.
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
  knownUtmSources,
  campaignPatternToRegExp,
  type UtmEmitter,
  type UtmEmitterStatus,
} from "../lib/shared/utm-registry.ts";
import { fetchAndAggregate } from "../count-subscriptions-by-utm.ts";
import { loadBeehiivConfig } from "../lib/beehiiv-config.ts";
import { brevoGet } from "../lib/brevo-client.ts";

// Mesmo racional de `studio-integrations.ts`/`dashboard-clarice.ts`: garante
// `.env.local`/`.env` carregados mesmo sem passar por um entrypoint que já
// chamou isso. Idempotente, nunca sobrescreve var já presente.
loadProjectEnv();

// ---------------------------------------------------------------------------
// Metadados editáveis (overlay por cima do registry)
// ---------------------------------------------------------------------------

/** Campos que a UI PODE editar. Qualquer outro é rejeitado — ver header. */
export const EDITABLE_METADATA_FIELDS = ["description", "status", "note"] as const;
export type EditableMetadataField = (typeof EDITABLE_METADATA_FIELDS)[number];

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
export function computeDrift(
  emitters: ReadonlyArray<UtmEmitter>,
  sourceCounts: Record<string, number>,
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

export interface UtmsSnapshot {
  execMode: ExecMode;
  generatedAt: string;
  cached: boolean;
  emitters: UtmEmitterRow[];
  drift: DriftFinding[];
  totals: { subscribers: number | null; campaignsRead: number };
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
  const meta = loadUtmMetadata(rootDir);
  const emittersBase = UTM_EMITTERS.map((e) => applyMetadata(e, meta[e.id]));

  // ── Beehiiv (conversão) ──────────────────────────────────────────────────
  let sourceCounts: Record<string, number> = {};
  let campaignCounts: Record<string, number> = {};
  let totalSubscribers: number | null = null;
  let beehiivError: string | undefined;
  try {
    const fetcher = opts.fetchSubscriptions ?? fetchAndAggregate;
    // `loadBeehiivConfig` faz `process.exit(1)` quando a credencial falta (é
    // um helper de CLI). No studio-server isso derrubaria o processo INTEIRO —
    // então a ausência é detectada ANTES e vira o campo `beehiivError`, que é
    // o comportamento fail-soft que o resto do módulo promete.
    const injected = Boolean(opts.fetchSubscriptions);
    if (!injected && (!env.BEEHIIV_API_KEY || !env.BEEHIIV_PUBLICATION_ID)) {
      throw new Error(
        "BEEHIIV_API_KEY/BEEHIIV_PUBLICATION_ID ausentes — dados de conversão indisponíveis neste ambiente.",
      );
    }
    const cfg = injected
      ? { publicationId: "", apiKey: "" }
      : loadBeehiivConfig("[studio-utms]");
    const result = await fetcher(cfg.publicationId, cfg.apiKey);
    sourceCounts = result.counts ?? {};
    campaignCounts = result.campaignCounts ?? {};
    totalSubscribers = result.total ?? null;
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

  const data: UtmsSnapshot = {
    execMode: detectExecMode({ projectRoot: rootDir }),
    generatedAt: new Date(nowMs).toISOString(),
    cached: false,
    emitters,
    drift: beehiivError ? [] : computeDrift(emittersBase, sourceCounts),
    totals: { subscribers: totalSubscribers, campaignsRead: clicks.campaignsRead },
    beehiivError,
    brevoError: clicks.error,
    editableFields: EDITABLE_METADATA_FIELDS,
  };
  cacheByRoot.set(rootDir, { data, expiresAt: nowMs + cacheTtlMs });
  return data;
}
