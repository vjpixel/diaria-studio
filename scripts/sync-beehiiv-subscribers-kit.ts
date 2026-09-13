#!/usr/bin/env npx tsx
/**
 * scripts/sync-beehiiv-subscribers-kit.ts (#6091 — migração Beehiiv → Kit, #461)
 *
 * Sync recorrente de assinantes ativos da Beehiiv pro Kit — pré-requisito
 * de QUALQUER switchover real (#464/#6048/#466). O #6047 fez uma importação
 * PONTUAL (585 assinantes, 24/08/2026); confirmado ao vivo em 25/08/2026
 * que o Kit continua com exatamente esses 585, todos `created_at:
 * 2026-08-24` — nenhum assinante novo da Beehiiv chegou ao Kit desde então,
 * porque não existia nenhum mecanismo recorrente. Este script é esse
 * mecanismo.
 *
 * ## Design: ADITIVO quanto a remoção, mas PODE REATIVAR
 *
 * Só cria/atualiza no Kit quem está `active` na Beehiiv e ainda não está
 * `active` no Kit (ausente, ou presente com outro `state`). NUNCA
 * desativa/remove ninguém do Kit — mesmo que tenha cancelado na Beehiiv.
 * Diferente do `sync-apoio-nivel-beehiiv.ts` (que precisa remover tags de
 * quem perdeu o nível), aqui a lista mais "atrasada em incluir" é
 * inofensiva (só significa que aquele e-mail não recebeu de novo alguém
 * que já estava lá); a lista mais "atrasada em remover" já é aceita como
 * escopo futuro (não perseguido aqui — decisão de manter o escopo mínimo
 * o bastante pra destravar os switchovers reais).
 *
 * **Achado do review (#6092): "aditivo" não é sinônimo de "nunca muda um
 * state existente".** Um e-mail `active` na Beehiiv mas `cancelled`/
 * `bounced`/etc. no KIT especificamente (independente do que aconteceu na
 * Beehiiv) É reativado — `computeMissingEmails` trata esse caso como
 * "faltando" de propósito. Risco aceito por ora (o Kit é um destino novo,
 * sem histórico orgânico de descadastro próprio ainda) — reavaliar antes
 * do Kit virar a lista viva de verdade.
 *
 * ## Guard: lista do Kit suspeita-vazia
 *
 * Se `listAllKitSubscribers` devolver poucos (<50% do que o Kit já tinha
 * na última vez que este script rodou com sucesso — persistido em
 * `data/kit-subscriber-sync-state.json`) — provável falha de auth/paginação
 * silenciosa, não "todo mundo cancelou". Bloqueia TODA a rodada (inclusive
 * dry-run — achado do review: a versão anterior só mencionava `--push` no
 * texto, mas o guard já corria antes do branch de dry-run; a inspeção
 * dry-run também merece o aviso alto, não um erro que a impede de rodar —
 * por isso dry-run agora só AVISA e continua, só `--push` de fato aborta).
 * `--force-empty-guard` é o escape hatch — e **nunca** atualiza o baseline
 * persistido quando usado (só uma rodada que passou pelo guard normalmente
 * grava `data/kit-subscriber-sync-state.json`), pra não perpetuar um
 * número degradado como "normal" nas rodadas seguintes.
 *
 * Uso:
 *   npx tsx scripts/sync-beehiiv-subscribers-kit.ts               # dry-run (default)
 *   npx tsx scripts/sync-beehiiv-subscribers-kit.ts --push         # aplica de verdade
 *
 * Exit codes: 1 erro fatal (config ausente, API falhou, guard de lista
 * suspeita-vazia em --push sem --force-empty-guard, ≥1 falha de escrita).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { hasMorePages } from "./backup-beehiiv.ts";
import { listAllKitSubscribers, createOrUpdateSubscriber } from "./lib/kit-subscribers.ts";
import { KIT_ORIGEM_CADASTRO_FIELD_NAME, KIT_BEEHIIV_SYNC_SIGNUP_MARKER } from "./lib/shared/kit-signup-origin.ts"; // #6425 Parte B
import { buildAttributionFields, type BeehiivSubscriberRecord } from "./lib/kit-attribution.ts"; // #8060

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
// #6047 (Kit) + #1897 (Beehiiv /subscriptions): os dois lados toleram só
// dezenas de chamadas sequenciais sem espaçamento antes de rate-limit —
// mesmo intervalo cobre ambos os fetch loops deste script.
const RATE_LIMIT_DELAY_MS = 350;
const PER_PAGE = 100;
/** Guard: se o Kit devolver menos que este % do que tinha na última rodada
 *  registrada, algo está errado (auth/paginação) — não "todo mundo cancelou". */
const EMPTY_GUARD_RATIO = 0.5;

/** Pura — normalização de e-mail pra comparação (nunca pra exibição/POST).
 *  Achado do review (#6092): estava duplicada em 2 call sites
 *  independentes — fatorada aqui pra a invariante "os dois lados
 *  normalizam igual" ser estrutural, não coincidência de manutenção. */
export function normalizeEmailForComparison(email: string): string {
  return email.trim().toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * #8060: além de `email`/`status`, o `GET /subscriptions` da Beehiiv traz os
 * mesmos 7 campos de atribuição já tipados em `BeehiivSubscriberRecord`
 * (`scripts/lib/kit-attribution.ts`) mais `acquisition_source`/
 * `acquisition_channel` — o rastreamento de aquisição PRÓPRIO da Beehiiv,
 * usado como ÚLTIMO fallback quando os UTM de topo vêm vazios (mesma regra
 * de precedência de `ingestBeehiivRoster` em `beehiiv-subscribers-ingest.ts`).
 * Todos opcionais/`string` (não `unknown`) porque este é o shape CRU vindo
 * direto da API — cada consumidor decide o que fazer com ausência, não este
 * tipo.
 */
export interface BeehiivSubscriptionRaw {
  email: string;
  status: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_channel?: string;
  utm_term?: string;
  utm_content?: string;
  referring_site?: string;
  acquisition_source?: string;
  acquisition_channel?: string;
}

interface BeehiivPage {
  data?: BeehiivSubscriptionRaw[];
  total_pages?: number;
  total_results?: number;
  limit?: number;
  page?: number;
}

export interface FetchBeehiivDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Pura — `fields` gravado por este sync no `POST /v4/subscribers`
 * (#6425 Parte B, ver comentário no call site em `main()`). Extraída pra
 * ser testável sem mock de rede — `main()` não expõe `fetchImpl` pro lado
 * Kit (mesma limitação aceita de sempre, ver docstring do teste).
 *
 * `attribution` (#8060) é OPCIONAL e aditivo — omitido (assinatura sem
 * argumento, comportamento anterior ao #8060 preservado por compat) ou sem
 * nenhum campo de UTM/`referring_site` preenchido na origem, o resultado é
 * idêntico a antes: só o marcador `origem_cadastro`. Quando presente, reusa
 * `buildAttributionFields` (`scripts/lib/kit-attribution.ts`) — o MESMO
 * mapeamento já usado pelo backfill (#6318/#6425) e por
 * `promoteKitSubscription` — em vez de inventar nomes de campo novos (pedido
 * explícito do corpo da #8060). `atribuicao_fonte: "beehiiv-import"`
 * gravado por `buildAttributionFields` é bônus, não acidente: sincroniza
 * `origem_cadastro` (marcador PRÓPRIO deste script, "veio do sync em lote")
 * com `atribuicao_fonte` (marcador do backfill, "já tem atribuição
 * recuperada da Beehiiv") — os dois nomes de campo nunca colidem, e um
 * assinante criado por este sync já nasce com `atribuicao_fonte` setado,
 * então `backfill-kit-attribution.ts` (`jaBackfillado`) o pula corretamente
 * na próxima rodada em vez de reprocessar um dado que este sync já gravou.
 * Campo ausente/vazio na origem nunca vira `""` fabricado — omitido, mesma
 * disciplina de `buildAttributionFields`.
 */
export function buildBeehiivSyncKitFields(attribution?: BeehiivSubscriberRecord): Record<string, string> {
  const base: Record<string, string> = { [KIT_ORIGEM_CADASTRO_FIELD_NAME]: KIT_BEEHIIV_SYNC_SIGNUP_MARKER };
  if (!attribution) return base;
  const attributionFields = buildAttributionFields(attribution);
  return attributionFields ? { ...base, ...attributionFields } : base;
}

/**
 * Pura (#8060) — resolve o `BeehiivSubscriberRecord` (7 campos de atribuição
 * de `kit-attribution.ts`) a partir do subscription CRU da Beehiiv, com a
 * MESMA precedência já aplicada por `ingestBeehiivRoster`
 * (`beehiiv-subscribers-ingest.ts`): `utm_source` de topo tem prioridade,
 * `acquisition_source` é o ÚLTIMO fallback só pra `utm_source` (a Beehiiv
 * não tem `utm_channel` nativo — só `acquisition_channel`, mesmo fallback
 * pra `utm_channel`). Caso concreto da issue (#8060): assinante com
 * `acquisition_source: "website: chatgpt.com / (none)"` e `utm_source`
 * vazio de topo — sem este fallback, `origem_cadastro: beehiiv-sync` seria
 * gravado sem NENHUM UTM, reproduzindo o bug relatado.
 */
export function resolveBeehiivAttribution(sub: BeehiivSubscriptionRaw): BeehiivSubscriberRecord {
  const utmSource = (sub.utm_source?.trim() || sub.acquisition_source?.trim()) || undefined;
  const utmChannel = (sub.utm_channel?.trim() || sub.acquisition_channel?.trim()) || undefined;
  return {
    email: sub.email,
    utm_source: utmSource,
    utm_medium: sub.utm_medium,
    utm_campaign: sub.utm_campaign,
    utm_channel: utmChannel,
    utm_term: sub.utm_term,
    utm_content: sub.utm_content,
    referring_site: sub.referring_site,
  };
}

/**
 * Pagina `GET /subscriptions?status=active` — mesmo achado/mitigação do
 * #1897 já aplicado em `backup-beehiiv.ts` (`per_page` é ignorado nesse
 * endpoint, `total_pages` infla; drena por `total_results` via
 * `hasMorePages`, reusado daqui). `fetchImpl` injetável pra teste (achado
 * do review, #6092 — antes esta função só usava o `fetch` global, sem
 * seam nenhum pra teste sem rede real).
 *
 * Devolve o subscription CRU inteiro (não só `email`) desde o #8060 — os
 * campos de atribuição (`utm_*`, `referring_site`, `acquisition_*`) já vêm
 * de graça na mesma resposta paginada, sem 2ª chamada por assinante.
 */
export async function fetchActiveBeehiivSubscriptions(
  apiKey: string,
  publicationId: string,
  deps: FetchBeehiivDeps = {},
): Promise<BeehiivSubscriptionRaw[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const subscriptions: BeehiivSubscriptionRaw[] = [];
  let page = 1;
  let more = true;
  let totalResults: number | null = null;
  while (more) {
    await sleep(RATE_LIMIT_DELAY_MS);
    const res = await fetchImpl(
      `${beehiivApiBase()}/publications/${publicationId}/subscriptions?status=active&limit=${PER_PAGE}&page=${page}`,
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
    );
    if (!res.ok) {
      throw new Error(`Beehiiv API ${res.status} em subscriptions (página ${page}): ${await res.text()}`);
    }
    const body = (await res.json()) as BeehiivPage;
    const got = body.data ?? [];
    subscriptions.push(...got);
    if (body.total_results != null) totalResults = body.total_results;
    more = hasMorePages({
      collected: subscriptions.length,
      gotLength: got.length,
      totalResults: body.total_results,
      effectiveLimit: body.limit,
      requestedPerPage: PER_PAGE,
    });
    page++;
  }
  if (totalResults != null && totalResults > 0 && subscriptions.length < totalResults) {
    throw new Error(`subscriptions truncado: ${subscriptions.length}/${totalResults} (loop encerrou antes de drenar total_results)`);
  }
  return subscriptions;
}

/**
 * Compat (#8060): call sites que só precisam da lista de e-mails (o
 * `main()` deste script agora usa `fetchActiveBeehiivSubscriptions`
 * diretamente pra também ter a atribuição) — mantido exportado porque
 * `test/sync-beehiiv-subscribers-kit.test.ts` cobre esta função
 * isoladamente.
 */
export async function fetchActiveBeehiivEmails(
  apiKey: string,
  publicationId: string,
  deps: FetchBeehiivDeps = {},
): Promise<string[]> {
  const subscriptions = await fetchActiveBeehiivSubscriptions(apiKey, publicationId, deps);
  return subscriptions.map((s) => s.email);
}

export interface SyncState {
  last_run_at: string;
  kit_subscriber_count: number;
}

/** #6092 (achado do review): o path do state NÃO é mais fixo no módulo —
 *  antes disso, `readSyncState`/`writeSyncState` sempre tocavam
 *  `data/kit-subscriber-sync-state.json` de verdade (compartilhado via
 *  OneDrive), inclusive em teste, o que tornava `main()` intestável sem
 *  arriscar sujar o estado real. `rootDir` segue a mesma convenção de
 *  `scripts/lib/pipeline-state.ts` (`readSentinel`/`writeSentinel` etc). */
function statePath(rootDir: string): string {
  return resolve(rootDir, "data", "kit-subscriber-sync-state.json");
}

/** Achado do review (#6092): valida o SHAPE, não só que é JSON válido — um
 *  arquivo JSON válido mas mal-formado (campo renomeado, tipo errado) antes
 *  produzia um `SyncState` com `kit_subscriber_count` não-numérico, que
 *  `evaluateEmptyGuard` dividia silenciosamente em `NaN` e — como
 *  `NaN < EMPTY_GUARD_RATIO` é `false` — o guard FALHAVA ABERTO (`ok: true`)
 *  exatamente no cenário (estado corrompido) que ele existe pra proteger.
 *  JSON genuinamente inválido já lançava um `SyntaxError` alto (fail
 *  fechado, correto); isto fecha o caminho onde o JSON era válido mas o
 *  shape não. */
function isValidSyncState(v: unknown): v is SyncState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.last_run_at === "string" && typeof o.kit_subscriber_count === "number" && Number.isFinite(o.kit_subscriber_count);
}

export function readSyncState(rootDir: string): SyncState | null {
  const path = statePath(rootDir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path}: JSON inválido (${(e as Error).message}) — apagar o arquivo trata como "sem baseline" na próxima rodada.`);
  }
  if (!isValidSyncState(parsed)) {
    throw new Error(`${path}: shape inesperado (esperava {last_run_at: string, kit_subscriber_count: number}) — apagar o arquivo trata como "sem baseline" na próxima rodada.`);
  }
  return parsed;
}

export function writeSyncState(rootDir: string, state: SyncState): void {
  const path = statePath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export type EmptyGuardResult = { ok: true } | { ok: false; reason: string };

/** Pura — recusa a rodada se a lista do Kit encolheu demais desde a última
 *  vez (ver docstring do módulo). Sem histórico prévio (1ª rodada), sempre
 *  passa — não há baseline pra comparar. */
export function evaluateEmptyGuard(currentCount: number, previousState: SyncState | null): EmptyGuardResult {
  if (!previousState || previousState.kit_subscriber_count === 0) return { ok: true };
  const ratio = currentCount / previousState.kit_subscriber_count;
  // #6092: ratio não-finito (NaN/Infinity — só alcançável hoje se
  // isValidSyncState tivesse um bug, já que ela garante kit_subscriber_count
  // numérico finito) falha FECHADO, nunca aberto — ver docstring de
  // isValidSyncState sobre por que "fail open" é o pior desfecho aqui.
  if (!Number.isFinite(ratio) || ratio < EMPTY_GUARD_RATIO) {
    const pct = Number.isFinite(ratio) ? `${(ratio * 100).toFixed(0)}%` : "indefinido";
    return {
      ok: false,
      reason: `Kit devolveu ${currentCount} assinantes, ${pct} dos ${previousState.kit_subscriber_count} da última rodada (${previousState.last_run_at}) — provável falha de auth/paginação, não "todo mundo cancelou".`,
    };
  }
  return { ok: true };
}

/** Pura — diff por e-mail (normalizado via `normalizeEmailForComparison`):
 *  quem está ativo na Beehiiv e ainda não está `active` no Kit. Um e-mail
 *  presente no Kit mas com outro `state` (`cancelled`/etc.) TAMBÉM conta
 *  como "faltando" — `createOrUpdateSubscriber` vai REATIVAR essa pessoa
 *  no Kit (ver docstring do módulo sobre esse efeito colateral do design
 *  aditivo: aditivo quanto a NUNCA remover, mas pode reativar). */
export function computeMissingEmails(beehiivActiveEmails: string[], kitEmailsByState: Map<string, string>): string[] {
  const missing: string[] = [];
  for (const raw of beehiivActiveEmails) {
    const email = normalizeEmailForComparison(raw);
    const kitState = kitEmailsByState.get(email);
    if (kitState !== "active") missing.push(raw);
  }
  return missing;
}

export async function main(rootDirOverride?: string): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const forceEmptyGuard = hasFlag(argv, "force-empty-guard");
  const log = (msg: string) => process.stderr.write(`[sync-beehiiv-subscribers-kit] ${msg}\n`);

  const beehiivCfg = loadBeehiivConfig("[sync-beehiiv-subscribers-kit]");
  const kitApiKey = process.env.KIT_API_KEY;
  if (!kitApiKey) {
    log("ERRO: KIT_API_KEY ausente (.env).");
    process.exitCode = 1;
    return;
  }
  const kitConfig = { apiKey: kitApiKey };

  log("buscando assinantes ativos da Beehiiv...");
  // #8060: subscription CRU (não só e-mail) — carrega os campos de
  // atribuição na mesma resposta paginada, sem 2ª chamada por assinante.
  const beehiivActiveSubscriptions = await fetchActiveBeehiivSubscriptions(beehiivCfg.apiKey, beehiivCfg.publicationId);
  const beehiivActiveEmails = beehiivActiveSubscriptions.map((s) => s.email);
  const beehiivAttributionByEmail = new Map(
    beehiivActiveSubscriptions.map((s) => [normalizeEmailForComparison(s.email), resolveBeehiivAttribution(s)]),
  );
  log(`${beehiivActiveEmails.length} assinante(s) ativo(s) na Beehiiv.`);

  log("buscando assinantes do Kit...");
  const kitSubscribers = await listAllKitSubscribers(kitConfig);
  log(`${kitSubscribers.length} assinante(s) no Kit.`);

  // #6092: readSyncState agora pode lançar (shape inválido) — deixa subir
  // pro catch de main() (mesmo padrão de erro fatal já usado nos outros
  // guards), não silencia.
  const previousState = readSyncState(rootDir);
  const guard = evaluateEmptyGuard(kitSubscribers.length, previousState);
  // #6092: o guard bloqueia a rodada INTEIRA (inclusive dry-run) só quando
  // vai de fato ESCREVER (--push). Em dry-run, um guard reprovado vira
  // aviso — a inspeção "o que aconteceria" continua útil justamente quando
  // algo parece errado, não deveria ficar bloqueada pelo mesmo motivo.
  if (!guard.ok) {
    if (push && !forceEmptyGuard) {
      log(`ERRO: ${guard.reason} Recusando --push.`);
      process.exitCode = 1;
      return;
    }
    log(`AVISO${push ? " (--force-empty-guard)" : ""}: ${guard.reason}${push ? " — prosseguindo mesmo assim." : ""}`);
  }

  const kitEmailsByState = new Map(kitSubscribers.map((s) => [normalizeEmailForComparison(s.email_address), s.state]));
  const missing = computeMissingEmails(beehiivActiveEmails, kitEmailsByState);
  log(`${missing.length} assinante(s) da Beehiiv ausente(s)/não-ativo(s) no Kit.`);

  if (!push) {
    log(`[dry-run] nenhuma escrita feita. Amostra (até 10): ${missing.slice(0, 10).join(", ")}`);
    return;
  }

  let synced = 0;
  let failed = 0;
  for (const email of missing) {
    try {
      // #6425 Parte B + #8060: `origem_cadastro` distingue "copiado em lote
      // da Beehiiv" de "entrou pelo funil" (`kit-nativo`) e de "promovido
      // por score" (`brevo-diaria-score`); desde o #8060, o UTM/
      // `referring_site` reais do cadastro na Beehiiv (já vieram na mesma
      // resposta paginada, ver `beehiivAttributionByEmail` acima) também são
      // propagados — antes deste fix, todo cadastro copiado por este sync
      // perdia a origem real e ficava indistinguível de "api: direct/(none)".
      const attribution = beehiivAttributionByEmail.get(normalizeEmailForComparison(email));
      await createOrUpdateSubscriber(
        { email_address: email, state: "active", fields: buildBeehiivSyncKitFields(attribution) },
        kitConfig,
      );
      synced++;
    } catch (e) {
      failed++;
      log(`falha ao sincronizar ${email}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }
  log(`sync concluído: ${synced} sincronizado(s) (criado ou reativado), ${failed} falha(s).`);

  // #6092: NUNCA `kitSubscribers.length + synced` — subestimaria reativações
  // (que não aumentam a contagem do Kit) e superestimaria em relação à
  // contagem REAL. Um re-fetch é a única fonte confiável do número pós-sync
  // — barato o bastante pra essa cadência (recorrente, não em loop apertado).
  // TAMBÉM: só grava o baseline quando o guard passou de verdade (`guard.ok`)
  // — uma rodada que só seguiu via --force-empty-guard nunca persiste,
  // pra não perpetuar um número degradado como "normal" (achado do review).
  if (guard.ok) {
    const kitSubscribersAfter = await listAllKitSubscribers(kitConfig);
    writeSyncState(rootDir, { last_run_at: new Date().toISOString(), kit_subscriber_count: kitSubscribersAfter.length });
  } else {
    log("baseline NÃO atualizado (rodada só seguiu via --force-empty-guard) — próxima rodada compara contra o último baseline confiável.");
  }

  if (failed > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sync-beehiiv-subscribers-kit] erro fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
