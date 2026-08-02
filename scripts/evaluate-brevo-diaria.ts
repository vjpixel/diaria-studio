#!/usr/bin/env node
/**
 * scripts/evaluate-brevo-diaria.ts (#4266, item 4/5 do plano da issue;
 * fórmula de saída e checagem de descadastro nativo reescritas no #4476;
 * threshold de supressão corrigido pra n>=3 + janela de maturação de 48h
 * implementada no self-review pós-merge da issue #4476)
 *
 * Avaliação periódica dos contatos `in_brevo` do canal Brevo próprio do
 * editor: recomputa a TAXA de abertura (`computeBrevoDiariaOpenRate`,
 * `scripts/lib/shared/brevo-diaria-score.ts`) e aplica a decisão do editor
 * (issue #4476, item 1 — substitui a fórmula aditiva original do #4266):
 *
 *   sends_count>=2 E openRate>=50% (INSTANTÂNEO) → promove pra Beehiiv
 *                  (lista confirmada)
 *   sends_count>=3 E openRate<=20% (só envios MADUROS, >=48h — ver "Passo
 *                  2b" abaixo) → suprime (para de receber, `emailBlacklisted:
 *                  true` na Brevo — NUNCA deletado, mesma semântica de
 *                  "suprimido, marcado como tal")
 *   caso contrário (inclusive piso de amostra não atingido) → mantém, só
 *                  atualiza contadores/taxa
 *
 * ## Passo 0: descadastro NATIVO (#4476 item 7) — checado ANTES de tudo
 *
 * Antes até da auto-confirmação, cada contato `in_brevo` tem seu estado
 * Brevo atual lido (`fetchBrevoContactState`). Se `emailBlacklisted` já é
 * `true` (a pessoa clicou no link de opt-out nativo do bloco de intro — ver
 * `context/snippets/brevo-diaria-pending-intro.md`), isso é uma 3ª saída
 * TERMINAL distinta de `suppressed` (que é decisão ALGORÍTMICA por
 * engajamento baixo) — `applyNativeUnsubscribe` marca o motivo
 * separadamente (`resolution_reason: "native_unsubscribe"`) e libera o slot
 * da fila IMEDIATAMENTE, sem esperar o piso de amostra da supressão
 * algorítmica (n>=3). O MESMO `GET /contacts/{email}` que confirma
 * `emailBlacklisted` já retorna `statistics` — reusado como fonte dos
 * contadores do passo 2 (score), então isto NÃO introduz uma 2ª chamada à
 * Brevo por contato; é estritamente um passo a mais de leitura do MESMO
 * corpo de resposta, feito mais cedo no loop.
 *
 * ## Passo 1: auto-confirmação (fecha gap registrado na própria issue #4266)
 *
 * Em seguida, cada contato `in_brevo` tem seu status Beehiiv atual
 * reconferido (`GET .../subscriptions/by_email/{email}`). Se a pessoa
 * confirmou o double opt-in por conta própria nesse meio-tempo (`status:
 * "active"`), ela é promovida por auto-confirmação (`applySelfConfirmed`),
 * independente da taxa de abertura — a issue #4266 registrou esse cenário
 * como risco de duplicidade NÃO resolvido pelo desenho original ("quem
 * confirma o opt-in depois de já ter recebido via Brevo passa a estar nas
 * duas bases"); esta rotina fecha o gap na primeira oportunidade (próxima
 * avaliação), não deixando o duplo envio se perpetuar indefinidamente.
 *
 * ## Passo 2: score (taxa de abertura + piso de amostra, 2 variantes)
 *
 * `GET /v3/contacts/{email}` da Brevo retorna `statistics.messagesSent` e
 * `statistics.opened` — arrays com 1 entrada por (campanha × evento). Um
 * mesmo contato pode ter múltiplas entradas `opened` pra UMA campanha
 * (reabriu o mesmo email); `computeCountsFromBrevoStatistics` deduplica por
 * `campaignId` — a fórmula é "quantas campanhas abriu" / "quantas recebeu",
 * não "quantos eventos de abertura", mesmo espírito de `sends_count`/
 * `opens_count` da Clarice (contagem por envio, não por evento bruto).
 *
 * ## Passo 2b: janela de maturação de 48h (issue #4476, só pra SUPRESSÃO)
 *
 * Cada entrada de `statistics.messagesSent`/`opened` carrega timestamp
 * próprio (`eventTime`/`messageSentTime`/`date`/`time` — mesmos campos que
 * `scripts/lib/brevo-stats.ts::latestEventTime` já usa pra popular
 * `last_sent_at`/`last_open_at` no store da Clarice, confirmados AO VIVO como
 * preenchidos corretamente pra `messagesSent`/`opened`, ver memória de sessão
 * 260801 "Cliques do store Clarice: não é sync defasado" — só `clicked`
 * precisou do fallback aninhado em `links[]`, adicionado no #4429).
 * `computeMatureCountsFromBrevoStatistics` reusa esse mesmo parsing
 * (`eventTimestampMs`, exportado de `brevo-stats.ts` nesta correção) pra
 * filtrar `messagesSent` a só os envios com >=48h de idade (baseado no
 * timestamp do PRÓPRIO envio, não da abertura) — `opens_count` maduro conta
 * só aberturas cujo envio correspondente já é maduro. Entrada sem timestamp
 * parseável é tratada como IMATURA (fail-safe: mais seguro excluir da conta
 * de supressão um envio de idade desconhecida do que arriscar suprimir com
 * base em dado que pode não ter tido tempo de ser aberto ainda).
 *
 * `classifyBrevoDiariaAction` (`brevo-diaria-score.ts`) recebe os DOIS
 * conjuntos de contadores (`instant` — todos os envios, avalia promoção;
 * `mature` — só >=48h, avalia supressão) e nunca mistura um no lugar do
 * outro. O `open_rate`/`opens_count`/`sends_count` REPORTADOS e persistidos
 * no store continuam sendo os INSTANTÂNEOS — a janela de maturação é
 * invisível pro que o editor vê como "taxa atual", só afeta a decisão
 * interna de supressão.
 *
 * ## Duas vias de promoção em paralelo — clique OU score (#4476 item 2)
 *
 * Esta rotina é a via de SCORE. A via de CLIQUE (link de confirmação
 * personalizado, item 3 da issue) roda por fora, num Worker (ver
 * `workers/reativar/`), e ativa a subscription Beehiiv diretamente. As duas
 * vias NUNCA colidem por construção: o passo 1 (auto-confirmação) acima
 * checa o status REAL da Beehiiv antes de avaliar qualquer score — se o
 * clique já promoveu a pessoa, o passo 1 já a marca `promoted_beehiiv` por
 * auto-confirmação e o `continue` pula a avaliação de score inteiramente
 * (a via de score nunca tenta promover de novo quem já foi promovido pela
 * via de clique).
 *
 * ## Promoção pra Beehiiv — ASSUNÇÃO NÃO VERIFICADA AO VIVO (via score)
 *
 * `promoteBeehiivSubscription` chama `POST /publications/{id}/subscriptions`
 * com `{email, reactivate_existing: true, send_welcome_email: false}` — o
 * padrão documentado da API pública da Beehiiv pra (re)criar uma
 * subscription. Como o double opt-in da publicação pode estar HABILITADO
 * (é o motivo do contato estar "Pending" em primeiro lugar), não há garantia
 * de que este POST force o status pra `active` sem uma nova confirmação por
 * email. Se a verificação pós-escrita (`verifyPromotedToBeehiiv`, releitura
 * de `by_email`) mostrar que o status continua `pending`, o script LOGA um
 * warning explícito e NÃO remove o contato da Brevo (mantém `in_brevo`) —
 * fail-safe: mais vale continuar entregando pelo canal que funciona do que
 * assumir sucesso e cortar a única entrega confirmada.
 *
 * **Esta ressalva vale IGUALMENTE pras duas vias (score E clique) — não é
 * exclusiva desta.** Correção de um overclaim anterior deste comentário
 * (comment-analyzer, achado pós-merge #4476): o teste ao vivo do item 3 (2
 * contatos sintéticos, ver PR do #4476) ficou INCONCLUSIVO pra pergunta
 * central de `reactivate_existing:true` — os 2 contatos caíram em
 * `status:"invalid"` (domínio flagado disposable) antes de chegar em
 * `pending`, então a transição `pending → active` nunca foi de fato
 * exercida em nenhuma das duas vias. O que o teste confirmou (e vale pras
 * DUAS vias, porque ambas chamam o mesmo endpoint com o mesmo payload) foi
 * só que HTTP 2xx no POST não garante `status:"active"` — daí a checagem
 * explícita em `verifyPromotedToBeehiiv` abaixo. Nem score nem clique têm a
 * hipótese central confirmada contra um contato Pending genuíno; ver
 * `workers/reativar/README.md` pro texto fixo dessa ressalva.
 *
 * ## Falha por contato não aborta o run (#4398 review — silent-failure-hunter
 * + code-reviewer + pr-test-analyzer convergiram independentemente)
 *
 * Cada contato do loop principal roda dentro do seu próprio try/catch —
 * diferente de `sync-pending-to-brevo.ts` cujo padrão este módulo agora
 * espelha. Uma falha transitória de API (Brevo ou Beehiiv) num contato NUNCA
 * aborta o run inteiro: é contada em `failed`, logada, e o loop segue pro
 * próximo contato. `writeStore()` roda uma vez ao final, mas como o `store`
 * é acumulado em memória a cada sucesso e o loop nunca é abortado por uma
 * exceção não-tratada, todo progresso de contatos já processados no mesmo
 * run é persistido mesmo quando outro contato falha no meio. Falha (de
 * qualquer classe: checagem de estado Brevo, checagem de status Beehiiv,
 * promoção, supressão, ou verificação pós-escrita não confirmada) sempre
 * incrementa `failed` e o processo sai com `exit(1)` ao final — nunca
 * silenciosamente reportado como sucesso (#738). Falha no passo 0 (estado
 * Brevo) faz o contato pular pra próxima rodada inteiro (`continue` sem
 * avaliar auto-confirmação/score com dado incompleto) — mais seguro que
 * decidir com informação parcial.
 *
 * ## Uso
 *
 *   npx tsx scripts/evaluate-brevo-diaria.ts           # dry-run (default)
 *   npx tsx scripts/evaluate-brevo-diaria.ts --push     # aplica promoções/supressões
 *
 * Como do PR #4398 (260731), `--push` ainda não foi rodado ao vivo pra vias
 * de score/supressão (guard de publicação, ver
 * `context/overnight-dispatch-rules.md` #1) — validado só via testes com
 * fetch mockado. Nota datada, não afirmação permanente: reler o histórico de
 * commits antes de assumir que isso ainda vale.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { brevoGet, brevoPut } from "./lib/brevo-client.ts";
import { eventTimestampMs } from "./lib/brevo-stats.ts";
import {
  computeBrevoDiariaOpenRate,
  classifyBrevoDiariaAction,
  BREVO_DIARIA_MATURATION_HOURS,
  type BrevoDiariaAction,
  type BrevoDiariaRateInput,
} from "./lib/shared/brevo-diaria-score.ts";
import {
  readStore,
  writeStore,
  applyEvaluation,
  applySelfConfirmed,
  applyNativeUnsubscribe,
  DEFAULT_STORE_PATH,
  type BrevoDiariaContact,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface BrevoDiariaConfig {
  api_key_env: string;
  list_id: number | null;
}
interface PlatformConfig {
  brevo_diaria?: BrevoDiariaConfig;
}

// ── contadores a partir da estatística de contato da Brevo (puro) ─────────

interface BrevoStatEvent {
  campaignId?: unknown;
}
export interface BrevoContactStatistics {
  messagesSent?: BrevoStatEvent[];
  opened?: BrevoStatEvent[];
}

/** Pura — dedup por campaignId (uma campanha reaberta várias vezes conta 1x). */
function uniqueCampaignIds(events: BrevoStatEvent[] | undefined): number {
  if (!Array.isArray(events)) return 0;
  const ids = new Set(events.map((e) => e.campaignId).filter((v) => v !== undefined));
  return ids.size;
}

/** Contadores INSTANTÂNEOS — todos os envios/aberturas, sem filtro de idade.
 * Único input usado pra avaliar PROMOÇÃO (ver `classifyBrevoDiariaAction`). */
export function computeCountsFromBrevoStatistics(
  statistics: BrevoContactStatistics | undefined,
): BrevoDiariaRateInput {
  return {
    sends_count: uniqueCampaignIds(statistics?.messagesSent),
    opens_count: uniqueCampaignIds(statistics?.opened),
  };
}

const MATURATION_MS = BREVO_DIARIA_MATURATION_HOURS * 60 * 60 * 1000;

/**
 * Pura — como `computeCountsFromBrevoStatistics`, mas filtra `messagesSent`/
 * `opened` a só envios MADUROS (>=48h de idade, issue #4476 "Janela de
 * maturação") — usado EXCLUSIVAMENTE pra avaliar SUPRESSÃO. A maturidade é
 * decidida pelo timestamp do PRÓPRIO envio (`eventTimestampMs` de uma
 * entrada de `messagesSent`), não da abertura: um envio de 10 dias atrás
 * continua maduro mesmo que tenha sido aberto ontem. `opens_count` maduro
 * conta só aberturas cujo `campaignId` está no conjunto de envios maduros —
 * nunca uma abertura "solta" sem o envio correspondente já confirmado maduro.
 *
 * Entrada sem timestamp parseável (`eventTimestampMs` retorna `null`) é
 * tratada como IMATURA — fail-safe: mais seguro excluir da conta de
 * supressão um envio de idade desconhecida do que arriscar contar como
 * "não abriu" um envio que pode não ter tido tempo de ser aberto ainda.
 *
 * `nowMs` injetável pra teste (default `Date.now()` — nunca real em teste,
 * #633).
 */
export function computeMatureCountsFromBrevoStatistics(
  statistics: BrevoContactStatistics | undefined,
  nowMs: number = Date.now(),
): BrevoDiariaRateInput {
  const sentEvents = Array.isArray(statistics?.messagesSent) ? statistics!.messagesSent! : [];
  const matureCampaignIds = new Set<unknown>();
  for (const e of sentEvents) {
    if (e?.campaignId === undefined) continue;
    const ts = eventTimestampMs(e);
    if (ts === null) continue; // timestamp desconhecido → imaturo, fail-safe
    if (nowMs - ts >= MATURATION_MS) matureCampaignIds.add(e.campaignId);
  }
  const openedEvents = Array.isArray(statistics?.opened) ? statistics!.opened! : [];
  const openedMatureIds = new Set<unknown>();
  for (const e of openedEvents) {
    if (e?.campaignId !== undefined && matureCampaignIds.has(e.campaignId)) {
      openedMatureIds.add(e.campaignId);
    }
  }
  return { sends_count: matureCampaignIds.size, opens_count: openedMatureIds.size };
}

/**
 * I/O — `GET /contacts/{email}` UMA vez, extrai contadores (instantâneos E
 * maduros) + `emailBlacklisted` (#4476 item 7). Fonte única pro passo 0
 * (descadastro nativo) E pro passo 2 (score) — nunca 2 GETs pro mesmo
 * contato no mesmo run.
 */
export interface BrevoContactState {
  /** Instantâneo — todos os envios, usado pra avaliar/reportar promoção. */
  sends_count: number;
  opens_count: number;
  /** Maduro (>=48h) — usado EXCLUSIVAMENTE pra avaliar supressão. */
  mature_sends_count: number;
  mature_opens_count: number;
  emailBlacklisted: boolean;
}

export async function fetchBrevoContactState(apiKey: string, email: string): Promise<BrevoContactState> {
  const res = await brevoGet(apiKey, `/contacts/${encodeURIComponent(email)}`);
  if (res.status !== 200) {
    throw new Error(`GET /contacts/${email} falhou (HTTP ${res.status}) — não foi possível ler estado.`);
  }
  const counts = computeCountsFromBrevoStatistics(res.body?.statistics);
  const mature = computeMatureCountsFromBrevoStatistics(res.body?.statistics);
  return {
    ...counts,
    mature_sends_count: mature.sends_count,
    mature_opens_count: mature.opens_count,
    emailBlacklisted: res.body?.emailBlacklisted === true,
  };
}

// ── status Beehiiv atual (auto-confirmação) ────────────────────────────────

/** I/O — status atual da subscription na Beehiiv (`null` se 404 — não encontrada). */
export async function fetchBeehiivSubscriptionStatus(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await fetchImpl(
    `${beehiivApiBase()}/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}?`,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Beehiiv API ${res.status} em subscriptions/by_email/${email}`);
  const body = (await res.json()) as { data?: { status?: string } };
  return body.data?.status ?? null;
}

// ── decisão pura por contato ────────────────────────────────────────────

export interface ContactEvaluation {
  email: string;
  /** Instantâneos — reportados/persistidos no store (o editor vê a taxa
   * ATUAL, não a recortada pela janela de maturação). */
  opens_count: number;
  sends_count: number;
  open_rate: number;
  action: BrevoDiariaAction;
}

export interface EvaluateContactCounts {
  /** Todos os envios, sem filtro de idade — avalia PROMOÇÃO, é o par
   * reportado/persistido. */
  instant: BrevoDiariaRateInput;
  /** Só envios com >=48h de idade — avalia SUPRESSÃO (issue #4476, "Janela
   * de maturação"). */
  mature: BrevoDiariaRateInput;
}

/** Pura — combina contadores frescos (instantâneos + maduros) + fórmula/
 * threshold num veredito só. `open_rate`/`opens_count`/`sends_count`
 * retornados são sempre os INSTANTÂNEOS — a janela de maturação afeta só a
 * decisão interna de supressão (`classifyBrevoDiariaAction`), nunca o que é
 * reportado/persistido. */
export function evaluateContact(counts: EvaluateContactCounts): Omit<ContactEvaluation, "email"> {
  const open_rate = computeBrevoDiariaOpenRate(counts.instant);
  return { ...counts.instant, open_rate, action: classifyBrevoDiariaAction(counts) };
}

// ── aplicação (I/O) ─────────────────────────────────────────────────────

/**
 * Suprime na Brevo — `emailBlacklisted: true`, NUNCA deleta (decisão do
 * editor). NÃO desvincula da lista sozinho (ver `unlinkFromBrevoList`,
 * chamada separadamente pelo caller — mesma composição do caminho de
 * promoção) — #4398 review: sem o unlink, `totalSubscribers` da lista
 * (consumido por `checkDailySendCap` em `publish-daily-brevo.ts`) infla
 * indefinidamente conforme supressões acumulam, eventualmente bloqueando
 * envios mesmo com a população `in_brevo` real bem abaixo do cap.
 */
export async function suppressInBrevo(apiKey: string, email: string): Promise<void> {
  await brevoPut(apiKey, `/contacts/${encodeURIComponent(email)}`, { emailBlacklisted: true });
}

/** Desvincula da lista Brevo (contato promovido/suprimido não precisa mais deste canal). */
export async function unlinkFromBrevoList(apiKey: string, listId: number, email: string): Promise<void> {
  await brevoPut(apiKey, `/contacts/${encodeURIComponent(email)}`, { unlinkListIds: [listId] });
}

/** (Re)cria a subscription na Beehiiv — ver disclaimer no cabeçalho do módulo. */
export async function promoteBeehiivSubscription(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${beehiivApiBase()}/publications/${publicationId}/subscriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ email, reactivate_existing: true, send_welcome_email: false }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Beehiiv API POST /subscriptions falhou pra ${email} (HTTP ${res.status}): ${text}`);
  }
}

/**
 * Releitura pós-promoção — `true` SÓ se o status for exatamente `active`.
 * Fail-safe: se ainda pending (double opt-in não confirmado pelo POST) OU
 * qualquer outro status não-`active`, o caller mantém o contato `in_brevo`
 * em vez de cortar a única entrega confirmada (ver disclaimer no cabeçalho).
 *
 * #4476 item 3 — corrigido a partir do teste ao vivo do link de confirmação
 * personalizado: a checagem original (`status !== "pending"`) tratava
 * QUALQUER status diferente de "pending" como confirmado — incluindo
 * `"invalid"`, que o teste ao vivo mostrou ser um resultado REAL e possível
 * de `POST .../subscriptions` com `reactivate_existing:true` (Beehiiv aceita
 * o POST com 201 mesmo quando a validação de e-mail/domínio rejeita o
 * contato, deixando `status:"invalid"` — nem `pending`, nem `active`). Sob a
 * checagem antiga, esse caso seria erroneamente reportado como promoção
 * bem-sucedida. `"active"` explícito é a única semântica correta de
 * "confirmado" — request/response exato documentado no PR do #4476.
 */
export async function verifyPromotedToBeehiiv(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const status = await fetchBeehiivSubscriptionStatus(publicationId, apiKey, email, fetchImpl);
  return status === "active";
}

/**
 * Releitura pós-supressão (#4398 review: `suppressInBrevo`/`unlinkFromBrevoList`
 * dependiam só do PUT não lançar, diferente de `ingestContactToBrevo`/
 * `verifyPromotedToBeehiiv`, que sempre releem antes de confiar no sucesso —
 * precedente documentado: a Beehiiv já aceitou um PATCH com 200 ignorando a
 * escrita silenciosamente, ver `sync-apoio-nivel-beehiiv.ts`). Como
 * `applyEvaluation` move o contato pra um status TERMINAL (`suppressed`) que
 * o loop nunca mais reavalia, uma falha silenciosa aqui seria permanente —
 * `true` só se `emailBlacklisted` estiver confirmado E o contato não constar
 * mais na lista (`listId`). O caller mantém o contato em `in_brevo`
 * (fail-safe, mesmo padrão de `verifyPromotedToBeehiiv`) se isto retornar
 * `false`.
 */
export async function verifySuppressedInBrevo(apiKey: string, listId: number, email: string): Promise<boolean> {
  const res = await brevoGet(apiKey, `/contacts/${encodeURIComponent(email)}`);
  if (res.status !== 200) return false;
  const blacklisted = res.body?.emailBlacklisted === true;
  const listIds: unknown = res.body?.listIds;
  const stillInList = Array.isArray(listIds) && listIds.includes(listId);
  return blacklisted && !stillInList;
}

// ── orquestração testável (#4398 review — pr-test-analyzer: main() precisa
// de uma função extraída pra ser testável sem mockar env/platform.config.json
// inteiros) ─────────────────────────────────────────────────────────────

export interface RunEvaluationParams {
  contacts: BrevoDiariaContact[];
  store: BrevoDiariaStore;
  push: boolean;
  publicationId: string;
  beehiivApiKey: string;
  /** Só obrigatória quando `push=true` (mesmo contrato do main() original). */
  brevoApiKey?: string;
  listId: number;
  log: (msg: string) => void;
}

/**
 * Contadores desta rodada — NÃO são uma partição exaustiva/mutuamente
 * exclusiva do total de contatos processados, apesar do que os nomes
 * sugerem (achado opcional #4476, type-design-analyzer): um mesmo contato
 * pode incrementar `promoted`/`suppressed` E `failed` no mesmo run (ex: a
 * avaliação decide `promote_to_beehiiv`, incrementa `promoted`, mas a
 * verificação pós-escrita falha — incrementa `failed` TAMBÉM e reverte pra
 * `keep` no store; ver o teste "push: suppress cuja releitura NÃO confirma"
 * em `test/evaluate-brevo-diaria-4266.test.ts`, que confirma
 * `suppressed===1` E `failed===1` no MESMO resultado). Somar todos os campos
 * não bate com `contacts.length`.
 */
export interface RunEvaluationResult {
  store: BrevoDiariaStore;
  /** #4476 item 7 — descadastro nativo detectado (saída terminal distinta de `suppressed`). */
  unsubscribedNative: number;
  selfConfirmed: number;
  promoted: number;
  suppressed: number;
  kept: number;
  /**
   * Conta QUALQUER anomalia por contato: falha transitória de API (checagem
   * de estado Brevo, checagem de status Beehiiv, promoção, supressão) OU
   * verificação pós-escrita que não confirma (mantido em `in_brevo` por
   * fail-safe). Nunca um não-evento silencioso (#738) — o caller (main())
   * usa isto pra decidir o exit code.
   */
  failed: number;
}

/**
 * Roda a avaliação sobre a lista de contatos `in_brevo` já dada (sem I/O de
 * env/config/disco — isso é responsabilidade do `main()`). Falha por contato
 * NUNCA aborta a função inteira: cada contato roda no próprio try/catch,
 * contado em `failed` e logado, seguindo pro próximo — mesmo padrão de
 * `sync-pending-to-brevo.ts`. O `store` retornado acumula todo progresso dos
 * contatos processados com sucesso, mesmo quando outro contato no meio falha.
 */
export async function runEvaluation(params: RunEvaluationParams): Promise<RunEvaluationResult> {
  const { contacts, push, publicationId, beehiivApiKey, brevoApiKey, listId, log } = params;
  let store = params.store;

  let unsubscribedNative = 0;
  let selfConfirmed = 0;
  let promoted = 0;
  let suppressed = 0;
  let kept = 0;
  let failed = 0;

  for (const contact of contacts) {
    try {
      // 0) descadastro NATIVO (#4476 item 7) — checado ANTES de qualquer
      // outra avaliação. Requer brevoApiKey (ausente em dry-run sem o env
      // configurado) — best-effort: sem a key, este passo é pulado (dry-run
      // ainda funciona pra preview do resto via contadores já no store).
      let nativeState: BrevoContactState | undefined;
      if (brevoApiKey) {
        try {
          nativeState = await fetchBrevoContactState(brevoApiKey, contact.email);
        } catch (e) {
          log(`warn: falha ao checar estado Brevo de ${contact.email}: ${(e as Error).message}`);
          failed++;
          // Sem estado confiável — não decide com dado incompleto, tenta de
          // novo na próxima rodada. Não passa pra auto-confirmação/score.
          continue;
        }
        if (nativeState.emailBlacklisted) {
          log(`${contact.email}: já descadastrado (emailBlacklisted) na Brevo → saída nativa, libera slot imediatamente.`);
          unsubscribedNative++;
          if (push) {
            await unlinkFromBrevoList(brevoApiKey, listId, contact.email);
            store = applyNativeUnsubscribe(store, contact.email);
          }
          continue;
        }
      }

      // 1) auto-confirmação — sempre checada, independente da taxa de abertura.
      let statusCheckFailed = false;
      const beehiivStatus = await fetchBeehiivSubscriptionStatus(publicationId, beehiivApiKey, contact.email).catch((e) => {
        log(`warn: falha ao checar status Beehiiv de ${contact.email}: ${(e as Error).message}`);
        statusCheckFailed = true;
        return undefined;
      });
      if (statusCheckFailed) failed++;

      if (beehiivStatus === "active") {
        log(`${contact.email}: já ativo na Beehiiv (auto-confirmação) → promovido, sem depender da taxa de abertura.`);
        selfConfirmed++;
        if (push) {
          await unlinkFromBrevoList(brevoApiKey!, listId, contact.email);
          store = applySelfConfirmed(store, contact.email);
        }
        continue;
      }

      // 2) taxa de abertura + piso de amostra (#4476 item 1), em 2 variantes
      // (instantânea pra promoção, madura >=48h pra supressão — #4476
      // "Janela de maturação"). Reusa `nativeState` (passo 0) quando
      // disponível — nunca um 2º GET pro mesmo contato no mesmo run.
      //
      // Fallback SEM `nativeState` (só ocorre com `brevoApiKey` ausente —
      // dry-run sem a key configurada; `--push` sempre exige a key, ver
      // main()): usa os contadores já persistidos no store pros dois papéis
      // (instant=mature) — limitação DOCUMENTADA e aceita, não um bug: sem
      // uma leitura fresca da Brevo não há timestamp por evento pra calcular
      // maturidade de verdade, e este caminho nunca aplica supressão de
      // qualquer forma (push sempre tem brevoApiKey). Só afeta o PREVIEW de
      // dry-run sem key configurada.
      const counts: EvaluateContactCounts = nativeState
        ? {
            instant: { opens_count: nativeState.opens_count, sends_count: nativeState.sends_count },
            mature: { opens_count: nativeState.mature_opens_count, sends_count: nativeState.mature_sends_count },
          }
        : {
            instant: { opens_count: contact.opens_count, sends_count: contact.sends_count },
            mature: { opens_count: contact.opens_count, sends_count: contact.sends_count },
          };
      const evalResult = evaluateContact(counts);
      log(
        `${contact.email}: openRate=${(evalResult.open_rate * 100).toFixed(1)}% ` +
          `(${counts.instant.opens_count} aberto(s)/${counts.instant.sends_count} enviado(s), ` +
          `${counts.mature.opens_count}/${counts.mature.sends_count} maduro(s) p/ supressão) → ${evalResult.action}`,
      );

      if (evalResult.action === "promote_to_beehiiv") promoted++;
      else if (evalResult.action === "suppress") suppressed++;
      else kept++;

      if (!push) continue;

      if (evalResult.action === "promote_to_beehiiv") {
        await promoteBeehiivSubscription(publicationId, beehiivApiKey, contact.email);
        const confirmed = await verifyPromotedToBeehiiv(publicationId, beehiivApiKey, contact.email);
        if (!confirmed) {
          log(`warn: ${contact.email} continua "pending" na Beehiiv após promoção — mantendo in_brevo (fail-safe).`);
          failed++;
          store = applyEvaluation(store, contact.email, { ...counts.instant, open_rate: evalResult.open_rate, action: "keep" });
          continue;
        }
        await unlinkFromBrevoList(brevoApiKey!, listId, contact.email);
        store = applyEvaluation(store, contact.email, { ...counts.instant, open_rate: evalResult.open_rate, action: "promote_to_beehiiv" });
      } else if (evalResult.action === "suppress") {
        await suppressInBrevo(brevoApiKey!, contact.email);
        await unlinkFromBrevoList(brevoApiKey!, listId, contact.email);
        const suppressConfirmed = await verifySuppressedInBrevo(brevoApiKey!, listId, contact.email);
        if (!suppressConfirmed) {
          log(`warn: ${contact.email} supressão/desvinculação não confirmada na Brevo — mantendo in_brevo (fail-safe).`);
          failed++;
          store = applyEvaluation(store, contact.email, { ...counts.instant, open_rate: evalResult.open_rate, action: "keep" });
          continue;
        }
        store = applyEvaluation(store, contact.email, { ...counts.instant, open_rate: evalResult.open_rate, action: "suppress" });
      } else {
        store = applyEvaluation(store, contact.email, { ...counts.instant, open_rate: evalResult.open_rate, action: "keep" });
      }
    } catch (e) {
      // #4398 review (fix 1): falha transitória de API num contato NUNCA
      // aborta o run inteiro — segue pro próximo, progresso já acumulado em
      // `store` (contatos processados com sucesso antes deste) persiste no
      // `writeStore()` final, mesmo padrão de `sync-pending-to-brevo.ts`.
      failed++;
      log(`FALHA em ${contact.email}: ${(e as Error).message}`);
    }
  }

  return { store, unsubscribedNative, selfConfirmed, promoted, suppressed, kept, failed };
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const log = (msg: string) => process.stderr.write(`[evaluate-brevo-diaria] ${msg}\n`);

  const platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as PlatformConfig;
  const brevoDiaria = platformConfig.brevo_diaria;
  if (!brevoDiaria || brevoDiaria.list_id == null) {
    log("ERRO: brevo_diaria não configurado (ou list_id ausente) em platform.config.json.");
    process.exit(2);
  }
  const { apiKey: beehiivApiKey, publicationId } = loadBeehiivConfig("[evaluate-brevo-diaria]");
  const brevoApiKey = process.env[brevoDiaria.api_key_env];
  if (push && !brevoApiKey) {
    log(`ERRO: ${brevoDiaria.api_key_env} não definido no ambiente (necessário pra --push).`);
    process.exit(2);
  }

  const store = readStore(DEFAULT_STORE_PATH);
  const inBrevo: BrevoDiariaContact[] = store.contacts.filter((c) => c.status === "in_brevo");
  log(`${inBrevo.length} contato(s) in_brevo a avaliar.`);

  const result = await runEvaluation({
    contacts: inBrevo,
    store,
    push,
    publicationId,
    beehiivApiKey,
    brevoApiKey,
    listId: brevoDiaria.list_id as number,
    log,
  });

  log(
    `resumo: ${result.unsubscribedNative} descadastrado(s) nativamente, ${result.selfConfirmed} auto-confirmado(s), ` +
      `${result.promoted} promovido(s) por taxa de abertura, ${result.suppressed} suprimido(s), ` +
      `${result.kept} mantido(s), ${result.failed} falha(s).`,
  );

  if (!push) {
    log("dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar.");
    if (result.failed > 0) process.exit(1);
    return;
  }
  writeStore(result.store, DEFAULT_STORE_PATH);
  log("push concluído — store atualizado.");
  if (result.failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[evaluate-brevo-diaria] erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
