#!/usr/bin/env node
/**
 * diaria-subscribers-ingest-beehiiv.ts (#6464 fatia 3b — #7104)
 *
 * Ingere no store unificado (`scripts/lib/diaria-subscribers-db.ts`) os
 * eventos por assinante × post da Beehiiv, lendo o backup local já drenado
 * pela fatia 1 (`beehiiv-engagement-backup` agent, #6465/#6733):
 * `data/beehiiv-backup/subscriber-engagement/{post_id}.jsonl` + o
 * `manifest.json` irmão (`scripts/lib/beehiiv-engagement-manifest.ts`).
 *
 * **Sem rede** — ao contrário de `diaria-subscribers-ingest-kit.ts`/
 * `-brevo.ts`, este builder nunca chama a API/MCP da Beehiiv; o dado já
 * está em disco no formato certo (ver corpo da issue #7104). Molde exato
 * do par Kit pro resto do desenho (miolo puro separado, manifest próprio
 * retomável, guard anti-fabricação) — só a camada de I/O troca rede por
 * leitura de arquivo.
 *
 * Miolo puro (derivação de eixos, chave natural, guard, escrita
 * idempotente): `scripts/lib/beehiiv-subscribers-ingest.ts`. Este arquivo é
 * só I/O — lê o manifest da fatia 1 + os `.jsonl`, escreve no store, mantém
 * o manifest PRÓPRIO desta ingestão (retomada independente da fatia 1).
 *
 * ## Só posts `status: "ok"` no manifest da fatia 1 entram
 *
 * Um post `pending`/`partial`/`error` na fatia 1 ainda não tem cobertura
 * confirmada — ingerir um JSONL parcial e marcar como concluído aqui
 * esconderia o buraco. Post `not_applicable` (nunca enviado, ver
 * `beehiiv-engagement-manifest.ts`) não tem engajamento a ingerir — esta
 * ingestão marca a entry PRÓPRIA como `ok` com 0 registros, pra não ficar
 * pendente pra sempre esperando um dado que não existe.
 *
 * ## Retomável — `beehiiv-ingest-manifest.json`
 *
 * Mesmo padrão do Kit (`diaria-subscribers-ingest-manifest.ts`, genérico):
 * 1 entry por post_id, status `ok`/`partial`/`error`. Re-rodar só refaz o
 * que ainda não está `ok` — nunca reprocessa um post já confirmado.
 *
 * ## Guard anti-fabricação (#6496)
 *
 * Um post só vira `ok` no manifest desta ingestão se a contagem de
 * registros PROCESSADOS (identidade resolvida) bater exatamente com o
 * `count` que o manifest da fatia 1 registrou pra esse post
 * (`verifyBeehiivIngestion`, `beehiiv-subscribers-ingest.ts`) — divergência
 * marca `partial` (os eventos já processados são gravados mesmo assim,
 * idempotente; a re-rodada seguinte tenta de novo, útil se o backup da
 * fatia 1 for corrigido/reextraído entretanto).
 *
 * ## Identidade
 *
 * `identity_alias.email` é gravado para todo registro com e-mail utilizável
 * (via `ensureSubscriber`) — é o que permite `resolveIdentitiesByEmail`
 * (#6589, `diaria-subscribers-resolve-identity.ts`) fundir a Beehiiv com
 * Kit/Brevo depois, por e-mail canonicalizado. Nenhuma canonicalização é
 * feita AQUI (mesmo desenho do Kit/Brevo) — só trim+lowercase; a fusão
 * cross-plataforma é passo separado, deliberadamente.
 *
 * Uso:
 *   npx tsx scripts/diaria-subscribers-ingest-beehiiv.ts [--db <p>]
 *     [--manifest <p>] [--source-dir <p>] [--limit N] [--post <post_id>] [--reset]
 *     [--roster-root <p>] [--skip-roster]
 *
 * Sem rede nenhuma — não requer nenhuma API key. Stdout: JSON summary.
 * Stderr: progresso.
 *
 * ## `--reset` — reingestão do zero (#7181)
 *
 * Apaga o `.db` (`--db`, default `DEFAULT_DB_PATH`) e o manifest PRÓPRIO
 * desta ingestão (`--manifest`, default `DEFAULT_MANIFEST_PATH`) antes de
 * rodar — nunca limpa in-place: `event` tem chave natural `(platform, type,
 * external_event_id)` e um alias fantasma pode ter resolvido eventos reais
 * para o `subscriber` errado, então desfazer seletivamente é mais arriscado
 * que reconstruir (decisão do editor, corpo da issue #7181). Só apagar o
 * `.db` sem apagar o manifest PRÓPRIO não reingere nada — o manifest desta
 * ingestão marca os posts como `ok` e `pendingManifestEntries` os pula.
 *
 * `--reset` apaga os dois arquivos que ESTA ingestão possui (`--db` +
 * `--manifest`) — nunca o manifest da fatia 1
 * (`data/beehiiv-backup/subscriber-engagement/manifest.json`, fonte
 * READ-ONLY desta ingestão). O `--db` compartilha o store unificado com
 * outras plataformas (Kit, Brevo — `scripts/diaria-subscribers-ingest-
 * {kit,brevo}.ts`) já ingeridas, então `--reset` apaga os dados delas
 * também (é o MESMO arquivo `.db`, reconstruído do zero só com Beehiiv).
 *
 * ## `--reset` invalida os manifests IRMÃOS (#7298)
 *
 * Kit e Brevo mantêm manifest PRÓPRIO (`kit-ingest-manifest.json`,
 * `brevo-ingest-manifest.json`, mesmo diretório do `.db`) que decide
 * idempotência olhando só pra si mesmo — nenhum dos dois sabia que o `.db`
 * tinha sido trocado por baixo. Sem isso, depois de um `--reset` da
 * Beehiiv o manifest do Kit continuava dizendo `ok` para broadcasts cujo
 * `event` acabou de ser destruído junto com o `.db` velho, e
 * `kit-subscribers-ingest.ts` relatava "0 pendentes / cobertura 100%" —
 * perda silenciosa com o sistema afirmando saúde total (achado ao vivo,
 * corpo da issue #7298). Por isso, depois da instalação atômica do store
 * novo (nunca antes — um `--reset` que aborta no meio não deve invalidar
 * nada, o `.db` velho continua valendo), este script também apaga
 * `kit-ingest-manifest.json` e `brevo-ingest-manifest.json` se existirem
 * ao lado do `.db`. Brevo já se autocura sozinho (full re-sync sempre,
 * nunca lê pendência do próprio manifest — ver docstring de
 * `diaria-subscribers-ingest-brevo.ts`), então invalidar o dele aqui é só
 * defensivo; o Kit é quem de fato depende disto para não mentir cobertura.
 * Reingerir as outras plataformas continua sendo passo manual de quem roda
 * o comando — o que muda é que elas agora SABEM que precisam rodar, em vez
 * de acharem (erradamente) que já estão em dia.
 *
 * ## `--reset` é atômico entre máquinas (#7187)
 *
 * O store novo NÃO é escrito por cima do atual: com `--reset`, toda a
 * reingestão roda num `.db` de TRABALHO no mesmo diretório
 * (`atomicRebuildTempPath`) e só no fim, com o store completo e a conexão
 * fechada, `atomicCommitRebuild` o instala por `rename` atômico. Motivação:
 * o `.db` é sincronizado via OneDrive entre as máquinas do projeto — o
 * padrão antigo (apagar e recriar no lugar) propagava a DELEÇÃO antes da
 * recriação terminar, deixando a outra máquina sem store nenhum, só com os
 * sidecars `-wal`/`-shm` órfãos (estado inválido). Agora ela vê o store
 * VELHO (dados desatualizados, estado válido) durante toda a janela —
 * ausência → desatualização. Duas consequências de borda:
 *
 * - Se a run morre no meio (crash, `--limit` interrompido), o store VELHO
 *   segue intacto no lugar e o lixo do build é varrido na próxima run com
 *   `--reset`. Antes, morrer entre apagar e recriar deixava o store
 *   destruído.
 * - Se o manifest da fatia 1 (fonte) não estiver disponível, a run aborta
 *   ANTES de qualquer troca — o store atual permanece (antes, o `--reset`
 *   apagava primeiro e só então descobria que não tinha fonte).
 *
 * ## Passo do ROSTER — popula `subscription` (#7229)
 *
 * O passo de engajamento acima (posts × assinante) nunca teve `status`/
 * `created`/UTM — por isso nenhum ingest Beehiiv chamava `upsertSubscription`
 * e a dimensão `subscription` seguia com ZERO linhas mesmo com o store
 * cheio de `subscriber`/`event` (#7229, medido em master). Essa informação
 * vem do snapshot semanal `data/beehiiv-backup/{YYYY-MM-DD}/
 * subscribers.jsonl` (`backup-beehiiv.ts`) — depois do passo de engajamento
 * acima, `main` lê o snapshot MAIS RECENTE sob `--roster-root` (default
 * `data/beehiiv-backup`) e chama `ingestBeehiivRoster`
 * (`beehiiv-subscribers-ingest.ts`) uma vez por execução. Sem manifest
 * próprio — `upsertSubscription`/`recordEvent` já são idempotentes, e
 * reprocessar o snapshot inteiro a cada rodada é barato (é 1 upsert por
 * assinante, sem I/O de rede). `--skip-roster` pula este passo (útil pra
 * testar só o passo de engajamento, ou numa máquina sem snapshot ainda).
 * Nenhum snapshot encontrado é `warn`, não erro fatal — o passo de
 * engajamento continua valendo mesmo sem `subscribers.jsonl`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { getArg, getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import {
  DEFAULT_DB_PATH,
  atomicCommitRebuild,
  atomicRebuildTempPath,
  openDiariaSubscribersDb,
  getStoreCounts,
} from "./lib/diaria-subscribers-db.ts";
import {
  ingestPostEngagement,
  verifyBeehiivIngestion,
  ingestBeehiivRoster,
  type BeehiivEngagementRecord,
} from "./lib/beehiiv-subscribers-ingest.ts";
import { latestSnapshotDate, readSnapshotSubscribers } from "./lib/beehiiv-backup-snapshots.ts";
import {
  type EngagementManifest,
  type EngagementManifestEntry,
} from "./lib/beehiiv-engagement-manifest.ts";
import {
  buildInitialManifest,
  mergeManifestEntries,
  upsertManifestEntry,
  pendingManifestEntries,
  manifestCoverageSummary,
  type IngestManifest,
  type IngestManifestEntry,
} from "./lib/diaria-subscribers-ingest-manifest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_SOURCE_DIR = resolve(ROOT, "data/beehiiv-backup/subscriber-engagement");
export const DEFAULT_MANIFEST_PATH = resolve(dirname(DEFAULT_DB_PATH), "beehiiv-ingest-manifest.json");
/** Raiz dos snapshots semanais (`{YYYY-MM-DD}/subscribers.jsonl`) — passo
 *  do roster (#7229), fonte diferente do passo de engajamento acima. */
export const DEFAULT_ROSTER_ROOT = resolve(ROOT, "data/beehiiv-backup");

// ---------------------------------------------------------------------------
// Leitura do backup da fatia 1 (manifest.json + {post_id}.jsonl)
// ---------------------------------------------------------------------------

/** Lê o manifest.json da fatia 1 (`beehiiv-engagement-backup`) — `null` se
 *  ausente ou ilegível (backup nunca rodou, ou `data/` ausente). */
export function loadSourceEngagementManifest(sourceDir: string): EngagementManifest | null {
  const path = resolve(sourceDir, "manifest.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EngagementManifest;
  } catch {
    return null;
  }
}

/** Parseia o JSONL de 1 post — 1 linha = 1 registro cru da MCP (ver
 *  `apply-mcp-subscriber-engagement.ts`, mesmo formato). Linha malformada é
 *  ignorada (contada como registro perdido pelo guard — o count esperado do
 *  manifest não vai bater, então o post não vira `ok` silenciosamente). */
export function readPostRecords(sourceDir: string, postId: string): BeehiivEngagementRecord[] {
  const path = resolve(sourceDir, `${postId}.jsonl`);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  const out: BeehiivEngagementRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as BeehiivEngagementRecord);
    } catch {
      // linha corrompida — ignorada, o guard de contagem abaixo detecta o gap.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ingestão de 1 post (fail-soft — nunca lança, vira entry "error")
// ---------------------------------------------------------------------------

export interface PostIngestOutcome {
  entry: IngestManifestEntry;
  eventsNew: number;
  eventsAlreadyKnown: number;
}

/**
 * Ingere 1 post a partir do JSONL local + a entry correspondente do
 * manifest da fatia 1 (já filtrada por `status: "ok"`/`"not_applicable"`
 * pelo chamador — ver `main`). Nunca lança: erro de parse/IO vira entry
 * `"error"`, mesmo padrão fail-soft do Kit/Brevo.
 */
export function ingestOnePost(
  db: DatabaseSync,
  sourceDir: string,
  sourceEntry: Pick<EngagementManifestEntry, "post_id" | "title" | "status" | "count">,
  now: string = new Date().toISOString(),
): PostIngestOutcome {
  const id = sourceEntry.post_id;

  if (sourceEntry.status === "not_applicable") {
    return {
      entry: { id, label: sourceEntry.title, status: "ok", counts: { records: 0 }, fetched_at: now },
      eventsNew: 0,
      eventsAlreadyKnown: 0,
    };
  }

  try {
    const records = readPostRecords(sourceDir, id);
    const result = ingestPostEngagement(db, id, records, now);

    // Guard anti-fabricação (#6496) exige um `count` EXPLÍCITO do manifest
    // da fatia 1 — nunca cair pra `records.length` como fallback: isso
    // compararia a lista lida contra si mesma, e o guard passaria
    // trivialmente mesmo com um JSONL truncado (achado de review, PR #7135).
    // Os eventos já lidos são gravados mesmo assim (idempotente, mesmo
    // espírito do guard normal — nunca descarta trabalho já feito), mas a
    // entry nunca vira "ok"/"partial": um `count` ausente é tratado como
    // erro explícito, não como "sem discrepância".
    if (sourceEntry.count === undefined || sourceEntry.count === null) {
      return {
        entry: {
          id,
          label: sourceEntry.title,
          status: "error",
          counts: {
            records_lidos: records.length,
            records_processados: result.recordsProcessed,
            records_sem_identidade: result.recordsSkippedNoIdentity,
          },
          fetched_at: now,
          error:
            `manifest da fatia 1 não registrou "count" pra este post — guard anti-fabricação (#6496) ` +
            `exige count explícito; nunca cair pra records.length (compararia a lista contra si mesma).`,
        },
        eventsNew: result.newEvents,
        eventsAlreadyKnown: result.alreadyKnown,
      };
    }

    const guard = verifyBeehiivIngestion(result.recordsProcessed, sourceEntry.count);

    return {
      entry: {
        id,
        label: sourceEntry.title,
        status: guard.ok ? "ok" : "partial",
        counts: {
          records_lidos: records.length,
          records_processados: result.recordsProcessed,
          records_sem_identidade: result.recordsSkippedNoIdentity,
          manifest_count: sourceEntry.count,
        },
        fetched_at: now,
        ...(guard.reason ? { error: guard.reason } : {}),
      },
      eventsNew: result.newEvents,
      eventsAlreadyKnown: result.alreadyKnown,
    };
  } catch (e) {
    return {
      entry: { id, label: sourceEntry.title, status: "error", error: e instanceof Error ? e.message : String(e), fetched_at: now },
      eventsNew: 0,
      eventsAlreadyKnown: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Manifest I/O (desta ingestão — separado do manifest da fatia 1)
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

/** Manifests de ingestões IRMÃS que vivem no mesmo diretório do `.db`
 *  compartilhado — nomes hardcoded (em vez de importados de
 *  `diaria-subscribers-ingest-{kit,brevo}.ts`) porque a invalidação segue a
 *  dir do `.db` que ESTE reset de fato instalou, não o `DEFAULT_DB_PATH` que
 *  o script irmão calcularia por conta própria com um `--db` customizado
 *  diferente (ver #7298). */
const SIBLING_MANIFEST_FILENAMES = ["kit-ingest-manifest.json", "brevo-ingest-manifest.json"];

/**
 * Apaga (se existirem) os manifests das ingestões irmãs no mesmo diretório
 * do `.db` recém-instalado — chamado só DEPOIS do swap atômico ter
 * sucedido (#7298; ver docstring do módulo "`--reset` invalida os
 * manifests IRMÃOS"). Devolve os paths de fato removidos, pra log/summary.
 *
 * Best-effort por arquivo (achado do review, #7298) — mesmo padrão dos
 * outros `rmSync` deste módulo que vivem na mesma janela pós-swap
 * (`atomicCommitRebuild`, sidecars `-wal`/`-shm`/`-journal`): o `.db` e os
 * manifests irmãos moram em `data/diaria-subscribers/`, junctioned pro
 * OneDrive, que segura arquivos por ~100-500ms durante sync no Windows. Se
 * `rmSync` lançasse sem `try/catch`, uma corrida de lock (a) faria a run
 * terminar com `exitCode: 1` mesmo com o reset do `.db` já tendo tido
 * sucesso, e (b) uma falha no 1º arquivo do loop faria o 2º nunca ser
 * tentado — os dois sintomas piores do que o problema que esta função
 * existe pra resolver. Falha vira warning no stderr; a invalidação
 * pendente é inerte (o pior caso é o manifest ficar `ok` por mais um
 * ciclo, exatamente o estado PRÉ-fix, não um estado novo).
 */
export function invalidateSiblingManifests(dbPath: string): string[] {
  const dir = dirname(dbPath);
  const removed: string[] = [];
  for (const filename of SIBLING_MANIFEST_FILENAMES) {
    const p = resolve(dir, filename);
    if (existsSync(p)) {
      try {
        rmSync(p, { force: true });
        removed.push(p);
      } catch (e) {
        console.error(
          `⚠️  --reset: falha ao invalidar manifest irmão ${p} (${(e as Error).message}) — ` +
            `best-effort, seguindo (#7298).`,
        );
      }
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const manifestPath = getArg(argv, "manifest") || DEFAULT_MANIFEST_PATH;
  const sourceDir = getArg(argv, "source-dir") || DEFAULT_SOURCE_DIR;
  const rosterRoot = getArg(argv, "roster-root") || DEFAULT_ROSTER_ROOT;
  const limit = getIntArg(argv, "limit", { min: 1 });
  const postFilter = getStringArg(argv, "post");
  const reset = hasFlag(argv, "reset");
  const skipRoster = hasFlag(argv, "skip-roster");

  const dbDir = dirname(dbPath);
  const dataRoot = dirname(dbDir);
  if (!existsSync(dataRoot)) {
    console.error(`❌ data/ não existe: ${dataRoot} (ver CLAUDE.md setup, passo 2b)`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  // Reingestão do zero (#7181) — nunca limpar in-place, ver docstring do
  // módulo. Apaga só o manifest PRÓPRIO desta ingestão; o manifest da fatia
  // 1 (fonte, read-only) nunca é tocado.
  //
  // O `.db` NÃO é apagado aqui (#7187): com `--reset`, toda a reingestão
  // abaixo roda num `.db` de TRABALHO no mesmo diretório
  // (`atomicRebuildTempPath`) e só no fim, com o store completo e fechado,
  // `atomicCommitRebuild` o instala por `rename` atômico. O consumidor da
  // outra máquina (o `.db` é sincronizado via OneDrive) vê o store VELHO
  // (dados desatualizados, estado válido) durante toda a janela — nunca o
  // estado inválido "só sidecars `-wal`/`-shm` sem `.db`" que o apagar-e-
  // recriar produzia. Se esta run abortar no meio (fonte ausente, crash),
  // o store velho segue intacto e o lixo do build é varrido na próxima.
  let workingDbPath = dbPath;
  let rebuildTmpPath: string | null = null;
  if (reset) {
    rebuildTmpPath = atomicRebuildTempPath(dbPath);
    workingDbPath = rebuildTmpPath;
    console.error(
      `🧱 --reset: store novo será construído em ${rebuildTmpPath} (swap atômico no fim, #7187)`,
    );
    if (existsSync(manifestPath)) {
      rmSync(manifestPath);
      console.error(`🗑️  --reset: removido ${manifestPath}`);
    }
  }

  const sourceManifest = loadSourceEngagementManifest(sourceDir);
  if (!sourceManifest) {
    console.error(
      `❌ manifest.json da fatia 1 não encontrado/ilegível em ${sourceDir} — ` +
        `rode o agent \`beehiiv-engagement-backup\` primeiro (ver #6465).`,
    );
    process.exitCode = 1;
    return;
  }

  // Só posts com cobertura confirmada (`ok`) ou sem engajamento a drenar
  // (`not_applicable`) entram — `pending`/`partial`/`error` na fatia 1 ainda
  // não têm dado confiável pra ingerir aqui.
  const readySourceEntries = sourceManifest.posts.filter((p) => p.status === "ok" || p.status === "not_applicable");
  console.error(
    `📇 manifest da fatia 1: ${sourceManifest.posts.length} post(s) total, ${readySourceEntries.length} pronto(s) pra ingestão.`,
  );

  let manifest = loadManifest(manifestPath);
  manifest = mergeManifestEntries(
    manifest,
    readySourceEntries.map((p) => ({ id: p.post_id, label: p.title })),
    new Date().toISOString(),
  );
  saveManifest(manifestPath, manifest);

  const byId = new Map(readySourceEntries.map((p) => [p.post_id, p]));
  let pending = pendingManifestEntries(manifest).filter((e) => byId.has(e.id));
  if (postFilter !== undefined) pending = pending.filter((e) => e.id === postFilter);
  if (limit !== undefined) pending = pending.slice(0, limit);

  console.error(`🔎 ${pending.length} post(s) pendente(s) de ${readySourceEntries.length} pronto(s).`);

  const db = openDiariaSubscribersDb(workingDbPath);
  let eventsNewTotal = 0;
  let eventsAlreadyKnownTotal = 0;
  let processed = 0;

  for (const entry of pending) {
    const sourceEntry = byId.get(entry.id)!;
    const outcome = ingestOnePost(db, sourceDir, sourceEntry);
    manifest = upsertManifestEntry(manifest, outcome.entry);
    saveManifest(manifestPath, manifest); // durável a cada post — retomável em qualquer ponto
    eventsNewTotal += outcome.eventsNew;
    eventsAlreadyKnownTotal += outcome.eventsAlreadyKnown;
    processed++;
    console.error(
      `  …[${processed}/${pending.length}] post ${entry.id} (${outcome.entry.status}) — ` +
        `${outcome.eventsNew} evento(s) novo(s), ${outcome.eventsAlreadyKnown} já conhecido(s)`,
    );
  }

  // Passo do roster (#7229) — popula `subscription`, fonte diferente do
  // loop de engajamento acima (ver docstring do módulo). Roda uma vez por
  // execução, depois do passo de engajamento; idempotente, sem manifest
  // próprio (upsertSubscription/recordEvent já dedupe).
  let rosterResult: ReturnType<typeof ingestBeehiivRoster> | null = null;
  let rosterSnapshotDate: string | null = null;
  if (!skipRoster) {
    rosterSnapshotDate = latestSnapshotDate(rosterRoot);
    if (rosterSnapshotDate) {
      const rosterSubscribers = readSnapshotSubscribers(rosterRoot, rosterSnapshotDate);
      console.error(
        `📇 roster: snapshot ${rosterSnapshotDate} (${rosterSubscribers.length} assinante(s)) sob ${rosterRoot}.`,
      );
      rosterResult = ingestBeehiivRoster(db, rosterSubscribers);
      console.error(
        `  …roster: ${rosterResult.subscriptionsWritten} subscription(s) escrita(s), ` +
          `${rosterResult.subscribeEvents.newEvents} subscribe novo(s), ` +
          `${rosterResult.unsubEvents.newEvents} unsub novo(s), ` +
          `${rosterResult.recordsSkippedNoEmail} sem e-mail pulado(s)`,
      );
    } else {
      console.error(`⚠️  roster: nenhum snapshot encontrado sob ${rosterRoot} — subscription não populada nesta rodada.`);
    }
  }

  const storeCounts = getStoreCounts(db);
  db.close();

  // Instalação atômica do store novo (#7187) — só depois de TODO o build
  // completo e a conexão fechada. A partir daqui, o `dbPath` definitivo é ou
  // o store velho (se o rename falhar — exceção propagada, run aborta) ou o
  // novo completo; nunca partial nem ausente.
  let invalidatedSiblingManifests: string[] = [];
  if (rebuildTmpPath) {
    atomicCommitRebuild(rebuildTmpPath, dbPath);
    console.error(`✅ --reset: store novo instalado atomicamente em ${dbPath} (#7187)`);

    // #7298: só invalida os manifests irmãos DEPOIS do swap ter sucesso —
    // se a run tivesse abortado antes, o `.db` velho (com dado do Kit/Brevo
    // intacto) continuaria valendo, e apagar o manifest deles seria
    // invalidação sem motivo.
    invalidatedSiblingManifests = invalidateSiblingManifests(dbPath);
    for (const p of invalidatedSiblingManifests) {
      console.error(`🗑️  --reset: manifest irmão invalidado ${p} (#7298 — força reingestão na próxima rodada)`);
    }
  }

  const coverage = manifestCoverageSummary(manifest);
  console.log(
    JSON.stringify(
      {
        db: dbPath,
        manifest: manifestPath,
        source_dir: sourceDir,
        source_posts_ready: readySourceEntries.length,
        processed_this_run: processed,
        events_new: eventsNewTotal,
        events_already_known: eventsAlreadyKnownTotal,
        coverage,
        roster: {
          skipped: skipRoster,
          root: rosterRoot,
          snapshot_date: rosterSnapshotDate,
          result: rosterResult,
        },
        store_counts: storeCounts,
        reset_invalidated_sibling_manifests: invalidatedSiblingManifests,
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[diaria-subscribers-ingest-beehiiv] erro fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
