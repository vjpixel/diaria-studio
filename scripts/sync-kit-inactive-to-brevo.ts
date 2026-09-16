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
 *   foi necessária **para o item 3** (a issue #6340 marcava a promoção
 *   Kit→active como "deliberadamente fora desta unidade, por risco": item
 *   4, que tocaria `evaluate-brevo-diaria.ts` diretamente). **O item 4 foi
 *   implementado depois, em unidade separada** — `runEvaluation` Passo 1
 *   (auto-confirmação) roteia por origem via `parseKitSubscriberId`: um
 *   contato com `beehiiv_subscription_id` prefixado `kit:` (como os que
 *   este script ingere) que vira `active` no Kit sai da fila do Brevo sem
 *   depender da taxa de abertura, mesmo tratamento terminal que a
 *   auto-confirmação Beehiiv já tinha. Ver o comentário `#6340 item 4` em
 *   `evaluate-brevo-diaria.ts` pro mecanismo completo.
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
 * - **MillionVerifier (#8192)**: `scripts/verify-kit-inactive-emails-mv.ts`
 *   verifica o pool antes deste script rodar, com checkpoint próprio
 *   (`KIT_INACTIVE_MV_CHECKPOINT_PATH`, `data/kit-inativos-reativacao/.mv-cache.json`).
 *   A cobertura é medida sobre o pool DESTA rodada (candidatos fora do
 *   store), direto do checkpoint: `processedCount` = candidatos com qualquer
 *   resultado, e só os `ok`/`catch_all` entram — inclusive com cobertura
 *   parcial (ingere o subconjunto verificado; o resto espera a próxima
 *   rodada, ver `decideKitIngestion`). E-mail rejeitado/inconclusivo nunca
 *   é ingerido. `--i-know-this-skips-mv` (uso manual) ignora o filtro.
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
 * ## Corte de 72h (#8192)
 *
 * Só entra quem recebeu o e-mail de confirmação do Kit há ≥72h
 * (`selectKitInactivePastDoiWindow`, `lib/kit-inactive-reativacao.ts` — o
 * mesmo filtro do verify MV). Endereços de sonda/teste
 * (`kit-fixture-patterns.ts`) ficam de fora.
 *
 * ## Gate do editor (#6340, comentário 28/08/2026)
 *
 * "o double opt-in altera quem recebe o quê — aprovação explícita do editor
 * antes de ativar. Implementação e e-mail de confirmação podem ser
 * preparados sem gate; a ativação, não." Este script É a implementação
 * (preparada); RODAR `--push` de verdade é a ativação, e segue fora do
 * alcance de qualquer sessão autônoma até o editor decidir (mesmo guard de
 * publicação de sempre). **Decidido em #8192 (16/09/2026):** o editor pediu
 * que este pool passe a receber via Brevo — o script entrou no
 * `brevo-diaria-run.ts --apply` (Etapa 5, automático).
 *
 * ## Uso
 *
 *   npx tsx scripts/sync-kit-inactive-to-brevo.ts              # dry-run (default)
 *   npx tsx scripts/sync-kit-inactive-to-brevo.ts --push   # exige verify-kit-inactive-emails-mv.ts antes
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
  selectContactsForBackfill,
  type MvCoverage,
  type PendingToIngestEntry,
} from "./sync-pending-to-brevo.ts";
import { buildOrigin } from "./lib/shared/brevo-diaria-origin.ts"; // #6678
import { selectKitInactivePastDoiWindow, formatKitInactiveSelection } from "./lib/kit-inactive-reativacao.ts"; // #8192
import { classifyResult, loadCheckpoint } from "./verify-pending-emails-mv.ts";
import { KIT_INACTIVE_MV_CHECKPOINT_PATH } from "./verify-kit-inactive-emails-mv.ts";
// #6340 item 4 fix D — importa a constante do prefixo do módulo canônico shared/
// (brevo-diaria-origin.ts) em vez de do evaluate-brevo-diaria.ts: ambos (produtor
// aqui e consumidor em evaluate-brevo-diaria.ts) referenciam a MESMA constante
// canônica (`evaluate-brevo-diaria.ts` re-exporta `KIT_ORIGIN_ID_PREFIX =
// ORIGIN_PREFIX.KIT` desde #6699). Isto trava a divergência de prefixo em
// RUNTIME, via teste — não em compile-time: nenhum tipo do TypeScript aqui
// impede reintroduzir um literal `"kit:"` independente em outro arquivo
// (foi exatamente o que aconteceu em `brevo-diaria-store.ts` antes do
// #6699). O guard real é o teste "fix D" em
// test/sync-kit-inactive-to-brevo-6340.test.ts (produtor↔evaluate) somado a
// test/brevo-diaria-origin-consumers-6699.test.ts (cobre também o store).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
    out.push({ email: s.email, beehiiv_subscription_id: buildOrigin("kit", String(s.kit_subscriber_id)) });
  }
  return out;
}

/**
 * Pura (#8192) — cobertura MV do pool desta rodada a partir do checkpoint do
 * `verify-kit-inactive-emails-mv.ts`. Mede só sobre `candidateEmails` (quem
 * ainda não está no store), nunca sobre o checkpoint inteiro — entradas de
 * rodadas antigas não podem inflar a cobertura. `verified` = `ok`/`catch_all`.
 */
export function computeKitMvCoverage(
  candidateEmails: readonly string[],
  checkpoint: Readonly<Record<string, { result: string }>>,
): { verified: Set<string>; coverage: MvCoverage } {
  const verified = new Set<string>();
  let processedCount = 0;
  for (const email of candidateEmails) {
    const cached = checkpoint[email];
    if (!cached) continue;
    processedCount++;
    if (classifyResult(cached.result) === "verified") verified.add(email);
  }
  return { verified, coverage: { processedCount, poolSize: candidateEmails.length } };
}

/**
 * Pura (#8192) — quem entra nesta rodada. Por padrão só os verificados
 * (`ok`/`catch_all`), inclusive com cobertura PARCIAL: diferente do pool
 * Beehiiv, aqui não existe caminho em que um não-verificado entre sem a flag,
 * então cobertura parcial não precisa abortar — ingere o subconjunto
 * verificado e deixa o resto pra próxima rodada (abortar travaria também quem
 * já foi verificado, por causa de uma falha transitória num único e-mail).
 * `--i-know-this-skips-mv` (só uso manual; `brevo-diaria-run.ts` nunca
 * repassa) ignora o filtro quando a cobertura está incompleta.
 */
export function decideKitIngestion<T extends { email: string }>(
  candidates: readonly T[],
  verified: ReadonlySet<string>,
  coverage: MvCoverage,
  skipMvFlag: boolean,
): { toIngest: T[]; mvComplete: boolean; skipsMv: boolean } {
  const mvComplete = coverage.processedCount >= coverage.poolSize;
  const skipsMv = skipMvFlag && !mvComplete;
  const toIngest = skipsMv ? [...candidates] : candidates.filter((c) => verified.has(c.email));
  return { toIngest, mvComplete, skipsMv };
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

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    log(`ERRO: ${kitConfigResult.reason}`);
    process.exit(2);
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

  const brevoApiKey = process.env[brevoDiaria!.api_key_env];
  if (push && !brevoApiKey) {
    log(`ERRO: ${brevoDiaria!.api_key_env} não definido no ambiente (necessário pra --push).`);
    process.exit(2);
  }

  log("buscando assinantes inactive no Kit…");
  const rawInactive = await listAllKitSubscribers(kitConfigResult.config, { status: "inactive" });
  const selection = selectKitInactivePastDoiWindow(rawInactive, Date.now());
  log(formatKitInactiveSelection(selection));
  const inactive = mapKitInactiveSubscribers(selection.eligible);

  const store = readStore(DEFAULT_STORE_PATH);
  // Pool da rodada = elegíveis fora do store (sem filtro MV); a cobertura é
  // medida sobre ele e o filtro MV é aplicado depois (#8192).
  const candidates = computeKitContactsToIngest(inactive, store);
  const { verified, coverage } = computeKitMvCoverage(
    candidates.map((c) => c.email),
    loadCheckpoint(KIT_INACTIVE_MV_CHECKPOINT_PATH, "sync-kit-inactive-to-brevo"),
  );
  const decision = decideKitIngestion(candidates, verified, coverage, hasFlag(argv, "i-know-this-skips-mv"));
  const toIngest = decision.toIngest;
  if (decision.skipsMv) {
    log(
      "aviso: --i-know-this-skips-mv — filtro MV IGNORADO com cobertura incompleta " +
        `(${coverage.processedCount}/${coverage.poolSize} processados). Risco de bounce aceito explicitamente pelo operador.`,
    );
  } else if (!decision.mvComplete) {
    log(
      `aviso: cobertura MV parcial (${coverage.processedCount}/${coverage.poolSize}) — só os verificados entram nesta rodada; ` +
        "o resto fica pra quando scripts/verify-kit-inactive-emails-mv.ts processar.",
    );
  }
  log(
    `${toIngest.length} contato(s) novo(s) elegível(is) (dedup pelo store compartilhado — ${store.contacts.length} já tratado(s); ` +
      `MV: ${coverage.processedCount}/${coverage.poolSize} processado(s), ${verified.size} ok).`,
  );

  // Fila compartilhada com sync-pending-to-brevo.ts (mesmo store/cap/circuit
  // breaker) — ver docstring do módulo.
  const cap = brevoDiaria!.daily_send_cap ?? DEFAULT_QUEUE_CAP;
  const currentActiveCount = computeCurrentActiveCount(store.contacts);
  const slotsBeforeGuardrail = computeAvailableSlots(currentActiveCount, cap);

  // Review #6809 (P2, confiança alta): sem `warn`, um state file corrompido
  // cai no fail-soft silencioso — se o rollout estava PAUSADO quando
  // corrompeu, o reset libera o envio sem log nenhum (#6799).
  const guardrailState = readRolloutGuardrailState(undefined, log);
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
