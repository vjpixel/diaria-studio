#!/usr/bin/env node
/**
 * scripts/sync-pending-to-brevo.ts (#4266, item 2a/3 do plano da issue;
 * fila de tamanho fixo + backfill adicionados no #4476 item 5)
 *
 * Triagem de SAÍDA (não envio duplicado aditivo — decisão do editor, sessão
 * /diaria-develop 260731, comentário 260731 da issue #4266): identifica
 * assinantes com status **Pending** na Beehiiv (assinaram, mas nunca
 * confirmaram o double opt-in — por definição NÃO recebem nada da Beehiiv) e
 * os adiciona à lista da conta Brevo PRÓPRIA do editor (`brevo_diaria` em
 * `platform.config.json`, distinta da conta da parceria Clarice), pra que
 * recebam a diária por esse canal alternativo enquanto continuam pendentes
 * na Beehiiv.
 *
 * ## Fila de tamanho fixo + backfill contínuo (#4476 item 5)
 *
 * SUBSTITUI o comportamento original (ingeria TODO `computeContactsToIngest`
 * de uma vez, sem cap): a fila de contatos `in_brevo` nunca excede o cap
 * free-tier da Brevo (300, `brevo_diaria.daily_send_cap`,
 * `computeAvailableSlots`). Cada rodada calcula quantos slots estão livres
 * (cap menos quem hoje ocupa um slot) e ingere só até esse número,
 * PRIORIZADO pelo score de origem (#4476 item 4, `selectContactsForBackfill`
 * + `loadOriginScores`, que lê `data/pending-reativacao/pending-scored-computed.csv`
 * gerado por `scripts/score-pending-origin.ts`). "Backfill CONTÍNUO" é uma
 * propriedade emergente de rodar este script periodicamente: quando
 * `evaluate-brevo-diaria.ts` promove/suprime/detecta descadastro nativo de
 * um contato (mudando seu status pra fora de `in_brevo`), a PRÓXIMA rodada
 * deste script vê mais slots livres e ingere o próximo da fila — nenhum
 * mecanismo adicional de "notificação de slot livre" é necessário.
 *
 * ## Circuit breaker de campanha (#4476 item 9) — freio automático REMOVIDO (#6793 item 1)
 *
 * Antes de calcular `availableSlots`, este script lê o latch persistido por
 * `scripts/check-brevo-diaria-guardrail.ts` (`data/brevo-diaria/guardrail-state.json`,
 * `scripts/lib/brevo-diaria-guardrail.ts`) — se `rollout_paused === true`, o
 * backfill é ZERADO nesta rodada. **#6793 "Faixa B" item 1 (01/09/2026,
 * decisão do editor): `shouldPauseRollout` sempre retorna `false` agora**,
 * então `rollout_paused` só chega `true` por estado legado/manual, nunca
 * mais automaticamente por bounce/spam/unsub agregado. O mecanismo do gate
 * em si (`applyRolloutGuardrailGate` abaixo) continua funcionando idêntico
 * — respeita o latch se ele algum dia estiver `true` — só nada o ativa
 * mais sozinho. Volta a funcionar normalmente só depois de
 * `check-brevo-diaria-guardrail.ts --unpause` (ação explícita do editor) —
 * nunca despausa sozinho (isso não mudou).
 *
 * MillionVerifier (issue #4476 item 8) — `scripts/verify-pending-emails-mv.ts`,
 * implementado 260802. 1 passada em lote sobre o pool inteiro ANTES do
 * primeiro envio (não por-backfill — decisão da issue #4476, pool estático).
 * A saída (`data/pending-reativacao/mv-verified.csv`) é consumida AQUI:
 * `loadMvVerifiedEmails` lê o CSV e `computeContactsToIngest` filtra pra só
 * quem está no set verificado — quem nunca foi verificado, ou foi
 * rejeitado/inconclusivo, NUNCA é ingerido, mesmo que apareça na paginação
 * Pending da Beehiiv.
 *
 * ## Guard de MV antes de `--push` — baseado em COBERTURA real, não em
 * "arquivo existe" (#4494 review: achado convergente de 4 dos 5 agentes do
 * fleet — code-reviewer, silent-failure-hunter, comment-analyzer,
 * type-design-analyzer — todos independentemente acharam a mesma lacuna;
 * silent-failure-hunter provou ao vivo contra o estado real do repo: com só
 * 2 de 626 verificados, a versão anterior do guard já passaria em silêncio)
 *
 * Duas falhas na versão anterior, ambas corrigidas juntas:
 *
 * 1. **Guard e filtro liam sinais DIFERENTES.** O guard usava
 *    `existsSync(mv-verified.csv)` — só "o arquivo existe". O filtro real
 *    (`loadMvVerifiedEmails`) é fail-soft: se o arquivo existe mas está
 *    corrompido/malformado, ele retorna `null` (mesmo efeito de "arquivo
 *    ausente") — mas o guard, sem saber disso, já tinha passado achando que
 *    tudo estava OK. Resultado: CSV corrompido → guard passa → filtro
 *    silenciosamente desliga → ingestão SEM verificação nenhuma, sem
 *    warning, sem exigir `--i-know-this-skips-mv`. Corrigido: o guard agora
 *    usa o MESMO `verifiedEmails` que o filtro usa — `verifiedEmails ===
 *    null` (por QUALQUER motivo: ausente ou malformado) sempre exige a flag.
 * 2. **"Arquivo existe" não é "verificação completa".** Mesmo com o CSV
 *    parseando bem, 2 e-mails verificados de um pool de 626 já fazia o guard
 *    antigo passar sem pedir a flag — a cobertura real (quantos do pool já
 *    foram PROCESSADOS pela MV, verified+rejected+unknown, não só quantos
 *    passaram) nunca era checada. Corrigido: o guard agora exige que a
 *    cobertura (`processedCount`, lido de `mv-verified.csv` +
 *    `mv-rejected.csv` + `mv-unknown.csv`) cubra o pool inteiro
 *    (`ORIGIN_SCORES_CSV_PATH`) antes de passar sem a flag.
 *
 * ## Dedup: pelo STORE, não pela Beehiiv (decisão de design)
 *
 * A issue original ("remove/marca da Beehiiv") deixava em aberto COMO
 * marcar. Investigação (#4266, achado 260730, replicado no #4273 Parte 2 pra
 * outro campo): a API pública da Beehiiv **ignora silenciosamente** escrita
 * de tag por assinante (`PATCH .../subscriptions/{id}` com `{tags:[...]}` →
 * 200, mas a releitura mostra `tags: []` — mesma armadilha documentada em
 * `scripts/sync-apoio-nivel-beehiiv.ts`). Um custom field funcionaria (mesmo
 * padrão daquele script), mas exigiria o editor criar o campo manualmente na
 * publicação ANTES desta unidade poder rodar — bloqueio externo desnecessário
 * quando o dedup pode viver inteiramente do lado de cá: `brevo-diaria-store.ts`
 * já é a fonte de verdade de "quem já foi triado" (idempotente por email,
 * `upsertIngested` nunca duplica). A Beehiiv nunca é escrita por este script —
 * só lida. Consequência aceita: um Pending nunca ingerido por este script,
 * mas que já apareceu numa rodada, não fica marcado NA Beehiiv como "já
 * tratado" — só no store local. Isso é suficiente porque este script SEMPRE
 * roda contra o store (nunca re-varre "quem ainda não tem tag") e o store
 * vive em `data/` (mesmo mecanismo de persistência de todo o resto do
 * pipeline Clarice/Brevo).
 *
 * ## Risco de duplicidade (registrado na própria issue, não eliminado aqui)
 *
 * Um contato Pending pode confirmar o double opt-in da Beehiiv por conta
 * própria DEPOIS de já ter sido ingerido aqui — ficaria recebendo dos dois
 * canais. Este script não fecha esse gap (é read-then-create, roda 1x por
 * contato); `scripts/evaluate-brevo-diaria.ts` fecha o gap na ELE, checando
 * o status Beehiiv atual de cada contato `in_brevo` a cada rodada de
 * avaliação (ver `applySelfConfirmed` em `brevo-diaria-store.ts`).
 *
 * ## Teto opcional escolhido pelo editor (#4637 item 2 — "quantos acrescentar")
 *
 * `--max-add N` limita o backfill desta rodada a no máximo N contatos, por
 * cima do teto normal de slots livres (`computeAvailableSlots`) — sem a
 * flag, o comportamento antigo continua (preenche até o cap). Isso existe
 * pra sustentar o passo de decisão de volume de `/diaria-brevo-diaria`
 * (Passo 2, SKILL.md): o editor decide quantos slots livres de fato
 * preencher nesta rodada (com "nenhum"/`--max-add 0` como resposta válida),
 * em vez do script sempre inferir "preenche tudo que couber". `--max-add`
 * nunca AUMENTA o backfill além do que já era possível (slots livres e
 * circuit breaker de campanha continuam valendo como teto) — só reduz.
 *
 * ## Pool Pending é FINITO pós-switchover (#6339, medido ao vivo 26/08/2026)
 *
 * Este script lê `status=pending` da Beehiiv — assinantes que se
 * cadastraram mas nunca confirmaram o double opt-in. Até o switchover do
 * #6114 (`platform.config.json` → `publishing.newsletter.backend = "kit"`),
 * todo cadastro novo passava pela Beehiiv primeiro, então esse pool crescia
 * organicamente. Desde que os 3 workers de assinatura passaram a
 * `SUBSCRIBE_BACKEND=kit` (achado da issue #6339), cadastro novo NUNCA MAIS
 * vira `pending` na Beehiiv — o pool parou de crescer e é, a partir de
 * agora, um conjunto FIXO (636 scored, medido 26/08/2026, ver
 * `data/pending-reativacao/pending-scored-computed.csv`).
 *
 * **Isto NÃO é um bug nem uma regressão a investigar** — é a consequência
 * esperada do switchover. Cada rodada de `evaluate-brevo-diaria.ts` que
 * promove/suprime/detecta descadastro nativo de um contato reduz o pool
 * elegível (nunca aumenta), então o esvaziamento gradual da fila
 * `in_brevo` até zero é o desfecho NORMAL deste canal, não um sinal de
 * falha de ingestão. Se `computeContactsToIngest` devolver cada vez menos
 * candidatos ao longo das semanas, a leitura correta é "o pool está
 * secando, como esperado" — nunca "algo parou de funcionar aqui".
 *
 * ## Uso
 *
 *   npx tsx scripts/sync-pending-to-brevo.ts              # dry-run (default)
 *   npx tsx scripts/sync-pending-to-brevo.ts --push        # aplica (cria contatos na Brevo)
 *     # --push ABORTA se `data/pending-reativacao/mv-verified.csv` não existir
 *     # (rode scripts/verify-pending-emails-mv.ts primeiro) — OU passe, ciente
 *     # do risco de bounce, sem MV nenhum:
 *   npx tsx scripts/sync-pending-to-brevo.ts --push --i-know-this-skips-mv
 *   npx tsx scripts/sync-pending-to-brevo.ts --push --max-add 10   # limita a 10 novos contatos
 *   npx tsx scripts/sync-pending-to-brevo.ts --push --max-add 0    # "nenhum" — roda o resto do fluxo sem ingerir ninguém
 *
 * Env: BEEHIIV_API_KEY (leitura) + platform.config.json → brevo_diaria.api_key_env (escrita).
 *
 * Como do PR #4398 (260731), `--push` ainda não foi rodado com efeito real
 * (guard de publicação — scripts que tocam Beehiiv/Brevo ao vivo não rodam a
 * partir de sessão autônoma). Validado só via testes com fetch mockado.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { hasFlag, isMainModule, getIntArg } from "./lib/cli-args.ts";
import { hasMorePages } from "./sync-cursos-subscribers-kv.ts";
import { brevoPost, brevoGet } from "./lib/brevo-client.ts";
import {
  DEFAULT_OUTPUT_PATH as ORIGIN_SCORES_CSV_PATH,
  DEFAULT_INPUT_PATH as RAW_POOL_CSV_PATH,
  LANE_RECENCY,
} from "./score-pending-origin.ts";
import { extractCustomFieldValue, RH_SOURCE_FIELD_NAME } from "./sync-sparkloop-exclusion-segment-beehiiv.ts";
import { MV_VERIFIED_CSV_PATH, MV_REJECTED_CSV_PATH, MV_UNKNOWN_CSV_PATH } from "./verify-pending-emails-mv.ts";
import { readRolloutGuardrailState } from "./lib/brevo-diaria-guardrail.ts";
import {
  readStore,
  writeStore,
  upsertIngested,
  normalizeEmail,
  DEFAULT_STORE_PATH,
  type BrevoDiariaStore,
  type BrevoDiariaContact,
} from "./lib/brevo-diaria-store.ts";
import { EDITOR_SEED_EMAILS } from "./lib/editor-copy.ts"; // #4631
import { buildOrigin } from "./lib/shared/brevo-diaria-origin.ts"; // #6678

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RATE_LIMIT_DELAY_MS = 300;
const PER_PAGE = 100;

interface BrevoDiariaConfig {
  api_key_env: string;
  list_id: number | null;
  /** #4476 item 5 — cap free tier Brevo (300). Era usado por
   * `checkDailySendCap` (`publish-daily-brevo.ts`, item 5 da issue #6793)
   * como teto de ENVIO diário — **correção #6940**: esse uso não está mais
   * ativo, `checkDailySendCap` foi esvaziado no mesmo #6793 e hoje só lê o
   * valor sem gatear nada. Também **deixou de** ser reusado como teto da
   * fila de contatos ATIVOS (`in_brevo`) — decisão do editor #6793 "Faixa A"
   * (30/08/2026, remoção deliberada dos freios automáticos de VOLUME,
   * assumindo o risco de reputação de domínio/IP conscientemente). Ver
   * `main()` abaixo, onde o cap da fila agora é ilimitado.
   */
  daily_send_cap?: number;
}
interface PlatformConfig {
  brevo_diaria?: BrevoDiariaConfig;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── leitura da Beehiiv (status=pending) ─────────────────────────────────────

export interface BeehiivPendingSubscription {
  id: string;
  email: string;
  /** #5183 — valor cru do custom field `RH_SOURCE`, `""` se ausente/vazio.
   * Sempre populado (a paginação sempre pede `expand[]=custom_fields`) —
   * consumidores que não precisam disto (o resto deste script) simplesmente
   * ignoram o campo. Usado por `refresh-pending-pool.ts` pro filtro de
   * exclusão SparkLoop (reusa `isSparkloopUpscribeSource`). */
  rhSource: string;
  /** #5183 — data de cadastro na Beehiiv, ISO 8601 (`""` se ausente/não
   * reconhecido). NÃO-VERIFICADO contra a API real nesta sessão (mesma
   * ressalva de `sync-sparkloop-exclusion-segment-beehiiv.ts`: o campo
   * `created` — unix epoch em segundos — vem só da documentação pública,
   * guard de publicação nunca permitiu confirmar ao vivo). Usado por
   * `refresh-pending-pool.ts` só como metadado de auditoria/ordenação —
   * nunca em nenhuma validação. */
  subscribedOn: string;
}

interface BeehiivSubscriptionApi {
  id: string;
  email: string;
  /** #5183 — presente só quando `expand[]=custom_fields` é pedido (sempre,
   * ver `fetchPendingBeehiivSubscriptions`). */
  custom_fields?: Array<{ name?: unknown; value?: unknown }>;
  /** #5183 — unix epoch segundos, quando presente (ver `normalizeSubscribedOn`). */
  created?: unknown;
}

/**
 * Pura (#5183) — normaliza o campo `created` cru da API Beehiiv pra ISO
 * 8601. Aceita número (unix epoch segundos) ou string já parseável por
 * `Date`; qualquer outra coisa (ausente, malformado) devolve `""` — nunca
 * lança, este dado é só metadado de auditoria/ordenação em
 * `refresh-pending-pool.ts`, não deve travar a ingestão principal.
 */
export function normalizeSubscribedOn(createdRaw: unknown): string {
  if (typeof createdRaw === "number" && Number.isFinite(createdRaw)) {
    const d = new Date(createdRaw * 1000);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  if (typeof createdRaw === "string" && createdRaw.trim()) {
    const d = new Date(createdRaw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return "";
}
interface Page<T> {
  data?: T[];
  total_results?: number;
  limit?: number;
}

async function beehiivFetch<T>(
  path: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  retries = 0,
): Promise<{ ok: boolean; status: number; body: T | null }> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetchImpl(`${beehiivApiBase()}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (res.status === 429 && retries < 5) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    await sleep(Math.max(retryAfter * 1000, 30_000));
    return beehiivFetch<T>(path, apiKey, fetchImpl, retries + 1);
  }
  if (!res.ok) return { ok: false, status: res.status, body: null };
  const text = await res.text();
  return { ok: true, status: res.status, body: text ? (JSON.parse(text) as T) : null };
}

/**
 * Pagina `GET /subscriptions?status=pending` — falha ALTO em qualquer !ok
 * (mesma disciplina de `sync-apoio-nivel-beehiiv.ts::fetchCurrentBeehiivState`:
 * este é o recurso PRINCIPAL do script, uma leitura truncada geraria
 * ingestão incompleta silenciosa). Reconciliação anti-truncamento via
 * `total_results`, mesmo padrão.
 */
export async function fetchPendingBeehiivSubscriptions(
  publicationId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BeehiivPendingSubscription[]> {
  const out: BeehiivPendingSubscription[] = [];
  let page = 1;
  let more = true;
  let totalResults: number | null = null;
  while (more) {
    const res = await beehiivFetch<Page<BeehiivSubscriptionApi>>(
      // #5183: expand[]=custom_fields sempre incluído — aditivo (só mais dados
      // na mesma resposta), nunca muda quantidade/paginação. Alimenta
      // rhSource/subscribedOn abaixo; callers que não precisam ignoram os campos.
      `/publications/${publicationId}/subscriptions?status=pending&expand[]=custom_fields&per_page=${PER_PAGE}&page=${page}`,
      apiKey,
      fetchImpl,
    );
    if (!res.ok) {
      throw new Error(`Beehiiv API ${res.status} em /subscriptions?status=pending (página ${page})`);
    }
    const body = res.body!;
    const got = body.data ?? [];
    for (const s of got) {
      out.push({
        id: s.id,
        email: normalizeEmail(s.email),
        rhSource: extractCustomFieldValue(s.custom_fields, RH_SOURCE_FIELD_NAME),
        subscribedOn: normalizeSubscribedOn(s.created),
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
      `paginação de /subscriptions?status=pending terminou cedo: coletado ${out.length} de ${totalResults} — ` +
        "leitura truncada nunca alimenta a ingestão.",
    );
  }
  return out;
}

// ── diff puro (desejado × store) ────────────────────────────────────────────

export interface PendingToIngestEntry {
  email: string;
  beehiiv_subscription_id: string;
}

/**
 * Pura — quem entre os Pending atuais da Beehiiv AINDA não está no store
 * (por qualquer status: `in_brevo`/`promoted_beehiiv`/`suppressed`/
 * `unsubscribed`/`bounced` (#5351 Parte B) contam como "já tratado", nunca
 * re-ingerido) E, se
 * `verifiedEmails` não for `null`, quem também passou pela verificação
 * MillionVerifier (`scripts/verify-pending-emails-mv.ts` — issue #4476 item
 * 8). `verifiedEmails === null` (arquivo `mv-verified.csv` ainda não
 * existe) → sem filtro de MV, comportamento antigo — o guard de `--push`
 * (`assertMvGuardAcknowledged`) é quem trava esse caso, não esta função.
 */
export function computeContactsToIngest(
  pending: BeehiivPendingSubscription[],
  store: BrevoDiariaStore,
  verifiedEmails: Set<string> | null = null,
): PendingToIngestEntry[] {
  const known = new Set(store.contacts.map((c) => c.email));
  const out: PendingToIngestEntry[] = [];
  const seen = new Set<string>();
  for (const p of pending) {
    if (known.has(p.email) || seen.has(p.email)) continue;
    if (verifiedEmails && !verifiedEmails.has(p.email)) continue;
    seen.add(p.email);
    out.push({ email: p.email, beehiiv_subscription_id: buildOrigin("beehiiv", p.id) });
  }
  return out;
}

/**
 * I/O — lê um CSV de 1 coluna `email` (formato de saída de
 * `verify-pending-emails-mv.ts`) e devolve o set de e-mails. Fail-soft:
 * arquivo ausente/malformado → `null` (nunca lança) — quem chama decide o
 * que `null` significa no contexto (ver `loadMvVerifiedEmails` e o cálculo
 * de cobertura em `main()`).
 */
function loadEmailSetFromCsv(path: string, label: string, log: (msg: string) => void): Set<string> | null {
  if (!existsSync(path)) {
    log(`aviso: ${path} não encontrado — ${label}. Rode scripts/verify-pending-emails-mv.ts.`);
    return null;
  }
  try {
    const csvText = readFileSync(path, "utf8");
    const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true, delimiter: "," });
    if (parsed.errors.length > 0) {
      log(`aviso: falha ao parsear ${path} — tratando como ${label}. Erros: ${JSON.stringify(parsed.errors.slice(0, 2))}`);
      return null;
    }
    const set = new Set<string>();
    for (const row of parsed.data) {
      const email = (row.email ?? "").trim().toLowerCase();
      if (email) set.add(email);
    }
    return set;
  } catch (e) {
    log(`aviso: erro lendo ${path} — tratando como ${label}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * I/O — lê `data/pending-reativacao/mv-verified.csv`
 * (`scripts/verify-pending-emails-mv.ts` — issue #4476 item 8) e devolve o
 * set de e-mails que passaram na verificação MillionVerifier (`result: ok
 * | catch_all`). Fail-soft: arquivo ausente/malformado → `null` (nunca
 * lança) — `computeContactsToIngest` interpreta `null` como "sem filtro de
 * MV disponível". **`null` por QUALQUER motivo (ausente OU malformado) faz
 * `assertMvGuardAcknowledged` exigir `--i-know-this-skips-mv`** (#4494
 * review — antes o guard só olhava `existsSync`, dessincronizado deste
 * fail-soft; corrigido usando o mesmo valor nos dois lugares).
 */
export function loadMvVerifiedEmails(path: string, log: (msg: string) => void = () => {}): Set<string> | null {
  return loadEmailSetFromCsv(path, "sem verificação MV disponível ainda", log);
}

/**
 * I/O — conta e-mails ÚNICOS no pool BRUTO (`pending-scored.csv`,
 * `RAW_POOL_CSV_PATH` — o arquivo que `refresh-pending-pool.ts` faz APPEND,
 * #5183). Fail-soft: arquivo ausente → 0 (nunca lança — quem nunca rodou
 * `refresh-pending-pool.ts` continua funcionando como antes). Comparado
 * contra `MvCoverage.poolSize` (que vem do pool COMPUTADO,
 * `pending-scored-computed.csv` — só reflete o pool bruto DEPOIS que
 * `score-pending-origin.ts` roda de novo): se o bruto tiver MAIS e-mails que
 * o computado, o pool foi refrescado mas ainda não recomputado/reverificado
 * — `assertMvGuardAcknowledged` trata isso como cobertura incompleta, mesmo
 * que `processedCount >= poolSize` "bata" sozinho (#5183 — fecha o gap
 * descrito na issue: "hoje o guard passaria com contatos fora do pool").
 */
export function countRawPoolEmails(path: string = RAW_POOL_CSV_PATH): number {
  if (!existsSync(path)) return 0;
  try {
    const csvText = readFileSync(path, "utf8");
    const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true, delimiter: "," });
    const set = new Set<string>();
    for (const row of parsed.data) {
      const email = (row.email ?? "").trim().toLowerCase();
      if (email) set.add(email);
    }
    return set.size;
  } catch {
    return 0;
  }
}

// ── guard de MillionVerifier antes de --push (#4476/#4494 achados silent-failure-hunter) ─

export interface MvCoverage {
  /** verified.size + rejected.size + unknown.size — quantos do pool já
   * foram PROCESSADOS pela MV, independente do resultado. */
  processedCount: number;
  /** Tamanho do pool total (via `loadOriginScores`/`ORIGIN_SCORES_CSV_PATH`). */
  poolSize: number;
  /** #5183 — tamanho do pool BRUTO (`countRawPoolEmails`/`RAW_POOL_CSV_PATH`).
   * `undefined`/ausente (callers antigos) é tratado como `0` — nunca bloqueia
   * quem não passa este campo. Ver `countRawPoolEmails` pro racional. */
  rawPoolSize?: number;
}

/**
 * Pura — bloqueia `--push` com erro explícito a menos que (a) `argv`
 * contenha `--i-know-this-skips-mv`, ou (b) `coverage` mostra o pool
 * INTEIRO já processado pela MV (`processedCount >= poolSize > 0` — não
 * basta o arquivo existir, ver header do módulo "Guard de MV antes de
 * --push" pros 2 achados do #4494 que motivaram isto) E o pool BRUTO não é
 * maior que o pool computado que gerou `poolSize` (#5183 — senão o
 * denominador está desatualizado em relação a um refresh recente, mesmo que
 * a aritmética "bata" isoladamente). `coverage === null` (nenhuma
 * verificação disponível — arquivo ausente OU malformado, mesmo `null` que
 * `loadMvVerifiedEmails` devolve) sempre exige a flag. Nunca chamado em
 * dry-run — só quando `push=true` (`main()` abaixo).
 */
export function assertMvGuardAcknowledged(argv: string[], coverage: MvCoverage | null): void {
  if (hasFlag(argv, "i-know-this-skips-mv")) return;
  const rawPoolStale = coverage !== null && (coverage.rawPoolSize ?? 0) > coverage.poolSize;
  if (coverage !== null && coverage.poolSize > 0 && coverage.processedCount >= coverage.poolSize && !rawPoolStale) return;
  const detail = coverage === null
    ? "Nenhuma verificação MillionVerifier disponível (arquivo ausente ou malformado)"
    : rawPoolStale
      ? `Pool bruto (${coverage.rawPoolSize} e-mail(s), pending-scored.csv) maior que o pool computado ` +
        `(${coverage.poolSize} e-mail(s), pending-scored-computed.csv) — refresh-pending-pool.ts rodou mas ` +
        "score-pending-origin.ts/verify-pending-emails-mv.ts ainda não (#5183): o denominador de cobertura " +
        "está desatualizado, mesmo que a aritmética bata sozinha"
      : `Verificação MillionVerifier incompleta (${coverage.processedCount} de ${coverage.poolSize} e-mail(s) do pool processados)`;
  throw new Error(
    `${detail} (issue #4476 item 8) — rode scripts/verify-pending-emails-mv.ts sobre o pool INTEIRO ` +
      "ANTES do 1º envio real (bounce de contato não-verificado degrada a reputação do domínio/IP, mesmo " +
      "risco documentado no CLAUDE.md pra cohorts não-assinantes), ou passe --i-know-this-skips-mv pra " +
      "confirmar que você está ciente do risco e quer prosseguir mesmo assim.",
  );
}

// ── fila de tamanho fixo + backfill (#4476 item 5) ──────────────────────────

/**
 * Pura — quantos slots estão livres na fila, dado um `cap` (parâmetro
 * genérico; não lê config sozinha). Histórico (#4476 item 5, até 30/08/2026):
 * o cap era 300 (`brevo_diaria.daily_send_cap`), e o MESMO valor cobria tanto
 * o teto de ENVIO diário quanto o teto de CONTATOS ativos simultâneos — os
 * dois usos compartilhavam a mesma constante, por escolha de desenho.
 * **Desde #6793 "Faixa A" item 6 (30/08/2026, decisão do editor): os
 * call sites que gerenciam o teto de CONTATOS ativos passam
 * `Number.POSITIVE_INFINITY`** — o acoplamento com `daily_send_cap` acabou
 * PARA ESSE USO. **Correção #6940:** `daily_send_cap` NÃO segue vivo pro
 * teto de ENVIO diário (item 5 da mesma issue) — `checkDailySendCap` em
 * `publish-daily-brevo.ts` foi esvaziado no mesmo #6793 e hoje só lê o valor
 * sem gatear nada; os dois usos deixaram de existir como gate, não só de
 * compartilhar constante. `currentActiveCount` é
 * `store.contacts` com `status === "in_brevo"` (quem hoje ocupa um slot —
 * `promoted_beehiiv`/`suppressed`/`unsubscribed` já liberaram o deles).
 * Nunca negativo (população acima do cap por transição de config — ex: cap
 * reduzido depois do fato — não gera backfill negativo, só 0 slots livres).
 */
export function computeAvailableSlots(currentActiveCount: number, cap: number): number {
  return Math.max(0, cap - currentActiveCount);
}

/**
 * Pura (#4476 item 9) — aplica o circuit breaker de campanha por cima do
 * cálculo normal de slots: `rolloutPaused === true` (latch de
 * `scripts/lib/brevo-diaria-guardrail.ts`, bounce/spam/unsub agregado
 * cruzou o limiar) zera o backfill desta rodada, mesmo com slots livres —
 * "pausa o rollout inteiro" (issue #4476), não um ajuste parcial. Quando
 * `false`, devolve `availableSlots` sem alteração — a fila top-300 (item 5)
 * continua funcionando normalmente.
 */
export function applyRolloutGuardrailGate(availableSlots: number, rolloutPaused: boolean): number {
  return rolloutPaused ? 0 : availableSlots;
}

/**
 * Pura (#4637 item 2) — aplica o teto OPCIONAL que o editor escolhe no passo
 * de decisão de volume de `/diaria-brevo-diaria` (Passo 2, SKILL.md) por
 * cima do cálculo normal de slots livres (já passado pelo circuit breaker
 * acima, se aplicável). `maxAdd === undefined` (flag `--max-add` omitida)
 * preserva o comportamento antigo — preenche até o cap, sem teto extra.
 * `maxAdd` sempre CLAMPA pra baixo (nunca aumenta o backfill além do que os
 * slots livres já permitiam) e nunca fica negativo — `--max-add 0` é a
 * resposta "nenhum" da pergunta ao editor, um valor válido e distinto de
 * "flag ausente" (mesma disciplina de não colapsar os dois no mesmo
 * sentinela documentada em `getIntArg`, `lib/cli-args.ts`).
 */
export function applyMaxAddGate(availableSlots: number, maxAdd: number | undefined): number {
  if (maxAdd === undefined) return availableSlots;
  return Math.max(0, Math.min(availableSlots, maxAdd));
}

/**
 * Pura (#4631) — quantos contatos do store hoje ocupam um slot `in_brevo`,
 * EXCLUINDO `EDITOR_SEED_EMAILS` do numerador. Diferente de
 * `checkDailySendCap` (`publish-daily-brevo.ts`), este número já vinha
 * correto por CONSTRUÇÃO antes deste fix: `EDITOR_SEED_EMAILS` nunca são
 * ingeridos por este script (ficam vinculados à lista Brevo diretamente,
 * fora do fluxo `upsertIngested` — mesmo fato documentado em
 * `findOrphanContacts`, `evaluate-brevo-diaria.ts`), então o filtro abaixo
 * normalmente não remove ninguém do `store.contacts` real. A exclusão
 * explícita é defesa em profundidade (mesmo raciocínio de
 * `checkContactCountReconciliation`/#4532): se algum caminho futuro alguma
 * vez inserir um dos 5 endereços no store (ex: um deles aparecer Pending na
 * Beehiiv e ser ingerido normalmente), este helper garante que ele nunca
 * conte 2x contra o cap — sem depender só do invariante "nunca acontece".
 */
export function computeCurrentActiveCount(
  contacts: readonly BrevoDiariaContact[],
  seedEmails: readonly string[] = EDITOR_SEED_EMAILS,
): number {
  const seedSet = new Set(seedEmails.map((e) => normalizeEmail(e)));
  return contacts.filter((c) => c.status === "in_brevo" && !seedSet.has(normalizeEmail(c.email))).length;
}

/**
 * Pura — seleciona os próximos `availableSlots` candidatos a ingerir,
 * ORDENADOS pelo score de origem (#4476 item 4, maior primeiro). `scoreByEmail`
 * vem de `data/pending-reativacao/pending-scored-computed.csv`
 * (`scripts/score-pending-origin.ts`) — se `null` (arquivo ainda não gerado
 * nesta máquina), a seleção cai pra ordem original de chegada (paginação da
 * Beehiiv) — fail-soft: a fila ainda funciona sem o score, só sem
 * priorização até o arquivo existir. Candidato sem score individual
 * (email ausente do CSV, ex: cadastro novo que o CSV snapshot não capturou)
 * ordena por ÚLTIMO entre os que têm score (nunca na frente de um candidato
 * já pontuado — mais seguro assumir prioridade baixa que alta pra um dado
 * desconhecido).
 *
 * MillionVerifier (item 8 da issue #4476) é DELIBERADAMENTE fora do escopo
 * desta função especificamente — não que ninguém verifique (#4494 correção:
 * o parágrafo antigo aqui dizia isso, ficou desatualizado quando o filtro
 * de MV foi implementado). A verificação já aconteceu ANTES desta função
 * rodar: `candidates` (o `toIngest` passado pelo caller) já vem filtrado por
 * `computeContactsToIngest`, que exclui quem não está em `mv-verified.csv`.
 * Esta função só prioriza por SCORE entre quem já passou nesse filtro — não
 * verifica e-mail nenhum aqui porque não precisa, isso é responsabilidade de
 * uma etapa anterior no pipeline (`main()`), não desta.
 *
 * ## Lane de recência (#5183)
 *
 * `laneByEmail` (opcional — `null`/omitido preserva 100% o comportamento
 * antigo) identifica candidatos ingeridos por `refresh-pending-pool.ts`
 * (`lane === LANE_RECENCY`) — decisão do editor (briefing 260814): cadastro
 * Pending recente/orgânico é mais "quente" que o pool congelado de 2023, mas
 * NÃO deve competir numericamente contra o `score` dele (nunca foi medido
 * pela mesma fórmula — inventar um score comparável seria pior que não ter
 * nenhum). Em vez disso, a lane de recência preenche os slots PRIMEIRO (FIFO
 * entre si, sem novo critério de ordenação), e só o que sobrar de
 * `availableSlots` vai pro pool de score de sempre. Isso naturalmente NÃO
 * afoga o pool antigo, porque `refresh-pending-pool.ts` já limita quantos
 * contatos de lane de recência existem por rodada (`--limit`,
 * `DEFAULT_REFRESH_LIMIT` — tipicamente pequeno frente ao cap de 300).
 */
export function selectContactsForBackfill(
  candidates: PendingToIngestEntry[],
  availableSlots: number,
  scoreByEmail: Map<string, number> | null,
  laneByEmail: Map<string, string> | null = null,
): PendingToIngestEntry[] {
  if (availableSlots <= 0) return [];
  const recencyLane = laneByEmail ? candidates.filter((c) => laneByEmail.get(c.email) === LANE_RECENCY) : [];
  const rest = laneByEmail ? candidates.filter((c) => laneByEmail.get(c.email) !== LANE_RECENCY) : candidates;
  const orderedRest = scoreByEmail
    ? [...rest].sort((a, b) => {
        const sa = scoreByEmail.get(a.email);
        const sb = scoreByEmail.get(b.email);
        if (sa === undefined && sb === undefined) return 0;
        if (sa === undefined) return 1; // a sem score → depois de b
        if (sb === undefined) return -1; // b sem score → depois de a
        return sb - sa; // descendente
      })
    : rest; // sem mapa de score — mantém a ordem original (FIFO da paginação Beehiiv)
  return [...recencyLane, ...orderedRest].slice(0, availableSlots);
}

/**
 * I/O — lê `data/pending-reativacao/pending-scored-computed.csv`
 * (`scripts/score-pending-origin.ts` — issue #5183) e devolve `email → lane`.
 * Fail-soft: arquivo ausente/malformado → `null` (nunca lança) — mesmo
 * padrão de `loadOriginScores`; `selectContactsForBackfill` interpreta
 * `null` como "sem lane de recência disponível" (comportamento antigo).
 */
export function loadOriginLanes(path: string, log: (msg: string) => void = () => {}): Map<string, string> | null {
  if (!existsSync(path)) {
    log(`aviso: ${path} não encontrado — backfill sem lane de recência (#5183). Rode scripts/score-pending-origin.ts pra gerar.`);
    return null;
  }
  try {
    const csvText = readFileSync(path, "utf8");
    const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true, delimiter: "," });
    if (parsed.errors.length > 0) {
      log(`aviso: falha ao parsear ${path} — backfill sem lane de recência. Erros: ${JSON.stringify(parsed.errors.slice(0, 2))}`);
      return null;
    }
    const map = new Map<string, string>();
    for (const row of parsed.data) {
      const email = (row.email ?? "").trim().toLowerCase();
      if (email) map.set(email, (row.lane ?? "").trim());
    }
    return map;
  } catch (e) {
    log(`aviso: erro lendo ${path} — backfill sem lane de recência: ${(e as Error).message}`);
    return null;
  }
}

/**
 * I/O — lê o CSV emitido por `scripts/score-pending-origin.ts`
 * (`email,score,...`) e devolve `email → score`. Fail-soft: arquivo
 * ausente/malformado → `null` (nunca lança) — a seleção cai pro fallback
 * FIFO documentado em `selectContactsForBackfill`. Score sozinho não é
 * suficiente pra bloquear o backfill: a priorização é um refinamento, não um
 * pré-requisito de funcionamento.
 */
export function loadOriginScores(path: string, log: (msg: string) => void = () => {}): Map<string, number> | null {
  if (!existsSync(path)) {
    log(`aviso: ${path} não encontrado — backfill sem priorização por score (ordem FIFO). Rode scripts/score-pending-origin.ts pra gerar.`);
    return null;
  }
  try {
    const csvText = readFileSync(path, "utf8");
    const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true, delimiter: "," });
    if (parsed.errors.length > 0) {
      log(`aviso: falha ao parsear ${path} — backfill sem priorização por score. Erros: ${JSON.stringify(parsed.errors.slice(0, 2))}`);
      return null;
    }
    const map = new Map<string, number>();
    for (const row of parsed.data) {
      const email = (row.email ?? "").trim().toLowerCase();
      const score = Number(row.score);
      if (email && !Number.isNaN(score)) map.set(email, score);
    }
    return map;
  } catch (e) {
    log(`aviso: erro lendo ${path} — backfill sem priorização por score: ${(e as Error).message}`);
    return null;
  }
}

// ── aplicação (I/O — cria contato na Brevo + verifica por releitura) ───────

/**
 * Cria (ou atualiza — `updateEnabled: true`) o contato na lista Brevo
 * `brevo_diaria.list_id` e confirma por RELEITURA (mesma disciplina de
 * `applyApoioTagEntry` — nunca confiar só no 2xx do POST).
 */
export async function ingestContactToBrevo(
  apiKey: string,
  listId: number,
  email: string,
): Promise<void> {
  await brevoPost(apiKey, "/contacts", { email, listIds: [listId], updateEnabled: true });
  const check = await brevoGet(apiKey, `/contacts/${encodeURIComponent(email)}`);
  if (check.status !== 200) {
    throw new Error(`releitura pós-criação falhou pra ${email} (HTTP ${check.status}) — mutação não confirmada.`);
  }
  const listIds: unknown = check.body?.listIds;
  if (!Array.isArray(listIds) || !listIds.includes(listId)) {
    throw new Error(
      `releitura pós-criação NÃO confere pra ${email}: listIds=${JSON.stringify(listIds)}, esperado incluir ${listId}.`,
    );
  }
}

/**
 * Guard de store ausente (#5351 Parte A).
 *
 * O dedup que impede reingestão de contato já tratado (`in_brevo`,
 * `suppressed`, `unsubscribed`, `promoted_beehiiv`) vive inteiramente em
 * `data/brevo-diaria/contacts.json` (`computeContactsToIngest`). `readStore`
 * é fail-soft por design (#4266) e devolve store VAZIO, sem erro, quando o
 * arquivo não existe — correto pro caso legítimo de 1ª execução, mas
 * silenciosamente perigoso se o junction `data/` (OneDrive) não estiver
 * montado: o script reingeriria o pool Pending inteiro, contatos já
 * suprimidos/descadastrados/promovidos incluídos.
 *
 * Distinção deliberada: **arquivo ausente**, nunca "store vazio" — um store
 * que existe mas tem `contacts: []` (1ª execução real, arquivo já
 * inicializado) precisa prosseguir sem flag. Mesmo padrão do
 * `guard.requiredFile` de `Diaria-Brevo-Diaria-Evaluate`
 * (`scripts/lib/scheduled-tasks.ts`).
 *
 * Pura (recebe `existsSync`/flag como parâmetros) pra ser testável sem tocar
 * `data/` real.
 */
export function assertStoreFileGuard(
  storeExists: boolean,
  argv: string[],
  storePath: string,
): void {
  if (storeExists) return;
  if (hasFlag(argv, "allow-missing-store")) return;
  throw new Error(
    `store ausente (${storePath}) — provável junction data/ (OneDrive) não montada, ou sincronização ` +
      "pendente. Abortando ANTES de qualquer I/O externo pra não reingerir o pool Pending inteiro " +
      "(contatos já suprimidos/descadastrados/promovidos incluídos — dedup depende inteiramente deste " +
      "arquivo). Se esta é genuinamente a 1ª execução (arquivo nunca existiu), rode de novo com " +
      "--allow-missing-store.",
  );
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const log = (msg: string) => process.stderr.write(`[sync-pending-to-brevo] ${msg}\n`);

  // #5351 Parte A — guard ANTES de qualquer I/O externo (inclui os reads
  // locais de CSV logo abaixo, que são baratos mas não são o ponto — o que
  // importa é rodar antes do fetch da Beehiiv/Brevo).
  try {
    assertStoreFileGuard(existsSync(DEFAULT_STORE_PATH), argv, DEFAULT_STORE_PATH);
  } catch (e) {
    log(`ERRO: ${(e as Error).message}`);
    process.exit(2);
  }

  let maxAdd: number | undefined;
  try {
    maxAdd = getIntArg(argv, "max-add", { min: 0 });
  } catch (e) {
    log(`ERRO: ${(e as Error).message}`);
    process.exit(2);
  }

  // #4476/#4494 achados silent-failure-hunter: guard de MV ANTES de qualquer
  // I/O de rede — falha rápido, nunca deixa a paginação/backfill rodar pra
  // só então abortar. Todos os reads abaixo são locais (CSVs em data/),
  // preservando essa propriedade.
  const verifiedEmails = loadMvVerifiedEmails(MV_VERIFIED_CSV_PATH, log);
  const scoreByEmail = loadOriginScores(ORIGIN_SCORES_CSV_PATH, log);
  const laneByEmail = loadOriginLanes(ORIGIN_SCORES_CSV_PATH, log); // #5183
  const poolSize = scoreByEmail?.size ?? 0;
  const rawPoolSize = countRawPoolEmails(RAW_POOL_CSV_PATH); // #5183
  let coverage: MvCoverage | null = null;
  if (verifiedEmails !== null) {
    const rejectedEmails = loadEmailSetFromCsv(MV_REJECTED_CSV_PATH, "0 rejeitados considerados", log);
    const unknownEmails = loadEmailSetFromCsv(MV_UNKNOWN_CSV_PATH, "0 inconclusivos considerados", log);
    coverage = {
      processedCount: verifiedEmails.size + (rejectedEmails?.size ?? 0) + (unknownEmails?.size ?? 0),
      poolSize,
      rawPoolSize,
    };
  }
  // #4651: os process.exit() abaixo até o 1º `await` de rede
  // (fetchPendingBeehiivSubscriptions, mais adiante) ficam como estão de
  // propósito — nenhum fetch rodou ainda neste processo nestes pontos
  // (guard de MV + leitura de platform.config.json/env são só I/O local
  // síncrono), então não há socket keep-alive aberto que dispare o crash
  // libuv (UV_HANDLE_CLOSING) do #4638/#1401.
  const mvComplete = coverage !== null && coverage.poolSize > 0 && coverage.processedCount >= coverage.poolSize;
  if (push) {
    try {
      assertMvGuardAcknowledged(argv, coverage);
      if (!mvComplete) {
        log(
          "aviso: --i-know-this-skips-mv confirmado — ingestão SEM verificação MillionVerifier completa " +
            `(issue #4476 item 8${coverage ? `, ${coverage.processedCount}/${coverage.poolSize} processados` : ""}). ` +
            "Risco de bounce aceito explicitamente pelo operador.",
        );
      }
    } catch (e) {
      log(`ERRO: ${(e as Error).message}`);
      process.exit(2);
    }
  }

  // Review #6809 (P2, confiança alta): mesmo padrão de corrupção que crashou
  // check-brevo-diaria-guardrail.ts (#6799) — JSON.parse sem try/catch aqui
  // propagaria SyntaxError cru em vez de diagnóstico + exit(2) controlado.
  let platformConfig: PlatformConfig;
  try {
    platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as PlatformConfig;
  } catch (e) {
    log(
      `ERRO: platform.config.json não parseia como JSON válido (${(e as Error).message}) — ` +
        "config corrompida ou escrita parcial. Não é seguro prosseguir sem config válida.",
    );
    process.exit(2);
  }
  const brevoDiaria = platformConfig.brevo_diaria;
  if (!brevoDiaria) {
    log("ERRO: brevo_diaria não configurado em platform.config.json.");
    process.exit(2);
  }
  if (brevoDiaria!.list_id == null) {
    log("ERRO: brevo_diaria.list_id não definido em platform.config.json.");
    process.exit(2);
  }

  const { apiKey: beehiivApiKey, publicationId } = loadBeehiivConfig("[sync-pending-to-brevo]");

  const brevoApiKey = process.env[brevoDiaria!.api_key_env];
  if (push && !brevoApiKey) {
    log(`ERRO: ${brevoDiaria!.api_key_env} não definido no ambiente (necessário pra --push).`);
    process.exit(2);
  }

  log("buscando assinantes Pending na Beehiiv…");
  const pending = await fetchPendingBeehiivSubscriptions(publicationId, beehiivApiKey);
  log(`${pending.length} assinante(s) Pending encontrado(s).`);

  const store = readStore(DEFAULT_STORE_PATH);
  const toIngest = computeContactsToIngest(pending, store, verifiedEmails);
  log(
    `${toIngest.length} contato(s) novo(s) elegível(is) (dedup pelo store — ${store.contacts.length} já tratado(s)` +
      (verifiedEmails ? `; filtrado por ${verifiedEmails.size} e-mail(s) verificado(s) via MillionVerifier` : "; SEM filtro de MV — nenhuma verificação disponível") +
      `).`,
  );

  // #6793 "Faixa A" (30/08/2026, decisão do editor, item 6): freio
  // automático de VOLUME da fila removido — a fila `brevo_diaria` não tem
  // mais teto de contatos ativos simultâneos. `daily_send_cap` continua
  // existindo em platform.config.json e continua valendo pro cap de ENVIO
  // diário (item 5 da mesma issue, `checkDailySendCap` em
  // publish-daily-brevo.ts) — só o uso dele AQUI, como teto do TAMANHO da
  // fila, foi removido. `computeAvailableSlots` continua puro/testado com
  // o mesmo contrato de sempre; só o cap passado a ela mudou.
  const cap = Number.POSITIVE_INFINITY;
  const currentActiveCount = computeCurrentActiveCount(store.contacts); // #4631: exclui EDITOR_SEED_EMAILS
  const slotsBeforeGuardrail = computeAvailableSlots(currentActiveCount, cap);

  // #4476 item 9 — circuit breaker de campanha: bounce/spam/unsub agregado
  // furado pausa o backfill inteiro (latch, ver scripts/lib/brevo-diaria-guardrail.ts
  // + scripts/check-brevo-diaria-guardrail.ts), independente de slots livres.
  // Review #6809 (P2, confiança alta): sem `warn` aqui, um state file
  // corrompido cai no fail-soft silencioso de readRolloutGuardrailState —
  // se o rollout estava genuinamente PAUSADO quando o arquivo corrompeu, o
  // reset pra "nunca pausado" libera o backfill sem nenhum log, exatamente
  // o risco que o guardrail existe pra prevenir (#6799).
  const guardrailState = readRolloutGuardrailState(undefined, log);
  const slotsAfterGuardrail = applyRolloutGuardrailGate(slotsBeforeGuardrail, guardrailState.rollout_paused);
  if (guardrailState.rollout_paused) {
    log(
      `AVISO: rollout PAUSADO pelo circuit breaker de campanha (#4476 item 9) desde ${guardrailState.paused_at} — ` +
        `backfill ZERADO nesta rodada (seriam ${slotsBeforeGuardrail} slot(s) livre(s) sem a pausa). ` +
        `Motivo: ${guardrailState.paused_reason?.join("; ") ?? "desconhecido"}. ` +
        "Rode 'npx tsx scripts/check-brevo-diaria-guardrail.ts --unpause' após investigar.",
    );
  }
  // #4637 item 2 — teto opcional do editor (--max-add), por cima do circuit breaker.
  const availableSlots = applyMaxAddGate(slotsAfterGuardrail, maxAdd);
  if (maxAdd !== undefined) {
    log(
      `--max-add ${maxAdd} aplicado: ${slotsAfterGuardrail} slot(s) livre(s) → ${availableSlots} slot(s) ` +
        "efetivo(s) pro backfill desta rodada (teto escolhido pelo editor no passo de decisão de volume).",
    );
  }
  log(`fila: ${currentActiveCount} ocupados, sem teto (#6793) — ${availableSlots} slot(s) livre(s) pro backfill.`);

  const selected = selectContactsForBackfill(toIngest, availableSlots, scoreByEmail, laneByEmail);
  log(`${selected.length} contato(s) selecionado(s) pra este backfill (de ${toIngest.length} elegíveis, ordenados por score).`);

  if (!push) {
    for (const c of selected) log(`  + ${c.email} (sub ${c.beehiiv_subscription_id})`);
    log("dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar.");
    return;
  }

  let nextStore = store;
  let applied = 0;
  let failed = 0;
  for (const c of selected) {
    try {
      await ingestContactToBrevo(brevoApiKey!, brevoDiaria!.list_id as number, c.email);
      nextStore = upsertIngested(nextStore, c);
      applied++;
    } catch (e) {
      failed++;
      log(`FALHA em ${c.email}: ${(e as Error).message}`);
    }
  }
  writeStore(nextStore, DEFAULT_STORE_PATH);
  log(`push concluído: ${applied} ingerido(s), ${failed} falha(s).`);
  // Windows fix (#4651, mesma classe do #4638/#1401): fetchPendingBeehiivSubscriptions
  // (incondicional, mais acima) já garante um await fetch antes deste ponto — e,
  // no caminho normal com `selected` não-vazio, o loop `ingestContactToBrevo`
  // acima também faz fetch — de qualquer forma, process.exit() arriscaria o
  // crash libuv (UV_HANDLE_CLOSING) com sockets keep-alive ainda abertos.
  if (failed > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sync-pending-to-brevo] erro fatal: ${(e as Error).message}\n`);
    // Windows fix (#4651): main() pode lançar depois de já ter feito await
    // fetch — mesma razão do bloco acima.
    process.exitCode = 1;
  });
}
