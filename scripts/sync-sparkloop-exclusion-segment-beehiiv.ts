#!/usr/bin/env node
/**
 * scripts/sync-sparkloop-exclusion-segment-beehiiv.ts (#5095)
 *
 * Cria (idempotente) o segmento dinâmico `Exclusão — SparkLoop Upscribe` na
 * Beehiiv, agrupando os contatos cadastrados pela integração SparkLoop
 * Upscribe (parceiro `Techzip Newsletter`) — burst identificado em 260810,
 * ~71% dos cadastros da semana, perfil totalmente fora da audiência (e-mails
 * corporativos US/anglófonos numa newsletter diária em pt-BR sobre IA).
 *
 * ## Decisão do editor (briefing da sessão develop 260812)
 *
 * A conta SparkLoop é legítima e os ~17 cadastros já feitos são MANTIDOS —
 * não é revogação de acesso nem remoção de assinante. O escopo é só marcar
 * esses contatos num segmento de exclusão, pra que análises futuras de
 * engajamento (open rate agregado, circuit breakers de spamRate, etc.)
 * possam excluí-los da base "assinantes ativos reais" sem apagar ninguém.
 *
 * Desde #5096 (mesmo dia), a publicação já tem double opt-in LIGADO — o que
 * barra NOVOS cadastros SparkLoop de virarem `active` sem confirmação. Este
 * script cobre o outro lado do problema: os que já entraram como `active`
 * ANTES do double opt-in ser ligado.
 *
 * ## Identificação
 *
 * Todo cadastro desta origem carrega os custom fields SparkLoop/RewardHero
 * (ver corpo da issue #5095) — o único usado aqui é `RH_SOURCE =
 * "sparkloop-upscribe"`, o fingerprint mais específico e estável (RH_PARTNER/
 * RH_PARTNER_NAME identificam o parceiro individual, não a integração — um
 * 2º parceiro SparkLoop no futuro teria RH_PARTNER diferente mas o mesmo
 * RH_SOURCE; escopar em RH_SOURCE cobre a integração inteira, não só a
 * Techzip Newsletter).
 *
 * ## Mecanismo — endpoint REST, não a UI (diferente do desenho de #4436)
 *
 * `scripts/lib/apoio-segments-canonical.ts` documenta que os 6 segmentos
 * `Apoio — *` foram criados/corrigidos manualmente pela UI da Beehiiv — na
 * época (260802), a leitura era que segmentos não eram programáveis via API
 * pública. Confirmado por leitura da documentação pública AGORA (260812,
 * consulta a `developers.beehiiv.com/api-reference/segments/create`) que
 * existe sim um endpoint de escrita:
 *
 *   POST /publications/{pub}/segments
 *   body: {
 *     name: "<nome único na publicação>",
 *     input: {
 *       type: "custom_fields",
 *       custom_fields: [{ name: "<nome de exibição do custom field>", operator: "equal", value: "<valor>" }],
 *       operator: "and"
 *     }
 *   }
 *   → 201 { data: { id, name, type: "dynamic", status: "pending", total_results, active } }
 *
 * Diferença de dialeto importante: a criação usa `name` (nome de EXIBIÇÃO do
 * custom field, ex. "RH_SOURCE"), não o `custom_field('<uuid>')` por ID que
 * `get_segment`/`save_segment` (MCP) devolvem depois de salvo — não precisa
 * resolver o ID do campo antes de criar (`list_custom_fields` não é chamado
 * por este script). ATENÇÃO: essa leitura de dialeto vem só da documentação
 * pública — ainda NÃO-VERIFICADA contra a API real (nenhum `--push` rodou
 * até agora, ver seção abaixo). Se o nome de exibição divergir do valor
 * usado internamente pela Beehiiv, o 1º `--push` real falharia ou criaria um
 * segmento com condição vazia — o operador deve conferir o `total_results`
 * do segmento recém-criado contra o preview do dry-run antes de confiar nele.
 *
 * Segmento é DINÂMICO (`type: "dynamic"`, default) — a Beehiiv recalcula a
 * pertinência sozinha sempre que a condição casar um assinante novo (ex:
 * caso o double opt-in de #5096 falhe silenciosamente algum dia e um novo
 * cadastro SparkLoop escape). Este script não reimplementa esse recálculo —
 * só cria a condição uma vez.
 *
 * ## Idempotência
 *
 * A API não tem endpoint de "get segment by name" — só por ID. Este script
 * pagina `GET /publications/{pub}/segments` (mesmo endpoint já usado por
 * `scripts/backup-beehiiv.ts` pra backup) e casa por `name` ANTES de criar.
 * Se `EXCLUSION_SEGMENT_NAME` já existe, o `--push` não cria um duplicado —
 * loga o id existente e sai limpo (idempotente: rodar de novo é seguro).
 *
 * ## Dry-run por padrão
 *
 * Sempre busca primeiro os segmentos existentes (checagem de idempotência,
 * barata). Se `EXCLUSION_SEGMENT_NAME` já existe, para aí — não paga o custo
 * de paginar toda a base de assinantes de novo, nem em modo dry-run nem em
 * `--push` (nada a fazer). Só quando o segmento AINDA NÃO existe é que busca
 * os assinantes ativos ATUAIS que casariam a condição (preview informativo —
 * a Beehiiv computa a pertinência real sozinha depois de criado, este script
 * não escreve nada em nenhum assinante) e imprime tudo — inclusive o corpo
 * exato do POST que seria enviado — sem nenhuma mutação.
 *
 * Com `--push` (e o segmento ainda não existindo): cria o segmento de verdade.
 *
 * IMPORTANTE (#5095 — escopo desta unidade, sessão `/diaria-develop`): este
 * script NUNCA foi executado contra a Beehiiv real nesta sessão — o guard de
 * publicação da rodada proíbe qualquer chamada de escrita OU leitura ao vivo
 * contra a Beehiiv/SparkLoop, mesmo em modo "teste". Validado só via testes
 * com `fetchImpl` mockado (nenhuma chamada de rede real) — ver
 * `test/sync-sparkloop-exclusion-segment-beehiiv.test.ts`.
 *
 * ## Fora de escopo desta unidade (documentado, não implementado)
 *
 * Nenhum call site deste repo hoje computa uma métrica agregada de
 * engajamento (open rate, denominador de circuit breaker) a partir de "todos
 * os assinantes ativos da Beehiiv" — o monitoramento de spamRate
 * (`scripts/postmaster-spam-sync.ts`) vem do Google Postmaster Tools, dado
 * agregado por DOMÍNIO do lado do Gmail, sem relação com segmentos/listas da
 * Beehiiv; não há um call site óbvio pra "consumir" este segmento hoje.
 * Se/quando um script assim existir, ele deveria excluir
 * `EXCLUSION_SEGMENT_NAME` do denominador — documentado aqui como TODO
 * futuro, não implementado especulativamente sem um consumidor real pra
 * validar contra.
 *
 * Uso:
 *   npx tsx scripts/sync-sparkloop-exclusion-segment-beehiiv.ts [--push]
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { hasMorePages } from "./sync-cursos-subscribers-kv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[sync-sparkloop-exclusion-segment-beehiiv]";

const RATE_LIMIT_DELAY_MS = 300;
const MAX_RETRIES = 3;
const PER_PAGE = 100;

/** Fallback de espera (ms) quando o header `Retry-After` está ausente ou não
 * é um inteiro de segundos válido (a spec permite HTTP-date além de delay em
 * segundos — `parseInt` de uma data vira `NaN`, ver `computeRetryDelayMs`). */
const RETRY_AFTER_FALLBACK_SECONDS = 60;
const RETRY_MIN_DELAY_MS = 30_000;

function log(msg: string): void {
  process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
}

/** Nome do segmento — mesma convenção de `apoio-segments-canonical.ts`
 * ("{Categoria} — {detalhe}", em dash), escopado ao NOME DA INTEGRAÇÃO
 * (não ao parceiro individual — ver cabeçalho do módulo). */
export const EXCLUSION_SEGMENT_NAME = "Exclusão — SparkLoop Upscribe";

/** Custom field escrito pela integração SparkLoop/RewardHero em todo
 * cadastro vindo dela — já existe na publicação, este script nunca cria
 * custom field, só lê. O nome de exibição usado aqui ("RH_SOURCE") é a
 * suposição não-verificada de que ele bate com o nome que o endpoint de
 * criação de segmento espera — ver caveat no cabeçalho do módulo. */
export const RH_SOURCE_FIELD_NAME = "RH_SOURCE";

/** Valor observado no burst investigado em #5095 — identifica a integração
 * SparkLoop Upscribe especificamente (não SparkLoop em geral, caso a
 * publicação venha a usar outro produto SparkLoop legítimo no futuro). */
export const RH_SOURCE_SPARKLOOP_UPSCRIBE_VALUE = "sparkloop-upscribe";

export interface BeehiivSubscriptionSnapshot {
  subscriptionId: string;
  /** E-mail normalizado (lowercase/trim). */
  email: string;
  /** Valor cru do custom field `RH_SOURCE` — `""` quando ausente/vazio. */
  rhSource: string;
}

interface BeehiivCustomFieldRaw {
  name?: unknown;
  value?: unknown;
}

interface BeehiivSubscriptionApi {
  id: string;
  /** `unknown`, não `string` — narrowing explícito em `fetchActiveSubscriptions`
   * (mesmo padrão de `BeehiivSegmentApi` abaixo). Se a API devolver um
   * assinante sem e-mail (ausente/null), a entrada é descartada com log em
   * vez de lançar `TypeError` em `.trim()`. */
  email: unknown;
  status: string;
  custom_fields?: BeehiivCustomFieldRaw[];
}

interface BeehiivSegmentApi {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  status?: unknown;
  total_results?: unknown;
}

interface Page<T> {
  data?: T[];
  total_results?: number;
  limit?: number;
}

// ── funções puras ───────────────────────────────────────────────────────

/** Pure: extrai o valor de um custom field pelo nome de exibição, de um
 * array `custom_fields` cru da API (`expand[]=custom_fields`). `""` quando
 * ausente, malformado, ou o campo não está setado nesse assinante. Mesmo
 * padrão de `sync-apoio-nivel-beehiiv.ts::extractApoioNivelValue`,
 * generalizado pro nome do campo em vez de hardcoded. */
export function extractCustomFieldValue(customFields: BeehiivCustomFieldRaw[] | undefined, fieldName: string): string {
  if (!Array.isArray(customFields)) return "";
  const entry = customFields.find((f) => f && f.name === fieldName);
  if (!entry) return "";
  return typeof entry.value === "string" ? entry.value : "";
}

/** Pure: `true` se o valor cru de `RH_SOURCE` identifica um cadastro
 * SparkLoop Upscribe. Case-insensitive/trim — a Beehiiv não documenta
 * normalização de custom field, e um valor com espaço/caixa diferente ainda
 * é a mesma origem. */
export function isSparkloopUpscribeSource(rhSourceRaw: string): boolean {
  return rhSourceRaw.trim().toLowerCase() === RH_SOURCE_SPARKLOOP_UPSCRIBE_VALUE;
}

/** Pure: filtra os assinantes cujo `RH_SOURCE` identifica SparkLoop
 * Upscribe — usado só pro PREVIEW informativo (dry-run e log do --push); a
 * pertinência real do segmento é computada pela própria Beehiiv depois de
 * criado (segmento dinâmico), este script não escreve em assinante nenhum. */
export function filterSparkloopContacts(
  subscriptions: readonly BeehiivSubscriptionSnapshot[],
): BeehiivSubscriptionSnapshot[] {
  return subscriptions.filter((s) => isSparkloopUpscribeSource(s.rhSource));
}

/** Corpo exato do `POST /publications/{pub}/segments` — ver cabeçalho do
 * módulo pro dialeto (nome de exibição do custom field, não ID). */
export interface CreateSegmentBody {
  name: string;
  input: {
    type: "custom_fields";
    custom_fields: Array<{ name: string; operator: "equal"; value: string }>;
    operator: "and";
  };
}

/** Pure: monta o corpo do POST de criação do segmento — fonte única, usada
 * tanto pro log do dry-run quanto pela chamada real do `--push`. */
export function buildCreateSegmentBody(): CreateSegmentBody {
  return {
    name: EXCLUSION_SEGMENT_NAME,
    input: {
      type: "custom_fields",
      custom_fields: [{ name: RH_SOURCE_FIELD_NAME, operator: "equal", value: RH_SOURCE_SPARKLOOP_UPSCRIBE_VALUE }],
      operator: "and",
    },
  };
}

/** Segmento existente casado por nome — resultado da checagem de
 * idempotência, ou `null` se `EXCLUSION_SEGMENT_NAME` ainda não existe. */
export interface ExistingSegmentMatch {
  id: string;
  name: string;
  totalResults: number | null;
}

/** Pure: procura `EXCLUSION_SEGMENT_NAME` numa lista de segmentos já lida da
 * Beehiiv (`GET /segments`). Casamento exato de nome — mesmo padrão de
 * `apoio-segments-canonical.ts` (nome é o identificador estável, a API não
 * expõe "get segment by name"). */
export function findExistingExclusionSegment(
  segments: readonly { id: string; name: string; totalResults: number | null }[],
): ExistingSegmentMatch | null {
  return segments.find((s) => s.name === EXCLUSION_SEGMENT_NAME) ?? null;
}

export type SyncAction = "skip-existing" | "dry-run" | "create";

/** Pure: decide a ação de `main()` a partir do estado observado — as DUAS
 * garantias de segurança centrais do script ("se o segmento já existe, não
 * faz nada" e "sem --push, nunca cria"), extraídas pra função exportada e
 * testável (#5098 item 6). Sem isso, `main()` não é exportada nem parametrizável
 * e nenhum teste consegue exercitar essa lógica — uma regressão que remova o
 * early-return de idempotência passaria em todos os testes existentes e
 * criaria um segmento duplicado numa conta Beehiiv real. */
export function resolveSyncAction(existing: ExistingSegmentMatch | null, pushRequested: boolean): SyncAction {
  if (existing) return "skip-existing";
  return pushRequested ? "create" : "dry-run";
}

/** Pure: calcula o delay de retry (ms) pra um 429, a partir do header
 * `Retry-After` cru. Extraída de `apiRequest` pra ser testável sem esperar o
 * `sleep` real (#5098 item 8). A spec HTTP permite `Retry-After` em segundos
 * OU em HTTP-date — `parseInt` de uma data produz `NaN`; sem o guard
 * `Number.isFinite`, `Math.max(NaN, RETRY_MIN_DELAY_MS)` também é `NaN` e o
 * backoff colapsa pra ~0ms exatamente no cenário (429 storm) onde mais
 * importa (#5098 item 3). */
export function computeRetryDelayMs(retryAfterHeader: string | null): number {
  const parsed = retryAfterHeader != null ? parseInt(retryAfterHeader, 10) : NaN;
  const seconds = Number.isFinite(parsed) ? parsed : RETRY_AFTER_FALLBACK_SECONDS;
  return Math.max(seconds * 1000, RETRY_MIN_DELAY_MS);
}

// ── I/O — leitura paginada ──────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiRequest<T>(
  path: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  init: RequestInit = {},
  retries = 0,
): Promise<{ ok: boolean; status: number; body: T | null }> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetchImpl(`${beehiivApiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (res.status === 429 && retries < MAX_RETRIES) {
    const delayMs = computeRetryDelayMs(res.headers.get("Retry-After"));
    log(`HTTP 429 em ${path} — tentativa ${retries + 1}/${MAX_RETRIES}, aguardando ${delayMs}ms antes de retry…`);
    await sleep(delayMs);
    return apiRequest<T>(path, apiKey, fetchImpl, init, retries + 1);
  }
  if (!res.ok) return { ok: false, status: res.status, body: null };
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : null;
  return { ok: true, status: res.status, body };
}

/**
 * Pagina `GET /subscriptions?status=active&expand[]=custom_fields` — mesmo
 * padrão (e mesma disciplina fail-loud + reconciliação anti-truncamento) de
 * `sync-apoio-nivel-beehiiv.ts::fetchCurrentBeehiivState`, generalizado pra
 * extrair `RH_SOURCE` em vez de `apoio_nivel`. Só usado pro preview — a
 * Beehiiv computa a pertinência real do segmento sozinha, este fetch nunca
 * alimenta uma mutação.
 */
export async function fetchActiveSubscriptions(
  publicationId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BeehiivSubscriptionSnapshot[]> {
  const out: BeehiivSubscriptionSnapshot[] = [];
  // Contador RAW (itens recebidos por página, antes do filtro de e-mail
  // malformado abaixo) — precisa ser distinto de `out.length` pela mesma
  // razão documentada em `fetchExistingSegments`: se algum item vier sem
  // `email` válido e for descartado, `out.length` ficaria menor que o total
  // de itens VISTOS, e `hasMorePages`/o guard de truncamento abaixo têm que
  // comparar contra o total VISTO, não o total ACEITO.
  let rawCollected = 0;
  let page = 1;
  let more = true;
  let totalResults: number | null = null;
  while (more) {
    const res = await apiRequest<Page<BeehiivSubscriptionApi>>(
      `/publications/${publicationId}/subscriptions?status=active&expand[]=custom_fields&per_page=${PER_PAGE}&page=${page}`,
      apiKey,
      fetchImpl,
    );
    if (!res.ok) {
      throw new Error(`Beehiiv API ${res.status} em /subscriptions (página ${page})`);
    }
    const body = res.body ?? {};
    const got = body.data ?? [];
    for (const s of got) {
      const email = typeof s.email === "string" ? s.email.trim().toLowerCase() : null;
      if (email === null) {
        log(`entrada malformada descartada em /subscriptions (página ${page}, id ${s.id}): campo "email" ausente/não-string.`);
        continue;
      }
      out.push({
        subscriptionId: s.id,
        email,
        rhSource: extractCustomFieldValue(s.custom_fields, RH_SOURCE_FIELD_NAME),
      });
    }
    rawCollected += got.length;
    if (body.total_results != null) totalResults = body.total_results;
    more = hasMorePages({
      collected: rawCollected,
      gotLength: got.length,
      totalResults: body.total_results,
      effectiveLimit: body.limit,
      requestedPerPage: PER_PAGE,
    });
    page++;
  }
  if (totalResults != null && totalResults > 0 && rawCollected < totalResults) {
    throw new Error(
      `paginação de /subscriptions terminou cedo: coletado ${rawCollected} de ${totalResults} ` +
        "reportado pela API — leitura truncada não alimenta o preview.",
    );
  }
  return out;
}

/** Pagina `GET /publications/{pub}/segments` (mesmo endpoint de
 * `backup-beehiiv.ts`) — usado só pra checagem de idempotência (casar
 * `EXCLUSION_SEGMENT_NAME` antes de criar). Única fonte da checagem de
 * idempotência (`findExistingExclusionSegment` é chamado só sobre o
 * resultado desta função) — uma leitura truncada aqui faria `main()`
 * concluir erroneamente "segmento não existe" e criar um DUPLICADO via
 * `--push`, então o guard de anti-truncamento abaixo é tão crítico quanto o
 * de `fetchActiveSubscriptions`. */
export async function fetchExistingSegments(
  publicationId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExistingSegmentMatch[]> {
  const out: ExistingSegmentMatch[] = [];
  // Contador RAW (itens recebidos por página, antes do filtro de
  // malformados abaixo) — precisa ser distinto de `out.length`: se algum
  // item vier malformado (sem id/name string) e for descartado, `out.length`
  // fica menor que o `total_results` reportado pela API mesmo com TODAS as
  // páginas lidas, o que faria `hasMorePages` pedir páginas extras pra
  // sempre (a API devolveria a última página de novo). `hasMorePages`
  // compara contra o total de itens VISTOS, não o total de itens ACEITOS.
  let rawCollected = 0;
  let totalResults: number | null = null;
  let page = 1;
  let more = true;
  while (more) {
    const res = await apiRequest<Page<BeehiivSegmentApi>>(
      `/publications/${publicationId}/segments?per_page=${PER_PAGE}&page=${page}`,
      apiKey,
      fetchImpl,
    );
    if (!res.ok) {
      throw new Error(`Beehiiv API ${res.status} em /segments (página ${page})`);
    }
    const body = res.body ?? {};
    const got = body.data ?? [];
    for (const s of got) {
      if (typeof s.id === "string" && typeof s.name === "string") {
        out.push({
          id: s.id,
          name: s.name,
          totalResults: typeof s.total_results === "number" ? s.total_results : null,
        });
      } else {
        log(`entrada malformada descartada em /segments (página ${page}): ${JSON.stringify(s)}`);
      }
    }
    rawCollected += got.length;
    if (body.total_results != null) totalResults = body.total_results;
    more = hasMorePages({
      collected: rawCollected,
      gotLength: got.length,
      totalResults: body.total_results,
      effectiveLimit: body.limit,
      requestedPerPage: PER_PAGE,
    });
    page++;
  }
  if (totalResults != null && totalResults > 0 && rawCollected < totalResults) {
    throw new Error(
      `paginação de /segments terminou cedo: coletado ${rawCollected} de ${totalResults} ` +
        "reportado pela API — checagem de idempotência não pode confiar numa lista truncada.",
    );
  }
  return out;
}

// ── I/O — criação (--push) ──────────────────────────────────────────────

export interface CreatedSegment {
  id: string;
  status: string;
}

/**
 * `POST /publications/{pub}/segments` — cria o segmento dinâmico. Não
 * verifica por releitura (diferente de `applyApoioTagEntry`): a Beehiiv
 * devolve `id`/`status` no próprio 201, e a pertinência (`total_results`)
 * só fica correta depois do recálculo assíncrono (`status: "pending"` →
 * `"completed"`) — não há nada síncrono pra confirmar além do 201 em si.
 */
export async function createExclusionSegment(
  publicationId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedSegment> {
  const res = await apiRequest<{ data?: BeehiivSegmentApi }>(
    `/publications/${publicationId}/segments`,
    apiKey,
    fetchImpl,
    { method: "POST", body: JSON.stringify(buildCreateSegmentBody()) },
  );
  if (!res.ok || !res.body?.data || typeof res.body.data.id !== "string") {
    throw new Error(`POST /segments falhou (HTTP ${res.status}) — segmento NÃO criado.`);
  }
  return {
    id: res.body.data.id,
    status: typeof res.body.data.status === "string" ? res.body.data.status : "unknown",
  };
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  loadProjectEnv(ROOT);

  const { apiKey, publicationId } = loadBeehiivConfig(LOG_PREFIX);

  log("buscando segmentos existentes (checagem de idempotência)…");
  const existingSegments = await fetchExistingSegments(publicationId, apiKey);
  const existing = findExistingExclusionSegment(existingSegments);
  const action = resolveSyncAction(existing, hasFlag(argv, "push"));

  if (action === "skip-existing" && existing) {
    // Idempotente: se o segmento já existe, nada a fazer — e nem vale a
    // pena pagar a paginação completa de /subscriptions só pra um preview
    // que ninguém vai usar (rodar este script de novo depois do --push tem
    // que ser barato, não repetir o fetch caro de toda vez).
    log(
      `segmento "${EXCLUSION_SEGMENT_NAME}" JÁ EXISTE (id ${existing.id}` +
        `${existing.totalResults != null ? `, total_results ${existing.totalResults}` : ""}) — ` +
        "nada a criar (idempotente).",
    );
    return;
  }

  log("buscando assinantes ativos (preview informativo)…");
  const active = await fetchActiveSubscriptions(publicationId, apiKey);
  const matches = filterSparkloopContacts(active);

  log(`${active.length} assinante(s) ativo(s) na Beehiiv; ${matches.length} casam RH_SOURCE = "${RH_SOURCE_SPARKLOOP_UPSCRIBE_VALUE}":`);
  for (const m of matches) {
    log(`  - ${m.email}`);
  }

  const body = buildCreateSegmentBody();
  log(`corpo do POST /publications/${publicationId}/segments:`);
  log(`  ${JSON.stringify(body)}`);

  if (action === "dry-run") {
    log(
      `segmento "${EXCLUSION_SEGMENT_NAME}" ainda não existe. dry-run (default) — NENHUMA mutação aplicada. ` +
        "Use --push para criar de verdade.",
    );
    return;
  }

  log("--push: criando o segmento…");
  const created = await createExclusionSegment(publicationId, apiKey);
  log(`segmento criado: id ${created.id}, status "${created.status}" (recálculo de pertinência é assíncrono na Beehiiv).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
