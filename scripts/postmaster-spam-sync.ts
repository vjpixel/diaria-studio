#!/usr/bin/env node
/**
 * postmaster-spam-sync.ts (#4154)
 *
 * Substitui a leitura MANUAL do `spamRate` diário do Google Postmaster Tools
 * (domínio `clarice.ai`, do parceiro) por uma chamada direta à
 * `gmailpostmastertools.googleapis.com` — grava no mesmo KV
 * (`postmaster:spam`) que `scripts/postmaster-spam-entry.ts` já grava, com o
 * mesmo formato (`PostmasterSpamEntry`), então o consumidor
 * (`resolveSpamSignal` em `workers/brevo-dashboard/src/thresholds.ts`) não
 * muda nada.
 *
 * Histórico (#4154): a issue foi fechada em 260727 como "bloqueada por
 * acesso de terceiro" — a hipótese era que a conta do editor não era dona do
 * domínio `clarice.ai` no Postmaster. Reaberta e investigada em 260730:
 * `vjpixel@gmail.com` tem permissão OWNER em `clarice.ai` no Postmaster
 * (confirmado ao vivo via UI e via `domains.get`). O erro real era outro — a
 * Gmail Postmaster Tools API nunca tinha sido HABILITADA no projeto GCP do
 * OAuth client (403 SERVICE_DISABLED); a investigação de 260727 não chegou a
 * testar o endpoint de fato e inferiu "não é dono" de um sintoma diferente.
 * Habilitada a API via console em 260730; `domains.get`/`trafficStats.get`
 * funcionam normalmente daí em diante.
 *
 * MÉDIA, não último dia isolado (260730, pedido do editor): a leitura é a
 * MÉDIA sobre os últimos `HEALTH_SAMPLE_DAYS` (mesma janela usada por TODAS
 * as outras métricas da aba Rampa — abertura, bounce, unsub — ver
 * `workers/brevo-dashboard/src/weekly-plan.ts`), não o dia mais recente
 * isolado. Um dia isolado é ruidoso; a mesma janela das outras métricas
 * mantém a leitura comparável e consistente com o resto da tabela.
 *
 * ── Migração pra v2 (#4704, 260806) ──
 *
 * Até esta versão, a coleta rodava sobre a API v1 (`trafficStats.get`, 1 GET
 * por dia-calendário da janela — N chamadas) e causava 429 recorrente. A
 * decisão do editor (#4703, medição ao vivo em 260806) foi migrar a fonte
 * autoritativa do breaker pra v2 (`domainStats:query`, métrica `SPAM_RATE`)
 * depois de confirmar que v1 e v2 DIVERGEM no mesmo dia/domínio (1,6% v1 vs
 * 0,00% v2 em 03/08/2026) — a v2 espelha o painel novo do Postmaster, a v1
 * espelha o clássico, e só um dos dois pode governar o breaker.
 *
 * A v2 aceita um `DateRange` inteiro numa chamada só (ver
 * `scripts/lib/postmaster-v2-client.ts`, cliente genérico reusado aqui sem
 * modificação) — N GETs viram 1 POST, eliminando a superfície de 429 por
 * construção. `collectSpamReadingsV2`/`buildWindowRange` substituem
 * `collectSpamReadings`/`fetchStatsFromApi` (v1); a série diária agora é
 * PERSISTIDA na entry (`PostmasterSpamEntry.dailyReadings`, ver
 * `scripts/lib/dashboard-kv-types.ts`) em vez de descartada depois da média
 * — antes desta migração, `buildAveragedEntry` calculava a média e jogava
 * fora o detalhe dia-a-dia.
 *
 * O que a v2 NÃO cobre (herdado de v1 e removido desta versão, não
 * silenciosamente — documentado): `domainReputation`/`ipReputations`
 * (#4703/#4711) eram capturados do payload de `trafficStats.get`; a v2 não
 * tem esses campos em `domainStats:query` — vivem em `getComplianceStatus`,
 * outro endpoint, explicitamente fora do escopo do #4704 nesta sessão. O
 * produtor "auto" fica temporariamente sem popular esses 2 campos
 * (diagnóstico, nunca consumido por `resolveSpamSignal` — zero mudança no
 * breaker) até uma sessão futura trazer `getComplianceStatus` v2. Ver
 * `scripts/lib/dashboard-kv-types.ts` (`PostmasterSpamEntry`) pro rationale
 * completo dessa lacuna.
 *
 * `userReportedSpamRatio`/`floatValue` AUSENTE (dia fora da lista
 * `domainStats`) SIGNIFICA "não publicado ainda", nunca 0% — e um dia
 * PRESENTE com valor 0 é 0% real (mesma distinção já validada pra v1 em
 * 260730, reconfirmada pra v2 ao vivo em 260806 — ver docstring de
 * `extractSpamRateReadingsV2` em `postmaster-v2-client.ts`).
 *
 * ── Spam POR CAMPANHA governa o breaker, não só a média de domínio (#4705) ──
 *
 * O #4704 (item residual do checklist original) já calculava o PICO de spam
 * por campanha via `scripts/postmaster-campaign-spam-report.ts`, mas era só
 * um relatório sob demanda — o breaker (`resolveSpamSignal` em
 * `workers/brevo-dashboard/src/thresholds.ts`) continuava lendo só a média de
 * domínio inteiro gravada por este produtor. A #4705 é o achado que expôs o
 * custo disso: em 03/08/2026 a média de domínio ficou dentro do limite
 * enquanto uma campanha específica provavelmente teve spam bem mais alto —
 * dado que só existe no nível por campanha, nunca aparece na média.
 *
 * Esta versão do produtor "auto" faz uma 2ª rodada de consultas (reusando
 * `scripts/lib/postmaster-campaign-spam.ts`, a mesma lib pura do #4704):
 * `FEEDBACK_LOOP_ID` (DAILY) sobre a MESMA janela → `collectCampaignFeedbackLoopIds`
 * deduplica por campanha → 1 query `FEEDBACK_LOOP_SPAM_RATE` por campanha →
 * `findWorstCampaignSpam` acha o PICO mais alto entre todas — gravado em
 * `PostmasterSpamEntry.worstCampaignSpamRatePct`/`worstCampaignFeedbackLoopId`.
 * `resolveSpamSignal` prefere esse valor sobre a média de domínio quando
 * presente (ver docstring de `resolveSpamSignal`).
 *
 * FAIL-SOFT em 2 camadas, nunca derruba a sync principal (a média de domínio
 * é o que já funcionava antes do #4705, e continua sendo gravada mesmo se
 * tudo abaixo falhar): (1) por campanha — 1 query de `FEEDBACK_LOOP_SPAM_RATE`
 * que falha (429/5xx/timeout) é pulada, resto da coleta segue (mesmo padrão
 * do `postmaster-campaign-spam-report.ts`); (2) a coleta inteira — se a
 * própria query de `FEEDBACK_LOOP_ID` falhar, ou não houver nenhuma campanha
 * atribuível na janela (schema evolution / dias sem `FEEDBACK_LOOP_ID` na
 * resposta / conta ESP diferente de `DEFAULT_POSTMASTER_ACCOUNT_ID`), `main()`
 * grava a entry só com a média de domínio — exatamente o comportamento
 * anterior ao #4705.
 *
 * ── Observabilidade do enriquecimento por-campanha (#4780) ──
 *
 * `collectWorstCampaignSpam` colapsava 3 cenários bem diferentes no MESMO
 * retorno `null` — sem campanha na janela (benigno), toda query por-campanha
 * falhou (real, silencioso), ou `DEFAULT_POSTMASTER_ACCOUNT_ID` desatualizado
 * (real, silencioso: campanhas existiam, mas de OUTRA conta ESP). A #4780
 * troca o retorno por `CollectWorstCampaignSpamResult` (`{worst, attempted,
 * failed, otherAccountsSeen}`) — `main()` usa esses 4 campos pra logar cada
 * cenário com uma mensagem DISTINTA (`console.warn` pros 2 casos reais,
 * `console.log` pro benigno), em vez do log único "sem campanha atribuível"
 * que valia pros 3. Não inclui um alarme por e-mail com streak (o padrão de
 * `clarice-opens-catchup-alarm.ts`/#4740) — decisão explícita de escopo
 * (issue #4780 P2, "não precisa criar um alarme completo se desproporcional")
 * dado que o log distinto já resolve o "silencioso" da lacuna original; um
 * alarme dedicado fica pra quando/se o log sozinho não bastar na prática.
 *
 * Uso:
 *   npx tsx scripts/postmaster-spam-sync.ts [--window-days 10] [--dry-run]
 *
 * Env:
 *   data/.credentials.json  com o scope `postmaster.traffic.readonly` (ou o
 *                            mais amplo `postmaster`) — ver
 *                            scripts/oauth-setup.ts. Token emitido antes do
 *                            #4704 não tem o scope novo; falha com 403
 *                            ACCESS_TOKEN_SCOPE_INSUFFICIENT até reaprovar.
 *   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_WORKERS_TOKEN  p/ upload no KV.
 */

import { gFetch } from "./google-auth.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { DASHBOARD_KV_NAMESPACE_ID } from "./lib/dashboard-kv.ts";
import { POSTMASTER_SPAM_KV_KEY } from "./postmaster-spam-entry.ts";
import { HEALTH_SAMPLE_DAYS } from "../workers/brevo-dashboard/src/weekly-plan.ts";
import type { PostmasterSpamEntry } from "./lib/dashboard-kv-types.ts";
import {
  queryDomainStatsV2,
  extractSpamRateReadingsV2,
  extractFeedbackLoopIdsV2,
  type CalendarDate,
  type DateRangeV2,
  type QueryDomainStatsResponseV2,
} from "./lib/postmaster-v2-client.ts";
import {
  collectCampaignFeedbackLoopIds,
  aggregateCampaignSpamReadings,
  findWorstCampaignSpam,
  DEFAULT_POSTMASTER_ACCOUNT_ID,
  type CampaignSpamAggregate,
  type ParsedFeedbackLoopId,
  type WorstCampaignSpam,
} from "./lib/postmaster-campaign-spam.ts";

loadProjectEnv();

const POSTMASTER_DOMAIN = "clarice.ai";
/** Mesma janela das outras métricas da aba Rampa (HEALTH_SAMPLE_DAYS) — pedido do editor, 260730. */
const DEFAULT_WINDOW_DAYS = HEALTH_SAMPLE_DAYS;
/** Nome arbitrário ecoado de volta em `DomainStatV2.metric` — só precisa bater entre a query e `extractSpamRateReadingsV2`. */
const SPAM_RATE_METRIC_NAME = "spam_rate";
/** Idem, pra `FEEDBACK_LOOP_ID` (#4705). */
const FEEDBACK_LOOP_ID_METRIC_NAME = "feedback_loop_id";
/** Idem, pra `FEEDBACK_LOOP_SPAM_RATE` por campanha (#4705). */
const CAMPAIGN_SPAM_RATE_METRIC_NAME = "campaign_spam_rate";

/** `Date` → `CalendarDate` (UTC) — formato de fronteira de range da v2 (`domainStats:query`). */
export function toCalendarDate(d: Date): CalendarDate {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Pura/testável: `[start, end]` cobrindo os últimos `windowDays`
 * dias-calendário (UTC) terminando em `now`, ambos os limites inclusive — 1
 * range cobre a janela inteira numa chamada só (#4704, troca os N GETs
 * diários da v1 por 1 POST).
 */
export function buildWindowRange(windowDays: number, now: Date): DateRangeV2 {
  const start = new Date(now.getTime() - (windowDays - 1) * 86_400_000);
  return { start: toCalendarDate(start), end: toCalendarDate(now) };
}

export interface DayReading {
  /** YYYY-MM-DD */
  date: string;
  /** 0-1 (não %) */
  ratio: number;
}

export interface CollectSpamReadingsResult {
  /** Uma entrada por dia com dado publicado na janela — dia ausente na resposta v2 = "não publicado ainda" (nunca vira 0%, ver `extractSpamRateReadingsV2`). Sem ordem garantida (ver `buildAveragedEntry`, que não confia em ordem). */
  readings: DayReading[];
  daysProbed: number;
}

/**
 * Consulta `domainStats:query` (v2) UMA vez pro range inteiro — sucessor de
 * `collectSpamReadings`/`fetchStatsFromApi` (v1, N GETs diários, #4154/#4342,
 * removidos nesta migração #4704). `query` é injetável (mesmo padrão do
 * resto do arquivo) — produção usa `queryDomainStatsV2` com `gFetch`
 * (ver `main()`), testes passam um fake sem bater rede/token real.
 *
 * Qualquer erro de HTTP na chamada única propaga (via `queryDomainStatsV2`,
 * que já lança com mensagem classificada — scope insuficiente / API
 * desabilitada / 401 / outro) — não há mais o caso "alguns dias falharam,
 * outros não" que existia com N chamadas independentes: com 1 chamada, ou a
 * janela inteira responde, ou nada responde. `main()` deixa esse throw
 * propagar (exit 1), mesma disciplina do #4342: erro de API real nunca vira
 * "sem dado, seguir em frente" em silêncio.
 */
export async function collectSpamReadingsV2(
  windowDays: number,
  now: Date,
  query: (range: DateRangeV2) => Promise<QueryDomainStatsResponseV2>,
): Promise<CollectSpamReadingsResult> {
  const range = buildWindowRange(windowDays, now);
  const response = await query(range);
  const readings = extractSpamRateReadingsV2(response, SPAM_RATE_METRIC_NAME).map((r) => ({
    date: r.date,
    ratio: r.ratio,
  }));
  return { readings, daysProbed: windowDays };
}

/**
 * Pura/testável: constrói o `PostmasterSpamEntry` a partir das leituras
 * coletadas — MÉDIA simples do ratio sobre os dias com leitura válida (não
 * ponderada por volume; a API não expõe volume por dia). `null` se não há
 * nenhuma leitura (nunca inventar uma média de zero elementos).
 *
 * NÃO assume nenhuma ordem em `readings` — acha o `date` mais recente
 * explicitamente (comparação lexicográfica de `YYYY-MM-DD`, que ordena
 * cronologicamente) em vez de confiar que `readings[0]` é o mais recente
 * (achado convergente de 2 agentes no self-review do #4345 —
 * silent-failure-hunter e type-design-analyzer, preservado nesta migração).
 *
 * `daysProbed` (#4541) é o tamanho da janela sondada — vem do chamador
 * (`daysProbed` em `main()`), não é recalculado aqui. Junto com
 * `readings.length` (gravado como `daysWithData`), permite `resolveSpamSignal`
 * degradar pra `indeterminate` quando a cobertura é baixa demais.
 *
 * #4704: `dailyReadings` grava a série completa (todos os dias com leitura,
 * mais antigo primeiro) — antes desta migração, esse detalhe era descartado
 * depois de calcular a média.
 *
 * #4705: `worstCampaign` (opcional, `null` por default — chamadas existentes
 * com 3 args continuam produzindo uma entry sem os 2 campos novos, mesmo
 * shape de antes) grava `worstCampaignSpamRatePct`/`worstCampaignFeedbackLoopId`
 * quando o chamador achou pelo menos 1 campanha atribuível na janela — ver
 * `findWorstCampaignSpam`. Ausência (`null`) nunca grava os campos (schema
 * evolution: `undefined`, não um valor inventado).
 */
export function buildAveragedEntry(
  readings: DayReading[],
  now: Date,
  daysProbed: number,
  worstCampaign: WorstCampaignSpam | null = null,
): PostmasterSpamEntry | null {
  if (readings.length === 0) return null;
  const avgRatio = readings.reduce((sum, r) => sum + r.ratio, 0) / readings.length;
  const mostRecent = readings.reduce((latest, r) => (r.date > latest.date ? r : latest), readings[0]);
  const dailyReadings = [...readings]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((r) => ({ date: r.date, spamRatePct: r.ratio * 100 }));
  return {
    date: mostRecent.date,
    spamRatePct: avgRatio * 100,
    recordedAt: now.toISOString(),
    producedBy: "auto",
    daysWithData: readings.length,
    daysProbed,
    dailyReadings,
    ...(worstCampaign
      ? {
          worstCampaignSpamRatePct: worstCampaign.spamRatePct,
          worstCampaignFeedbackLoopId: worstCampaign.feedbackLoopId,
          // #4780: cobertura da campanha vencedora — ver docstring de
          // `WorstCampaignSpam.daysWithData` (postmaster-campaign-spam.ts).
          worstCampaignDaysWithData: worstCampaign.daysWithData,
        }
      : {}),
  };
}

/**
 * #4780: resultado ESTRUTURADO de `collectWorstCampaignSpam` — substitui o
 * `WorstCampaignSpam | null` anterior, que colapsava 3 causas de "sem pico"
 * na mesma saída (ver docstring do módulo, seção "Observabilidade do
 * enriquecimento por-campanha"). `main()` usa os 4 campos pra decidir QUAL
 * mensagem logar; nenhum deles entra em `buildAveragedEntry` além de `worst`
 * (os outros 3 são só diagnóstico, nunca gravados no KV).
 */
export interface CollectWorstCampaignSpamResult {
  /** Pico de spam por campanha na janela — `null` quando nenhuma campanha atribuível teve leitura (`attempted===0`) OU todas as queries tentadas falharam/vieram vazias. */
  worst: WorstCampaignSpam | null;
  /** Quantas campanhas (da conta `accountId` configurada) foram encontradas na janela e tiveram uma query de `FEEDBACK_LOOP_SPAM_RATE` tentada. `0` = nenhuma campanha atribuível a esta conta — ver `otherAccountsSeen` pra distinguir "não houve campanha na janela" de "accountId hardcoded desatualizado". */
  attempted: number;
  /** Dentre as `attempted`, quantas queries de `FEEDBACK_LOOP_SPAM_RATE` lançaram (429/5xx/timeout) — cada uma já foi pulada e logada via `console.warn` no momento da falha (fail-soft por campanha, preservado). `attempted>0 && failed===attempted` é o cenário "toda query por-campanha falhou" da issue #4780 — real, não deveria virar o mesmo log do caso benigno. */
  failed: number;
  /** #4780: quantas campanhas com `feedback_loop_id` no formato `{conta}_{campanha}` apareceram na janela mas de OUTRA conta ESP (`account !== accountId`) — `>0` junto com `attempted===0` é o sinal de que `DEFAULT_POSTMASTER_ACCOUNT_ID` pode estar desatualizado (havia campanha atribuível na resposta bruta, só não bateu a conta configurada); `0` é o caso benigno "nenhuma campanha (de nenhuma conta) na janela". */
  otherAccountsSeen: number;
}

/**
 * I/O/testável (#4705, retorno estruturado desde #4780): coleta o PICO de
 * spam por campanha na mesma janela do domínio — `queryFeedbackLoopIds`/
 * `queryCampaignSpamRate` injetáveis (mesmo padrão do resto do arquivo),
 * produção passa `gFetch` via `queryDomainStatsV2` (ver `main()`), testes
 * passam fakes sem bater rede/token real.
 *
 * FAIL-SOFT por campanha: uma query de `FEEDBACK_LOOP_SPAM_RATE` que falhar
 * (429/5xx/timeout) é pulada com `console.warn`, resto da coleta segue — mesmo
 * padrão de `postmaster-campaign-spam-report.ts`; a falha é contada em
 * `failed` pro chamador distinguir "algumas falharam" de "nenhuma campanha".
 * Se `queryFeedbackLoopIds` (a query base) falhar, o erro PROPAGA — é
 * responsabilidade do chamador (`main()`) decidir se isso derruba a sync
 * inteira ou só a parte por-campanha (decisão: só a parte por-campanha, ver
 * docstring do módulo).
 *
 * `worst: null` quando não há nenhuma campanha atribuível na janela
 * (`attempted===0`) ou quando as campanhas tentadas não produziram nenhum
 * agregado válido (falha, ou sucesso com 0 leituras) — o chamador (`main()`)
 * decide a mensagem certa a partir de `attempted`/`failed`/`otherAccountsSeen`.
 */
export async function collectWorstCampaignSpam(
  range: DateRangeV2,
  accountId: string,
  queryFeedbackLoopIds: (range: DateRangeV2) => Promise<QueryDomainStatsResponseV2>,
  queryCampaignSpamRate: (parsed: ParsedFeedbackLoopId, range: DateRangeV2) => Promise<QueryDomainStatsResponseV2>,
): Promise<CollectWorstCampaignSpamResult> {
  const idsResponse = await queryFeedbackLoopIds(range);
  const idsByDay = extractFeedbackLoopIdsV2(idsResponse, FEEDBACK_LOOP_ID_METRIC_NAME);
  const campaigns = collectCampaignFeedbackLoopIds(idsByDay, accountId);
  // #4780: mesma lista, SEM o filtro de accountId — a diferença de tamanho é
  // quantas campanhas de OUTRA conta apareceram na janela (sinal de
  // accountId hardcoded desatualizado quando attempted===0 mas isto é >0).
  const allAccountsCampaigns = collectCampaignFeedbackLoopIds(idsByDay);
  const otherAccountsSeen = allAccountsCampaigns.length - campaigns.length;

  if (campaigns.length === 0) {
    return { worst: null, attempted: 0, failed: 0, otherAccountsSeen };
  }

  const aggregates: CampaignSpamAggregate[] = [];
  let failed = 0;
  for (const parsed of campaigns) {
    try {
      const response = await queryCampaignSpamRate(parsed, range);
      const campaignReadings = extractSpamRateReadingsV2(response, CAMPAIGN_SPAM_RATE_METRIC_NAME);
      const agg = aggregateCampaignSpamReadings(parsed.campaignId, parsed.feedbackLoopId, campaignReadings);
      if (agg) aggregates.push(agg);
    } catch (e) {
      failed++;
      console.warn(
        `[postmaster-spam-sync] falha ao consultar FEEDBACK_LOOP_SPAM_RATE da campanha #${parsed.campaignId} ` +
          `(feedback_loop_id="${parsed.feedbackLoopId}"): ${e instanceof Error ? e.message : String(e)} — pulando, resto da coleta por-campanha segue.`,
      );
    }
  }
  return { worst: findWorstCampaignSpam(aggregates), attempted: campaigns.length, failed, otherAccountsSeen };
}

/**
 * Pura/testável: valida `--window-days`. Vazio usa o default
 * (HEALTH_SAMPLE_DAYS, mesma janela das outras métricas da Rampa); qualquer
 * valor não-numérico ou < 1 lança erro explícito (mesmo padrão de
 * `buildPostmasterSpamEntry` em postmaster-spam-entry.ts).
 */
export function parseWindowDaysArg(arg: string): number {
  if (arg.trim() === "") return DEFAULT_WINDOW_DAYS;
  const n = Number(arg);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--window-days inválido: "${arg}" (esperado inteiro >= 1).`);
  }
  return n;
}

async function main(): Promise<void> {
  const isDryRun = hasFlag(process.argv, "dry-run");
  const windowArg = getArg(process.argv, "window-days");

  let windowDays: number;
  try {
    windowDays = parseWindowDaysArg(windowArg);
  } catch (e) {
    console.error(`[postmaster-spam-sync] ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  const now = new Date();
  const query = (range: DateRangeV2) =>
    queryDomainStatsV2(
      POSTMASTER_DOMAIN,
      [{ name: SPAM_RATE_METRIC_NAME, standardMetric: "SPAM_RATE" }],
      range,
      gFetch,
    );
  const { readings, daysProbed } = await collectSpamReadingsV2(windowDays, now, query);

  // #4705: pico de spam POR CAMPANHA na MESMA janela do domínio — fail-soft
  // (ver docstring do módulo): uma falha aqui nunca derruba a sync principal,
  // só deixa a entry sem os 2 campos novos (fallback pro comportamento
  // anterior ao #4705, resolveSpamSignal usa a média de domínio).
  const range = buildWindowRange(windowDays, now);
  const queryFeedbackLoopIds = (r: DateRangeV2) =>
    queryDomainStatsV2(
      POSTMASTER_DOMAIN,
      [{ name: FEEDBACK_LOOP_ID_METRIC_NAME, standardMetric: "FEEDBACK_LOOP_ID" }],
      r,
      gFetch,
    );
  const queryCampaignSpamRate = (parsed: ParsedFeedbackLoopId, r: DateRangeV2) =>
    queryDomainStatsV2(
      POSTMASTER_DOMAIN,
      [
        {
          name: CAMPAIGN_SPAM_RATE_METRIC_NAME,
          standardMetric: "FEEDBACK_LOOP_SPAM_RATE",
          filter: `feedback_loop_id="${parsed.feedbackLoopId}"`,
        },
      ],
      r,
      gFetch,
    );
  let campaignResult: CollectWorstCampaignSpamResult = { worst: null, attempted: 0, failed: 0, otherAccountsSeen: 0 };
  try {
    campaignResult = await collectWorstCampaignSpam(range, DEFAULT_POSTMASTER_ACCOUNT_ID, queryFeedbackLoopIds, queryCampaignSpamRate);
  } catch (e) {
    console.warn(
      `[postmaster-spam-sync] falha ao coletar spam por campanha (#4705) — seguindo só com a média de domínio: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const { worst: worstCampaign, attempted, failed, otherAccountsSeen } = campaignResult;

  // #4780: 5 mensagens distintas em vez do log único "sem campanha
  // atribuível" que antes valia pros 3 cenários da issue — só os 2 primeiros
  // (pico achado / todas as queries falharam) e o de accountId suspeito são
  // `console.warn`/`console.log` de ATENÇÃO; os outros 2 são o caminho
  // normal/benigno.
  if (worstCampaign) {
    console.log(
      `[postmaster-spam-sync] pior campanha na janela: feedback_loop_id="${worstCampaign.feedbackLoopId}" ` +
        `pico=${worstCampaign.spamRatePct.toFixed(3)}% em ${worstCampaign.date} (cobertura: ${worstCampaign.daysWithData} dia(s) com dado) — ` +
        `este valor governa o breaker (precedência sobre a média de domínio).`,
    );
  } else if (attempted > 0 && failed === attempted) {
    console.warn(
      `[postmaster-spam-sync] TODAS as ${attempted} campanha(s) atribuível(is) na janela falharam na query de FEEDBACK_LOOP_SPAM_RATE ` +
        `(#4780) — enriquecimento por-campanha ficou OFFLINE nesta execução (não é "sem campanha", é falha real). ` +
        `Breaker segue usando só a média de domínio.`,
    );
  } else if (attempted === 0 && otherAccountsSeen > 0) {
    console.warn(
      `[postmaster-spam-sync] ${otherAccountsSeen} campanha(s) com feedback_loop_id de OUTRA conta ESP apareceram na janela, ` +
        `nenhuma da conta configurada (DEFAULT_POSTMASTER_ACCOUNT_ID="${DEFAULT_POSTMASTER_ACCOUNT_ID}") — este valor hardcoded pode estar ` +
        `desatualizado (#4780). Breaker segue usando só a média de domínio.`,
    );
  } else if (attempted === 0) {
    console.log(
      "[postmaster-spam-sync] sem campanha atribuível na janela (#4705) — breaker segue usando a média de domínio.",
    );
  } else {
    console.log(
      `[postmaster-spam-sync] ${attempted - failed}/${attempted} campanha(s) consultada(s) com sucesso, mas nenhuma teve leitura de ` +
        `FEEDBACK_LOOP_SPAM_RATE na janela — breaker segue usando a média de domínio.`,
    );
  }

  const entry = buildAveragedEntry(readings, now, daysProbed, worstCampaign);

  if (!entry) {
    console.log(
      `[postmaster-spam-sync] Nenhuma leitura válida na janela sondada (${daysProbed} dias, nenhum dia com dado publicado ainda). ` +
        "NÃO escrevendo no KV — mantendo a última leitura válida (expira em 48h e vira indeterminate, nunca verde falso).",
    );
    return;
  }

  if (!entry.dailyReadings || entry.dailyReadings.length === 0) {
    // `buildAveragedEntry` sempre popula `dailyReadings` quando `entry` não é
    // `null` (guard acima) — chegar aqui vazio seria um bug de regressão
    // naquela função, não um caso normal. `dailyReadings` continua opcional
    // no TYPE (schema evolution, entries manuais/pré-#4704), então o
    // acesso abaixo não pode assumir presença via non-null assertion (#4716).
    console.warn(
      "[postmaster-spam-sync] entry sem dailyReadings apesar de ter leituras — inesperado, buildAveragedEntry deveria sempre populá-lo.",
    );
  }
  const daysDetail = (entry.dailyReadings ?? []).map((r) => `${r.date}=${r.spamRatePct.toFixed(3)}%`).join(", ");
  console.log(
    `[postmaster-spam-sync] média de ${readings.length}/${daysProbed} dias da janela: ${daysDetail}`,
  );
  const json = JSON.stringify(entry, null, 2);
  console.log(`[postmaster-spam-sync] leitura: ${json}`);

  if (isDryRun) {
    console.log("[postmaster-spam-sync] --dry-run: não gravou no KV.");
    return;
  }

  await uploadTextToWorkerKV(json, POSTMASTER_SPAM_KV_KEY, {
    kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_WORKERS_TOKEN ?? "",
  });
  console.log(
    `[postmaster-spam-sync] KV atualizado: ${POSTMASTER_SPAM_KV_KEY} (spamRatePct=${entry.spamRatePct.toFixed(3)}, date=${entry.date}, média de ${readings.length}/${daysProbed} dias).`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[postmaster-spam-sync] erro:", e);
    process.exit(1);
  });
}
