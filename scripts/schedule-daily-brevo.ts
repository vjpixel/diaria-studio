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
 *   npx tsx scripts/schedule-daily-brevo.ts --edition-dir <dir> --scheduled-at <ISO8601> [--allow-other-date]
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
 *   6 — `--scheduled-at` diverge da data da edição (#8207) — recusado salvo
 *       `--allow-other-date`; ver `scripts/lib/edition-scheduled-at.ts`
 *       OU (#11689) `--scheduled-at` já passou / a <2 min de agora (sem
 *       override; roda depois do atalho idempotente) — voltar ao gate do Stage 6
 *
 * Semanal dividida (#11286): com `terca_campaign_id` no estado, depois da
 * campanha de segunda confirmada agenda também a de terça, 24h depois (mesmo
 * fluxo: cota do dia de terça sobre a lista de terça, PUT, GET). Falha na de
 * terça devolve o exit dela (3/4/5) com a de segunda já agendada e gravada;
 * re-rodar o mesmo comando pula a de segunda (idempotente) e tenta a de terça.
 * A cota da de segunda desconta a lista de terça (excluída da campanha).
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { brevoPut, brevoGetCampaign, brevoGetList } from "./lib/brevo-client.ts";
import {
  checkAccountSendQuota,
  resolveAccountDailyLimit,
  type BrevoAccountLimitConfig,
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
import { editionAammddFromDir, checkScheduledAtMatchesEditionDate, checkScheduledAtNotPast, FINAL_GUARD_MIN_LEAD_MS } from "./lib/edition-scheduled-at.ts";
import { resolveEditionDirArgOrExit } from "./lib/resolve-edition-dir-arg.ts"; // #9427
import { tercaScheduledAt } from "./lib/brevo-semanal-split.ts"; // #11286

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface BrevoDiariaConfig extends BrevoAccountLimitConfig {
  api_key_env: string;
}
interface PlatformConfig {
  brevo_diaria?: BrevoDiariaConfig;
}

export type ScheduleDailyBrevoResult =
  | {
      ok: true;
      campaignId: number;
      scheduledAt: string;
      status: string;
      alreadyScheduled?: boolean;
      /** #11286 — campanha de terça da semanal dividida, quando existe. */
      terca?: { campaignId: number; scheduledAt: string; status: string; alreadyScheduled?: boolean };
    }
  | { ok: false; code: 2 | 3 | 4 | 5 | 6; reason: string };

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
  checkQuota: (
    listId: number,
    sendDay: string,
    /** #11286 — lista excluída da campanha (semanal dividida): destinatários = lista − excluída. */
    excludeListId?: number,
  ) => Promise<{ check: AccountQuotaCheck; warnings: string[] }>;
}

export async function scheduleDailyBrevo(
  editionDir: string,
  scheduledAtIso: string,
  deps: ScheduleDailyBrevoDeps,
  options: { allowOtherDate?: boolean; now?: Date } = {},
): Promise<ScheduleDailyBrevoResult> {
  // #8207 item 2 — mesmo guard de `schedule-newsletter-kit.ts`: recusa
  // `--scheduled-at` cuja data-calendário em BRT diverge da data da edição,
  // salvo `--allow-other-date`. Roda antes de qualquer leitura/mutação.
  const editionAammdd = editionAammddFromDir(editionDir);
  if (editionAammdd) {
    const dateCheck = checkScheduledAtMatchesEditionDate(editionAammdd, scheduledAtIso, options.allowOtherDate);
    if (!dateCheck.ok) {
      return { ok: false, code: 6, reason: dateCheck.reason };
    }
  }

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
  const main = await scheduleMainCampaign(editionDir, published, scheduledAtIso, deps, options.now);
  if (!main.ok) return main;
  const state = main.state;
  const mainResult: ScheduleDailyBrevoResult & { ok: true } = main.result;

  // #11286 — semanal dividida: a campanha de terça (mesma edição, lista de
  // terça) sai 24h depois da de segunda. Só depois da principal confirmada.
  if (typeof state.terca_campaign_id !== "number" || typeof state.terca_list_id !== "number") return mainResult;
  const terca = await scheduleTercaCampaign(editionDir, state, scheduledAtIso, deps);
  if (!terca.ok) {
    return {
      ok: false,
      code: terca.code,
      reason:
        `campanha de segunda ${mainResult.campaignId} agendada (${mainResult.scheduledAt}), mas a de terça ` +
        `${state.terca_campaign_id} não: ${terca.reason}`,
    };
  }
  return { ...mainResult, terca: terca.terca };
}

type CampaignScheduleOutcome =
  | { ok: true; state: BrevoDiariaPublished; result: ScheduleDailyBrevoResult & { ok: true } }
  | { ok: false; code: 3 | 4 | 5 | 6; reason: string };

/** PUT `scheduledAt` + GET de confirmação, comparando INSTANTES (#5851). */
async function putAndVerify(
  campaignId: number,
  scheduledAtIso: string,
  deps: ScheduleDailyBrevoDeps,
): Promise<{ ok: true; status: string; scheduledAt: string } | { ok: false; code: 3 | 4; reason: string }> {
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
  return { ok: true, status: verified.status, scheduledAt: verified.scheduledAt! };
}

/** #6146 — cota da conta no dia do envio; ilegível nunca vira permissão. */
async function checkQuotaOrFail(
  deps: ScheduleDailyBrevoDeps,
  listId: number,
  sendIso: string,
  excludeListId?: number,
): Promise<{ ok: true } | { ok: false; code: 5; reason: string }> {
  let quota: { check: AccountQuotaCheck; warnings: string[] };
  try {
    // O dia consultado é o do ENVIO, não o de hoje: a cota da Brevo zera por
    // dia UTC, e a Etapa 6 às vezes roda antes da virada (a campanha 27 foi
    // criada 20/08 23:57 UTC pra enviar 21/08 09:00 UTC). Consultar "hoje"
    // aqui mediria um balde que não é o que vai despachar a campanha.
    quota =
      excludeListId === undefined
        ? await deps.checkQuota(listId, toStatsDay(new Date(sendIso)))
        : await deps.checkQuota(listId, toStatsDay(new Date(sendIso)), excludeListId);
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
  if (!quota.check.ok) return { ok: false, code: 5, reason: quota.check.reason };
  return { ok: true };
}

async function scheduleMainCampaign(
  editionDir: string,
  published: BrevoDiariaPublished,
  scheduledAtIso: string,
  deps: ScheduleDailyBrevoDeps,
  now?: Date,
): Promise<CampaignScheduleOutcome> {
  const campaignId = published.campaign_id;

  // Idempotência HONESTA (#8207 item 3, mesmo achado do #464 — reagendar pelo
  // script oficial respondia "sucesso" sem mudar nada quando o horário pedido
  // divergia do gravado). `already_scheduled` só quando o horário GRAVADO é o
  // MESMO instante do pedido (compara instantes via `Date.parse`, não
  // strings — mesma disciplina do #5851 já usado mais abaixo). Pedido com
  // horário DIFERENTE cai pro PUT normal abaixo, apesar da campanha Brevo
  // agendada ser nominalmente imutável (docstring acima) — é exatamente esse
  // PUT que o editor rodou manualmente em 17/09 pra corrigir a edição 260917;
  // este guard só formaliza o caminho.
  if (published.status === "scheduled" && typeof published.scheduled_at === "string") {
    const storedMs = Date.parse(published.scheduled_at);
    const requestedMs = Date.parse(scheduledAtIso);
    if (Number.isFinite(storedMs) && Number.isFinite(requestedMs) && storedMs === requestedMs) {
      return {
        ok: true,
        state: published,
        result: { ok: true, campaignId, scheduledAt: published.scheduled_at, status: "already_scheduled", alreadyScheduled: true },
      };
    }
  }

  // #11689 — defesa final contra passado, DEPOIS do atalho idempotente e ANTES
  // da cota/PUT; vale mesmo com basename de edição irreconhecível. Margem
  // pequena (o gate já exigiu 15 min) pra não deixar agendamento parcial.
  const pastCheck = checkScheduledAtNotPast(scheduledAtIso, now, { minLeadMs: FINAL_GUARD_MIN_LEAD_MS });
  if (!pastCheck.ok) return { ok: false, code: 6, reason: pastCheck.reason };

  // #6146: checado DEPOIS do short-circuit de idempotência acima (uma
  // campanha já agendada não deve ser reprovada por cota — o compromisso já
  // foi feito e é imutável) e ANTES do PUT, que é o ponto de não-retorno.
  // Sem isto, a Etapa 6 agendava alegremente uma campanha que a Brevo iria
  // suspender no horário por falta de cota, e ninguém ficava sabendo
  // (incidente 260825). #11286: semanal dividida conta só quem fica na
  // segunda (a lista de terça é excluída desta campanha).
  const quota = await checkQuotaOrFail(deps, published.list_id, scheduledAtIso, published.terca_list_id);
  if (!quota.ok) return quota;

  const put = await putAndVerify(campaignId, scheduledAtIso, deps);
  if (!put.ok) return put;

  // Só persiste depois da verificação via GET confirmar — nunca a partir só do PUT (#5772).
  const state = buildScheduledPublishedState(published, put.scheduledAt);
  deps.writePublished(editionDir, state);
  return { ok: true, state, result: { ok: true, campaignId, scheduledAt: put.scheduledAt, status: put.status } };
}

/**
 * #11286 — agenda a campanha de TERÇA da semanal dividida: 24h depois do
 * `scheduledAtIso` da de segunda, cota do dia de terça medida sobre a lista
 * de terça, mesma idempotência por instante e mesma confirmação por GET.
 */
async function scheduleTercaCampaign(
  editionDir: string,
  state: BrevoDiariaPublished,
  mondayIso: string,
  deps: ScheduleDailyBrevoDeps,
): Promise<
  | { ok: true; terca: { campaignId: number; scheduledAt: string; status: string; alreadyScheduled?: boolean } }
  | { ok: false; code: 3 | 4 | 5; reason: string }
> {
  const campaignId = state.terca_campaign_id!;
  const tercaIso = tercaScheduledAt(mondayIso);
  if (tercaIso === null) return { ok: false, code: 4, reason: `--scheduled-at ilegível (${mondayIso}) pra derivar a terça.` };
  if (typeof state.terca_scheduled_at === "string" && Date.parse(state.terca_scheduled_at) === Date.parse(tercaIso)) {
    return { ok: true, terca: { campaignId, scheduledAt: state.terca_scheduled_at, status: "already_scheduled", alreadyScheduled: true } };
  }
  const quota = await checkQuotaOrFail(deps, state.terca_list_id!, tercaIso);
  if (!quota.ok) return quota;
  const put = await putAndVerify(campaignId, tercaIso, deps);
  if (!put.ok) return put;
  deps.writePublished(editionDir, { ...state, terca_scheduled_at: put.scheduledAt });
  return { ok: true, terca: { campaignId, scheduledAt: put.scheduledAt, status: put.status } };
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
    checkQuota: async (listId, sendDay, excludeListId) => {
      if (!apiKey) throw new Error(`${brevoDiaria?.api_key_env ?? "BREVO_DIARIA_API_KEY"} não definido no ambiente.`);
      const listInfo = await brevoGetList(apiKey, listId);
      // #11286 — a lista de terça é subconjunto da principal (reconcile no publish).
      const excluded = excludeListId === undefined ? 0 : (await brevoGetList(apiKey, excludeListId)).totalSubscribers;
      const snapshot = await fetchAccountQuotaSnapshot(apiKey, sendDay);
      const dailyLimit = resolveAccountDailyLimit(brevoDiaria);
      return {
        check: checkAccountSendQuota({
          dailyLimit,
          transactionalRequestsOnSendDay: snapshot.transactionalRequestsOnSendDay,
          recipients: Math.max(0, listInfo.totalSubscribers - excluded),
        }),
        warnings: describeQuotaWarnings(snapshot, dailyLimit),
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
      "uso: npx tsx scripts/schedule-daily-brevo.ts --edition-dir <dir> --scheduled-at <ISO8601> [--allow-other-date]\n",
    );
    process.exit(1);
  }
  const editionDir = resolveEditionDirArgOrExit(editionDirArg, { root: ROOT }); // #9427 (antes: cwd)
  const allowOtherDate = hasFlag(argv, "allow-other-date");
  scheduleDailyBrevo(editionDir, scheduledAtArg, productionDeps(ROOT), { allowOtherDate }).then((result) => {
    console.log(JSON.stringify(result));
    if (result.ok) {
      process.exitCode = 0;
    } else {
      process.exitCode = result.code;
    }
  });
}
