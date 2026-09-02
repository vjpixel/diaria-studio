#!/usr/bin/env node
/**
 * scripts/sync-apoio-nivel-beehiiv.ts (#4273 parte 2, renomeado + carência/guard #4436)
 *
 * Sincroniza o nível de recompensa de apoio (Amigo/Apoiador/Mantenedor/
 * Patrono) do CRM de Apoios (apoia.se) pra Beehiiv, pra permitir segmentação
 * de envio pra apoiadores (agradecimento, conteúdo exclusivo, etc — ver #4273
 * corpo da issue). Os 6 segmentos que CONSOMEM esse campo
 * (`Apoio — {Amigo,Apoiador,Mantenedor,Patrono,Todos,Nenhum}`) são versionados
 * em `scripts/lib/apoio-segments-canonical.ts` — não neste arquivo.
 *
 * NÃO reimplementa a checagem de apoio: reusa a MESMA maquinaria já testada
 * do painel Apoios (`scripts/studio-ui/studio-apoios.ts`) —
 * `buildApoiosData` (loadContacts + fetchCurrentStatuses/checkBacker +
 * deriveContactStatus, fail-soft em 3 camadas), `computeRewardGroup` (fonte
 * única do particionamento por valor mensal) e `readPastMonthSnapshots`
 * (histórico de meses anteriores, sem chamada de rede nova). Mesmo padrão de
 * `scripts/build-apoiador-allowlist.ts` (#3940), que já faz exatamente esse
 * tipo de "desejado × I/O externa" pra outro alvo (KV do worker
 * `artigo-mensal`).
 *
 * ## RENOMEADO em #4436 — nome antigo guardava o desenho refutado
 *
 * Este arquivo se chamava `sync-apoio-tags-beehiiv.ts`. O nome descrevia o
 * desenho ORIGINAL da issue #4273 ("tag por assinante"), refutado no mesmo
 * dia (ver seção abaixo) — o mecanismo real sempre foi um custom field. O
 * nome antigo sobreviveu ao pivot e virou uma pista falsa pra quem lesse o
 * repo sem o histórico da issue. `sync-apoio-nivel-beehiiv.ts` descreve o que
 * o script de fato escreve: o *nível* de apoio, num *custom field*.
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
 * ## Carência de 1 mês (#4436, decisão do editor 260801)
 *
 * `computeRewardGroup` sozinho parte do valor pago NO MÊS CORRENTE
 * (`isPaidThisMonth`/`thisMonthPaidValue` da apoia.se), que reseta no dia 1º
 * e só volta conforme a cobrança de cada apoiador entra ao longo do mês. Uma
 * rodada de `--push` no dia 1º geraria remoção de TODOS os apoiadores até a
 * cobrança de cada um entrar — "nível de recompensa piscando todo mês".
 *
 * Fix: o nível DESEJADO passa a ser o MAIOR entre a faixa paga no mês
 * corrente e a faixa paga no mês ANTERIOR (`readPastMonthSnapshots`, já
 * existe, zero chamada de rede nova). Cancelamento real só remove depois de
 * **2 meses** sem pagamento (mês corrente E anterior ambos sem pagamento) —
 * comportamento correto pra uma recompensa mensal. Não há janela por DIA do
 * mês (decisão do editor: `BackerStatus` não guarda data de pagamento, só
 * "pagou no mês X" — qualquer regra sub-mensal viria do relógio, não do
 * dado; carência mensal cobre também cobrança recusada/retentada dias
 * depois, e não trava o `--push` no dia 1). Ver `computeDesiredApoioLevels`,
 * `previousMonthKey` (cuidado com virada de ano: `2025-12` → `2026-01`).
 *
 * ## Guard de blast radius (#4436, decisão do editor 260801 — limiar 30%)
 *
 * Independente da carência acima (rede de segurança que vale ter mesmo com
 * ela): se as remoções calculadas passarem de **30%** de quem tem
 * `apoio_nivel` setado HOJE na Beehiiv, o `--push` inteiro é recusado (nem
 * adições, nem remoções são aplicadas) — `shouldBlockRemovals` acima só cobre
 * `error`/`sem_dados`, nunca "removeu demais por outro motivo" (bug de
 * cálculo, apoia.se fora do ar respondendo `nao_apoia` em vez de erro, etc).
 * `--force-blast-radius` é o escape hatch explícito (decisão consciente do
 * editor, sempre logada). Ver `evaluateBlastRadiusGuard`.
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
 * IMPORTANTE (#4436 — escopo desta unidade): `--push` NUNCA foi executado
 * nesta sessão contra a Beehiiv real (o guard padrão de publicação do
 * overnight cobre este script — só a correção dos 6 SEGMENTOS pela UI foi
 * autorizada ao vivo, não o `--push` deste script). Validado só via dry-run
 * (leitura real, sem escrita) + testes com fixtures (nenhuma chamada de rede
 * real nos testes).
 *
 * Uso:
 *   npx tsx scripts/sync-apoio-nivel-beehiiv.ts [--push] [--allow-partial] [--force-blast-radius]
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type ApoioNivel, isApoioNivel } from "./lib/shared/apoio-nivel-types.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { readApoiaSeEnv, defaultCacheDir, competenceMonth } from "./lib/apoia-se.ts";
import { previousMonthKey } from "./lib/apoio-month-key.ts";
import { findEmailMatchCandidates, type EmailMatchCandidate } from "./lib/apoio-email-heuristics.ts";
import { runApoioReconciliationCycle } from "./lib/apoio-reconciliation-cycle.ts";
import {
  buildApoiosData,
  computeRewardGroup,
  readPastMonthSnapshots,
  type ContactWithStatus,
  type MonthSnapshot,
} from "./studio-ui/studio-apoios.ts";
import { hasMorePages } from "./sync-cursos-subscribers-kv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LOG_PREFIX = "[sync-apoio-nivel-beehiiv]";

const RATE_LIMIT_DELAY_MS = 300;
const MAX_RETRIES = 3;
const PER_PAGE = 100;

/** Limiar do guard de blast radius — decisão do editor, #4436 comentário
 * 260801 ("sim, limiar 30%"). Removido daqui pra facilitar achar/mudar. */
const BLAST_RADIUS_THRESHOLD = 0.3;

/** Nome do custom field na publicação — já criado manualmente pelo editor
 * (ver cabeçalho do módulo). Este script nunca cria o campo, só lê/escreve. */
export const APOIO_NIVEL_FIELD_NAME = "apoio_nivel";

/** `ApoioNivel` + `isApoioNivel` extraídos pra `lib/shared/apoio-nivel-types.ts`
 * (hotfix #7030, master vermelho c8fcdc9b) — ver docblock daquele módulo.
 * Reexportados aqui pra manter todo consumidor existente
 * (`kit-gmail-warmup-ramp.ts`, `sync-artigos-apoio-kv.ts`, etc.) importando
 * de `./sync-apoio-nivel-beehiiv.ts` sem nenhuma mudança. */
export type { ApoioNivel };
export { isApoioNivel };

/** Ordinal de faixa — usado só por `maxLevel` pra decidir a carência (#4436).
 * `null` (sem apoio) é sempre o mínimo. */
const LEVEL_RANK: Record<ApoioNivel, number> = { amigo: 1, apoiador: 2, mantenedor: 3, patrono: 4 };

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

// ── carência de 1 mês (#4436) — puro ────────────────────────────────────

/** Pure: maior das duas faixas (ou `null` se ambas `null`). Usado pra
 * combinar o nível do mês corrente com o do mês anterior (carência). */
export function maxLevel(a: ApoioNivel | null, b: ApoioNivel | null): ApoioNivel | null {
  const rankA = a ? LEVEL_RANK[a] : 0;
  const rankB = b ? LEVEL_RANK[b] : 0;
  return rankA >= rankB ? a : b;
}

/**
 * Reexportado (#4437) de `./lib/apoio-month-key.ts` — extraído pra lá porque
 * `scripts/studio-ui/studio-apoios.ts` (Entrega 1, grupo "ainda não pagou
 * esse mês") também precisa desta função, e este arquivo já importa DE
 * `studio-apoios.ts` (`buildApoiosData`/`computeRewardGroup`/
 * `readPastMonthSnapshots`) — mantê-la aqui criaria um ciclo de módulos ES.
 * Reexportar preserva o import existente (`test/sync-apoio-nivel-
 * beehiiv.test.ts` importa `previousMonthKey` deste path). Ver o cabeçalho
 * de `apoio-month-key.ts` pro rationale completo.
 */
export { previousMonthKey };

/**
 * Pure: nível pago por um contato (qualquer um dos seus e-mails) num
 * snapshot de mês específico — `null` se o snapshot não existe (mês sem
 * cache, ex: primeiro mês de operação) ou se nenhum e-mail pagou naquele
 * mês. Mesma regra de "qualquer e-mail que bate" de `deriveContactStatus`.
 */
export function levelFromSnapshot(emails: readonly string[], snapshot: MonthSnapshot | undefined): ApoioNivel | null {
  if (!snapshot) return null;
  for (const email of emails) {
    const s = snapshot.statuses[email];
    if (s?.isPaidThisMonth) {
      return computeRewardGroup(s.thisMonthPaidValue);
    }
  }
  return null;
}

// ── estado DESEJADO (puro, de ContactWithStatus[] + histórico) ─────────────

export interface DesiredApoioLevel {
  contactId: string;
  contactName: string;
  /** E-mails normalizados (lowercase/trim, dedup) do contato. */
  emails: string[];
  /** Nível desejado, ou `null` se o contato não deve ter valor nenhum (não
   * apoiou nem no mês corrente nem no anterior — carência esgotada). */
  level: ApoioNivel | null;
  /** `true` quando `status.label === "sem_dados"` — nível DESCONHECIDO (falha
   * transiente de checagem), nunca tratado como "sem apoio". */
  unresolved: boolean;
}

/**
 * Pure: computa o nível de recompensa desejado por contato a partir do
 * `ContactWithStatus[]` já resolvido por `buildApoiosData`, aplicando a
 * carência de 1 mês (#4436): nível desejado = MAIOR faixa entre o mês
 * corrente e o mês anterior (`pastSnapshots`, saída de
 * `readPastMonthSnapshots` — zero chamada de rede nova). Reusa
 * `computeRewardGroup` (mesma fonte única de limiar usada pelo painel Apoios
 * e por `build-apoiador-allowlist.ts`) — SEM reimplementar a lógica de
 * faixas. Contatos "sem_dados" são marcados `unresolved: true` com `level:
 * null` (desconhecido, não "sem apoio") — `diffApoioTags` nunca gera ação
 * pra eles, e a carência não se aplica (nível do mês corrente é
 * desconhecido, não "não pagou").
 */
export function computeDesiredApoioLevels(
  contacts: ContactWithStatus[],
  pastSnapshots: MonthSnapshot[],
  currentMonth: string,
): DesiredApoioLevel[] {
  const previousSnapshot = pastSnapshots.find((s) => s.month === previousMonthKey(currentMonth));

  return contacts.map((c) => {
    const unresolved = c.status.label === "sem_dados";
    const emails = normalizeEmailList(c.emails);

    if (unresolved) {
      return { contactId: c.id, contactName: c.name, emails, level: null, unresolved: true };
    }

    const currentLevel = c.status.label === "apoiando" ? computeRewardGroup(c.status.monthlyValue) : null;
    const previousLevel = levelFromSnapshot(emails, previousSnapshot);

    return {
      contactId: c.id,
      contactName: c.name,
      emails,
      level: maxLevel(currentLevel, previousLevel),
      unresolved: false,
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
 *
 * **Falha loud, sempre (achado do review, PR #4307).** `/subscriptions` é o
 * recurso PRINCIPAL deste script, não um endpoint opcional (diferente do
 * padrão `optional: true`/`fetchAllPages` de `scripts/backup-beehiiv.ts`,
 * reservado a features fora do plano). O próprio `backup-beehiiv.ts`, ao
 * paginar ESSE MESMO endpoint (`/subscriptions`), nunca tolera 404/403 —
 * `if (!res.ok) throw` incondicional. Uma versão anterior deste arquivo
 * tratava 404/403 como "fim de paginação" (copiado sem questionar de
 * `sync-cursos-subscribers-kv.ts`, script aditivo/baixo-risco onde isso é
 * defensável) — aqui é destrutivo: uma página truncada faz assinantes reais
 * desaparecerem de `current`, e `diffApoioTags` os classifica como
 * `notBeehiivSubscriber` ("não é erro") quando na verdade é "nunca
 * chegamos lá" — e pior, um assinante já taggeado que caiu fora da leitura
 * truncada vira uma remoção fantasma (`toRemove`) sem que `shouldBlockRemovals`
 * tenha qualquer sinal disso (o guard só enxerga `data.error`/`sem_dados` do
 * lado apoia.se, nunca truncamento do lado Beehiiv). Por isso: qualquer
 * `!res.ok` aqui é sempre fatal — nunca vira `break` silencioso.
 *
 * **Reconciliação anti-truncamento-silencioso** (mesmo padrão de
 * `backup-beehiiv.ts` #1897): se a API informou `total_results` e o loop
 * terminou (`hasMorePages` retornou `false`) sem ter coletado esse total,
 * falha barulhento em vez de devolver uma lista parcial que pareça completa.
 */
export async function fetchCurrentBeehiivState(
  publicationId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BeehiivSubscriptionSnapshot[]> {
  const out: BeehiivSubscriptionSnapshot[] = [];
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
    const body = res.body!;
    const got = body.data ?? [];
    for (const s of got) {
      out.push({
        subscriptionId: s.id,
        email: s.email.trim().toLowerCase(),
        apoioNivel: extractApoioNivelValue(s.custom_fields),
      });
    }
    if (body.total_results != null) totalResults = body.total_results;
    more = hasMorePages({
      collected: out.length,
      gotLength: got.length,
      totalResults: body.total_results,
      effectiveLimit: body.limit,
      requestedPerPage: PER_PAGE,
    });
    page++;
  }
  if (totalResults != null && totalResults > 0 && out.length < totalResults) {
    throw new Error(
      `paginação de /subscriptions terminou cedo: coletado ${out.length} de ${totalResults} ` +
        "reportado pela API — leitura truncada nunca alimenta o diff (risco de remoção fantasma).",
    );
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

/** #4490 causa 3: apoiador que não casou por e-mail exato, com candidatos
 * heurísticos (0 ou mais) pra confirmação manual do editor — NUNCA aplicados
 * sozinhos, ver `scripts/lib/apoio-email-heuristics.ts`. */
export interface UnmatchedApoiador extends DesiredApoioLevel {
  candidates: EmailMatchCandidate[];
}

export interface ApoioTagDiffResult {
  /** Adições + trocas de faixa — sempre seguro aplicar (nunca gated pelo
   * guard de dados parciais). */
  toApply: ApoioTagDiffEntry[];
  /** Remoções (contato parou de apoiar) — sujeito ao guard fail-closed de
   * dados parciais (`shouldBlockRemovals`) e ao guard de blast radius
   * (`evaluateBlastRadiusGuard`). */
  toRemove: ApoioTagDiffEntry[];
  /** Já convergido — nenhuma ação necessária (idempotência). */
  unchanged: ApoioTagDiffEntry[];
  /** Contatos "sem_dados" — nenhuma ação gerada, nível desconhecido. */
  skippedUnresolved: DesiredApoioLevel[];
  /** Apoiadores (ou não-apoiadores) que NÃO casaram por e-mail exato contra
   * nenhuma subscription Beehiiv — não é necessariamente "não assina", pode
   * assinar com outro endereço (#4490 causa 3, ver `candidates`). */
  notBeehiivSubscriber: UnmatchedApoiador[];
}

/**
 * Pure: diffa o estado desejado (por contato) contra o estado atual (por
 * assinante Beehiiv). Casamento por e-mail segue a MESMA regra de
 * `deriveContactStatus` (#4273): bate se QUALQUER e-mail do contato bater com
 * uma subscription. Um contato pode casar com MÚLTIPLAS subscriptions
 * (múltiplos e-mails assinados na Beehiiv) — cada uma recebe uma entrada de
 * diff própria, pra que a recompensa alcance a pessoa independente de qual
 * e-mail ela usa pra ler a newsletter.
 *
 * Quando NENHUM e-mail conhecido bate exato (#4490 causa 3),
 * `findEmailMatchCandidates` gera candidatos heurísticos (local-part
 * normalizado, nome no local-part, domínio próprio, variação/typo) pra
 * apresentar ao editor — nunca decide um vínculo sozinho.
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
  const notBeehiivSubscriber: UnmatchedApoiador[] = [];

  for (const d of desired) {
    if (d.unresolved) {
      skippedUnresolved.push(d);
      continue;
    }

    const matches = d.emails
      .map((e) => currentByEmail.get(e))
      .filter((s): s is BeehiivSubscriptionSnapshot => s !== undefined);

    if (matches.length === 0) {
      const candidates = findEmailMatchCandidates(d.contactName, d.emails, current);
      notBeehiivSubscriber.push({ ...d, candidates });
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

// ── guard de blast radius (#4436) — puro ────────────────────────────────

export interface BlastRadiusGuardResult {
  /** `true` = o `--push` inteiro deve ser recusado (nem adições nem
   * remoções são aplicadas). */
  blocked: boolean;
  removalCount: number;
  /** Quantos assinantes têm `apoio_nivel` setado HOJE na Beehiiv (antes do
   * push) — denominador do limiar. */
  currentWithLevelCount: number;
  /** `removalCount / currentWithLevelCount` — `0` quando o denominador é 0
   * (não há ninguém com nível hoje, logo não há base pra "% removido"). */
  ratio: number;
}

/**
 * Pure: recusa o `--push` inteiro quando as remoções calculadas excedem
 * `BLAST_RADIUS_THRESHOLD` (30%, decisão do editor #4436) de quem TEM
 * `apoio_nivel` setado hoje na Beehiiv — independente do motivo (bug de
 * cálculo, virada de mês sem a carência ter pego o caso, apoia.se
 * respondendo `nao_apoia` em massa por instabilidade). Mais amplo que
 * `shouldBlockRemovals` (que só cobre `error`/`sem_dados`): aqui o critério é
 * puramente de MAGNITUDE, não de origem do dado. "Passar de" é estrito —
 * exatamente no limiar (`ratio === threshold`) NÃO bloqueia.
 * `force` (`--force-blast-radius`) é o escape hatch explícito.
 */
export function evaluateBlastRadiusGuard(
  removalCount: number,
  current: readonly BeehiivSubscriptionSnapshot[],
  force: boolean,
): BlastRadiusGuardResult {
  const currentWithLevelCount = current.filter((s) => s.apoioNivel !== "").length;
  const ratio = currentWithLevelCount > 0 ? removalCount / currentWithLevelCount : 0;
  const blocked = !force && ratio > BLAST_RADIUS_THRESHOLD;
  return { blocked, removalCount, currentWithLevelCount, ratio };
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

/** Exportado (#6049) — `scripts/sync-apoio-nivel-kit.ts` reusa esta função de
 * log tal qual (mesmo shape de diff, plataforma-agnóstica) em vez de
 * duplicar as ~50 linhas de formatação. */
export function logDiff(diff: ApoioTagDiffResult, removalsBlocked: boolean): void {
  const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);

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
    // #4490 causa 3: texto trocado de "não é erro" (soava conclusivo, e era
    // falso pra 4 de 5 casos reais) pra uma leitura que não afirma ausência
    // de vínculo — pode assinar com outro endereço, ver candidatos abaixo.
    log(
      `${diff.notBeehiivSubscriber.length} apoiador(es)/contato(s) NÃO casaram por e-mail exato ` +
        "com nenhuma subscription Beehiiv (pode assinar com outro endereço — ver candidatos heurísticos):",
    );
    for (const d of diff.notBeehiivSubscriber) {
      const label = d.contactName || d.emails[0];
      if (d.candidates.length === 0) {
        log(`  - ${label} (${d.emails.join(", ")}): nenhum candidato heurístico`);
      } else {
        log(`  - ${label} (${d.emails.join(", ")}): ${d.candidates.length} candidato(s):`);
        for (const c of d.candidates) {
          log(`      ? ${c.email} — ${c.detail} (confirmar manualmente, nunca aplicado sozinho)`); // #4506: reason virou union curta, detail carrega o texto legível
        }
      }
    }
  }

  log(`${diff.unchanged.length} já convergido(s) (nenhuma ação).`);
  // #4485 item 3 (follow-up de #4273): "5 apoiadores pagam e não recebem
  // nada por e-mail" já sai listado acima (notBeehiivSubscriber) — TODO pro
  // editor: decidir se isso deveria virar um ALARME (não só um item de
  // relatório) quando o mesmo contato persiste sem vínculo por várias
  // rodadas seguidas. Não implementado — é decisão editorial, não técnica.
}

/** Exportado (#6049) — mesma razão de `logDiff` acima. */
export function logBlastRadiusGuard(guard: BlastRadiusGuardResult): void {
  const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
  const pct = (guard.ratio * 100).toFixed(1);
  log(
    `guard de blast radius: ${guard.removalCount} remoção(ões) de ${guard.currentWithLevelCount} ` +
      `com nível hoje (${pct}%, limiar ${(BLAST_RADIUS_THRESHOLD * 100).toFixed(0)}%)` +
      (guard.blocked ? " — EXCEDIDO." : "."),
  );
}

// ── reconciliação de promessas pendentes (#4490 causa 4) ────────────────

/**
 * Reexportado (self-review consolidado do PR #4503, achados críticos 1/2 e
 * altos 3/4) de `./lib/apoio-reconciliation-cycle.ts` — extraído pra lá
 * junto com `runApoioReconciliationCycle` (a orquestração inteira: drena
 * Gmail → importa notificações confirmadas → funde + reconcilia promessas →
 * persiste), que este arquivo e `apoios-diff-alarm.ts` agora chamam em vez
 * de duplicar a sequência. Mantê-la aqui criaria um ciclo de módulos ES
 * (mesmo motivo do reexport de `previousMonthKey` acima). Reexportar
 * preserva o import existente (`test/sync-apoio-nivel-beehiiv.test.ts`
 * importa `reconcilePendingPromises` deste path). Ver o cabeçalho de
 * `apoio-reconciliation-cycle.ts` pro rationale completo, inclusive o fix do
 * `catch {}` vazio que engolia `ApoiaSeAuthError` (achado crítico 2).
 */
export { reconcilePendingPromises, type ReconcilePromisesResult } from "./lib/apoio-reconciliation-cycle.ts";

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  loadProjectEnv(ROOT);

  const { apiKey, publicationId } = loadBeehiivConfig(LOG_PREFIX);

  // #4490 causa 4 / self-review do PR #4503: drena Gmail (apoia.se) → importa
  // notificações de PAGAMENTO CONFIRMADO como contato (achado crítico 1) →
  // funde + reconcilia promessas pendentes do store (achado crítico 2) →
  // persiste o que mudou — sequência extraída (achado alto de duplicação)
  // pra `runApoioReconciliationCycle`, chamada aqui e em
  // `apoios-diff-alarm.ts::main()`. Fail-soft pra tudo, EXCETO
  // `ApoiaSeAuthError` (ver `cycle.authError` abaixo) — buildApoiosData relê
  // contacts.jsonl do disco a seguir, então qualquer contato
  // importado/promovido aqui já entra no cálculo do diff.
  const cycle = await runApoioReconciliationCycle(ROOT);
  if (cycle.drainSkipped) {
    process.stderr.write(
      `${LOG_PREFIX} aviso: drain de promessas (Gmail) pulado (${cycle.drainSkipReason ?? "erro desconhecido"}) — ` +
        "reconciliação segue só com promessas já no store.\n",
    );
  }
  if (cycle.promessasDrained > 0) {
    process.stderr.write(`${LOG_PREFIX} ${cycle.promessasDrained} promessa(s) nova(s) drenada(s) do Gmail.\n`);
  }
  if (cycle.notificationsImported > 0) {
    process.stderr.write(
      `${LOG_PREFIX} ${cycle.notificationsImported} notificação(ões) de pagamento confirmado importada(s) como contato novo.\n`,
    );
  }
  if (cycle.promoted.length > 0) {
    process.stderr.write(
      `${LOG_PREFIX} ${cycle.promoted.length} promessa(s) confirmada(s) como pagamento — ` +
        `promovida(s) a contato: ${cycle.promoted.map((p) => `${p.name} <${p.email}>`).join(", ")}\n`,
    );
  }
  if (cycle.remainingPending.length > 0) {
    process.stderr.write(
      `${LOG_PREFIX} ${cycle.remainingPending.length} promessa(s) ainda pendente(s) (sem confirmação de pagamento).\n`,
    );
  }
  if (cycle.stale.length > 0) {
    // #4506 item 2: cada uma já foi logada individualmente dentro de
    // reconcilePendingPromises — este é só o resumo agregado no nível do sync.
    process.stderr.write(
      `${LOG_PREFIX} aviso: ${cycle.stale.length} promessa(s) pendente(s) há mais de 90 dias sem confirmar — ver avisos acima.\n`,
    );
  }
  if (cycle.warning) {
    process.stderr.write(`${LOG_PREFIX} aviso: ${cycle.warning}\n`);
  }
  if (cycle.authError) {
    // Achado crítico 2 (PR #4503): chave apoia.se rejeitada é LOUD, nunca
    // "seguindo sem ela" — sem isso, toda promessa pendente falharia em
    // silêncio pra sempre, indistinguível de "ainda não pagou".
    process.stderr.write(
      `${LOG_PREFIX} ERRO FATAL: chave apoia.se rejeitada durante a reconciliação de promessas pendentes ` +
        `(${cycle.authError}) — verifique APOIA_SE_API_KEY/APOIA_SE_API_SECRET. Sync abortado antes de tocar a Beehiiv.\n`,
    );
    process.exit(1);
  }

  const data = await buildApoiosData(ROOT);
  if (data.error) {
    process.stderr.write(`${LOG_PREFIX} aviso: buildApoiosData reportou erro (dados podem estar incompletos): ${data.error}\n`);
  }

  const now = new Date();
  const currentMonth = competenceMonth(now);
  let pastSnapshots: MonthSnapshot[] = [];
  try {
    const env = readApoiaSeEnv();
    pastSnapshots = readPastMonthSnapshots(defaultCacheDir(env.campaign), currentMonth);
  } catch (e) {
    process.stderr.write(
      `${LOG_PREFIX} aviso: não foi possível ler snapshots de meses anteriores (carência de 1 mês ` +
        `desativada nesta rodada, comportamento cai pro mês corrente só): ${(e as Error).message}\n`,
    );
  }

  const desired = computeDesiredApoioLevels(data.contacts, pastSnapshots, currentMonth);

  process.stderr.write(`${LOG_PREFIX} buscando estado atual na Beehiiv…\n`);
  const current = await fetchCurrentBeehiivState(publicationId, apiKey);
  process.stderr.write(`${LOG_PREFIX} ${current.length} assinante(s) ativo(s) na Beehiiv.\n`);

  const diff = diffApoioTags(desired, current);
  const allowPartial = hasFlag(argv, "allow-partial");
  const removalsBlockedByPartialData = shouldBlockRemovals(data.error, diff, allowPartial);
  const forceBlastRadius = hasFlag(argv, "force-blast-radius");
  const blastGuard = evaluateBlastRadiusGuard(diff.toRemove.length, current, forceBlastRadius);

  logDiff(diff, removalsBlockedByPartialData);
  logBlastRadiusGuard(blastGuard);

  if (!hasFlag(argv, "push")) {
    process.stderr.write(`${LOG_PREFIX} dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar.\n`);
    return;
  }

  if (blastGuard.blocked) {
    process.stderr.write(
      `${LOG_PREFIX} RECUSANDO o --push inteiro (guard de blast radius acima) — nenhuma mutação foi ` +
        "aplicada, nem adições nem remoções. Confira se é uma virada de mês/instabilidade da apoia.se " +
        "antes de usar --force-blast-radius (decisão consciente do editor, sempre logada).\n",
    );
    process.exit(1);
  }

  if (removalsBlockedByPartialData && diff.toRemove.length > 0) {
    process.stderr.write(
      `${LOG_PREFIX} RECUSANDO aplicar as remoções acima (dados parciais/sem_dados) — ` +
        "uma falha de rede não pode virar remoção em massa de recompensa. Re-tente, ou use " +
        "--allow-partial pra prosseguir mesmo assim (decisão consciente do editor, sempre logada).\n",
    );
  }

  const toApplyNow = [...diff.toApply, ...(removalsBlockedByPartialData ? [] : diff.toRemove)];
  process.stderr.write(`${LOG_PREFIX} --push: aplicando ${toApplyNow.length} mutação(ões)…\n`);

  let applied = 0;
  let failed = 0;
  for (const entry of toApplyNow) {
    try {
      await applyApoioTagEntry(entry, publicationId, apiKey);
      applied++;
    } catch (e) {
      failed++;
      process.stderr.write(`${LOG_PREFIX} FALHA em ${entry.email}: ${(e as Error).message}\n`);
    }
  }

  process.stderr.write(`${LOG_PREFIX} push concluído: ${applied} aplicada(s), ${failed} falha(s).\n`);
  if (failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
