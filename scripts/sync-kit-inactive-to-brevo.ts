#!/usr/bin/env node
/**
 * scripts/sync-kit-inactive-to-brevo.ts (#6340 item 3)
 *
 * Análogo de `sync-pending-to-brevo.ts`, trocando a fonte: em vez do
 * segmento Pending da Beehiiv, lê o cohort `inactive` do Kit
 * (`GET /v4/subscribers?status=inactive`, via `listAllKitSubscribers` de
 * `scripts/lib/kit-subscribers.ts`) — assinantes que os Workers (`poll`
 * primeiro, PR #6479) criam com `state: "inactive"` quando o double opt-in
 * do #6340 (item 1) está ativo pra aquele Worker, e que ainda não
 * confirmaram via `KIT_DOI_FORM_ID`.
 *
 * ## Reuso deliberado do resto da maquinaria (#6340 item 3, texto literal
 * da issue: "reusando o resto da maquinaria — store, MV, fila,
 * promoção/supressão")
 *
 * - **Store**: MESMO `data/brevo-diaria/contacts.json`
 *   (`scripts/lib/brevo-diaria-store.ts`) que `sync-pending-to-brevo.ts` já
 *   usa — não um store paralelo. Um contato Kit-inactive ingerido aqui e um
 *   contato Beehiiv-pending ingerido lá competem pelo MESMO teto de fila
 *   (`brevo_diaria.daily_send_cap`) e passam pela MESMA avaliação de
 *   engajamento em `evaluate-brevo-diaria.ts` — nenhuma mudança nesse script
 *   foi necessária (a issue #6340 marca isso como "deliberadamente fora
 *   desta unidade, por risco": item 4, promoção Kit→active, ainda depende
 *   do #6339/tocaria `evaluate-brevo-diaria.ts` diretamente).
 * - **Convenção de origem sintética no `beehiiv_subscription_id`**: o campo
 *   é nomeado para a origem Beehiiv (`BrevoDiariaContact.beehiiv_subscription_id:
 *   string`, obrigatório), mas já existem 2 precedentes de uso para origem
 *   NÃO-Beehiiv sem alterar o schema — `import-curated-batch-brevo.ts`
 *   (`curated:${email}`) e `sunset-dead-subscribers.ts` (`sunset:${email}`).
 *   Este script segue o mesmo padrão: `kit:${kit_subscriber_id}`. Isso evita
 *   tocar `brevo-diaria-store.ts`/`evaluate-brevo-diaria.ts` (ambos usados
 *   por `evaluate-brevo-diaria.ts`, fora de escopo por decisão da própria
 *   issue) só para acomodar uma 2ª origem.
 * - **Fila de tamanho fixo + circuit breaker de campanha**: reusa
 *   `computeAvailableSlots`/`applyRolloutGuardrailGate`/`applyMaxAddGate`/
 *   `computeCurrentActiveCount`/`ingestContactToBrevo`/`assertStoreFileGuard`
 *   diretamente de `sync-pending-to-brevo.ts` (já exportados) — nenhuma
 *   reimplementação. `selectContactsForBackfill` também é reusada, mas SEM
 *   priorização por score/lane de recência (`scoreByEmail`/`laneByEmail`
 *   passados como `null`): o pool Kit-inactive é da ordem de unidades/dia
 *   (texto da issue), então FIFO já é suficiente e evita depender de
 *   `score-pending-origin.ts` (que só existe pro pool Beehiiv legado).
 * - **MillionVerifier**: reusa `loadMvVerifiedEmails`/`assertMvGuardAcknowledged`/
 *   `MvCoverage` (mesmo mecanismo, mesma flag `--i-know-this-skips-mv`),
 *   apontando pra um CSV DEDICADO (`KIT_INACTIVE_MV_VERIFIED_CSV_PATH`,
 *   `data/kit-inativos-reativacao/mv-verified.csv`) — não o CSV do pool
 *   Beehiiv (populações diferentes, verificação não é intercambiável).
 *   **Nenhum script `verify-kit-inactive-emails-mv.ts` foi criado nesta
 *   unidade** (fora do escopo do item 3, que pede só "alimentar o Brevo a
 *   partir do cohort inactive") — até que exista, `--push` sempre exige
 *   `--i-know-this-skips-mv` (mesmo comportamento do pool Beehiiv antes do
 *   #4476 item 8 existir). A COBERTURA usada aqui é simplificada em relação
 *   ao par Beehiiv: `processedCount = verifiedEmails.size` (sem quebrar em
 *   rejected/unknown) — aceitável porque, sem o verify script, o cenário
 *   normal é `verifiedEmails === null` (guard exige a flag de qualquer
 *   jeito); a granularidade fina só importa quando o CSV existe de verdade.
 *
 * ## O que NÃO é reusado, de propósito
 *
 * - Sem score/lane de recência (`loadOriginScores`/`loadOriginLanes`) — não
 *   existe fonte de score pro pool Kit; ver acima.
 * - Sem `--max-add`/circuit breaker NOVOS — os já existentes (compartilhados
 *   com `sync-pending-to-brevo.ts` via `platform.config.json.brevo_diaria` e
 *   `data/brevo-diaria/guardrail-state.json`) já bastam, e duplicar um 2º
 *   circuit breaker paralelo criaria dois latches divergentes pro mesmo
 *   canal de envio.
 *
 * ## Guard de publicação
 *
 * Mesma disciplina do par Beehiiv: `--push` nunca rodou com efeito real
 * nesta sessão (guard de publicação do overnight/develop — scripts que
 * tocam Brevo/Kit ao vivo não rodam a partir de sessão autônoma). Validado
 * só via testes com fetch/Kit mockados.
 *
 * ## Gate do editor (#6340, comentário 28/08/2026)
 *
 * "o double opt-in altera quem recebe o quê — aprovação explícita do editor
 * antes de ativar. Implementação e e-mail de confirmação podem ser
 * preparados sem gate; a ativação, não." Este script É a implementação
 * (preparada); RODAR `--push` de verdade é a ativação, e segue fora do
 * alcance de qualquer sessão autônoma até o editor decidir (mesmo guard de
 * publicação de sempre).
 *
 * ## Uso
 *
 *   npx tsx scripts/sync-kit-inactive-to-brevo.ts              # dry-run (default)
 *   npx tsx scripts/sync-kit-inactive-to-brevo.ts --push --i-know-this-skips-mv
 *   npx tsx scripts/sync-kit-inactive-to-brevo.ts --push --max-add 5
 *
 * Env: KIT_API_KEY (leitura) + platform.config.json → brevo_diaria.api_key_env (escrita).
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, getIntArg } from "./lib/cli-args.ts";
import { listAllKitSubscribers, type KitSubscriberSummary } from "./lib/kit-subscribers.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { readRolloutGuardrailState } from "./lib/brevo-diaria-guardrail.ts";
import {
  readStore,
  writeStore,
  upsertIngested,
  normalizeEmail,
  DEFAULT_STORE_PATH,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";
import {
  computeAvailableSlots,
  applyRolloutGuardrailGate,
  applyMaxAddGate,
  computeCurrentActiveCount,
  ingestContactToBrevo,
  assertStoreFileGuard,
  loadMvVerifiedEmails,
  assertMvGuardAcknowledged,
  selectContactsForBackfill,
  type MvCoverage,
  type PendingToIngestEntry,
} from "./sync-pending-to-brevo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** #6340 item 3 — pool dedicado, distinto de `data/pending-reativacao/`
 *  (populações diferentes: Kit `inactive` vs. Beehiiv Pending). Ver docstring
 *  do módulo, seção MillionVerifier, sobre por que ainda não existe um
 *  script que popula este arquivo. */
export const KIT_INACTIVE_MV_VERIFIED_CSV_PATH = resolve(ROOT, "data/kit-inativos-reativacao/mv-verified.csv");

interface BrevoDiariaConfig {
  api_key_env: string;
  list_id: number | null;
  daily_send_cap?: number;
}
interface PlatformConfig {
  brevo_diaria?: BrevoDiariaConfig;
}

/** Mesmo fallback de `sync-pending-to-brevo.ts::DEFAULT_QUEUE_CAP`. */
const DEFAULT_QUEUE_CAP = 300;

// ── leitura do Kit + diff puro (mesma forma de `computeContactsToIngest`) ──

export interface KitInactiveSubscriber {
  kit_subscriber_id: number;
  email: string;
}

/**
 * Pura — traduz o shape cru do Kit (`KitSubscriberSummary`) pro shape mínimo
 * que este script precisa, normalizando o e-mail (mesma convenção do resto
 * do repo, `normalizeEmail`).
 */
export function mapKitInactiveSubscribers(subs: readonly KitSubscriberSummary[]): KitInactiveSubscriber[] {
  return subs.map((s) => ({ kit_subscriber_id: s.id, email: normalizeEmail(s.email_address) }));
}

/**
 * Pura — análoga a `computeContactsToIngest` (sync-pending-to-brevo.ts), mas
 * sobre o shape Kit. Mesma regra de dedup (pelo STORE — `data/brevo-diaria/
 * contacts.json`, nunca pelo Kit, mesma decisão de design documentada lá) e
 * mesmo filtro opcional de MillionVerifier. `beehiiv_subscription_id` da
 * entry devolvida usa o prefixo sintético `kit:` (ver docstring do módulo).
 */
export function computeKitContactsToIngest(
  inactive: readonly KitInactiveSubscriber[],
  store: BrevoDiariaStore,
  verifiedEmails: Set<string> | null = null,
): PendingToIngestEntry[] {
  const known = new Set(store.contacts.map((c) => c.email));
  const out: PendingToIngestEntry[] = [];
  const seen = new Set<string>();
  for (const s of inactive) {
    if (known.has(s.email) || seen.has(s.email)) continue;
    if (verifiedEmails && !verifiedEmails.has(s.email)) continue;
    seen.add(s.email);
    out.push({ email: s.email, beehiiv_subscription_id: `kit:${s.kit_subscriber_id}` });
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const log = (msg: string) => process.stderr.write(`[sync-kit-inactive-to-brevo] ${msg}\n`);

  // #5351 Parte A (reusado do par Beehiiv) — guard ANTES de qualquer I/O externo.
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

  const verifiedEmails = loadMvVerifiedEmails(KIT_INACTIVE_MV_VERIFIED_CSV_PATH, log);

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    log(`ERRO: ${kitConfigResult.reason}`);
    process.exit(2);
  }

  const platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as PlatformConfig;
  const brevoDiaria = platformConfig.brevo_diaria;
  if (!brevoDiaria) {
    log("ERRO: brevo_diaria não configurado em platform.config.json.");
    process.exit(2);
  }
  if (brevoDiaria!.list_id == null) {
    log("ERRO: brevo_diaria.list_id não definido em platform.config.json.");
    process.exit(2);
  }

  const brevoApiKey = process.env[brevoDiaria!.api_key_env];
  if (push && !brevoApiKey) {
    log(`ERRO: ${brevoDiaria!.api_key_env} não definido no ambiente (necessário pra --push).`);
    process.exit(2);
  }

  log("buscando assinantes inactive no Kit…");
  const rawInactive = await listAllKitSubscribers(kitConfigResult.config, { status: "inactive" });
  const inactive = mapKitInactiveSubscribers(rawInactive);
  log(`${inactive.length} assinante(s) inactive encontrado(s) no Kit.`);

  // Coverage simplificada (ver docstring do módulo — sem verify script Kit-
  // específico ainda, `processedCount` não distingue rejected/unknown).
  const poolSize = inactive.length;
  const coverage: MvCoverage | null =
    verifiedEmails !== null ? { processedCount: verifiedEmails.size, poolSize } : null;
  const mvComplete = coverage !== null && coverage.poolSize > 0 && coverage.processedCount >= coverage.poolSize;
  if (push) {
    try {
      assertMvGuardAcknowledged(argv, coverage);
      if (!mvComplete) {
        log(
          "aviso: --i-know-this-skips-mv confirmado — ingestão SEM verificação MillionVerifier completa " +
            `(#6340 item 3${coverage ? `, ${coverage.processedCount}/${coverage.poolSize} processados` : ""}). ` +
            "Risco de bounce aceito explicitamente pelo operador.",
        );
      }
    } catch (e) {
      log(`ERRO: ${(e as Error).message}`);
      process.exit(2);
    }
  }

  const store = readStore(DEFAULT_STORE_PATH);
  const toIngest = computeKitContactsToIngest(inactive, store, verifiedEmails);
  log(
    `${toIngest.length} contato(s) novo(s) elegível(is) (dedup pelo store compartilhado — ${store.contacts.length} já tratado(s)` +
      (verifiedEmails
        ? `; filtrado por ${verifiedEmails.size} e-mail(s) verificado(s) via MillionVerifier`
        : "; SEM filtro de MV — nenhuma verificação disponível") +
      `).`,
  );

  // Fila compartilhada com sync-pending-to-brevo.ts (mesmo store/cap/circuit
  // breaker) — ver docstring do módulo.
  const cap = brevoDiaria!.daily_send_cap ?? DEFAULT_QUEUE_CAP;
  const currentActiveCount = computeCurrentActiveCount(store.contacts);
  const slotsBeforeGuardrail = computeAvailableSlots(currentActiveCount, cap);

  const guardrailState = readRolloutGuardrailState();
  const slotsAfterGuardrail = applyRolloutGuardrailGate(slotsBeforeGuardrail, guardrailState.rollout_paused);
  if (guardrailState.rollout_paused) {
    log(
      `AVISO: rollout PAUSADO pelo circuit breaker de campanha (compartilhado com sync-pending-to-brevo.ts) desde ${guardrailState.paused_at} — ` +
        `backfill ZERADO nesta rodada (seriam ${slotsBeforeGuardrail} slot(s) livre(s) sem a pausa). ` +
        `Motivo: ${guardrailState.paused_reason?.join("; ") ?? "desconhecido"}. ` +
        "Rode 'npx tsx scripts/check-brevo-diaria-guardrail.ts --unpause' após investigar.",
    );
  }
  const availableSlots = applyMaxAddGate(slotsAfterGuardrail, maxAdd);
  if (maxAdd !== undefined) {
    log(
      `--max-add ${maxAdd} aplicado: ${slotsAfterGuardrail} slot(s) livre(s) → ${availableSlots} slot(s) efetivo(s) pro backfill desta rodada.`,
    );
  }
  log(`fila (compartilhada): ${currentActiveCount}/${cap} ocupados, ${availableSlots} slot(s) livre(s) pro backfill.`);

  // Sem score/lane — pool Kit-inactive é pequeno (unidades/dia), FIFO basta.
  const selected = selectContactsForBackfill(toIngest, availableSlots, null, null);
  log(`${selected.length} contato(s) selecionado(s) pra este backfill (de ${toIngest.length} elegíveis, ordem FIFO).`);

  if (!push) {
    for (const c of selected) log(`  + ${c.email} (${c.beehiiv_subscription_id})`);
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
  if (failed > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sync-kit-inactive-to-brevo] erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
