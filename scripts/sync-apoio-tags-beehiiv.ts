#!/usr/bin/env node
/**
 * scripts/sync-apoio-tags-beehiiv.ts (#4273 parte 2)
 *
 * Sincroniza o nível de recompensa de apoio (Amigo/Apoiador/Mantenedor/
 * Patrono) do CRM de Apoios (apoia.se) pra Beehiiv, pra permitir segmentação
 * de envio pra apoiadores (agradecimento, conteúdo exclusivo, etc — ver #4273
 * corpo da issue).
 *
 * NÃO reimplementa a checagem de apoio: reusa a MESMA maquinaria já testada
 * do painel Apoios (`scripts/studio-ui/studio-apoios.ts`) —
 * `buildApoiosData` (loadContacts + fetchCurrentStatuses/checkBacker +
 * deriveContactStatus, fail-soft em 3 camadas) e `computeRewardGroup` (fonte
 * única do particionamento por valor mensal). Mesmo padrão de
 * `scripts/build-apoiador-allowlist.ts` (#3940), que já faz exatamente esse
 * tipo de "desejado × I/O externa" pra outro alvo (KV do worker
 * `artigo-mensal`).
 *
 * ## MECANISMO: custom field, não tag (desvio do desenho original da issue)
 *
 * O corpo original da issue #4273 descrevia "tag por assinante
 * (`apoio-amigo`, `apoio-apoiador`, …)". Investigação ao vivo na publicação
 * de produção (comentários da issue, 260729, autorizada pelo editor)
 * **refutou esse desenho**:
 *
 *   - `PATCH /publications/{pub}/subscriptions/{sub}` com `{tags: [...]}`
 *     retorna `200` e **ignora silenciosamente** o campo — a releitura
 *     (inclusive com `?expand[]=tags`) devolve `tags: []`. Não existe
 *     endpoint de escrita de tag por assinante na API pública da Beehiiv
 *     (nem tag-level, nem via `save_subscriber_tag` do MCP — esse só
 *     cria/renomeia a ENTIDADE tag, não associa a um assinante).
 *   - Em contraste, um **custom field** por assinante (`custom_fields`)
 *     FUNCIONA e foi verificado por escrita+releitura (não só status code):
 *     `PUT .../subscriptions/by_email/{email}` com
 *     `{custom_fields: [{name, value}]}` grava o valor, e `{name, delete:
 *     true}` remove — confirmado pela documentação pública (ver abaixo) e
 *     pelo teste ao vivo do editor na própria conta (comentário "Verificação
 *     260729 — custom field FUNCIONA" na issue #4273).
 *
 * Desenho revisado: **um único custom field** `apoio_nivel` (string) com
 * valor `"amigo"` / `"apoiador"` / `"mantenedor"` / `"patrono"`, ou string
 * vazia (equivalente a "sem tag"). Como o valor é exclusivo por assinante,
 * "quem mudou de faixa troca de valor" é atômico por construção — nunca
 * acumula duas tags. O campo `apoio_nivel` já foi criado na publicação pelo
 * editor (id `e70e4347-a13e-4490-a641-4bfdd2aa37f7`, ver issue) — este script
 * não cria o campo, só lê/escreve o valor.
 *
 * ## Endpoint REST usado (confirmado contra a documentação pública, 260729)
 *
 * Leitura do estado atual (paginado, mesmo padrão de
 * `scripts/sync-cursos-subscribers-kv.ts`):
 *   `GET /publications/{pub}/subscriptions?status=active&expand[]=custom_fields`
 *   https://developers.beehiiv.com/api-reference/subscriptions/list
 *
 * Escrita/remoção — endpoint "Update Subscription by Email" (preferido sobre
 * "by ID": a leitura acima já entrega o email, e a doc confirma
 * `custom_fields` no corpo):
 *   `PUT /publications/{pub}/subscriptions/by_email/{email}`
 *   body: `{ custom_fields: [{ name: "apoio_nivel", value: "<nivel>" }] }` (adicionar/trocar)
 *   body: `{ custom_fields: [{ name: "apoio_nivel", delete: true }] }` (remover)
 *   https://developers.beehiiv.com/api-reference/subscriptions/update-by-email
 *
 * Verificação por releitura — endpoint "Get Subscription by Email" (nunca
 * confiar só no status code: o próprio `tags` acima respondeu 200 e não fez
 * nada — essa armadilha é o motivo desta disciplina):
 *   `GET /publications/{pub}/subscriptions/by_email/{email}?expand[]=custom_fields`
 *   https://developers.beehiiv.com/api-reference/subscriptions/get-by-email
 *
 * ## Fail-closed em leitura parcial
 *
 * Mesma disciplina de `build-apoiador-allowlist.ts`: se `buildApoiosData`
 * reportou `error` (nível topo — data/ ausente, credenciais apoia.se
 * ausentes, 401) OU se qualquer contato tem `status.label === "sem_dados"`
 * (falha TRANSIENTE por contato — distinto de `"nao_apoia"`, resultado
 * válido), o `--push` **recusa gerar remoções** (não destageia ninguém) —
 * uma falha de rede não pode virar remoção em massa de recompensa.
 * Adições/trocas ainda prosseguem normalmente (atraso de benefício é menos
 * grave que remoção indevida). `--allow-partial` é o escape hatch explícito.
 * Contatos "sem_dados" nunca geram NENHUMA ação (nem adição nem remoção) —
 * seu nível desejado é desconhecido, não "sem apoio".
 *
 * ## Dry-run por padrão
 *
 * Só aplica mutação real na Beehiiv com `--push` explícito. Sem `--push`,
 * imprime o diff calculado (quem ganha/perde/troca de nível) e sai.
 *
 * IMPORTANTE (#4273 parte 2 — escopo desta unidade): `--push` NUNCA foi
 * executado nesta sessão contra a Beehiiv real. Validado só via dry-run (leitura
 * real, sem escrita) + testes com fixtures (nenhuma chamada de rede real nos
 * testes).
 *
 * Uso:
 *   npx tsx scripts/sync-apoio-tags-beehiiv.ts [--push] [--allow-partial]
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { buildApoiosData, computeRewardGroup, type ContactWithStatus } from "./studio-ui/studio-apoios.ts";
import { hasMorePages } from "./sync-cursos-subscribers-kv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RATE_LIMIT_DELAY_MS = 300;
const MAX_RETRIES = 3;
const PER_PAGE = 100;

/** Nome do custom field na publicação — já criado manualmente pelo editor
 * (ver cabeçalho do módulo). Este script nunca cria o campo, só lê/escreve. */
export const APOIO_NIVEL_FIELD_NAME = "apoio_nivel";

export type ApoioNivel = "amigo" | "apoiador" | "mantenedor" | "patrono";

const LEVEL_VALUES: readonly ApoioNivel[] = ["amigo", "apoiador", "mantenedor", "patrono"];

function isApoioNivel(v: string): v is ApoioNivel {
  return (LEVEL_VALUES as readonly string[]).includes(v);
}

function normalizeEmailList(emails: string[] | undefined | null): string[] {
  if (!Array.isArray(emails)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const e = (raw ?? "").trim().toLowerCase();
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

// ── estado DESEJADO (puro, de ContactWithStatus[]) ─────────────────────────

export interface DesiredApoioLevel {
  contactId: string;
  contactName: string;
  /** E-mails normalizados (lowercase/trim, dedup) do contato. */
  emails: string[];
  /** Nível desejado, ou `null` se o contato não deve ter valor nenhum (não
   * apoia / apoiou e parou). */
  level: ApoioNivel | null;
  /** `true` quando `status.label === "sem_dados"` — nível DESCONHECIDO (falha
   * transiente de checagem), nunca tratado como "sem apoio". */
  unresolved: boolean;
}

/**
 * Pure: computa o nível de recompensa desejado por contato a partir do
 * `ContactWithStatus[]` já resolvido por `buildApoiosData`. Reusa
 * `computeRewardGroup` (mesma fonte única de limiar usada pelo painel Apoios
 * e por `build-apoiador-allowlist.ts`) — SEM reimplementar a lógica de
 * faixas. Contatos "sem_dados" são marcados `unresolved: true` com `level:
 * null` (desconhecido, não "sem apoio") — `diffApoioTags` nunca gera ação
 * pra eles.
 */
export function computeDesiredApoioLevels(contacts: ContactWithStatus[]): DesiredApoioLevel[] {
  return contacts.map((c) => {
    const unresolved = c.status.label === "sem_dados";
    let level: ApoioNivel | null = null;
    if (c.status.label === "apoiando") {
      level = computeRewardGroup(c.status.monthlyValue);
    }
    return {
      contactId: c.id,
      contactName: c.name,
      emails: normalizeEmailList(c.emails),
      level,
      unresolved,
    };
  });
}

// ── estado ATUAL (I/O — leitura paginada da Beehiiv) ────────────────────────

export interface BeehiivSubscriptionSnapshot {
  subscriptionId: string;
  /** E-mail normalizado (lowercase/trim). */
  email: string;
  /** Valor atual do custom field `apoio_nivel` — `""` quando ausente/vazio. */
  apoioNivel: string;
}

interface BeehiivCustomFieldRaw {
  name?: unknown;
  value?: unknown;
}

interface BeehiivSubscriptionApi {
  id: string;
  email: string;
  status: string;
  custom_fields?: BeehiivCustomFieldRaw[];
}

interface Page<T> {
  data?: T[];
  total_results?: number;
  limit?: number;
}

/** Pure: extrai o valor do custom field `apoio_nivel` de um array
 * `custom_fields` cru da API (`expand[]=custom_fields`). `""` quando ausente,
 * malformado, ou o campo não está setado nesse assinante. */
export function extractApoioNivelValue(customFields: BeehiivCustomFieldRaw[] | undefined): string {
  if (!Array.isArray(customFields)) return "";
  const entry = customFields.find((f) => f && f.name === APOIO_NIVEL_FIELD_NAME);
  if (!entry) return "";
  return typeof entry.value === "string" ? entry.value : "";
}

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
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    await sleep(Math.max(retryAfter * 1000, 30_000));
    return apiRequest<T>(path, apiKey, fetchImpl, init, retries + 1);
  }
  if (!res.ok) return { ok: false, status: res.status, body: null };
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : null;
  return { ok: true, status: res.status, body };
}

/**
 * Pagina `GET /subscriptions?status=active&expand[]=custom_fields` — mesmo
 * padrão de paginação de `scripts/sync-cursos-subscribers-kv.ts`
 * (`hasMorePages`, importado direto de lá — não reimplementado). A API
 * ignora `per_page` além de um limite (comentário original desse arquivo),
 * daí `hasMorePages` decidir por `total_results`/`limit` em vez de assumir
 * que o `per_page` pedido sempre volta cheio.
 */
export async function fetchCurrentBeehiivState(
  publicationId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BeehiivSubscriptionSnapshot[]> {
  const out: BeehiivSubscriptionSnapshot[] = [];
  let page = 1;
  let more = true;
  while (more) {
    const res = await apiRequest<Page<BeehiivSubscriptionApi>>(
      `/publications/${publicationId}/subscriptions?status=active&expand[]=custom_fields&per_page=${PER_PAGE}&page=${page}`,
      apiKey,
      fetchImpl,
    );
    if (!res.ok) {
      if (res.status === 404 || res.status === 403) break;
      throw new Error(`Beehiiv API ${res.status} em /subscriptions (página ${page})`);
    }
    const body = res.body!;
    const got = body.data ?? [];
    for (const s of got) {
      out.push({
        subscriptionId: s.id,
        email: s.email.trim().toLowerCase(),
        apoioNivel: extractApoioNivelValue(s.custom_fields),
      });
    }
    more = hasMorePages({
      collected: out.length,
      gotLength: got.length,
      totalResults: body.total_results,
      effectiveLimit: body.limit,
      requestedPerPage: PER_PAGE,
    });
    page++;
  }
  return out;
}

// ── diff (puro — desejado × atual) ──────────────────────────────────────

export interface ApoioTagDiffEntry {
  contactId: string;
  contactName: string;
  email: string;
  subscriptionId: string;
  /** `null` = sem valor atual (custom field vazio/ausente). */
  fromLevel: ApoioNivel | null;
  /** `null` = remover (contato não apoia mais). */
  toLevel: ApoioNivel | null;
}

export interface ApoioTagDiffResult {
  /** Adições + trocas de faixa — sempre seguro aplicar (nunca gated pelo
   * guard de dados parciais). */
  toApply: ApoioTagDiffEntry[];
  /** Remoções (contato parou de apoiar) — sujeito ao guard fail-closed de
   * dados parciais (`shouldBlockRemovals`). */
  toRemove: ApoioTagDiffEntry[];
  /** Já convergido — nenhuma ação necessária (idempotência). */
  unchanged: ApoioTagDiffEntry[];
  /** Contatos "sem_dados" — nenhuma ação gerada, nível desconhecido. */
  skippedUnresolved: DesiredApoioLevel[];
  /** Apoiadores (ou não-apoiadores) sem NENHUMA subscription Beehiiv casada
   * por qualquer um dos seus e-mails — não é erro, só reportado. */
  notBeehiivSubscriber: DesiredApoioLevel[];
}

/**
 * Pure: diffa o estado desejado (por contato) contra o estado atual (por
 * assinante Beehiiv). Casamento por e-mail segue a MESMA regra de
 * `deriveContactStatus` (#4273): bate se QUALQUER e-mail do contato bater com
 * uma subscription. Um contato pode casar com MÚLTIPLAS subscriptions
 * (múltiplos e-mails assinados na Beehiiv) — cada uma recebe uma entrada de
 * diff própria, pra que a recompensa alcance a pessoa independente de qual
 * e-mail ela usa pra ler a newsletter.
 */
export function diffApoioTags(
  desired: DesiredApoioLevel[],
  current: BeehiivSubscriptionSnapshot[],
): ApoioTagDiffResult {
  const currentByEmail = new Map<string, BeehiivSubscriptionSnapshot>();
  for (const s of current) currentByEmail.set(s.email, s);

  const toApply: ApoioTagDiffEntry[] = [];
  const toRemove: ApoioTagDiffEntry[] = [];
  const unchanged: ApoioTagDiffEntry[] = [];
  const skippedUnresolved: DesiredApoioLevel[] = [];
  const notBeehiivSubscriber: DesiredApoioLevel[] = [];

  for (const d of desired) {
    if (d.unresolved) {
      skippedUnresolved.push(d);
      continue;
    }

    const matches = d.emails
      .map((e) => currentByEmail.get(e))
      .filter((s): s is BeehiivSubscriptionSnapshot => s !== undefined);

    if (matches.length === 0) {
      notBeehiivSubscriber.push(d);
      continue;
    }

    for (const sub of matches) {
      const fromLevel = sub.apoioNivel && isApoioNivel(sub.apoioNivel) ? sub.apoioNivel : null;
      const toLevel = d.level;
      const entry: ApoioTagDiffEntry = {
        contactId: d.contactId,
        contactName: d.contactName,
        email: sub.email,
        subscriptionId: sub.subscriptionId,
        fromLevel,
        toLevel,
      };

      if (fromLevel === toLevel) {
        unchanged.push(entry);
      } else if (toLevel !== null) {
        toApply.push(entry);
      } else {
        toRemove.push(entry);
      }
    }
  }

  return { toApply, toRemove, unchanged, skippedUnresolved, notBeehiivSubscriber };
}

/**
 * Pure: decide se remoções devem ser bloqueadas (fail-closed) — `true` se
 * `buildApoiosData` reportou erro de nível topo OU há qualquer contato
 * "sem_dados" nesta rodada, a menos que `allowPartial` (escape hatch
 * `--allow-partial`) esteja explicitamente ligado.
 */
export function shouldBlockRemovals(
  dataError: string | null,
  diff: Pick<ApoioTagDiffResult, "skippedUnresolved">,
  allowPartial: boolean,
): boolean {
  if (allowPartial) return false;
  return dataError !== null || diff.skippedUnresolved.length > 0;
}

// ── aplicação (I/O — escrita + verificação por releitura) ──────────────────

/**
 * Aplica UMA entrada de diff via `PUT .../subscriptions/by_email/{email}`
 * (endpoint documentado — ver cabeçalho do módulo) e verifica por RELEITURA
 * (`GET .../subscriptions/by_email/{email}?expand[]=custom_fields`) — nunca
 * confia só no status code (o endpoint de `tags` respondeu 200 e não fez
 * nada; essa armadilha é o motivo desta disciplina, #4273).
 *
 * Lança se a releitura não confirmar o valor esperado.
 */
export async function applyApoioTagEntry(
  entry: ApoioTagDiffEntry,
  publicationId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const emailPath = encodeURIComponent(entry.email);
  const body =
    entry.toLevel !== null
      ? { custom_fields: [{ name: APOIO_NIVEL_FIELD_NAME, value: entry.toLevel }] }
      : { custom_fields: [{ name: APOIO_NIVEL_FIELD_NAME, delete: true }] };

  const putRes = await apiRequest(
    `/publications/${publicationId}/subscriptions/by_email/${emailPath}`,
    apiKey,
    fetchImpl,
    { method: "PUT", body: JSON.stringify(body) },
  );
  if (!putRes.ok) {
    throw new Error(
      `PUT subscriptions/by_email/${entry.email} falhou (HTTP ${putRes.status}) — ` +
        `nível desejado: ${entry.toLevel ?? "(remover)"}`,
    );
  }

  const getRes = await apiRequest<{ data?: BeehiivSubscriptionApi }>(
    `/publications/${publicationId}/subscriptions/by_email/${emailPath}?expand[]=custom_fields`,
    apiKey,
    fetchImpl,
  );
  if (!getRes.ok || !getRes.body?.data) {
    throw new Error(
      `releitura pós-escrita falhou pra ${entry.email} (HTTP ${getRes.status}) — ` +
        "não é possível confirmar que a mutação foi aplicada.",
    );
  }
  const actualValue = extractApoioNivelValue(getRes.body.data.custom_fields);
  const expectedValue = entry.toLevel ?? "";
  if (actualValue !== expectedValue) {
    throw new Error(
      `releitura pós-escrita NÃO confere pra ${entry.email}: esperado ` +
        `"${expectedValue}", encontrado "${actualValue}" — mesma armadilha do endpoint ` +
        "de tags (200 mas ignorado em silêncio); mutação NÃO confirmada.",
    );
  }
}

// ── logging do diff (dry-run e --push) ──────────────────────────────────

function logDiff(diff: ApoioTagDiffResult, removalsBlocked: boolean): void {
  const log = (msg: string) => process.stderr.write(`[sync-apoio-tags-beehiiv] ${msg}\n`);

  log(`${diff.toApply.length} adição(ões)/troca(s) de nível:`);
  for (const e of diff.toApply) {
    log(`  + ${e.email} (${e.contactName}): ${e.fromLevel ?? "(nenhum)"} → ${e.toLevel}`);
  }

  if (removalsBlocked && diff.toRemove.length > 0) {
    log(
      `${diff.toRemove.length} remoção(ões) CALCULADA(S) mas BLOQUEADA(S) (dados parciais — ` +
        "ver aviso acima; use --allow-partial pra forçar):",
    );
  } else {
    log(`${diff.toRemove.length} remoção(ões):`);
  }
  for (const e of diff.toRemove) {
    log(`  - ${e.email} (${e.contactName}): ${e.fromLevel} → (nenhum)`);
  }

  if (diff.skippedUnresolved.length > 0) {
    log(
      `${diff.skippedUnresolved.length} contato(s) "sem_dados" pulado(s) (nível desconhecido, ` +
        `nenhuma ação): ${diff.skippedUnresolved.map((d) => d.contactName || d.emails[0]).join(", ")}`,
    );
  }

  if (diff.notBeehiivSubscriber.length > 0) {
    log(
      `${diff.notBeehiivSubscriber.length} apoiador(es)/contato(s) sem nenhuma subscription ` +
        `Beehiiv casada (não é erro): ${diff.notBeehiivSubscriber.map((d) => d.contactName || d.emails[0]).join(", ")}`,
    );
  }

  log(`${diff.unchanged.length} já convergido(s) (nenhuma ação).`);
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  loadProjectEnv(ROOT);

  const { apiKey, publicationId } = loadBeehiivConfig("[sync-apoio-tags-beehiiv]");

  const data = await buildApoiosData(ROOT);
  if (data.error) {
    process.stderr.write(
      `[sync-apoio-tags-beehiiv] aviso: buildApoiosData reportou erro (dados podem estar incompletos): ${data.error}\n`,
    );
  }

  const desired = computeDesiredApoioLevels(data.contacts);

  process.stderr.write("[sync-apoio-tags-beehiiv] buscando estado atual na Beehiiv…\n");
  const current = await fetchCurrentBeehiivState(publicationId, apiKey);
  process.stderr.write(`[sync-apoio-tags-beehiiv] ${current.length} assinante(s) ativo(s) na Beehiiv.\n`);

  const diff = diffApoioTags(desired, current);
  const allowPartial = hasFlag(argv, "allow-partial");
  const removalsBlocked = shouldBlockRemovals(data.error, diff, allowPartial);

  logDiff(diff, removalsBlocked);

  if (!hasFlag(argv, "push")) {
    process.stderr.write(
      "[sync-apoio-tags-beehiiv] dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar.\n",
    );
    return;
  }

  if (removalsBlocked && diff.toRemove.length > 0) {
    process.stderr.write(
      "[sync-apoio-tags-beehiiv] RECUSANDO aplicar as remoções acima (dados parciais/sem_dados) — " +
        "uma falha de rede não pode virar remoção em massa de recompensa. Re-tente, ou use " +
        "--allow-partial pra prosseguir mesmo assim (decisão consciente do editor, sempre logada).\n",
    );
  }

  const toApplyNow = [...diff.toApply, ...(removalsBlocked ? [] : diff.toRemove)];
  process.stderr.write(`[sync-apoio-tags-beehiiv] --push: aplicando ${toApplyNow.length} mutação(ões)…\n`);

  let applied = 0;
  let failed = 0;
  for (const entry of toApplyNow) {
    try {
      await applyApoioTagEntry(entry, publicationId, apiKey);
      applied++;
    } catch (e) {
      failed++;
      process.stderr.write(`[sync-apoio-tags-beehiiv] FALHA em ${entry.email}: ${(e as Error).message}\n`);
    }
  }

  process.stderr.write(`[sync-apoio-tags-beehiiv] push concluído: ${applied} aplicada(s), ${failed} falha(s).\n`);
  if (failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sync-apoio-tags-beehiiv] erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
