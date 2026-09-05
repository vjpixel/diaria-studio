#!/usr/bin/env node
/**
 * diaria-subscribers-ingest-kit.ts (#6464 fatia 3 — #6586)
 *
 * Ingere no store unificado (`scripts/lib/diaria-subscribers-db.ts`) os
 * eventos por assinante × broadcast do Kit — os 4 eixos que
 * `POST /v4/subscribers/filter` expõe: `sent`, `delivered`, `opens`,
 * `clicks` (identidade real, não só contagem — o único endpoint do Kit que
 * devolve QUEM). Reusa `fetchAudience`/`drainPages`/`todasOuNenhuma`, já
 * endurecidos em `scripts/kit-provider-split.ts` (envelope 2xx malformado
 * tratado como erro, nunca fim-de-lista silencioso; `Promise.allSettled`
 * reporta TODAS as falhas concorrentes, não só a 1ª).
 *
 * Miolo puro (mapeamento eixo→evento, chave natural, guard anti-fabricação,
 * escrita idempotente): `scripts/lib/kit-subscribers-ingest.ts`. Este
 * arquivo é só a camada de I/O — fetch real + persistência do manifest.
 *
 * ## Retomável — `kit-ingest-manifest.json`
 *
 * Mesmo padrão de `apply-mcp-subscriber-engagement.ts` (#6465): 1 entry por
 * broadcast, status `ok`/`partial`/`error`. Re-rodar só refaz o que ainda
 * não está `ok` — nunca reprocessa um broadcast já confirmado. Só broadcasts
 * `status: "completed"` (efetivamente enviados) entram na enumeração — um
 * rascunho/agendado não tem audiência real pra ingerir ainda.
 *
 * ## Guard anti-fabricação (#6496)
 *
 * Um broadcast só vira `ok` no manifest se a contagem do eixo `sent`
 * ingerida bater exatamente com `stats.recipients` do próprio Kit
 * (`verifyKitIngestion`, `kit-subscribers-ingest.ts`) — divergência marca
 * `partial` (os eventos já coletados são gravados mesmo assim, idempotente;
 * a re-rodada seguinte tenta de novo).
 *
 * ## Passo 1 (#7174) — ingestão de ROSTER, popula `subscription`
 *
 * Antes da ingestão de audiência por broadcast (acima), este CLI agora lista
 * o roster COMPLETO do Kit (`status: "all"`) e grava 1 `subscriber` + 1
 * `subscription` + eventos `subscribe`/`unsub` por assinante
 * (`ingestKitRoster`, `kit-subscribers-ingest.ts`) — fecha o buraco de
 * `subscription` nunca ser populada pelo lado Kit. **Dry-run por padrão**:
 * SEMPRE lista o roster (custa a chamada de rede), mas só GRAVA no store com
 * `--write` explícito — escritor único (a task agendada `Diaria-Kit-Roster-
 * Ingest`, `scripts/lib/scheduled-tasks.ts`, é quem passa `--write` por
 * padrão; execução manual sem a flag é só um preview). `--skip-roster` pula
 * o Passo 1 inteiro (nem lista) — útil pra isolar teste do Passo 2
 * (broadcast) sem pagar a chamada de roster a cada invocação manual.
 *
 * Uso:
 *   npx tsx scripts/diaria-subscribers-ingest-kit.ts [--db <p>] [--manifest <p>]
 *     [--limit N] [--broadcast <id>] [--write] [--skip-roster] [--captura-log <p>]
 *
 * Requer `KIT_API_KEY` no env (`resolveKitConfig`, lança se ausente — mesmo
 * fail-fast do resto da camada Kit). Stdout: JSON summary. Stderr: progresso.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getArg, getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import {
  listBroadcasts,
  getBroadcastStats,
  getBroadcastClicks,
  type KitBroadcastSummary,
  type KitBroadcastStats,
  type KitBroadcastClick,
} from "./lib/kit-client.ts";
import { fetchAudience, fetchUrlClicks, todasOuNenhuma, type BroadcastAudience, type DrainResult } from "./kit-provider-split.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDb, getStoreCounts } from "./lib/diaria-subscribers-db.ts";
import {
  ingestBroadcastAudience,
  ingestBroadcastUrlClicks,
  verifyKitIngestion,
  ingestKitRoster,
} from "./lib/kit-subscribers-ingest.ts";
import { listAllKitSubscribers } from "./lib/kit-subscribers.ts";
import { buildCapturaLogEntry, serializeCapturaLogEntry } from "./lib/metrics/captura-log.ts";
import {
  buildInitialManifest,
  mergeManifestEntries,
  upsertManifestEntry,
  pendingManifestEntries,
  manifestCoverageSummary,
  type IngestManifest,
  type IngestManifestEntry,
} from "./lib/diaria-subscribers-ingest-manifest.ts";

export const DEFAULT_MANIFEST_PATH = resolve(dirname(DEFAULT_DB_PATH), "kit-ingest-manifest.json");

/** `data/metrics/captura-log.jsonl` (#7174) — o único arquivo fora do store
 *  que este CLI escreve. Fica sob `data/metrics/`, irmão de
 *  `data/diaria-subscribers/` (não dentro dela), porque não é parte do
 *  schema do #6464 — ver `scripts/lib/metrics/captura-log.ts`. */
export const DEFAULT_CAPTURA_LOG_PATH = resolve(dirname(DEFAULT_DB_PATH), "..", "metrics", "captura-log.jsonl");

/** Pacing entre broadcasts — mesma ordem de grandeza medida no #6047
 *  (endpoints singulares do Kit toleram só dezenas de chamadas sequenciais
 *  sem espaçamento antes de 429). Cada broadcast já dispara 5 chamadas
 *  concorrentes (4 eixos + stats); a pausa é ENTRE broadcasts, não dentro. */
export const BROADCAST_PACING_MS = 350;

// ---------------------------------------------------------------------------
// Dependências injetáveis (produção = real; teste = fixture)
// ---------------------------------------------------------------------------

export interface KitIngestDeps {
  listAllBroadcasts: () => Promise<KitBroadcastSummary[]>;
  fetchAudience: (broadcastId: number, axis: BroadcastAudience) => Promise<DrainResult>;
  getBroadcastStats: (id: number) => Promise<KitBroadcastStats>;
  sleep: (ms: number) => Promise<void>;
  /** Roster COMPLETO — `status: "all"` sempre (#7174: omitir devolve só
   *  `active` em silêncio, ver `scripts/lib/kit-subscribers.ts`). */
  listAllRosterSubscribers: () => ReturnType<typeof listAllKitSubscribers>;
  /**
   * #7206, ambos OPCIONAIS: refinamento por-link do eixo "clicks", que
   * popula `event.url` (Beehiiv e Brevo já populam; o Kit era o que faltava
   * fechar). `getBroadcastLinkClicks` lista TODOS os links do broadcast,
   * paginado até o fim (REST `/broadcasts/{id}/clicks`, endpoint confirmado
   * ao vivo em #6185 — responde "quais URLs perguntar"; produção usa
   * `getAllBroadcastLinkClicks`, #7454 review — a versão anterior só lia a
   * 1ª página, silenciando links além dela); `fetchUrlClicks` devolve quem
   * clicou em CADA um (`/subscribers/filter` escopado por URL — shape
   * best-effort, ainda não confirmado ao vivo, ver docstring de
   * `kit-provider-split.ts::buildUrlClickFilterBody`).
   *
   * Opcionais de propósito: `makeRealKitIngestDeps` sempre os fornece;
   * fixtures/testes que antecedem o #7206 simplesmente não os populam, e
   * `ingestOneBroadcast` trata a ausência como "pular o refinamento" —
   * fail-soft, nunca afeta os 4 eixos principais nem o guard anti-fabricação
   * (#6496), que seguem ancorados só em `sent`/`stats.recipients`.
   */
  getBroadcastLinkClicks?: (id: number) => Promise<{ clicks: KitBroadcastClick[] }>;
  fetchUrlClicks?: (broadcastId: number, url: string) => Promise<DrainResult>;
}

/**
 * Detecta cópias de conflito do OneDrive pro arquivo alvo — mesmo padrão
 * medido em `data/run-log.jsonl` (23 cópias: `run-log-Neo{,-2..-10}.jsonl`,
 * `run-log-Zenbook{,-2..-6}.jsonl`, `run-log-predator{,-safeBackup-*}.jsonl`).
 * Com um `.db` SQLite no meio, a bifurcação é pior que ruído — ver docstring
 * de `scripts/lib/kit-subscribers-ingest.ts::ingestKitRoster`. Retorna os
 * nomes de arquivo encontrados (vazio = nenhum conflito). @pure sobre a
 * lista de arquivos já lida (a leitura do diretório é do chamador). */
export function detectSiblingConflictFiles(filesInDir: readonly string[], expectedBasename: string): string[] {
  const dot = expectedBasename.lastIndexOf(".");
  const stem = dot === -1 ? expectedBasename : expectedBasename.slice(0, dot);
  const ext = dot === -1 ? "" : expectedBasename.slice(dot);
  // Casa "{stem}-QUALQUERCOISA{ext}" (ex: "diaria-subscribers-Neo.db",
  // "captura-log-safeBackup-0001.jsonl") mas nunca o arquivo esperado em si.
  const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-.+${ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  return filesInDir.filter((f) => f !== expectedBasename && re.test(f));
}

/**
 * Pagina `GET /broadcasts?status=completed` até o fim — só broadcasts
 * efetivamente enviados têm audiência real pra ingerir.
 *
 * `has_next_page=true` sem `end_cursor` é envelope malformado, NUNCA fim de
 * lista silencioso — mesma disciplina de `drainPages` (`kit-provider-split.ts`,
 * achado do review #6491): uma lista de broadcasts truncada em silêncio
 * deixaria broadcasts inteiros fora da enumeração, sem nenhum sinal de erro.
 */
export async function listAllCompletedBroadcasts(): Promise<KitBroadcastSummary[]> {
  const out: KitBroadcastSummary[] = [];
  let after: string | undefined;
  for (;;) {
    const { broadcasts, pagination } = await listBroadcasts({ status: "completed", perPage: 100, after });
    out.push(...broadcasts);
    if (!pagination.has_next_page) break;
    if (!pagination.end_cursor) {
      throw new Error(
        "[diaria-subscribers-ingest-kit] listagem de broadcasts: has_next_page=true mas end_cursor " +
          "ausente — lista truncada, abortando em vez de tratar como fim de lista (#6491).",
      );
    }
    after = pagination.end_cursor;
  }
  return out;
}

/**
 * Pagina `GET /broadcasts/{id}/clicks` até o fim (#7454 review, correctness +
 * silent-failure-hunter, alta confiança) — a chamada anterior (`getBroadcastClicks(id)`,
 * sem `perPage` nem loop) descartava `pagination` e só via a 1ª página. Um
 * broadcast com mais links do que cabem numa página (default do Kit não
 * confirmado; `kit-verify-click-fields.ts` já usa `perPage: 100` pro mesmo
 * endpoint) teria os links das páginas seguintes silenciosamente fora do
 * refinamento #7206 — sem erro, sem warning, indistinguível de "só tinha
 * esses links". Mesma disciplina de `listAllCompletedBroadcasts` acima:
 * `has_next_page=true` sem `end_cursor` é envelope malformado, nunca fim de
 * lista silencioso.
 */
export async function getAllBroadcastLinkClicks(id: number): Promise<{ clicks: KitBroadcastClick[] }> {
  const out: KitBroadcastClick[] = [];
  let after: string | undefined;
  for (;;) {
    const { clicks, pagination } = await getBroadcastClicks(id, { perPage: 100, after });
    out.push(...clicks);
    if (!pagination.has_next_page) break;
    if (!pagination.end_cursor) {
      throw new Error(
        `[diaria-subscribers-ingest-kit] getAllBroadcastLinkClicks(${id}): has_next_page=true mas ` +
          "end_cursor ausente — lista de links truncada, abortando em vez de tratar como fim de lista.",
      );
    }
    after = pagination.end_cursor;
  }
  return { clicks: out };
}

export function makeRealKitIngestDeps(): KitIngestDeps {
  return {
    listAllBroadcasts: listAllCompletedBroadcasts,
    fetchAudience,
    getBroadcastStats,
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    // status: "all" SEMPRE (#7174) — nunca omitir a opção, senão a API
    // devolve só `active` em silêncio (ver docstring de kit-subscribers.ts).
    listAllRosterSubscribers: () => listAllKitSubscribers(undefined, { status: "all" }),
    // #7206: produção sempre fornece o refinamento por-link.
    getBroadcastLinkClicks: getAllBroadcastLinkClicks,
    fetchUrlClicks,
  };
}

// ---------------------------------------------------------------------------
// Ingestão de 1 broadcast (fail-soft — nunca lança, vira entry "error")
// ---------------------------------------------------------------------------

export interface BroadcastIngestOutcome {
  entry: IngestManifestEntry;
  eventsNew: number;
  eventsAlreadyKnown: number;
}

/**
 * Ingerir 1 broadcast: fetch dos 4 eixos + stats (concorrente, via
 * `todasOuNenhuma` — nomeia TODAS as falhas se mais de uma coleta cair
 * junto), escreve no DB via `ingestBroadcastAudience` por eixo, aplica o
 * guard anti-fabricação, devolve a entry pronta pro manifest.
 *
 * NUNCA lança — uma falha de fetch (rede, 429 esgotado, envelope malformado)
 * vira `status: "error"` na entry, e o broadcast volta em
 * `pendingManifestEntries` na próxima rodada. Mesmo padrão fail-soft
 * por-unidade de `apply-mcp-subscriber-engagement.ts` (#6465).
 */
export async function ingestOneBroadcast(
  db: DatabaseSync,
  broadcast: Pick<KitBroadcastSummary, "id" | "subject" | "published_at" | "send_at">,
  deps: Pick<KitIngestDeps, "fetchAudience" | "getBroadcastStats" | "getBroadcastLinkClicks" | "fetchUrlClicks">,
  now: string = new Date().toISOString(),
): Promise<BroadcastIngestOutcome> {
  const id = String(broadcast.id);
  // #6586: `/subscribers/filter` não devolve timestamp por assinante — a
  // precisão de "quando" fica no nível do broadcast, não do evento.
  const ts = broadcast.published_at ?? broadcast.send_at ?? now;

  let sent: DrainResult, delivered: DrainResult, opens: DrainResult, clicks: DrainResult, stats: KitBroadcastStats;
  try {
    [sent, delivered, opens, clicks, stats] = await todasOuNenhuma<
      [DrainResult, DrainResult, DrainResult, DrainResult, KitBroadcastStats]
    >([
      deps.fetchAudience(broadcast.id, "sent"),
      deps.fetchAudience(broadcast.id, "delivered"),
      deps.fetchAudience(broadcast.id, "opens"),
      deps.fetchAudience(broadcast.id, "clicks"),
      deps.getBroadcastStats(broadcast.id),
    ]);
  } catch (e) {
    return {
      entry: {
        id,
        label: broadcast.subject,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        fetched_at: now,
      },
      eventsNew: 0,
      eventsAlreadyKnown: 0,
    };
  }

  const axes: Array<[BroadcastAudience, DrainResult]> = [
    ["sent", sent],
    ["delivered", delivered],
    ["opens", opens],
    ["clicks", clicks],
  ];
  let eventsNew = 0;
  let eventsAlreadyKnown = 0;
  const counts: Record<string, number> = {};
  for (const [axis, result] of axes) {
    const r = ingestBroadcastAudience(db, broadcast.id, axis, result.emails, ts, now);
    eventsNew += r.newEvents;
    eventsAlreadyKnown += r.alreadyKnown;
    counts[axis] = result.emails.length;
  }
  counts.recipients_reportados = stats.recipients;

  // #7206: refinamento OPCIONAL por-link do eixo "clicks" — popula
  // `event.url`. Fail-soft de propósito: uma falha aqui (rede, shape ainda
  // não confirmado ao vivo — ver docstring de `buildUrlClickFilterBody`)
  // NUNCA derruba os 4 eixos principais já gravados acima, nem muda o guard
  // anti-fabricação abaixo (ancorado só em "sent"/`stats.recipients`).
  let urlClicksError: string | undefined;
  if (deps.getBroadcastLinkClicks && deps.fetchUrlClicks) {
    // #7454 review (silent-failure-hunter, correctness — alta confiança):
    // `counts.clicks_com_url` só era atribuído DEPOIS do loop inteiro — se um
    // link no meio lançasse, os links anteriores já tinham sido gravados no
    // banco (efeito colateral real e correto), mas o manifest reportava
    // `clicks_com_url: undefined`, como se nada tivesse sido processado.
    // Inicializar antes do loop e incrementar dentro dele preserva o
    // progresso parcial no manifest mesmo quando o loop aborta no meio.
    counts.clicks_com_url = 0;
    try {
      const { clicks: linkClicks } = await deps.getBroadcastLinkClicks(broadcast.id);
      // Sequencial de propósito (nunca Promise.all) — #6047 já mediu que
      // endpoints singulares do Kit toleram só dezenas de chamadas seguidas
      // sem espaçamento antes de 429; este broadcast já soma 5 chamadas
      // concorrentes acima (4 eixos + stats) mais 1+N aqui (1 listagem de
      // links + até N `fetchUrlClicks`). Paralelizar este loop reintroduziria
      // a rajada que o desenho do arquivo evita entre broadcasts.
      for (const linkClick of linkClicks) {
        if (!linkClick.url || linkClick.unique_clicks <= 0) continue;
        const urlResult = await deps.fetchUrlClicks(broadcast.id, linkClick.url);
        const r = ingestBroadcastUrlClicks(db, broadcast.id, linkClick.url, urlResult.emails, ts, now);
        eventsNew += r.newEvents;
        eventsAlreadyKnown += r.alreadyKnown;
        counts.clicks_com_url += r.newEvents + r.alreadyKnown;
      }
    } catch (e) {
      urlClicksError = e instanceof Error ? e.message : String(e);
    }
  }

  const guard = verifyKitIngestion(sent.emails.length, stats.recipients);
  const combinedError = [guard.reason, urlClicksError ? `refinamento por-link (#7206): ${urlClicksError}` : undefined]
    .filter((x): x is string => Boolean(x))
    .join(" | ");
  // #7454 review (silent-failure-hunter + type-design-analyzer, achado
  // convergente, alta confiança): antes, `status` vinha SÓ de `guard.ok` —
  // uma falha real do refinamento por-link (rede, ou o shape ainda não
  // confirmado ao vivo do filtro por URL, ver `buildUrlClickFilterBody`)
  // saía como `status: "ok"` com o erro perdido dentro de `error`.
  // `pendingManifestEntries` só reoferece entries com `status !== "ok"` —
  // uma falha assim nunca seria retentada, e `manifestCoverageSummary`
  // contaria "100% ok" com o refinamento inteiro quebrado desde o 1º
  // broadcast. `urlClicksError` agora também força `status: "partial"`
  // (mesmo status já usado por "guard não bateu" — os 4 eixos principais
  // e o guard anti-fabricação continuam intocados por essa mudança,
  // `guard.ok` nunca é derivado de `urlClicksError`).
  const status = guard.ok && !urlClicksError ? "ok" : "partial";
  if (urlClicksError) {
    console.error(`  ⚠️  broadcast ${id}: ${combinedError}`);
  }
  return {
    entry: {
      id,
      label: broadcast.subject,
      status,
      counts,
      fetched_at: now,
      ...(combinedError ? { error: combinedError } : {}),
    },
    eventsNew,
    eventsAlreadyKnown,
  };
}

// ---------------------------------------------------------------------------
// Manifest I/O
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

export async function main(
  argv: string[] = process.argv.slice(2),
  // Injetável (#6586 self-review): permite testar `main()` ponta-a-ponta
  // com fixtures, sem rede real — produção nunca passa isto, cai no default.
  deps: KitIngestDeps = makeRealKitIngestDeps(),
): Promise<void> {
  loadProjectEnv();

  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const manifestPath = getArg(argv, "manifest") || DEFAULT_MANIFEST_PATH;
  const limit = getIntArg(argv, "limit", { min: 1 });
  const broadcastFilter = getIntArg(argv, "broadcast", { min: 1 });

  const dbDir = dirname(dbPath);
  const dataRoot = dirname(dbDir);
  if (!existsSync(dataRoot)) {
    console.error(`❌ data/ não existe: ${dataRoot} (ver CLAUDE.md setup, passo 2b)`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  const db = openDiariaSubscribersDb(dbPath);

  // -------------------------------------------------------------------------
  // Passo 1 (#7174): ingestão de ROSTER — popula `subscription`, que a
  // ingestão de audiência por broadcast abaixo nunca tocava. Escritor único
  // (mesma disciplina de `data/run-log.jsonl` fork por máquina): execução
  // MANUAL é dry-run por padrão; `--write` explícito grava de verdade. A
  // task agendada no `helios` (Diaria-Kit-Roster-Ingest,
  // scripts/lib/scheduled-tasks.ts) sempre passa `--write`.
  // -------------------------------------------------------------------------
  const capturaLogPath = getArg(argv, "captura-log") || DEFAULT_CAPTURA_LOG_PATH;
  const shouldWriteRoster = hasFlag(argv, "write");
  const skipRoster = hasFlag(argv, "skip-roster"); // #6586-only regression fixtures não têm listAllRosterSubscribers
  let rosterSummary: { total: number; written: boolean; novosGravados: number; eventosEstado: number } | null = null;

  if (!skipRoster) {
    const capturaLogDir = dirname(capturaLogPath);
    if (shouldWriteRoster) {
      if (existsSync(capturaLogDir)) {
        const siblingConflicts = detectSiblingConflictFiles(readdirSync(capturaLogDir), "captura-log.jsonl");
        if (siblingConflicts.length > 0) {
          console.error(
            `❌ cópias de conflito do OneDrive detectadas em ${capturaLogDir}: ${siblingConflicts.join(", ")} — ` +
              `abortando a escrita do roster (escritor único, ver docstring de detectSiblingConflictFiles).`,
          );
          process.exitCode = 1;
          db.close();
          return;
        }
      }
    }

    console.error(`📇 listando roster completo do Kit (status: "all")${shouldWriteRoster ? "" : " [dry-run — passe --write pra gravar]"}…`);
    const roster = await deps.listAllRosterSubscribers();
    console.error(`  …${roster.length} assinante(s) no roster.`);

    if (shouldWriteRoster) {
      const capturedAt = new Date().toISOString();
      const result = ingestKitRoster(db, roster, capturedAt);
      mkdirSync(capturaLogDir, { recursive: true });
      const eventosEstado = result.subscribeEvents.newEvents + result.unsubEvents.newEvents;
      const logEntry = buildCapturaLogEntry({
        platform: "kit",
        capturedAt,
        totalRetornadoApi: roster.length,
        novosGravados: result.subscribeEvents.newEvents,
        eventosEstado,
        exit: 0,
        // #7179 (F7): distingue esta linha (série viva, por-EXECUÇÃO) das
        // linhas por-DIA que o backfill histórico escreve.
        origemSerie: "kit-vivo",
      });
      appendFileSync(capturaLogPath, serializeCapturaLogEntry(logEntry));
      rosterSummary = { total: roster.length, written: true, novosGravados: result.subscribeEvents.newEvents, eventosEstado };
      console.error(
        `  …roster gravado: ${result.subscriptionsWritten} subscription(s), ${result.subscribeEvents.newEvents} novo(s) cadastro(s), ${eventosEstado} evento(s) de estado.`,
      );
    } else {
      rosterSummary = { total: roster.length, written: false, novosGravados: 0, eventosEstado: 0 };
    }
  }

  console.error("📇 listando broadcasts completados do Kit…");
  const broadcasts = await deps.listAllBroadcasts();
  console.error(`  …${broadcasts.length} broadcast(s) completados.`);

  let manifest = loadManifest(manifestPath);
  manifest = mergeManifestEntries(
    manifest,
    broadcasts.map((b) => ({ id: String(b.id), label: b.subject })),
    new Date().toISOString(),
  );
  saveManifest(manifestPath, manifest);

  const byId = new Map(broadcasts.map((b) => [String(b.id), b]));
  let pending = pendingManifestEntries(manifest).filter((e) => byId.has(e.id));
  if (broadcastFilter !== undefined) pending = pending.filter((e) => e.id === String(broadcastFilter));
  if (limit !== undefined) pending = pending.slice(0, limit);

  console.error(`🔎 ${pending.length} broadcast(s) pendente(s) de ${broadcasts.length} total.`);

  let eventsNewTotal = 0;
  let eventsAlreadyKnownTotal = 0;
  let processed = 0;

  for (const entry of pending) {
    const broadcast = byId.get(entry.id)!;
    const outcome = await ingestOneBroadcast(db, broadcast, deps);
    manifest = upsertManifestEntry(manifest, outcome.entry);
    saveManifest(manifestPath, manifest); // durável a cada broadcast — retomável em qualquer ponto
    eventsNewTotal += outcome.eventsNew;
    eventsAlreadyKnownTotal += outcome.eventsAlreadyKnown;
    processed++;
    console.error(
      `  …[${processed}/${pending.length}] broadcast ${entry.id} (${outcome.entry.status}) — ` +
        `${outcome.eventsNew} evento(s) novo(s), ${outcome.eventsAlreadyKnown} já conhecido(s)`,
    );
    if (processed < pending.length) await deps.sleep(BROADCAST_PACING_MS);
  }

  db.close();

  const coverage = manifestCoverageSummary(manifest);
  console.log(
    JSON.stringify(
      {
        db: dbPath,
        manifest: manifestPath,
        roster: rosterSummary,
        broadcasts_total: broadcasts.length,
        processed_this_run: processed,
        events_new: eventsNewTotal,
        events_already_known: eventsAlreadyKnownTotal,
        coverage,
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[diaria-subscribers-ingest-kit] erro fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
