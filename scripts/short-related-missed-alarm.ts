#!/usr/bin/env node
/**
 * scripts/short-related-missed-alarm.ts (#11353)
 *
 * Entrypoint da task `Diaria-Short-Related-Missed-Alarm` (diária 13:30 BRT no
 * `300`, `scripts/lib/scheduled-tasks.ts`): alarma quando a task LOCAL do
 * vídeo relacionado do Short (#10811, no Neo) não deixou registro na edição
 * do dia depois do prazo de desistência. Desde o #12541 item 2 consulta
 * primeiro o KV da Cloudflare (`short-related:{AAMMDD}`, gravado pela task
 * por API) e depois o arquivo replicado. Lógica pura em
 * `scripts/lib/diaria/short-related-missed-alarm.ts`; aqui só leitura de
 * disco, relógio e o portão `notifyEditor`. Nunca grava na pasta da edição
 * (o Neo escreve ali; uma escrita daqui disputaria o OneDrive).
 *
 * Uso:
 *   npx tsx scripts/short-related-missed-alarm.ts                    # edição de hoje (BRT)
 *   npx tsx scripts/short-related-missed-alarm.ts --edition 261027   # outra edição
 *   npx tsx scripts/short-related-missed-alarm.ts --dry-run          # avalia e imprime, não alarma
 *   npx tsx scripts/short-related-missed-alarm.ts --to email@x       # override do destinatário
 *
 * Exit 0 sempre que a avaliação e o alarme (se houver) saírem; exit 1 só se
 * o alarme não conseguir ser registrado (issue não criada).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { notifyEditor } from "./lib/editor-notify.ts";
import { logEvent } from "./lib/run-log.ts";
import { loadShortScheduleConfig, resolveShortTime } from "./lib/diaria/short-video.ts";
import { readEditionVideoEvidenceInput } from "./lib/diaria/edition-video-evidence.ts";
import { createKvRestOps } from "./lib/cloudflare-kv-rest.ts";
import { readShortRelatedKv, resolveOpsStateKvConfig, type ShortRelatedKvRead } from "./lib/diaria/short-related-kv.ts";
import {
  SHORT_RELATED_FILE,
  brtInstant,
  brtTodayAammdd,
  parseShortRelatedRecord,
  studioShortsListUrl,
  type ShortRelatedRecord,
} from "./lib/diaria/youtube-short-related.ts";
import {
  buildShortRelatedMissedAlarm,
  evaluateShortRelatedMissed,
  isAlarmingShortRelatedVerdict,
  shortRelatedMissedSeverity,
  type FileRead,
} from "./lib/diaria/short-related-missed-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[short-related-missed-alarm]";

function readRecord(dir: string, aammdd: string): FileRead<ShortRelatedRecord> {
  const path = join(dir, SHORT_RELATED_FILE);
  if (!existsSync(path)) return { kind: "absent" };
  try {
    return { kind: "ok", value: parseShortRelatedRecord(readFileSync(path, "utf8"), aammdd, path) };
  } catch (e) {
    return { kind: "unreadable", error: (e as Error).message };
  }
}

function loadShortAt(aammdd: string): Date | null {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
    return brtInstant(aammdd, resolveShortTime(loadShortScheduleConfig(cfg), aammdd, "youtube_shorts").hhmm);
  } catch (e) {
    console.error(`${LOG_PREFIX} [aviso] horário do Short não derivado (${(e as Error).message}) — prazo = agora`);
    return null;
  }
}

/**
 * #12541 item 2: registro no KV da Cloudflare, gravado pela task do Neo por
 * API. Configuração ausente ou falha de leitura viram `error` (incerteza
 * explícita no veredito), nunca `absent`: não ter como perguntar não é o
 * mesmo que o KV responder "não existe".
 */
async function readKvRecord(aammdd: string): Promise<ShortRelatedKvRead> {
  try {
    const cfgJson = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
    const cfg = resolveOpsStateKvConfig(cfgJson, process.env);
    if (!cfg.ok) return { kind: "error", error: `configuração do KV ausente: ${cfg.missing.join(", ")}` };
    return await readShortRelatedKv(createKvRestOps(cfg.config), aammdd);
  } catch (e) {
    return { kind: "error", error: (e as Error).message };
  }
}

/**
 * Edição avaliada: `--edition AAMMDD` quando passada, senão a de hoje em BRT
 * (o timer chama sem a flag). Usa `getStringArg`, que devolve `undefined`
 * quando a flag está ausente: com `getArg` (que devolve `""`) o `??` nunca
 * caía no fallback e toda execução do timer morria em "--edition inválido"
 * (#11472). Flag passada sem valor ou vazia lança, em vez de virar "hoje".
 */
export function resolveAlarmEdition(argv: string[], now: Date): string {
  const aammdd = getStringArg(argv, "edition", { example: "261027" }) ?? brtTodayAammdd(now);
  if (!/^\d{6}$/.test(aammdd)) throw new Error(`--edition inválido: ${JSON.stringify(aammdd)} (esperado AAMMDD)`);
  return aammdd;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  loadProjectEnv(ROOT);

  const now = new Date();
  const aammdd = resolveAlarmEdition(argv, now);
  const dir = resolve(ROOT, editionDirFor(aammdd));
  const editionExists = existsSync(dir);

  // #12541: as mesmas fontes de evidência de vídeo que o plano da task do Neo lê.
  const evidence = editionExists ? readEditionVideoEvidenceInput(dir, aammdd) : null;
  const ev = evaluateShortRelatedMissed({
    aammdd,
    now,
    editionExists,
    noVideo: evidence?.noVideo ?? false,
    shortsRegistry: evidence?.shortsRegistry ?? { kind: "absent" },
    youtubeStep: evidence?.youtubeStep,
    horizontalUploadRecord: evidence?.horizontalUploadRecord,
    d1VideoUrl: evidence?.d1VideoUrl,
    record: editionExists ? readRecord(dir, aammdd) : { kind: "absent" },
    // Só consulta a rede quando a pasta existe; o veredito decide se importa.
    kvRecord: editionExists ? await readKvRecord(aammdd) : { kind: "absent" },
    shortAt: loadShortAt(aammdd),
  });
  console.log(`${LOG_PREFIX} aammdd=${aammdd} verdict=${ev.verdict} source=${ev.recordSource ?? "-"} — ${ev.reason}`);
  if (ev.kvError) console.error(`${LOG_PREFIX} [aviso] leitura do KV falhou: ${ev.kvError}`);

  const alarming = isAlarmingShortRelatedVerdict(ev.verdict);
  if (dryRun) {
    console.log(`${LOG_PREFIX} --dry-run: ${alarming ? "alarmaria" : "não alarmaria"} — issue/e-mail NÃO acionados.`);
    return;
  }

  logEvent(
    {
      edition: aammdd,
      stage: null,
      agent: "short-related-missed-alarm",
      level: alarming ? "error" : "info",
      message: `short-related-missed-alarm: ${ev.verdict}`,
      details: ev,
    },
    ROOT,
  );
  if (!alarming) return;

  const { subject, body } = buildShortRelatedMissedAlarm(ev, studioShortsListUrl());
  // Fingerprint pela edição: um alarme por dia; reexecução reusa a issue.
  // `urgente`: o editor precisa vincular no mesmo dia, com o Short já no ar,
  // e sob `email_policy: "urgent_only"` só `urgente` recém-criado vira e-mail
  // — o mesmo canal do `--alert` que a própria task usaria se tivesse rodado.
  // Exceções (#12541): `missing-record` (ausência de registro) e
  // `record-unconfirmed` (KV fora, nada no arquivo) saem `acao` (issue sem
  // e-mail) — ver `shortRelatedMissedSeverity`.
  const res = await notifyEditor(
    {
      check: "short-related-missed",
      fingerprint: aammdd,
      severity: shortRelatedMissedSeverity(ev.verdict),
      subject,
      body,
      priority: "P2",
      family: "evento",
      labels: ["bug"],
    },
    { cwd: ROOT, emailTo: toOverride },
  );
  if (res.issue?.action === "failed") {
    console.error(`${LOG_PREFIX} issue não criada/reusada: ${res.issue.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `${LOG_PREFIX} alarme registrado (issue #${res.issue?.issueNumber ?? "?"}, ${res.issue?.action ?? "?"}); e-mail ${res.emailSent ? "enviado" : `não enviado${res.emailError ? `: ${res.emailError}` : ""}`}.`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro fatal:`, e);
    process.exitCode = 1;
  });
}
