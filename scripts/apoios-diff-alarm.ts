#!/usr/bin/env node
/**
 * apoios-diff-alarm.ts (#4485 item 2)
 *
 * Task diária: computa o MESMO diff do dry-run de
 * `scripts/sync-apoio-nivel-beehiiv.ts` (desejado × estado atual da Beehiiv)
 * — reusando as mesmas funções puras exportadas de lá, sem reimplementar a
 * lógica — e, se houver diff pendente (adições/trocas/remoções), envia um
 * e-mail de alarme ao editor via Gmail API. **NUNCA aplica `--push`** — o
 * gate humano de `/diaria-apoios-sync` (Passo 3) continua sendo a única
 * forma de gravar de verdade na Beehiiv.
 *
 * Idempotente por FINGERPRINT do diff (`scripts/lib/apoios-diff-alarm.ts`) —
 * o mesmo diff pendente não gera um novo e-mail a cada rodada diária; só
 * quando o conteúdo muda ou depois de ter sido resolvido e reaparecer (ver
 * docstring do módulo pura).
 *
 * **Reconciliação de promessas pendentes (#4490 causa 4, self-review finding
 * 1 do PR #4503):** antes de computar o diff, roda o MESMO bloco de
 * `scripts/sync-apoio-nivel-beehiiv.ts::main()` — drena promessas novas do
 * Gmail + reconsulta `reconcilePendingPromises` pra cada promessa pendente do
 * store; se confirmar pagamento, promove a contato ANTES do cálculo. Sem
 * isso, esta task diária (a cadência REAL do #4485 item 2) nunca fecharia o
 * loop da causa 4 sozinha — só `/diaria-apoios-sync` rodado manualmente
 * fazia essa reconciliação. Idempotente via o store, fail-soft (falha vira
 * aviso, nunca aborta o alarme).
 *
 * Uso:
 *   npx tsx scripts/apoios-diff-alarm.ts [--dry-run] [--to email@x.com]
 *
 *   --dry-run  computa o diff e avalia se alarmaria, mas NÃO envia e-mail
 *              nem avança o cursor de idempotência — inspeção sem efeito
 *              colateral (mesmo contrato de `cursos-error-alarm.ts`).
 *   --to       override do destinatário (default: resolveEditorEmail).
 *
 * Env: mesmas credenciais do `sync-apoio-nivel-beehiiv.ts` dry-run
 * (BEEHIIV_API_KEY/BEEHIIV_PUBLICATION_ID, APOIA_SE_API_KEY/APOIA_SE_API_SECRET/APOIA_SE_CAMPAIGN)
 * + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito de
 * `clarice-guardrail-alarm.ts`/`cursos-error-alarm.ts`) + o junction `data/`
 * (OneDrive) pra `contacts.jsonl` e o cache apoia.se.
 *
 * Estado (idempotência): `data/apoios-diff-alarm-state.json`.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig } from "./lib/beehiiv-config.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { readApoiaSeEnv, defaultCacheDir, competenceMonth } from "./lib/apoia-se.ts";
import {
  pendingPromisesPath,
  loadPendingPromises,
  savePendingPromises,
  mergeNewPromises,
} from "./lib/apoio-promise-store.ts";
import { drainApoiaSeNotifications } from "./lib/apoia-se-gmail-drain.ts";
import {
  buildApoiosData,
  readPastMonthSnapshots,
  loadContacts,
  saveContacts,
  type MonthSnapshot,
} from "./studio-ui/studio-apoios.ts";
import {
  computeDesiredApoioLevels,
  diffApoioTags,
  fetchCurrentBeehiivState,
  reconcilePendingPromises,
  shouldBlockRemovals,
  evaluateBlastRadiusGuard,
} from "./sync-apoio-nivel-beehiiv.ts";
import {
  emptyApoiosDiffAlarmState,
  advanceState,
  shouldAlarm,
  hasPendingDiff,
  computeDiffFingerprint,
  buildApoiosDiffAlarmEmail,
  type ApoiosDiffAlarmState,
  type DiffAlarmInput,
  type DiffAlarmGuardWarnings,
} from "./lib/apoios-diff-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "apoios-diff-alarm-state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[apoios-diff-alarm]";

export function loadState(statePath: string = STATE_PATH): ApoiosDiffAlarmState {
  if (!existsSync(statePath)) return emptyApoiosDiffAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<ApoiosDiffAlarmState>;
    const fingerprint = typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null ? raw.lastAlarmedFingerprint : null;
    const checkedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    return { lastAlarmedFingerprint: fingerprint ?? null, lastCheckedAt: checkedAt ?? null };
  } catch {
    return emptyApoiosDiffAlarmState();
  }
}

export function saveState(state: ApoiosDiffAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const { apiKey, publicationId } = loadBeehiivConfig(LOG_PREFIX);

  // #4490 causa 4 / self-review finding 1 do PR #4503: esta é a task diária
  // REAL registrada pelo #4485 item 2 (`Diaria-Apoios-Diff-Alarm`) — sem esta
  // reconciliação, uma promessa que confirma pagamento só é promovida a
  // contato se alguém rodar `/diaria-apoios-sync` manualmente, o que
  // reintroduz a dependência de "alguém lembrar" que a causa 4 deveria
  // eliminar. Mesmo bloco de `sync-apoio-nivel-beehiiv.ts::main()` — drena
  // promessas novas do Gmail + reconsulta as pendentes do store ANTES do
  // resto do cálculo (buildApoiosData relê contacts.jsonl do disco a seguir,
  // então um contato promovido aqui já entra no diff computado abaixo).
  // Fail-soft total — qualquer falha (credenciais apoia.se ausentes, Gmail
  // indisponível, erro de I/O) vira aviso e a rodada segue sem reconciliação
  // de promessas, nunca aborta o alarme por causa dela.
  try {
    const apoiaEnv = readApoiaSeEnv();
    const promisesPath = pendingPromisesPath(ROOT, apoiaEnv.campaign);
    let pending = loadPendingPromises(promisesPath);

    const drainResult = await drainApoiaSeNotifications(ROOT);
    if (drainResult.skipped) {
      console.error(
        `${LOG_PREFIX} aviso: drain de promessas (Gmail) pulado (${drainResult.reason ?? "erro desconhecido"}) — ` +
          "reconciliação segue só com promessas já no store.",
      );
    } else if (drainResult.promessas && drainResult.promessas.length > 0) {
      pending = mergeNewPromises(pending, drainResult.promessas);
      console.error(`${LOG_PREFIX} ${drainResult.promessas.length} promessa(s) nova(s) drenada(s) do Gmail.`);
    }

    if (pending.length > 0) {
      const contactsBeforeReconcile = loadContacts(ROOT);
      const reconciled = await reconcilePendingPromises(contactsBeforeReconcile, pending, {
        env: apoiaEnv,
        cacheDir: defaultCacheDir(apoiaEnv.campaign),
      });
      if (reconciled.promoted.length > 0) {
        saveContacts(ROOT, reconciled.contacts);
        console.error(
          `${LOG_PREFIX} ${reconciled.promoted.length} promessa(s) confirmada(s) como pagamento — ` +
            `promovida(s) a contato: ${reconciled.promoted.map((p) => `${p.name} <${p.email}>`).join(", ")}`,
        );
      }
      savePendingPromises(promisesPath, reconciled.remainingPromises);
      if (reconciled.remainingPromises.length > 0) {
        console.error(
          `${LOG_PREFIX} ${reconciled.remainingPromises.length} promessa(s) ainda pendente(s) (sem confirmação de pagamento).`,
        );
      }
    } else {
      savePendingPromises(promisesPath, pending);
    }
  } catch (e) {
    console.error(
      `${LOG_PREFIX} aviso: reconciliação de promessas pendentes falhou (${(e as Error).message}) — seguindo sem ela.`,
    );
  }

  const data = await buildApoiosData(ROOT);
  if (data.error) {
    console.error(`${LOG_PREFIX} aviso: buildApoiosData reportou erro (dados podem estar incompletos): ${data.error}`);
  }

  const now = new Date();
  const currentMonth = competenceMonth(now);
  let pastSnapshots: MonthSnapshot[] = [];
  try {
    const env = readApoiaSeEnv();
    pastSnapshots = readPastMonthSnapshots(defaultCacheDir(env.campaign), currentMonth);
  } catch (e) {
    console.error(`${LOG_PREFIX} aviso: não foi possível ler snapshots de meses anteriores: ${(e as Error).message}`);
  }

  const desired = computeDesiredApoioLevels(data.contacts, pastSnapshots, currentMonth);
  const current = await fetchCurrentBeehiivState(publicationId, apiKey);
  const diff = diffApoioTags(desired, current);

  const input: DiffAlarmInput = {
    toApply: diff.toApply.map((e) => ({ email: e.email, contactName: e.contactName, fromLevel: e.fromLevel, toLevel: e.toLevel })),
    toRemove: diff.toRemove.map((e) => ({ email: e.email, contactName: e.contactName, fromLevel: e.fromLevel, toLevel: e.toLevel })),
  };

  const state = loadState();
  console.log(
    `${LOG_PREFIX} diff: ${input.toApply.length} adição(ões)/troca(s), ${input.toRemove.length} remoção(ões) ` +
      `(último alarme: ${state.lastCheckedAt ?? "nunca"}).`,
  );

  if (shouldAlarm(state, input)) {
    // Self-review finding 5 (PR #4503): informa no e-mail quais remoções um
    // `--push` real recusaria — avaliado SEM os escape hatches
    // (`--allow-partial`/`--force-blast-radius`), o pior caso, já que este
    // script nunca sabe se o editor vai usá-los.
    const partialDataBlocksRemovals = shouldBlockRemovals(data.error, diff, false) && diff.toRemove.length > 0;
    const blastGuard = evaluateBlastRadiusGuard(diff.toRemove.length, current, false);
    const guardWarnings: DiffAlarmGuardWarnings = {
      partialDataBlocksRemovals,
      blastRadiusBlocked: blastGuard.blocked,
      blastRadiusRatioPct: Math.round(blastGuard.ratio * 1000) / 10,
    };
    const { subject, body } = buildApoiosDiffAlarmEmail(input, guardWarnings);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else {
    console.log(
      `${LOG_PREFIX} nenhum e-mail necessário (sem diff pendente, ou o mesmo diff já foi alarmado antes).`,
    );
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: cursor NÃO avançado.`);
    return;
  }

  const nextFingerprint = hasPendingDiff(input) ? computeDiffFingerprint(input) : null;
  saveState(advanceState(nextFingerprint, now));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
