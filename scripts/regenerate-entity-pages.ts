#!/usr/bin/env node
/**
 * scripts/regenerate-entity-pages.ts (#5125 — condição do editor 14/08/2026:
 * "prova de conceito com UMA página, publicada em host nosso... a página
 * nasce com regeneração automática... senão vira mais um artefato que
 * degrada sozinho — é literalmente o que já acontece com os hubs, #5123 e
 * #5124")
 *
 * Task diária que faz as DUAS metades da "regeneração automática" das
 * páginas de entidade (`workers/artigos/public/entidades/{slug}/index.html`,
 * `scripts/lib/entities/{slug}.ts`, `ENTITY_LOADERS` em
 * `scripts/build-entity-page.ts`):
 *
 * **1. Mecânica — o HTML servido nunca fica atrás do `EntityContent` fonte.**
 * Para cada entidade em `ENTITY_LOADERS`, re-renderiza o HTML a partir do
 * módulo TS committed e sobrescreve o asset SE divergir do que já está em
 * disco (ex: `entity-page.ts`/`curadoria-page.ts`/design tokens mudaram e
 * ninguém rodou `build-entity-page.ts --all` à mão depois). Sem risco
 * editorial — a saída é 100% determinística a partir de dado já commitado
 * (mesma garantia que `test/build-entity-page.test.ts` já verifica em CI);
 * quando nada mudou, é puro no-op.
 *
 * **2. Detecção com aging — a página nunca fica desatualizada em
 * SILÊNCIO.** Espelha `scripts/hub-staleness-check.ts` (#5123, já em
 * produção pro problema irmão dos hubs): roda
 * `findStaleEntityMentions`/`computeFirstSeenMap`/`computeAgedStale`/
 * `filterOverdue` (`scripts/lib/entity-staleness-check.ts`) contra o
 * corpus sincronizado e alarma por e-mail (idempotente por fingerprint)
 * quando uma edição casa o padrão de uma entidade publicada, ainda não
 * está no `mentions` dela, e já passou do limiar de dias (default 3 — a
 * data de 1ª detecção é persistida entre execuções, então uma edição
 * detectada hoje não alarma imediatamente). Esta parte é DETECÇÃO, não
 * correção — escrever a entrada nova exige síntese editorial (ler
 * `content.free.web`, sintetizar 1-3 frases próprias), que este script não
 * tenta fazer sozinho (ver docstring de `entity-staleness-check.ts` para o
 * racional completo, espelhando a decisão já registrada em #5123 item 4
 * pro problema irmão dos hubs: "só alarmar" em vez de auto-commitar prosa
 * gerada sem revisão).
 *
 * Juntas, as 2 metades cumprem a condição do editor: a página nunca
 * silenciosamente regride (parte 1: o HTML nunca diverge do que o código diz
 * que deveria ser) nem silenciosamente estagna (parte 2: uma edição nova
 * relevante nunca passa despercebida além do limiar — vira e-mail, não vira
 * nada).
 *
 * Uso:
 *   npx tsx scripts/regenerate-entity-pages.ts                       # roda as 2 partes, alarma se vencido
 *   npx tsx scripts/regenerate-entity-pages.ts --dry-run              # avalia + imprime, não escreve/persiste/alarma
 *   npx tsx scripts/regenerate-entity-pages.ts --threshold-days 5     # override do limiar de alarme (default 3)
 *   npx tsx scripts/regenerate-entity-pages.ts --to email@x           # override do destinatário do alarme
 *
 * **Fail-soft na Parte 2, NUNCA bloqueia (#2643, label `local`, mesmo
 * contrato de `hub-staleness-check.ts`).** O cache Beehiiv só existe com o
 * junction `data/` (OneDrive) populado — em sessão cloud, ou antes do 1º
 * `beehiiv-sync.ts`, o diretório não existe. Tratado como "nada a
 * detectar", não como erro: a Parte 1 (regen mecânica, que só depende de
 * código já commitado) roda mesmo assim; só a Parte 2 é pulada com aviso em
 * stderr e exit 0. `data/.credentials.json` com o scope `gmail.send` só é
 * necessário quando há pendência vencida pra de fato alarmar.
 *
 * Estado: `data/entities/staleness-state.json` (idempotência do alarme +
 * memória de 1ª-detecção, mesmo par de campos de `hub-staleness-check.ts`'s
 * `PersistedState`) — `data/entities/staleness-{YYYY-MM-DD}.json` (snapshot
 * diário, histórico; sempre escrito, mesmo sem pendência).
 *
 * Como os outros alarmes locais deste repo (#4320/#4382/#4490/#4534/#4723/
 * #4740/#4750/#5123), o registro da task no systemd e a 1ª execução ao vivo
 * nunca rodaram nesta unidade (worktree isolado, sem `data/.credentials.json`
 * real) — a Parte 1 (regen mecânica) FOI validada ao vivo nesta unidade
 * (`npx tsx scripts/regenerate-entity-pages.ts --dry-run`, rodando contra o
 * `data/` real via junction OneDrive, ver PR); a Parte 2 (alarme) só via
 * teste com a lógica pura (sem rede/Gmail real).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { renderEntityPage } from "./lib/shared/entity-page.ts";
import { ENTITY_LOADERS } from "./build-entity-page.ts";
import { loadPosts } from "./generate-hub-sources.ts";
import {
  findStaleEntityMentions,
  computeFirstSeenMap,
  computeAgedStale,
  filterOverdue,
  shouldAlarmEntityStaleness,
  computeEntityStalenessFingerprint,
  advanceEntityStalenessState,
  buildEntityStalenessAlarmEmail,
  emptyEntityStalenessAlarmState,
  type EntityStalenessAlarmState,
  type StaleFirstSeenMap,
} from "./lib/entity-staleness-check.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = resolve(ROOT, "data/beehiiv-cache/posts");
const ENTITIES_DATA_DIR = resolve(ROOT, "data/entities");
const STATE_PATH = join(ENTITIES_DATA_DIR, "staleness-state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[regenerate-entity-pages]";
const DEFAULT_THRESHOLD_DAYS = 3;

// ─── Parte 1: regen mecânica do HTML ───────────────────────────────────────

function outPathFor(slug: string): string {
  return resolve(ROOT, `workers/artigos/public/entidades/${slug}/index.html`);
}

/** Re-renderiza cada entidade de `ENTITY_LOADERS` e sobrescreve o asset SE
 * divergir do que já está commitado. Retorna os slugs que foram
 * REESCRITOS (vazio = tudo já estava em dia, no-op). `dryRun: true` só
 * reporta o que mudaria, sem tocar disco. */
export function regenerateEntityHtml(dryRun: boolean): string[] {
  const rewritten: string[] = [];
  for (const [slug, loader] of Object.entries(ENTITY_LOADERS)) {
    const fresh = renderEntityPage(loader()); // lança se EntityContent for inválido — fail-fast, mesmo padrão de build-entity-page.ts
    const outPath = outPathFor(slug);
    const committed = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
    if (committed === fresh) continue;
    rewritten.push(slug);
    if (dryRun) {
      console.log(`${LOG_PREFIX} [dry-run] ${slug}: HTML divergiu do committed — regeneraria ${outPath}`);
      continue;
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileAtomic(outPath, fresh);
    console.log(`${LOG_PREFIX} ${slug}: HTML regenerado em ${outPath}`);
  }
  return rewritten;
}

// ─── Parte 2: detecção com aging — estado (idempotência + 1ª-detecção) ─────

interface PersistedState {
  alarm: EntityStalenessAlarmState;
  firstSeen: StaleFirstSeenMap;
}

function emptyPersistedState(): PersistedState {
  return { alarm: emptyEntityStalenessAlarmState(), firstSeen: {} };
}

export function loadState(statePath: string = STATE_PATH): PersistedState {
  if (!existsSync(statePath)) return emptyPersistedState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<PersistedState>;
    const firstSeen =
      raw.firstSeen && typeof raw.firstSeen === "object" && !Array.isArray(raw.firstSeen)
        ? (raw.firstSeen as StaleFirstSeenMap)
        : {};
    const alarm =
      raw.alarm && typeof raw.alarm === "object"
        ? {
            lastAlarmedFingerprint:
              typeof raw.alarm.lastAlarmedFingerprint === "string" ? raw.alarm.lastAlarmedFingerprint : null,
            lastCheckedAt: typeof raw.alarm.lastCheckedAt === "string" ? raw.alarm.lastCheckedAt : null,
          }
        : emptyEntityStalenessAlarmState();
    return { alarm, firstSeen };
  } catch {
    return emptyPersistedState();
  }
}

export function saveState(state: PersistedState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/** `YYYY-MM-DD` em UTC — mesma resolução de `hub-staleness-check.ts::todayISO`. */
function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const thresholdArg = getArg(argv, "threshold-days");
  const thresholdDays = thresholdArg ? Number.parseInt(thresholdArg, 10) : DEFAULT_THRESHOLD_DAYS;

  // Parte 1: regen mecânica — roda incondicionalmente, nunca depende do
  // corpus (só do que já está commitado em scripts/lib/entities/*.ts).
  const rewritten = regenerateEntityHtml(isDryRun);
  console.log(
    `${LOG_PREFIX} regen mecânica: ${rewritten.length === 0 ? "nada divergiu (no-op)" : `${rewritten.length} entidade(s) regenerada(s) — ${rewritten.join(", ")}`}.`,
  );

  // Parte 2: detecção de defasagem de conteúdo — precisa do junction data/.
  if (!existsSync(POSTS_DIR)) {
    console.warn(
      `${LOG_PREFIX} ⚠ ${POSTS_DIR} ausente — precisa do junction data/ (OneDrive) populado por beehiiv-sync.ts. Pulando detecção de defasagem (fail-soft, ver CLAUDE.md label "local").`,
    );
    return;
  }

  const posts = loadPosts();
  const mentionEditionSlugsBySlug: Record<string, Set<string>> = {};
  for (const [slug, loader] of Object.entries(ENTITY_LOADERS)) {
    mentionEditionSlugsBySlug[slug] = new Set(
      loader().mentions.map((m) => m.editionUrl.replace(/^https:\/\/diar\.ia\.br\/p\//, "")),
    );
  }
  const { stale, warnings } = findStaleEntityMentions(posts, mentionEditionSlugsBySlug);
  for (const w of warnings) console.warn(`${LOG_PREFIX} ⚠ ${w}`);

  const now = new Date();
  const today = todayISO(now);
  const state = loadState();
  const firstSeen = computeFirstSeenMap(stale, state.firstSeen, today);
  const aged = computeAgedStale(stale, firstSeen, today);
  const overdue = filterOverdue(aged, thresholdDays);

  console.log(
    `${LOG_PREFIX} ${stale.length} entrada(s) stale, ${overdue.length} vencida(s) (>= ${thresholdDays} dia(s)).`,
  );

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: snapshot NÃO persistido, alarme NÃO enviado, cursor NÃO avançado.`);
    if (shouldAlarmEntityStaleness(state.alarm, overdue)) {
      const { subject, body } = buildEntityStalenessAlarmEmail(overdue, thresholdDays, now);
      console.log(`${LOG_PREFIX} --dry-run: alarmaria com:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    }
    return;
  }

  // Snapshot diário — sempre escrito, mesmo sem pendência (confirma que a
  // task de fato rodou naquele dia, mesmo padrão de hub-staleness-check.ts).
  mkdirSync(ENTITIES_DATA_DIR, { recursive: true });
  const snapshotPath = join(ENTITIES_DATA_DIR, `staleness-${today}.json`);
  writeFileAtomic(snapshotPath, JSON.stringify({ date: today, thresholdDays, stale: aged }, null, 2) + "\n");
  console.log(`${LOG_PREFIX} snapshot gravado em ${snapshotPath}.`);

  let nextAlarmState = state.alarm;
  if (shouldAlarmEntityStaleness(state.alarm, overdue)) {
    const { subject, body } = buildEntityStalenessAlarmEmail(overdue, thresholdDays, now);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    // Sem try/catch de propósito (mesmo racional de hub-staleness-check.ts):
    // se o envio falhar, o cursor não avança, e a próxima execução tenta
    // alarmar de novo em vez de marcar como "já avisado" sem o editor ter
    // recebido nada.
    await sendGmailMessage(to, subject, body);
    console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (${overdue.length} vencida(s)).`);
    nextAlarmState = advanceEntityStalenessState(computeEntityStalenessFingerprint(overdue), now);
  } else if (overdue.length > 0) {
    console.log(`${LOG_PREFIX} ${overdue.length} vencida(s), mas o mesmo conjunto já foi alarmado antes — sem novo e-mail.`);
  } else {
    console.log(`${LOG_PREFIX} nenhuma entrada vencida — sem alarme.`);
    nextAlarmState = advanceEntityStalenessState(null, now);
  }

  saveState({ alarm: nextAlarmState, firstSeen });
}

if (isMainModule(import.meta.url)) {
  // #4745: process.exitCode em vez de process.exit() — este catch roda
  // DEPOIS de awaits de rede (sendGmailMessage), mesmo cenário
  // UV_HANDLE_CLOSING documentado em worker-drift-check.ts/hub-staleness-check.ts.
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
