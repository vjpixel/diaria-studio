#!/usr/bin/env node
/**
 * scripts/evaluate-brevo-diaria.ts (#4266, item 4/5 do plano da issue)
 *
 * Avaliação periódica dos contatos `in_brevo` do canal Brevo próprio do
 * editor: recomputa o score (`computeBrevoDiariaScore`,
 * `scripts/lib/shared/brevo-diaria-score.ts`) e aplica a decisão do editor
 * (sessão /diaria-develop 260731):
 *
 *   score >= 60  → promove pra Beehiiv (lista confirmada)
 *   score <= -30 → suprime (para de receber, `emailBlacklisted: true` na
 *                  Brevo — NUNCA deletado, mesma semântica de "suprimido,
 *                  marcado como tal" da decisão)
 *   caso contrário → mantém, só atualiza contadores/score
 *
 * ## Passo extra: auto-confirmação (fecha gap registrado na própria issue)
 *
 * ANTES de avaliar o score, cada contato `in_brevo` tem seu status Beehiiv
 * atual reconferido (`GET .../subscriptions/by_email/{email}`). Se a pessoa
 * confirmou o double opt-in por conta própria nesse meio-tempo (`status:
 * "active"`), ela é promovida por auto-confirmação (`applySelfConfirmed`),
 * independente do score — a issue #4266 registrou esse cenário como risco
 * de duplicidade NÃO resolvido pelo desenho original ("quem confirma o
 * opt-in depois de já ter recebido via Brevo passa a estar nas duas
 * bases"); esta rotina fecha o gap na primeira oportunidade (próxima
 * avaliação), não deixando o duplo envio se perpetuar indefinidamente.
 *
 * ## Fonte dos contadores (opens_count/sends_count)
 *
 * `GET /v3/contacts/{email}` da Brevo retorna `statistics.messagesSent` e
 * `statistics.opened` — arrays com 1 entrada por (campanha × evento). Um
 * mesmo contato pode ter múltiplas entradas `opened` pra UMA campanha
 * (reabriu o mesmo email); `computeCountsFromBrevoStatistics` deduplica por
 * `campaignId` — a fórmula é "quantas campanhas abriu" / "quantas recebeu",
 * não "quantos eventos de abertura", mesmo espírito de `sends_count`/
 * `opens_count` da Clarice (contagem por envio, não por evento bruto).
 *
 * ## Promoção pra Beehiiv — ASSUNÇÃO NÃO VERIFICADA AO VIVO
 *
 * `promoteBeehiivSubscription` chama `POST /publications/{id}/subscriptions`
 * com `{email, reactivate_existing: true, send_welcome_email: false}` — o
 * padrão documentado da API pública da Beehiiv pra (re)criar uma
 * subscription. Como o double opt-in da publicação pode estar HABILITADO
 * (é o motivo do contato estar "Pending" em primeiro lugar), não há garantia
 * de que este POST force o status pra `active` sem uma nova confirmação por
 * email — isso NUNCA foi testado contra a conta real (sem credenciais nesta
 * sessão, guard de publicação #1 do checklist de dispatch). Se a
 * verificação pós-escrita (`verifyPromotedToBeehiiv`, releitura de
 * `by_email`) mostrar que o status continua `pending`, o script LOGA um
 * warning explícito e NÃO remove o contato da Brevo (mantém `in_brevo`) —
 * fail-safe: mais vale continuar entregando pelo canal que funciona do que
 * assumir sucesso e cortar a única entrega confirmada.
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
 * qualquer classe: checagem de status Beehiiv, fetch de contadores Brevo,
 * promoção, supressão, ou verificação pós-escrita não confirmada) sempre
 * incrementa `failed` e o processo sai com `exit(1)` ao final — nunca
 * silenciosamente reportado como sucesso (#738).
 *
 * ## Uso
 *
 *   npx tsx scripts/evaluate-brevo-diaria.ts           # dry-run (default)
 *   npx tsx scripts/evaluate-brevo-diaria.ts --push     # aplica promoções/supressões
 *
 * Como do PR #4398 (260731), `--push` ainda não foi rodado ao vivo (guard de
 * publicação, ver `context/overnight-dispatch-rules.md` #1) — validado só via
 * testes com fetch mockado. Nota datada, não afirmação permanente: reler o
 * histórico de commits antes de assumir que isso ainda vale.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { brevoGet, brevoPut } from "./lib/brevo-client.ts";
import {
  computeBrevoDiariaScore,
  classifyBrevoDiariaAction,
  type BrevoDiariaAction,
} from "./lib/shared/brevo-diaria-score.ts";
import {
  readStore,
  writeStore,
  applyEvaluation,
  applySelfConfirmed,
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

export function computeCountsFromBrevoStatistics(
  statistics: BrevoContactStatistics | undefined,
): { sends_count: number; opens_count: number } {
  return {
    sends_count: uniqueCampaignIds(statistics?.messagesSent),
    opens_count: uniqueCampaignIds(statistics?.opened),
  };
}

/** I/O — `GET /contacts/{email}` e extrai os contadores. */
export async function fetchBrevoContactCounts(
  apiKey: string,
  email: string,
): Promise<{ sends_count: number; opens_count: number }> {
  const res = await brevoGet(apiKey, `/contacts/${encodeURIComponent(email)}`);
  if (res.status !== 200) {
    throw new Error(`GET /contacts/${email} falhou (HTTP ${res.status}) — não foi possível ler estatísticas.`);
  }
  return computeCountsFromBrevoStatistics(res.body?.statistics);
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
  opens_count: number;
  sends_count: number;
  score: number;
  action: BrevoDiariaAction;
}

/** Pura — combina contadores frescos + fórmula/threshold num veredito só. */
export function evaluateContact(counts: { opens_count: number; sends_count: number }): Omit<ContactEvaluation, "email"> {
  const score = computeBrevoDiariaScore(counts);
  return { ...counts, score, action: classifyBrevoDiariaAction(score) };
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
 * Releitura pós-promoção — `true` só se o status NÃO for mais `pending`.
 * Fail-safe: se ainda pending (double opt-in não confirmado pelo POST),
 * o caller mantém o contato `in_brevo` em vez de cortar a única entrega
 * confirmada (ver disclaimer no cabeçalho).
 */
export async function verifyPromotedToBeehiiv(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const status = await fetchBeehiivSubscriptionStatus(publicationId, apiKey, email, fetchImpl);
  return status !== null && status !== "pending";
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

export interface RunEvaluationResult {
  store: BrevoDiariaStore;
  selfConfirmed: number;
  promoted: number;
  suppressed: number;
  kept: number;
  /**
   * Conta QUALQUER anomalia por contato: falha transitória de API (checagem
   * de status Beehiiv, fetch de contadores, promoção, supressão) OU
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

  let selfConfirmed = 0;
  let promoted = 0;
  let suppressed = 0;
  let kept = 0;
  let failed = 0;

  for (const contact of contacts) {
    try {
      // 1) auto-confirmação — sempre checada primeiro, independente do score.
      let statusCheckFailed = false;
      const beehiivStatus = await fetchBeehiivSubscriptionStatus(publicationId, beehiivApiKey, contact.email).catch((e) => {
        log(`warn: falha ao checar status Beehiiv de ${contact.email}: ${(e as Error).message}`);
        statusCheckFailed = true;
        return undefined;
      });
      if (statusCheckFailed) failed++;

      if (beehiivStatus === "active") {
        log(`${contact.email}: já ativo na Beehiiv (auto-confirmação) → promovido, sem depender do score.`);
        selfConfirmed++;
        if (push) {
          await unlinkFromBrevoList(brevoApiKey!, listId, contact.email);
          store = applySelfConfirmed(store, contact.email);
        }
        continue;
      }

      // 2) score
      const counts = push
        ? await fetchBrevoContactCounts(brevoApiKey!, contact.email)
        : { opens_count: contact.opens_count, sends_count: contact.sends_count };
      const evalResult = evaluateContact(counts);
      log(`${contact.email}: score=${evalResult.score} (${counts.opens_count} aberto(s)/${counts.sends_count} enviado(s)) → ${evalResult.action}`);

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
          store = applyEvaluation(store, contact.email, { ...counts, score: evalResult.score, action: "keep" });
          continue;
        }
        await unlinkFromBrevoList(brevoApiKey!, listId, contact.email);
        store = applyEvaluation(store, contact.email, { ...counts, score: evalResult.score, action: "promote_to_beehiiv" });
      } else if (evalResult.action === "suppress") {
        await suppressInBrevo(brevoApiKey!, contact.email);
        await unlinkFromBrevoList(brevoApiKey!, listId, contact.email);
        const suppressConfirmed = await verifySuppressedInBrevo(brevoApiKey!, listId, contact.email);
        if (!suppressConfirmed) {
          log(`warn: ${contact.email} supressão/desvinculação não confirmada na Brevo — mantendo in_brevo (fail-safe).`);
          failed++;
          store = applyEvaluation(store, contact.email, { ...counts, score: evalResult.score, action: "keep" });
          continue;
        }
        store = applyEvaluation(store, contact.email, { ...counts, score: evalResult.score, action: "suppress" });
      } else {
        store = applyEvaluation(store, contact.email, { ...counts, score: evalResult.score, action: "keep" });
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

  return { store, selfConfirmed, promoted, suppressed, kept, failed };
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
    `resumo: ${result.selfConfirmed} auto-confirmado(s), ${result.promoted} promovido(s) por score, ` +
      `${result.suppressed} suprimido(s), ${result.kept} mantido(s), ${result.failed} falha(s).`,
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
