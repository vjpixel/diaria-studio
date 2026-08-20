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
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { brevoPut, brevoGetCampaign } from "./lib/brevo-client.ts";
import {
  readBrevoDiariaPublished,
  writeBrevoDiariaPublished,
  buildScheduledPublishedState,
  type BrevoDiariaPublished,
} from "./publish-daily-brevo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface BrevoDiariaConfig {
  api_key_env: string;
}
interface PlatformConfig {
  brevo_diaria?: BrevoDiariaConfig;
}

export type ScheduleDailyBrevoResult =
  | { ok: true; campaignId: number; scheduledAt: string; status: string }
  | { ok: false; code: 2 | 3 | 4; reason: string };

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

  if (verified.scheduledAt !== scheduledAtIso) {
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
