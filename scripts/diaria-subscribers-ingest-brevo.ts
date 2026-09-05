#!/usr/bin/env node
/**
 * diaria-subscribers-ingest-brevo.ts (#6464 fatia 4 — #6587)
 *
 * Ingere no store unificado (`scripts/lib/diaria-subscribers-db.ts`) os
 * eventos por contato da conta Brevo `brevo_diaria` — canal de reativação
 * da diária (`BREVO_DIARIA_API_KEY`). **Nunca** toca a conta `brevo_clarice`
 * (#7196, fatia 1 do épico #7163) — essa base (~435k contatos, produto
 * diferente) tem pipeline PRÓPRIO em `clarice-sync-brevo.ts` →
 * `clarice_users`, banco IRMÃO que nunca cruza com este store (ver
 * docstring de `PLATFORMS` em `diaria-subscribers-db.ts`). Até o #7196,
 * este script ingeria as duas contas — `BREVO_ACCOUNTS` abaixo hoje só
 * lista `brevo_diaria`; a estrutura de array/loop foi mantida (em vez de
 * colapsar pra uma chamada única) porque é o formato mais barato de
 * reintroduzir uma 3ª conta Brevo legítima no futuro, se surgir.
 *
 * Copia o PADRÃO de `clarice-sync-brevo.ts` (enumerar contatos paginado,
 * `GET /contacts/{id}` por contato, checkpoint resumível) — não o destino:
 * aqui o alvo é o `event` genérico do épico #6464, não `clarice_users`. A
 * fonte é `/v3/contacts/*` (36.000 RPH — folgado, ver docs acima), nunca a
 * família `/v3/emailCampaigns*` (100 RPH apertado) — esta ingestão NUNCA
 * lista/lê campanhas, só contatos, então não compete pela cota apertada com
 * `clarice-schedule-ramp.ts`/`clarice-plan-wave.ts` nem com o dashboard.
 *
 * Miolo puro (parsing de `contact.statistics` → eventos, mapeamento pro
 * vocabulário do store, chave natural, escrita idempotente):
 * `scripts/lib/brevo-subscribers-ingest.ts` + `scripts/lib/brevo-stats.ts`
 * (`extractContactEvents`). Este arquivo é só a camada de I/O.
 *
 * ## Pacing + retomada após 429 (#6587 critério de pronto)
 *
 * `brevoGet` (`lib/brevo-client.ts`) já retenta 429/5xx honrando
 * `Retry-After`/`x-sib-ratelimit-reset` com backoff, e desiste cedo se o
 * `Retry-After` real exceder o orçamento por tentativa (nunca dorme um
 * teto sabendo de antemão que vai falhar de novo — mesma disciplina de
 * `clarice-sync-brevo.ts`). Quando o orçamento estoura mesmo assim, o erro
 * sobe, o checkpoint (já salvo incrementalmente) preserva o progresso, e
 * `db.close()` roda antes do processo terminar — re-rodar continua de onde
 * parou, sem duplicar (idempotência vem de `recordEvent`'s `INSERT OR
 * IGNORE` + a chave natural que embute `ts`, ver `buildBrevoEventExternalId`).
 *
 * ## Escopo desta versão — full sync (da LISTA, não da conta), sem incremental
 *
 * Ao contrário de `clarice-sync-brevo.ts` (que tem `--incremental` +
 * catch-up de opens via export de campanha), esta 1ª versão sempre faz
 * FULL enumeration — decisão explícita pra caber no orçamento desta issue
 * (#6587 não pede incremental). O checkpoint já torna o full resumível
 * entre execuções; adicionar `--incremental` fica pra uma issue futura, se
 * o volume da conta `brevo_diaria` tornar o full recorrente caro demais.
 *
 * ## Escopo por LISTA, não por conta inteira (#7199)
 *
 * A conta `brevo_diaria` hospeda MAIS de uma lista — pelo menos
 * `brevo_diaria.list_id` (reativação Pending, `platform.config.json`),
 * `brevo_apoiadores.list_id` (digest mensal) e a lista dinâmica de
 * onboarding D+10 (`onboarding-welcome-run.ts` § `ensureD10List`) — a lista
 * pode crescer, não é um trio fechado. `GET /v3/contacts` (sem filtro)
 * enumera a conta INTEIRA — misturaria todos esses públicos como se fossem
 * assinante da diária. Por isso a enumeração usa
 * `GET /contacts/lists/{listId}/contacts`, escopada ao `list_id` de cada
 * conta em `BREVO_ACCOUNTS` (lido de `platform.config.json`) — nunca o
 * listing de conta inteira. Achado ao vivo (260905): rodar sem esse escopo
 * ingeriu os 754 contatos da conta como `brevo_diaria`, quando a lista real
 * (`list_id=7`) tinha só 9 membros — revertido antes de mergear.
 *
 * Uso:
 *   npx tsx scripts/diaria-subscribers-ingest-brevo.ts [--db <p>]
 *     [--account brevo_diaria] [--limit N] [--concurrency N]
 *
 * `--account` só aceita `brevo_diaria` (único valor de `BREVO_ACCOUNTS`) —
 * omitido, roda essa única conta; qualquer outro valor recusa cedo.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { getArg, getIntArg, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { brevoGet } from "./lib/brevo-client.ts";
import { pool } from "./lib/pool.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDb } from "./lib/diaria-subscribers-db.ts";
import { runCanonicalEdicaoBackfillFailSoft } from "./lib/diaria-subscribers-edicao-canonica.ts";
import { ingestBrevoContact, type BrevoAccountPlatform } from "./lib/brevo-subscribers-ingest.ts";
import {
  buildInitialManifest,
  upsertManifestEntry,
  type IngestManifest,
} from "./lib/diaria-subscribers-ingest-manifest.ts";

export const DEFAULT_MANIFEST_PATH = resolve(dirname(DEFAULT_DB_PATH), "brevo-ingest-manifest.json");

/** `list_id` da lista Brevo "Diária — Reativação Pending" (`brevo_diaria`
 *  em `platform.config.json`) — fallback se o config não puder ser lido OU
 *  se `brevo_diaria.list_id` estiver ausente/inválido lá dentro. Fail-soft
 *  deliberado (não `process.exit`, diferente de `sync-pending-to-brevo.ts`
 *  pro MESMO campo): esta ingestão roda desassistida (overnight/cron), e
 *  abortar o processo inteiro por um campo de config perderia a rodada de
 *  ingestão toda por um problema menor. O preço do fail-soft é justamente
 *  o achado dos reviewers do #7451: sem aviso alto o bastante, cair no
 *  fallback é indistinguível de ler o config certo — por isso os DOIS
 *  ramos de fallback (erro de leitura E `list_id` ausente/inválido) emitem
 *  `console.error` alto (nunca silencioso), e o valor aceito é validado com
 *  `Number.isInteger(x) && x > 0` (não `Number.isFinite`, que aceitava
 *  0/negativo/fracionário como "válido"). */
const FALLBACK_BREVO_DIARIA_LIST_ID = 7;

/** Exportada só para teste (injetar `cfgPath` fake) — nenhum call site de
 *  produção passa o argumento, sempre resolve o `platform.config.json` real. */
export function loadBrevoDiariaListId(
  cfgPath: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", "platform.config.json"),
): number {
  let listId: unknown;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    listId = cfg?.brevo_diaria?.list_id;
  } catch (e) {
    console.error(
      `⚠️  platform.config.json não lido (${e instanceof Error ? e.message : String(e)}); ` +
        `usando list_id default ${FALLBACK_BREVO_DIARIA_LIST_ID} pra brevo_diaria`,
    );
    return FALLBACK_BREVO_DIARIA_LIST_ID;
  }
  // #7199 fix reviewers (achado convergente, alta confiança): `Number.isFinite`
  // aceitava 0/negativo/fracionário como "válido", e este ramo (config lido
  // com sucesso mas `list_id` ausente/tipo errado) não emitia NENHUM aviso —
  // exatamente a classe de "escopo errado, ninguém percebe" que #7199 corrige.
  if (typeof listId === "number" && Number.isInteger(listId) && listId > 0) return listId;
  console.error(
    `⚠️  platform.config.json lido, mas brevo_diaria.list_id ausente ou inválido (valor: ${JSON.stringify(listId)}); ` +
      `usando list_id default ${FALLBACK_BREVO_DIARIA_LIST_ID} pra brevo_diaria`,
  );
  return FALLBACK_BREVO_DIARIA_LIST_ID;
}

/** A única conta Brevo que ingere no store da diária — env var da key +
 *  platform de destino (#7196: `brevo_clarice` nunca entra aqui) +
 *  `listId` (#7199: enumeração é sempre escopada à LISTA, nunca à conta
 *  inteira — ver docstring do arquivo, "Escopo por LISTA"). */
export const BREVO_ACCOUNTS: Array<{ platform: BrevoAccountPlatform; apiKeyEnv: string; listId: number }> = [
  { platform: "brevo_diaria", apiKeyEnv: "BREVO_DIARIA_API_KEY", listId: loadBrevoDiariaListId() },
];

/** Pacing entre páginas do listing — mesmo valor de `clarice-sync-brevo.ts`
 *  (`PAGE_PACING_MS`), memória `brevo-hourly-ratelimit`. */
const PAGE_PACING_MS = 250;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A cada N contatos, persiste o checkpoint em disco (durabilidade sem pagar
 *  o custo de 1 write por contato). */
const CHECKPOINT_FLUSH_EVERY = 50;

// ---------------------------------------------------------------------------
// Checkpoint por conta (mesmo padrão de `clarice-sync-brevo.ts::Checkpoint`,
// adaptado — só full, sem `modifiedSince`).
// ---------------------------------------------------------------------------

export interface BrevoIngestCheckpoint {
  listingComplete: boolean;
  ids: Array<{ id: number; email: string }>;
  doneIds: number[];
}

/** Nome do checkpoint embute o `listId` (#7199) — um checkpoint de
 *  enumeração de CONTA inteira (escopo anterior a esta issue) nunca é
 *  reaproveitado por engano para uma enumeração escopada à lista, e
 *  vice-versa: são universos de contatos diferentes. */
export function checkpointPathForAccount(dbPath: string, platform: BrevoAccountPlatform, listId: number): string {
  return resolve(dirname(dbPath), `.brevo-ingest-checkpoint-${platform}-list${listId}.json`);
}

/** Path do listing ESCOPADO À LISTA (`GET /contacts/lists/{listId}/contacts`)
 *  — nunca `/contacts` puro, que enumeraria a conta inteira (#7199). Mesma
 *  paginação `limit=500&offset=N` do antigo `contactsListPath` (removido
 *  deste arquivo — ver `clarice-sync-brevo.ts` pro equivalente de conta
 *  inteira, usado só pela Clarice).
 *
 *  `brevoListContacts` (`lib/brevo-client.ts`, #7385) já bate o MESMO
 *  endpoint, mas devolve só `email[]` — aqui é preciso `{id, email}[]` (o
 *  `id` alimenta `GET /contacts/{id}` por contato e o checkpoint `doneIds`),
 *  então não é um drop-in trivial; não reusado de propósito, registrado
 *  aqui pra quem for procurar duplicação de paginação Brevo. */
export function contactsByListPath(listId: number, offset: number): string {
  return `/contacts/lists/${listId}/contacts?limit=500&offset=${offset}`;
}

function loadCheckpoint(path: string): BrevoIngestCheckpoint | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BrevoIngestCheckpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(cp: BrevoIngestCheckpoint, path: string): void {
  writeFileAtomic(path, JSON.stringify(cp));
}

/** Enumera contatos (id + email) via `/contacts/lists/{listId}/contacts`,
 *  paginado, resumível, escopado à LISTA (#7199 — nunca a conta inteira). */
async function enumerateContacts(
  apiKey: string,
  listId: number,
  existing: BrevoIngestCheckpoint | null,
  checkpointPath: string,
): Promise<BrevoIngestCheckpoint> {
  if (existing?.listingComplete) return existing;
  const ids: Array<{ id: number; email: string }> = existing?.ids ?? [];
  const doneIds = existing?.doneIds ?? [];
  let offset = ids.length;
  for (;;) {
    const { status, body } = await brevoGet(apiKey, contactsByListPath(listId, offset));
    // #7199 review (silent-failure-hunter, alta confiança): `brevoGet` trata
    // 404 como benigno (`{status:404, body:{}}`) — desenhado pra "contato
    // sumiu entre listar e buscar" (lookup de 1 entidade), nunca pra
    // LISTAGEM em massa. Mesmo racional já corrigido em
    // `fetchBrevoContactAttributeNames`/`iterateListContacts` (#4532/#4634):
    // 404 aqui significa `listId` inválido/erro real, nunca "lista vazia".
    // Sem este guard, `body?.contacts ?? []` silenciaria o 404 como 0
    // contatos com `listingComplete: true` — o espelho exato do bug que
    // este PR corrige (escopo errado sem nenhum aviso).
    if (status !== 200) {
      throw new Error(
        `Brevo API ${status} em /contacts/lists/${listId}/contacts — 404 numa listagem em massa não ` +
          `significa lista vazia, significa list_id inválido ou erro real (mesma disciplina de ` +
          `fetchBrevoContactAttributeNames, #4532/#4634).`,
      );
    }
    const cs = (body?.contacts ?? []) as Array<{ id: number; email?: string }>;
    for (const c of cs) ids.push({ id: c.id, email: String(c.email ?? "").toLowerCase() });
    const complete = cs.length < 500;
    saveCheckpoint({ listingComplete: complete, ids, doneIds }, checkpointPath);
    console.error(`  📇 listando contatos… ${ids.length}`);
    if (complete) break;
    offset += 500;
    await sleep(PAGE_PACING_MS);
  }
  return { listingComplete: true, ids, doneIds };
}

// ---------------------------------------------------------------------------
// Ingestão de 1 conta
// ---------------------------------------------------------------------------

export interface AccountIngestResult {
  platform: BrevoAccountPlatform;
  contactsListed: number;
  contactsProcessed: number;
  contactsFailed: number;
  eventsNew: number;
  eventsAlreadyKnown: number;
  eventsSkippedNoTimestamp: number;
}

export interface AccountIngestDeps {
  fetchContact: (apiKey: string, id: number) => Promise<Record<string, any>>;
}

function makeRealDeps(): AccountIngestDeps {
  return {
    fetchContact: async (apiKey, id) => {
      const { body } = await brevoGet(apiKey, `/contacts/${id}`);
      return body;
    },
  };
}

/**
 * Ingere 1 conta Brevo inteira: enumera contatos (resumível), busca cada um
 * (`concurrency` em paralelo, mesmo padrão de `clarice-sync-brevo.ts`) e
 * grava via `ingestBrevoContact`. Checkpoint por-contato (`doneIds`) garante
 * que uma interrupção (rate-limit, Ctrl+C) não perde progresso — re-rodar
 * pula quem já está `doneIds` e continua o resto.
 */
export async function ingestAccount(
  db: DatabaseSync,
  apiKey: string,
  platform: BrevoAccountPlatform,
  listId: number,
  dbPath: string,
  opts: { concurrency?: number; limit?: number; deps?: AccountIngestDeps } = {},
): Promise<AccountIngestResult> {
  const concurrency = opts.concurrency ?? 4;
  const deps = opts.deps ?? makeRealDeps();
  const checkpointPath = checkpointPathForAccount(dbPath, platform, listId);

  let loaded = loadCheckpoint(checkpointPath);
  const cp = await enumerateContacts(apiKey, listId, loaded, checkpointPath);
  const done = new Set<number>(cp.doneIds);
  let pending = cp.ids.filter((c) => c.id && !done.has(c.id));
  if (opts.limit && opts.limit > 0) pending = pending.slice(0, opts.limit);

  console.error(`  🔎 ${cp.ids.length} contato(s) · ${done.size} já feito(s) · ${pending.length} a processar`);

  let contactsProcessed = 0;
  let contactsFailed = 0;
  let eventsNew = 0;
  let eventsAlreadyKnown = 0;
  let eventsSkippedNoTimestamp = 0;
  let sinceFlush = 0;

  await pool(pending, concurrency, async (c) => {
    try {
      const contact = await deps.fetchContact(apiKey, c.id);
      const result = ingestBrevoContact(db, platform, c.id, contact);
      eventsNew += result.newEvents;
      eventsAlreadyKnown += result.alreadyKnown;
      eventsSkippedNoTimestamp += result.skippedNoTimestamp;
      contactsProcessed++;
    } catch (e) {
      contactsFailed++;
      console.error(`  ⚠️  contato ${c.id}: ${e instanceof Error ? e.message : String(e)}`);
      return; // não marca done — re-rodar tenta de novo
    }
    done.add(c.id);
    sinceFlush++;
    if (sinceFlush >= CHECKPOINT_FLUSH_EVERY) {
      sinceFlush = 0;
      saveCheckpoint({ listingComplete: true, ids: cp.ids, doneIds: [...done] }, checkpointPath);
    }
  });
  saveCheckpoint({ listingComplete: true, ids: cp.ids, doneIds: [...done] }, checkpointPath);

  // Enumeração + processamento completos, nada pendente → limpa o
  // checkpoint (mesmo padrão de `clarice-sync-brevo.ts`: uma rodada futura
  // recomeça a enumeração do zero, o que é OK — os EVENTOS já gravados
  // seguem intocados via idempotência do `recordEvent`).
  if (done.size >= cp.ids.length && existsSync(checkpointPath)) {
    try {
      unlinkSync(checkpointPath);
    } catch {
      /* não-bloqueante */
    }
  }

  return {
    platform,
    contactsListed: cp.ids.length,
    contactsProcessed,
    contactsFailed,
    eventsNew,
    eventsAlreadyKnown,
    eventsSkippedNoTimestamp,
  };
}

// ---------------------------------------------------------------------------
// Manifest (resumo por CONTA — o progresso granular fica no checkpoint acima)
// ---------------------------------------------------------------------------

function loadManifest(path: string): IngestManifest {
  if (!existsSync(path)) return buildInitialManifest(new Date().toISOString());
  try {
    return JSON.parse(readFileSync(path, "utf8")) as IngestManifest;
  } catch {
    return buildInitialManifest(new Date().toISOString());
  }
}

function saveManifest(path: string, manifest: IngestManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(manifest, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadProjectEnv();

  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const manifestPath = getArg(argv, "manifest") || DEFAULT_MANIFEST_PATH;
  const accountFilter = getArg(argv, "account");
  const limit = getIntArg(argv, "limit", { min: 1 });
  const concurrency = getIntArg(argv, "concurrency", { min: 1 }) ?? 4;

  if (accountFilter && !BREVO_ACCOUNTS.some((a) => a.platform === accountFilter)) {
    console.error(`❌ --account inválido: "${accountFilter}" (esperado: brevo_diaria)`);
    process.exitCode = 1;
    return;
  }

  const dbDir = dirname(dbPath);
  const dataRoot = dirname(dbDir);
  if (!existsSync(dataRoot)) {
    console.error(`❌ data/ não existe: ${dataRoot} (ver CLAUDE.md setup, passo 2b)`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  const db = openDiariaSubscribersDb(dbPath);
  let manifest = loadManifest(manifestPath);
  const results: AccountIngestResult[] = [];

  const accounts = accountFilter ? BREVO_ACCOUNTS.filter((a) => a.platform === accountFilter) : BREVO_ACCOUNTS;

  for (const account of accounts) {
    const apiKey = process.env[account.apiKeyEnv];
    if (!apiKey) {
      console.error(`⚠️  ${account.apiKeyEnv} ausente no env — pulando conta ${account.platform}.`);
      manifest = upsertManifestEntry(manifest, {
        id: account.platform,
        status: "error",
        error: `${account.apiKeyEnv} ausente no env`,
        fetched_at: new Date().toISOString(),
      });
      saveManifest(manifestPath, manifest);
      continue;
    }
    console.error(`🔄 ingerindo conta ${account.platform}…`);
    try {
      const result = await ingestAccount(db, apiKey, account.platform, account.listId, dbPath, { concurrency, limit });
      results.push(result);
      manifest = upsertManifestEntry(manifest, {
        id: account.platform,
        status: result.contactsFailed > 0 ? "partial" : "ok",
        counts: {
          contacts_listed: result.contactsListed,
          contacts_processed: result.contactsProcessed,
          contacts_failed: result.contactsFailed,
          events_new: result.eventsNew,
        },
        fetched_at: new Date().toISOString(),
      });
      console.error(
        `  ✅ ${account.platform}: ${result.contactsProcessed}/${result.contactsListed} contato(s) · ` +
          `${result.eventsNew} evento(s) novo(s) · ${result.contactsFailed} falha(s)`,
      );
    } catch (e) {
      console.error(`  ⚠️  ${account.platform} interrompida: ${e instanceof Error ? e.message : String(e)}. Re-rode pra continuar de onde parou.`);
      manifest = upsertManifestEntry(manifest, {
        id: account.platform,
        status: "partial",
        error: e instanceof Error ? e.message : String(e),
        fetched_at: new Date().toISOString(),
      });
    }
    saveManifest(manifestPath, manifest);
  }

  db.close();

  // #7204 (pós-#7249): último passo — refresca `event.edicao_canonica` com o
  // dado recém-ingerido (fail-soft, ver docstring de `runCanonicalEdicaoBackfillFailSoft`).
  const canonicalEdicaoBackfill = runCanonicalEdicaoBackfillFailSoft(dbPath);

  console.log(
    JSON.stringify(
      {
        db: dbPath,
        manifest: manifestPath,
        accounts: results,
        canonical_edicao_backfill: canonicalEdicaoBackfill,
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[diaria-subscribers-ingest-brevo] erro fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
