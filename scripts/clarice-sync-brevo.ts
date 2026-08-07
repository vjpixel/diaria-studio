#!/usr/bin/env node
/**
 * clarice-sync-brevo.ts — sincroniza engajamento/supressão do Brevo pro store
 * único de usuários da Clarice (#2647 follow-up). Fecha o gap que deixava
 * `send_eligible` não-autoritativo (descadastro/bounce ficavam no default).
 *
 * Por contato (GET /contacts/{id}): opens/clicks/sends, hard/soft bounces,
 * unsub, complaints, last_*_at, blacklist, RECENCY_QUARTIL, listIds, timestamps.
 * Parsing puro em `lib/brevo-stats.ts`; upsert em `lib/clarice-db.ts`.
 *
 * ⚠️ PESADO + RATE-LIMITED: a base toda são dezenas de milhares de contatos =
 * 1 GET por contato. A Brevo tem limite HORÁRIO (memória `brevo-hourly-ratelimit`)
 * — o `brevoGet` reusado respeita `Retry-After`, mas um run completo pode esgotar
 * a cota. Por isso o run é **checkpoint-resumável**: o progresso é durável no
 * próprio DB (upsert incremental em transações de BATCH) + um checkpoint de ids
 * já processados. Se cair (rate-limit/Ctrl+C), re-rodar continua de onde parou.
 *
 * Uso:
 *   npx tsx scripts/clarice-sync-brevo.ts [--db <p>] [--concurrency N] [--limit N]
 *   (--limit: processa só os N primeiros contatos — sync parcial / teste)
 *
 * INCREMENTAL (#2928): --incremental sincroniza SÓ os contatos modificados desde
 * o último sync (deriva de MAX(brevo_modified_at) − 5min), via `modifiedSince` da
 * Brevo → uma fração das chamadas, sem hammering do teto horário. --modified-since
 * <ISO> força uma data explícita. Sem nenhum dos dois = full (comportamento antigo).
 *
 * OPENS CATCH-UP (#4688): abrir um e-mail NÃO toca `modifiedAt` do contato na
 * Brevo — só clique/outras mutações tocam. Isso faz `--incremental` (que
 * enumera contatos via `modifiedSince`) nunca re-visitar quem só abre sem
 * clicar, e `opens_count` degrada continuamente (medido ao vivo em 260806:
 * ~32% de subcontagem agregada antes de um full resync manual). Em vez de
 * depender do `modifiedAt` do contato, o modo incremental TAMBÉM varre os
 * destinatários das campanhas enviadas numa janela recente
 * (`--opens-window-days`, default 30 dias — mesma ordem de grandeza do
 * `DEFAULT_REFETCH_WINDOW_DAYS` de `clarice-engagement-cohorts-v2.ts`, #4451,
 * reusando a MESMA infra de export por campanha, já validada ao vivo em
 * 260802) via `POST /emailCampaigns/{id}/exportRecipients`, que reporta
 * `Total Opens` por destinatário independente de `modifiedAt`. Os e-mails com
 * abertura registrada nessa janela são re-buscados individualmente
 * (`GET /contacts/{email}`, mesmo parsing/upsert do loop principal — MAX-merge
 * em `opens_count`, nunca regride). Roda só quando `modifiedSince` é
 * conhecido (modo incremental ou `--modified-since` explícito) — o modo full
 * já pega todo mundo com stats exatos, catch-up seria redundante ali.
 * Desligável via `--no-catch-opens`. FAIL-SOFT: uma falha no catch-up (rede,
 * rate-limit) vira warning no stderr + `opens_catchup.error` no summary —
 * nunca reprova o sync principal, que já persistiu com sucesso. O cache de
 * campanha do catch-up vive em `OPENS_CATCHUP_CACHE_DIR`, subdiretório
 * PRÓPRIO (nunca o `CAMPAIGN_CACHE_DIR` real da #4451, #4717 follow-up
 * achado 5) — `--cache-dir <dir>` sobrescreve pra isolamento em teste.
 *
 * Requer BREVO_CLARICE_API_KEY no env. Stdout: JSON summary. Stderr: progresso.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { brevoGet } from "./lib/brevo-client.ts";
import { pool } from "./lib/pool.ts";
import { parseBrevoContact, type BrevoColumns } from "./lib/brevo-stats.ts";
import {
  openClariceDb,
  makeBrevoUpsert,
  recomputeDerived,
  DEFAULT_DB_PATH,
} from "./lib/clarice-db.ts";
import { getArg, getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  makeRealCampaignExportClient,
  getOrFetchCampaignCache,
  isWithinRefetchWindow,
  CAMPAIGN_CACHE_DIR,
  type CampaignExportClient,
  type CampaignCache,
} from "./clarice-engagement-cohorts-v2.ts"; // #4688: reusa a infra de export por campanha (#4451)

/**
 * #4205: caminho dos 2 arquivos de checkpoint (full + incremental — #2928,
 * SEPARADOS pra não clobberar o resume um do outro), derivado do DIRETÓRIO do
 * `--db` em vez de um `ROOT`/`data/` fixo. Antes eram consts hardcoded
 * ancoradas em `data/clarice-subscribers/` do repo real — impossível de
 * injetar em teste (um `main()` de teste escreveria fora do tmpdir isolado,
 * em `data/`, que num worktree fresco/cloud nem existe). Como o checkpoint já
 * sempre viveu ao LADO do `.db` (mesma pasta `data/clarice-subscribers/` do
 * `DEFAULT_DB_PATH`), co-localizar com `dbPath` preserva o comportamento de
 * produção (`--db` omitido → mesmo path de sempre) e torna o par
 * db+checkpoint isolável junto num `--db <tmp>/store.db` de teste. Pura/testável.
 */
export function checkpointPathsForDb(dbPath: string): {
  checkpoint: string;
  checkpointInc: string;
} {
  const dir = resolve(dbPath, "..");
  return {
    checkpoint: resolve(dir, ".brevo-sync-checkpoint.json"),
    checkpointInc: resolve(dir, ".brevo-sync-checkpoint-inc.json"),
  };
}
const BATCH = 200; // flush no DB + checkpoint a cada N contatos (durabilidade)
const PAGE_PACING_MS = 250; // pacing leve entre páginas do listing (memória brevo-hourly-ratelimit)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Checkpoint {
  listingComplete: boolean;
  ids: Array<{ id: number; email: string }>;
  doneIds: number[];
  // #2928: qual modifiedSince gerou esta enumeração (null = full). Resume só é
  // válido pra mesma data; datas/modos diferentes descartam o checkpoint.
  modifiedSince?: string | null;
}

function loadCheckpoint(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(cp: Checkpoint, path: string): void {
  writeFileSync(path, JSON.stringify(cp), "utf8");
}

/**
 * #2928: path do listing de contatos (limit 500 + offset), com `modifiedSince`
 * opcional encodado. Pure/testável.
 */
export function contactsListPath(offset: number, modifiedSince: string | null): string {
  const since = modifiedSince ? `&modifiedSince=${encodeURIComponent(modifiedSince)}` : "";
  return `/contacts?limit=500&offset=${offset}${since}`;
}

/**
 * #2928: deriva o `modifiedSince` do incremental a partir de MAX(brevo_modified_at)
 * menos um buffer (default 5min, pra não perder contatos na fronteira do último
 * sync). Devolve ISO UTC, ou null se a data for ausente/inválida (→ cai pra full).
 * Pure/testável.
 */
export function deriveIncrementalSince(
  maxBrevoModifiedAt: string | null | undefined,
  bufferMs = 5 * 60_000,
): string | null {
  if (!maxBrevoModifiedAt) return null;
  const t = new Date(maxBrevoModifiedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - bufferMs).toISOString();
}

/**
 * #2929 review: âncora do incremental, ESTÁVEL entre resumes. RESUME (checkpoint
 * incremental pendente com cutoff) → REUSA o cutoff do checkpoint. **Não re-derivar
 * num resume**: `MAX(brevo_modified_at)` avança conforme sincronizamos (flush por
 * batch), então re-derivar estreitaria a janela e PULARIA os contatos ainda
 * pendentes de `[cutoff_antigo, cutoff_novo)` — quebrando a resumibilidade sob
 * rate-limit. Run novo (sem checkpoint) → deriva de MAX − buffer. Pure/testável.
 */
export function anchorForIncremental(
  checkpointModifiedSince: string | null | undefined,
  maxBrevoModifiedAt: string | null | undefined,
  bufferMs = 5 * 60_000,
): string | null {
  if (checkpointModifiedSince) return checkpointModifiedSince;
  return deriveIncrementalSince(maxBrevoModifiedAt, bufferMs);
}

// ─── Opens catch-up (#4688) ──────────────────────────────────────────────
//
// Abrir um e-mail não toca `modifiedAt` — o incremental (que enumera por
// `modifiedSince`) nunca revisita esses contatos, então `opens_count`
// degrada continuamente pra quem abre sem clicar. Em vez disso, varremos os
// destinatários das campanhas ENVIADAS numa janela recente via
// `exportRecipients` (`Total Opens` por destinatário, independe de
// `modifiedAt` do contato) e re-buscamos cada opener individualmente — mesmo
// caminho preciso de sempre (`GET /contacts/{email}`, MAX-merge no upsert).

/** Janela default (dias) — mesma ordem de grandeza do DEFAULT_REFETCH_WINDOW_DAYS
 * de clarice-engagement-cohorts-v2.ts (#4451); "chute inicial" documentado lá,
 * não recalibrado empiricamente ainda. Override via --opens-window-days. */
export const DEFAULT_OPENS_CATCHUP_WINDOW_DAYS = 30;

/**
 * #4717 follow-up (achado 5): subdiretório PRÓPRIO do catch-up, irmão de
 * `CAMPAIGN_CACHE_DIR` (não o mesmo diretório). `CAMPAIGN_CACHE_DIR` é o
 * cache que `clarice-engagement-cohorts-v2.ts` (#4451) usa como artefato
 * ESTÁVEL pro cutover v1-vs-v2 ainda em dry-run — o catch-up roda diariamente
 * (task `Diaria-Clarice-Sync`, 08:30) com `forceRefresh: true` e sobrescreve
 * o cache de cada campanha na janela a cada execução; compartilhar o mesmo
 * diretório acoplaria essas duas features sem documentação (a #4451 acabaria
 * vendo o cache re-escrito por uma rotina que ela não conhece). Separar em
 * `opens-catchup/` evita a colisão sem exigir coordenação entre as duas.
 */
export const OPENS_CATCHUP_CACHE_DIR = resolve(CAMPAIGN_CACHE_DIR, "..", "opens-catchup");

/**
 * Extrai o conjunto de e-mails normalizados com abertura registrada em
 * QUALQUER dos caches de campanha passados (union — um opener em 2
 * campanhas diferentes entra 1x). Pura — testável sem rede (#633).
 */
export function collectOpenedEmails(caches: CampaignCache[]): Set<string> {
  const out = new Set<string>();
  for (const cache of caches) {
    for (const [email, flags] of Object.entries(cache.recipients)) {
      if (flags.opened) out.add(email);
    }
  }
  return out;
}

export interface OpensCatchupDeps {
  /** Cliente de export de campanha — real (`makeRealCampaignExportClient`) ou fake em teste. */
  client: CampaignExportClient;
  /** Busca 1 contato por identificador (email ou id) — devolve o body cru da Brevo. */
  fetchContact: (identifier: string) => Promise<Record<string, any>>;
  /** Upsert no store — mesma função usada pelo loop principal (MAX-merge, nunca regride). */
  upsert: (cols: BrevoColumns) => void;
  cacheDir?: string;
  windowDays?: number;
  nowMs?: number;
  concurrency?: number;
}

export interface OpensCatchupResult {
  campaignsConsidered: number;
  campaignsInWindow: number;
  campaignsFailed: number;
  openersFound: number;
  contactsUpdated: number;
  contactsFailed: number;
}

/**
 * Roda o catch-up: campanhas recentes → destinatários com abertura → re-busca
 * individual + upsert. FAIL-SOFT por campanha (uma campanha que falhar no
 * export não aborta as demais) e por contato (um 404/erro pontual não aborta
 * o catch-up inteiro) — o chamador (`main`) decide se uma falha TOTAL vira
 * warning ou propaga.
 */
export async function runOpensCatchup(deps: OpensCatchupDeps): Promise<OpensCatchupResult> {
  const windowDays = deps.windowDays ?? DEFAULT_OPENS_CATCHUP_WINDOW_DAYS;
  const nowMs = deps.nowMs ?? Date.now();
  // #4717 follow-up (achado 5, hardening): o default cai no subdiretório
  // PRÓPRIO do catch-up, nunca em CAMPAIGN_CACHE_DIR (produção compartilhada
  // com a #4451) — `main()` já passa `deps.cacheDir` sempre explicitamente
  // (achado 1), este fallback é só defesa em profundidade pra qualquer
  // caller futuro de runOpensCatchup que esqueça de passar cacheDir.
  const cacheDir = deps.cacheDir ?? OPENS_CATCHUP_CACHE_DIR;
  const concurrency = deps.concurrency ?? 4;

  const campaigns = await deps.client.listSentCampaigns();
  const recent = campaigns.filter((c) => isWithinRefetchWindow(c, nowMs, windowDays));

  const caches: CampaignCache[] = [];
  let campaignsFailed = 0;
  for (const campaign of recent) {
    try {
      // dentro da janela → sempre re-exporta (mesma semântica de isWithinRefetchWindow
      // em clarice-engagement-cohorts-v2.ts: captura engajamento tardio).
      const { cache } = await getOrFetchCampaignCache(deps.client, campaign, {
        cacheDir,
        forceRefresh: true,
      });
      caches.push(cache);
    } catch (e) {
      campaignsFailed++;
      // #4717 follow-up (achado 2): logar a mensagem, não só incrementar o
      // contador — um contador anônimo esconderia erro real (escrita SQLite,
      // regressão de escopo OAuth, timeout de polling) atrás de um número,
      // a mesma classe de subcontagem silenciosa que esta feature existe
      // pra corrigir.
      console.error(
        `⚠️  catch-up: export da campanha ${campaign.id} (${campaign.name}) falhou: ${(e as Error).message}`,
      );
    }
  }

  const openerEmails = collectOpenedEmails(caches);
  let contactsUpdated = 0;
  let contactsFailed = 0;
  await pool(Array.from(openerEmails), concurrency, async (email) => {
    try {
      const contact = await deps.fetchContact(email);
      const cols = parseBrevoContact(contact);
      if (!cols.email) {
        contactsFailed++; // 404/corpo vazio (contato sumiu entre o export e a re-busca)
        return;
      }
      deps.upsert(cols);
      contactsUpdated++;
    } catch (e) {
      contactsFailed++;
      // #4717 follow-up (achado 2): diferente do `!cols.email` acima (404
      // esperado — contato sumiu entre export e re-busca, não logado), este
      // catch pega falha REAL (rede, parse, upsert no SQLite) — logar sempre.
      console.error(`⚠️  catch-up: re-busca/upsert de ${email} falhou: ${(e as Error).message}`);
    }
  });

  return {
    campaignsConsidered: campaigns.length,
    campaignsInWindow: recent.length,
    campaignsFailed,
    openersFound: openerEmails.size,
    contactsUpdated,
    contactsFailed,
  };
}

/**
 * Enumera contatos (id + email) paginando /contacts. Resumível.
 * #2928: com `modifiedSince` (ISO), enumera SÓ os contatos modificados desde
 * então (Brevo `modifiedSince`) — o incremental. null = full.
 */
async function enumerateContacts(
  apiKey: string,
  existing: Checkpoint | null,
  modifiedSince: string | null,
  checkpointPath: string,
): Promise<Checkpoint> {
  if (existing?.listingComplete) return existing;
  const ids: Array<{ id: number; email: string }> = existing?.ids ?? [];
  const doneIds = existing?.doneIds ?? [];
  let offset = ids.length;
  for (;;) {
    const { body } = await brevoGet(apiKey, contactsListPath(offset, modifiedSince));
    const cs = body?.contacts ?? [];
    for (const c of cs)
      ids.push({ id: c.id, email: String(c.email ?? "").toLowerCase() });
    const complete = cs.length < 500;
    // checkpoint POR PÁGINA → se o listing cair no meio (rate-limit), re-rodar
    // retoma de offset=ids.length em vez de re-enumerar do zero.
    saveCheckpoint({ listingComplete: complete, ids, doneIds, modifiedSince }, checkpointPath);
    console.error(`📇 listando contatos${modifiedSince ? " (incremental)" : ""}… ${ids.length}`);
    if (complete) break;
    offset += 500;
    await sleep(PAGE_PACING_MS);
  }
  return { listingComplete: true, ids, doneIds, modifiedSince };
}


export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  loadProjectEnv();
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("❌ BREVO_CLARICE_API_KEY ausente no env.");
    process.exit(1);
  }

  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const concurrency = Number(getArg(argv, "concurrency")) || 4;
  // getIntArg (#4497) — ausente vira 0 ("sem limite", comportamento normal do
  // sync agendado); um typo no VALOR (ex: "--limit abc") agora LANÇA em vez
  // de colapsar no mesmo 0 silenciosamente (antes: Number(getArg(...)) || 0
  // não distinguia "flag ausente" de "valor inválido" — mesma classe do
  // incidente #4476/#4496).
  const limitArg = getIntArg(argv, "limit") ?? 0;
  // #4688: catch-up de opens via export de campanha, ligado por padrão em modo
  // incremental (ver bloco "Opens catch-up" acima); --no-catch-opens desliga.
  const catchOpensEnabled = !hasFlag(argv, "no-catch-opens");
  const opensWindowDays =
    getIntArg(argv, "opens-window-days") ?? DEFAULT_OPENS_CATCHUP_WINDOW_DAYS;
  // #4717 follow-up (achado 1): SEMPRE passado explicitamente pro
  // runOpensCatchup abaixo — nunca deixar o default implícito de dentro de
  // runOpensCatchup decidir. `--cache-dir` existe só pra teste isolar o
  // diretório (mkdtempSync); em produção cai no subdiretório próprio do
  // catch-up (achado 5), nunca no CAMPAIGN_CACHE_DIR real compartilhado.
  const opensCatchupCacheDir = getArg(argv, "cache-dir") || OPENS_CATCHUP_CACHE_DIR;
  const { checkpoint: CHECKPOINT, checkpointInc: CHECKPOINT_INC } =
    checkpointPathsForDb(dbPath);

  const db = openClariceDb(dbPath);
  const upsertBrevo = makeBrevoUpsert(db);

  // #2928: modo incremental — --modified-since <ISO> explícito, ou --incremental
  // deriva de MAX(brevo_modified_at) − 5min (buffer contra perder a fronteira).
  const explicitSince = getArg(argv, "modified-since");
  let modifiedSince: string | null = explicitSince || null;
  if (!modifiedSince && hasFlag(argv, "incremental")) {
    // RESUME: reusa o cutoff do checkpoint incremental pendente; senão deriva de
    // MAX − buffer. anchorForIncremental encapsula (não re-derivar num resume —
    // review #2929, o MAX avança com o flush e pularia contatos pendentes).
    const incCp = loadCheckpoint(CHECKPOINT_INC);
    const row = db
      .prepare("SELECT MAX(brevo_modified_at) AS m FROM clarice_users")
      .get() as { m: string | null };
    modifiedSince = anchorForIncremental(incCp?.modifiedSince, row?.m);
    if (incCp?.modifiedSince) {
      console.error(`⏩ incremental: retomando modifiedSince=${modifiedSince} (do checkpoint)`);
    } else if (modifiedSince) {
      console.error(`⏩ incremental: modifiedSince=${modifiedSince} (MAX(brevo_modified_at) − 5min)`);
    } else {
      console.error("⚠️  --incremental mas store sem brevo_modified_at — caindo pra sync FULL.");
    }
  }
  const checkpointPath = modifiedSince ? CHECKPOINT_INC : CHECKPOINT;

  // Fase 1 — enumerar ids (resumível). Checkpoint de outra data/modo → descarta.
  let loaded = loadCheckpoint(checkpointPath);
  if (loaded && (loaded.modifiedSince ?? null) !== modifiedSince) {
    console.error("ℹ️  checkpoint de outra data/modo — recomeçando enumeração.");
    loaded = null;
  }
  let cp = await enumerateContacts(apiKey, loaded, modifiedSince, checkpointPath);
  const done = new Set<number>(cp.doneIds);
  let pending = cp.ids.filter((c) => c.id && c.email && !done.has(c.id));
  if (limitArg > 0) pending = pending.slice(0, limitArg);
  console.error(
    `🔎 ${cp.ids.length} contatos · ${done.size} já feitos · ${pending.length} a processar`,
  );

  // Fase 2 — per-id GET + parse + upsert, em batches transacionais duráveis.
  let buffer: Array<{ id: number; cols: ReturnType<typeof parseBrevoContact> }> =
    [];
  let processed = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    db.exec("BEGIN");
    try {
      for (const b of batch) upsertBrevo(b.cols);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      // batch NÃO entra em done → re-run re-busca (idempotente). Não re-bufferiza
      // pra não arriscar loop no mesmo erro persistente.
      throw e;
    }
    // done/checkpoint só APÓS o COMMIT durável (senão um COMMIT que falha deixaria
    // ids "feitos" sem linha no DB).
    for (const b of batch) done.add(b.id);
    cp.doneIds = [...done];
    saveCheckpoint(cp, checkpointPath);
  };

  try {
    await pool(pending, concurrency, async (c) => {
      const { body } = await brevoGet(apiKey, `/contacts/${c.id}`);
      // 404 (sumiu entre listar e buscar) → body {} → parse vira tudo-zero; marca
      // como done mesmo assim pra não re-tentar em loop.
      buffer.push({ id: c.id, cols: parseBrevoContact(body) });
      processed++;
      if (buffer.length >= BATCH) flush();
      if (processed % BATCH === 0)
        console.error(`  …${processed}/${pending.length}`);
    });
    flush();
  } catch (e) {
    // persiste o que já veio antes de abortar; um flush que TAMBÉM falhe não pode
    // escapar daqui (senão db.close()/exitCode 2 + return não rodam → uncaught
    // exception derruba com exit 1 e stack, mascarando o exit code do erro real).
    try {
      flush();
    } catch (flushErr) {
      console.error(`⚠️  flush final falhou: ${(flushErr as Error).message}`);
    }
    console.error(
      `⚠️  sync interrompido (${(e as Error).message}). ${done.size}/${cp.ids.length} ` +
        `salvos no DB + checkpoint. Re-rode pra continuar de onde parou.`,
    );
    db.close();
    // Windows fix (#4689, mesma classe do #4651/#4638/#1401): este catch só é
    // alcançado depois de pelo menos um `await brevoGet(...)` (pool acima) —
    // process.exit() aqui derrubaria o processo via libuv (UV_HANDLE_CLOSING)
    // antes do flush dos streams, no MESMO caminho de erro que mais precisa
    // do log. process.exitCode + return deixa o event loop drenar sozinho.
    process.exitCode = 2;
    return;
  }

  // #4688: catch-up de opens via export de campanha — só faz sentido em modo
  // incremental (full já pega stats exatos de todo mundo via GET /contacts/{id}).
  // FAIL-SOFT: uma falha aqui não derruba o sync principal, que já persistiu.
  let opensCatchup: (OpensCatchupResult & { error?: string }) | null = null;
  if (modifiedSince && catchOpensEnabled) {
    console.error(
      `🔄 catch-up de opens (janela ${opensWindowDays}d) — campanhas enviadas recentemente…`,
    );
    try {
      const campaignClient = makeRealCampaignExportClient(apiKey);
      opensCatchup = await runOpensCatchup({
        client: campaignClient,
        fetchContact: async (identifier) => {
          const { body } = await brevoGet(apiKey, `/contacts/${encodeURIComponent(identifier)}`);
          return body;
        },
        upsert: upsertBrevo,
        windowDays: opensWindowDays,
        concurrency, // #4688 self-review: reusa o mesmo --concurrency do loop principal (era hardcoded default 4)
        cacheDir: opensCatchupCacheDir, // #4717 follow-up (achado 1 + 5): nunca o default implícito
      });
      console.error(
        `✅ catch-up: ${opensCatchup.campaignsInWindow}/${opensCatchup.campaignsConsidered} campanhas na janela ` +
          `(${opensCatchup.campaignsFailed} falharam) · ${opensCatchup.openersFound} openers · ` +
          `${opensCatchup.contactsUpdated} contatos atualizados (${opensCatchup.contactsFailed} falharam)`,
      );
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`⚠️  catch-up de opens falhou (não afeta o sync principal, já persistido): ${msg}`);
      opensCatchup = {
        campaignsConsidered: 0,
        campaignsInWindow: 0,
        campaignsFailed: 0,
        openersFound: 0,
        contactsUpdated: 0,
        contactsFailed: 0,
        error: msg,
      };
    }
  }

  // Concluído: recompute global + limpa checkpoint.
  console.error(`⚙️  recomputando derivados (send_eligible + priority_points)…`);
  const derived = recomputeDerived(db);
  if (existsSync(checkpointPath)) unlinkSync(checkpointPath);

  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM clarice_users").get() as { n: number }
  ).n;
  const suppressed = (
    db
      .prepare("SELECT COUNT(*) AS n FROM clarice_users WHERE send_eligible = 0")
      .get() as { n: number }
  ).n;
  db.close();

  console.log(
    JSON.stringify(
      {
        db: dbPath,
        mode: modifiedSince ? "incremental" : "full",
        modified_since: modifiedSince,
        contacts_listed: cp.ids.length,
        contacts_synced: processed,
        users_total: total,
        suppressed,
        derived_recomputed: derived,
        brevo_synced: true,
        opens_catchup: opensCatchup,
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[clarice-sync-brevo] erro fatal: ${(e as Error).message}\n`);
    // Windows fix (#4651, mesma classe do #4638/#1401/#4689): main() pode
    // lançar fora do try/catch interno (ex: enumerateContacts na Fase 1,
    // antes do try; ou recomputeDerived/db.close() pós-sucesso) — depois de
    // já ter feito await fetch, então process.exit() aqui arriscaria o mesmo
    // crash libuv que o #4689 corrigiu no catch pós-await.
    process.exitCode = 1;
  });
}
