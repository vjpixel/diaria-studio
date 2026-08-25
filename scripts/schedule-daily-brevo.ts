#!/usr/bin/env node
/**
 * scripts/schedule-daily-brevo.ts (#5772)
 *
 * Agenda a campanha Brevo diária (`brevo_diaria`, segmento Pending —
 * reativação) criada como rascunho pela Etapa 5
 * (`brevo-diaria-stage5-dispatch.ts`/`publish-daily-brevo.ts`). Roda na
 * Etapa 6, dentro do MESMO gate humano do Schedule do Beehiiv — mesma
 * divisão 5/6 já usada pra newsletter (rascunho na 5, agendamento na 6),
 * decisão do editor no comentário 2026-08-20 da issue #5772.
 *
 * Diferente de `publish-daily-brevo.ts` (que nunca implementou
 * `--schedule-at`, ver #4980), este script é dedicado só ao PUT de
 * agendamento + verificação pós-mutação — mesmo padrão de releitura usado
 * em `ingestContactToBrevo` (`sync-pending-to-brevo.ts`) e no Schedule do
 * Beehiiv (`verify-scheduled-post.ts`): nunca reporta "agendado" a partir
 * só do que foi enviado no PUT, sempre relê via GET antes de declarar
 * sucesso.
 *
 * Uma campanha Brevo agendada é IMUTÁVEL (mesma ressalva de
 * `/diaria-brevo-diaria` Passo 8) — confirme o horário antes de rodar isto
 * fora de um gate humano.
 *
 * Uso:
 *   npx tsx scripts/schedule-daily-brevo.ts --edition-dir <dir> --scheduled-at <ISO8601>
 *
 * Exit codes:
 *   0 — agendado e verificado (GET confirma status "queued"/scheduledAt correto)
 *   1 — uso/erro genérico (args ausentes/inválidos, credenciais ausentes)
 *   2 — `_internal/brevo-diaria-published.json` ausente ou sem campaign_id
 *       (nada a agendar — canal foi pulado/falhou na Etapa 5, ou `--skip brevo`)
 *   3 — PUT falhou (erro de API)
 *   4 — GET de verificação pós-PUT não confirma o agendamento esperado
 *   5 — cota da CONTA Brevo insuficiente/ilegível pro dia (#6146): agendar
 *       aqui produziria uma campanha `suspended` no horário, em silêncio
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { brevoPut, brevoGetCampaign, brevoGetList } from "./lib/brevo-client.ts";
import {
  BREVO_FREE_DAILY_SEND_LIMIT,
  checkAccountSendQuota,
  describeQuotaWarnings,
  fetchAccountQuotaSnapshot,
  toStatsDay,
  type AccountQuotaCheck,
} from "./lib/brevo-account-quota.ts"; // #6146
import {
  readBrevoDiariaPublished,
  writeBrevoDiariaPublished,
  buildScheduledPublishedState,
  type BrevoDiariaPublished,
} from "./publish-daily-brevo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface BrevoDiariaConfig {
  api_key_env: string;
  /** #6146 — teto diário da CONTA. Default: BREVO_FREE_DAILY_SEND_LIMIT. */
  account_daily_limit?: number;
}
interface PlatformConfig {
  brevo_diaria?: BrevoDiariaConfig;
}

export type ScheduleDailyBrevoResult =
  | { ok: true; campaignId: number; scheduledAt: string; status: string; alreadyScheduled?: boolean }
  | { ok: false; code: 2 | 3 | 4 | 5; reason: string };

/**
 * Pura o suficiente pra ser testável — `deps.readPublished`/`deps.writePublished`/
 * `deps.putSchedule`/`deps.getCampaign` são injetáveis (nenhuma chamada de
 * rede/I/O real em teste).
 */
export interface ScheduleDailyBrevoDeps {
  readPublished: (editionDir: string) => BrevoDiariaPublished | null;
  writePublished: (editionDir: string, state: BrevoDiariaPublished) => void;
  putSchedule: (campaignId: number, scheduledAt: string) => Promise<unknown>;
  getCampaign: (campaignId: number) => Promise<{ status: string; scheduledAt?: string | null }>;
  /**
   * #6146 — cota da CONTA Brevo (balde único transacional + marketing) pro
   * dia corrente. Injetável como o resto; `productionDeps` lê a lista pra
   * saber quantos destinatários o agendamento vai comprometer.
   */
  checkQuota: (listId: number) => Promise<{ check: AccountQuotaCheck; warnings: string[] }>;
}

export async function scheduleDailyBrevo(
  editionDir: string,
  scheduledAtIso: string,
  deps: ScheduleDailyBrevoDeps,
): Promise<ScheduleDailyBrevoResult> {
  const published = deps.readPublished(editionDir);
  if (!published || typeof published.campaign_id !== "number") {
    return {
      ok: false,
      code: 2,
      reason:
        "_internal/brevo-diaria-published.json ausente ou sem campaign_id — nada a agendar (canal Brevo " +
        "diária foi pulado/falhou na Etapa 5, ou --skip brevo foi usado).",
    };
  }
  const campaignId = published.campaign_id;

  // Idempotência (#5781): campanha Brevo agendada é imutável (docstring
  // acima) — resume após sucesso mas antes do sentinel do Stage 6 não deve
  // re-tentar o PUT (falharia de novo pelo mesmo motivo). Espelha
  // "already_done" de brevo-diaria-stage5-dispatch.ts.
  if (published.status === "scheduled" && typeof published.scheduled_at === "string") {
    return {
      ok: true,
      campaignId,
      scheduledAt: published.scheduled_at,
      status: "already_scheduled",
      alreadyScheduled: true,
    };
  }

  // #6146: checado DEPOIS do short-circuit de idempotência acima (uma
  // campanha já agendada não deve ser reprovada por cota — o compromisso já
  // foi feito e é imutável) e ANTES do PUT, que é o ponto de não-retorno.
  // Sem isto, a Etapa 6 agendava alegremente uma campanha que a Brevo iria
  // suspender no horário por falta de cota, e ninguém ficava sabendo
  // (incidente 260825).
  let quota: { check: AccountQuotaCheck; warnings: string[] };
  try {
    quota = await deps.checkQuota(published.list_id);
  } catch (e) {
    return {
      ok: false,
      code: 5,
      reason:
        `não foi possível ler a cota da conta Brevo antes de agendar: ${(e as Error).message}. ` +
        "Cota ilegível nunca vira permissão de agendamento (#6146).",
    };
  }
  for (const w of quota.warnings) process.stderr.write(`[schedule-daily-brevo] AVISO: ${w}\n`);
  if (!quota.check.ok) {
    return { ok: false, code: 5, reason: quota.check.reason };
  }

  try {
    await deps.putSchedule(campaignId, scheduledAtIso);
  } catch (e) {
    return { ok: false, code: 3, reason: `PUT /emailCampaigns/${campaignId} falhou: ${(e as Error).message}` };
  }

  let verified: { status: string; scheduledAt?: string | null };
  try {
    verified = await deps.getCampaign(campaignId);
  } catch (e) {
    return {
      ok: false,
      code: 4,
      reason: `GET /emailCampaigns/${campaignId} (verificação pós-PUT) falhou: ${(e as Error).message}`,
    };
  }

  // #5851: compara INSTANTES, não strings — a Brevo devolve `scheduledAt` no
  // offset LOCAL da conta (ex: `-03:00`), não em `Z`. Um agendamento correto
  // (mesmo instante, formato diferente do que foi enviado no PUT) falhava
  // esta checagem por comparação textual, mesmo com o agendamento certo já
  // confirmado (`status: "queued"`) — ocorrência real na edição 260821:
  // enviado `2026-08-21T09:00:00.000Z`, recebido `2026-08-21T06:00:00.000-03:00`,
  // o MESMO instante. `Date.parse` retorna `NaN` pra string inválida —
  // `NaN !== NaN` é sempre `true`, então um `scheduledAt` ausente/corrompido
  // ainda reprova aqui (nunca um falso "confirmado" por acidente de NaN).
  const expectedMs = Date.parse(scheduledAtIso);
  const receivedMs = verified.scheduledAt != null ? Date.parse(verified.scheduledAt) : NaN;
  if (receivedMs !== expectedMs || Number.isNaN(receivedMs)) {
    return {
      ok: false,
      code: 4,
      reason:
        `GET pós-PUT não confirma o agendamento: esperado scheduledAt=${scheduledAtIso}, ` +
        `recebido ${JSON.stringify(verified.scheduledAt)} (status atual: ${verified.status}).`,
    };
  }

  // Só persiste depois da verificação via GET confirmar — nunca a partir só do PUT (#5772).
  deps.writePublished(editionDir, buildScheduledPublishedState(published, verified.scheduledAt!));

  return { ok: true, campaignId, scheduledAt: verified.scheduledAt!, status: verified.status };
}

export function productionDeps(rootDir: string = ROOT): ScheduleDailyBrevoDeps {
  const platformConfig = JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8")) as PlatformConfig;
  const brevoDiaria = platformConfig.brevo_diaria;
  const apiKey = brevoDiaria ? process.env[brevoDiaria.api_key_env] : undefined;
  return {
    readPublished: (editionDir) => readBrevoDiariaPublished(editionDir),
    writePublished: (editionDir, state) => writeBrevoDiariaPublished(editionDir, state),
    putSchedule: async (campaignId, scheduledAt) => {
      if (!apiKey) throw new Error(`${brevoDiaria?.api_key_env ?? "BREVO_DIARIA_API_KEY"} não definido no ambiente.`);
      return brevoPut(apiKey, `/emailCampaigns/${campaignId}`, { scheduledAt });
    },
    getCampaign: async (campaignId) => {
      if (!apiKey) throw new Error(`${brevoDiaria?.api_key_env ?? "BREVO_DIARIA_API_KEY"} não definido no ambiente.`);
      return brevoGetCampaign(apiKey, campaignId);
    },
    checkQuota: async (listId) => {
      if (!apiKey) throw new Error(`${brevoDiaria?.api_key_env ?? "BREVO_DIARIA_API_KEY"} não definido no ambiente.`);
      const listInfo = await brevoGetList(apiKey, listId);
      const snapshot = await fetchAccountQuotaSnapshot(apiKey, toStatsDay(new Date()));
      return {
        check: checkAccountSendQuota({
          dailyLimit: brevoDiaria?.account_daily_limit ?? BREVO_FREE_DAILY_SEND_LIMIT,
          transactionalRequestsToday: snapshot.transactionalRequestsToday,
          recipients: listInfo.totalSubscribers,
        }),
        warnings: describeQuotaWarnings(snapshot),
      };
    },
  };
}

if (isMainModule(import.meta.url)) {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const editionDirArg = getStringArg(argv, "edition-dir");
  const scheduledAtArg = getStringArg(argv, "scheduled-at");
  if (!editionDirArg || !scheduledAtArg) {
    process.stderr.write(
      "uso: npx tsx scripts/schedule-daily-brevo.ts --edition-dir <dir> --scheduled-at <ISO8601>\n",
    );
    process.exit(1);
  }
  const editionDir = resolve(editionDirArg);
  scheduleDailyBrevo(editionDir, scheduledAtArg, productionDeps(ROOT)).then((result) => {
    console.log(JSON.stringify(result));
    if (result.ok) {
      process.exitCode = 0;
    } else {
      process.exitCode = result.code;
    }
  });
}
