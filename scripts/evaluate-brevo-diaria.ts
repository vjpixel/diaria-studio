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
 * ## Uso
 *
 *   npx tsx scripts/evaluate-brevo-diaria.ts           # dry-run (default)
 *   npx tsx scripts/evaluate-brevo-diaria.ts --push     # aplica promoções/supressões
 *
 * **NUNCA executado com --push nesta sessão** (guard de publicação). Validado
 * só via testes com fetch mockado.
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

/** Suprime na Brevo — `emailBlacklisted: true`, NUNCA deleta (decisão do editor). */
export async function suppressInBrevo(apiKey: string, email: string): Promise<void> {
  await brevoPut(apiKey, `/contacts/${encodeURIComponent(email)}`, { emailBlacklisted: true });
}

/** Desvincula da lista Brevo (contato promovido não precisa mais deste canal). */
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

  let store = readStore(DEFAULT_STORE_PATH);
  const inBrevo: BrevoDiariaContact[] = store.contacts.filter((c) => c.status === "in_brevo");
  log(`${inBrevo.length} contato(s) in_brevo a avaliar.`);

  let selfConfirmed = 0;
  let promoted = 0;
  let suppressed = 0;
  let kept = 0;

  for (const contact of inBrevo) {
    // 1) auto-confirmação — sempre checada primeiro, independente do score.
    const beehiivStatus = await fetchBeehiivSubscriptionStatus(publicationId, beehiivApiKey, contact.email).catch((e) => {
      log(`warn: falha ao checar status Beehiiv de ${contact.email}: ${(e as Error).message}`);
      return undefined;
    });
    if (beehiivStatus === "active") {
      log(`${contact.email}: já ativo na Beehiiv (auto-confirmação) → promovido, sem depender do score.`);
      selfConfirmed++;
      if (push) {
        await unlinkFromBrevoList(brevoApiKey!, brevoDiaria.list_id as number, contact.email);
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
        store = applyEvaluation(store, contact.email, { ...counts, score: evalResult.score, action: "keep" });
        continue;
      }
      await unlinkFromBrevoList(brevoApiKey!, brevoDiaria.list_id as number, contact.email);
      store = applyEvaluation(store, contact.email, { ...counts, score: evalResult.score, action: "promote_to_beehiiv" });
    } else if (evalResult.action === "suppress") {
      await suppressInBrevo(brevoApiKey!, contact.email);
      store = applyEvaluation(store, contact.email, { ...counts, score: evalResult.score, action: "suppress" });
    } else {
      store = applyEvaluation(store, contact.email, { ...counts, score: evalResult.score, action: "keep" });
    }
  }

  log(
    `resumo: ${selfConfirmed} auto-confirmado(s), ${promoted} promovido(s) por score, ` +
      `${suppressed} suprimido(s), ${kept} mantido(s).`,
  );

  if (!push) {
    log("dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar.");
    return;
  }
  writeStore(store, DEFAULT_STORE_PATH);
  log("push concluído — store atualizado.");
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[evaluate-brevo-diaria] erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
