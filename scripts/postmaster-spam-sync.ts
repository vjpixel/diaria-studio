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
 * `FEEDBACK_LOOP_ID` (DAILY) sobre a janela de DESCOBERTA — `CAMPAIGN_DISCOVERY_WINDOW_DAYS`,
 * 90 dias, separada da janela de média de domínio desde #5446 — → `collectCampaignFeedbackLoopIds`
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
 * Achado CRITICAL do fleet review pré-merge do #4780, corrigido em #4785: a
 * query BASE (`queryFeedbackLoopIds`) falhando é um 4º cenário real e
 * silencioso que o #4780 não cobriu — `campaignResult` ficava no mesmo shape
 * default do cenário benigno (`{worst: null, attempted: 0, failed: 0,
 * otherAccountsSeen: 0}`), então a mensagem impressa era "sem campanha
 * atribuível... segue normal" logo depois do `console.warn` real já emitido
 * pelo `catch` de `main()` — mascarando o próprio warn. `baseQueryFailed`
 * (rastreado explicitamente em `main()`) e `describeCampaignSpamCollectionLine`
 * (seleção de mensagem extraída pra função pura/testável, mesmo padrão de
 * `describeSpamSignalLine` em `clarice-schedule-ramp.ts`) fecham essa lacuna
 * com uma 6ª mensagem dedicada — nunca cai no ramo benigno quando a query
 * base falhou. Contando esse caso, são 3 cenários de `console.warn` (query
 * base falhou, todas as queries por-campanha falharam, accountId hardcoded
 * suspeito) e 3 de `console.log` (pico achado — caminho normal/ideal, sem
 * campanha atribuível, campanhas consultadas sem leitura na janela).
 *
 * ── Mapa por-campanha ACUMULADO alimenta a coluna Spam da tabela Envios (#4970) ──
 *
 * Até esta versão, o único dado por-campanha gravado no KV era o PICO da
 * janela sondada (`worstCampaignSpamRatePct`/`worstCampaignFeedbackLoopId`,
 * #4705) — suficiente pro breaker da aba Rampa, que só precisa de 1 número,
 * mas insuficiente pra tabela Envios (#4970), que precisa de 1 leitura POR
 * LINHA/campanha. Esta versão do produtor "auto" também grava
 * `PostmasterSpamEntry.campaignSpam` — um mapa `campaignId(string) →
 * PostmasterCampaignSpamRecord` — ACUMULADO entre execuções (`main()` lê o
 * mapa já gravado no KV via `getTextFromWorkerKV`, mescla com o lote desta
 * execução via `mergeCampaignSpamRecords`, grava o resultado): a janela de
 * DESCOBERTA por execução é `CAMPAIGN_DISCOVERY_WINDOW_DAYS` (90 dias desde
 * #5446 — era `HEALTH_SAMPLE_DAYS`/10 dias antes, insuficiente pra alcançar
 * os dias esparsos em que o Postmaster publica `FEEDBACK_LOOP_ID`, ver
 * docstring da constante), mas mesmo com 90 dias o merge continua
 * necessário — sem ele, cada execução reescreveria o mapa do zero e
 * apagaria silenciosamente o histórico de campanhas fora da janela atual.
 * Leitura do KV anterior é FAIL-SOFT (mesmo padrão do resto do
 * enriquecimento por-campanha): falhar nunca derruba a sync, só degrada pra
 * "sem mapa anterior" (grava só o lote desta execução).
 *
 * ── N domínios, chave KV por domínio (#4973) ──
 *
 * Até esta versão, o produtor sondava só `clarice.ai` (hardcoded) — o canal
 * `brevo_diaria` (#4515, domínio `diar.ia.br`) ficava completamente cego de
 * entregabilidade. `POSTMASTER_DOMAINS` generaliza pra uma lista de
 * `PostmasterDomainConfig` ({domain, kvKey, collectCampaignSpam}); `syncDomain`
 * (extraído do antigo corpo monolítico de `main()`) roda 1 vez por domínio,
 * sequencialmente. `clarice.ai` continua gravando na chave LITERAL
 * `postmaster:spam` (`POSTMASTER_SPAM_KV_KEY`, INTOCADA — o breaker da Rampa,
 * `resolveSpamSignal`, não muda nada) — só domínios novos usam
 * `additionalPostmasterSpamKvKey(domain)` (`postmaster:spam:{domain}`, fonte
 * única com o consumidor em `workers/brevo-dashboard/src/brevo-diaria.ts`).
 *
 * `diar.ia.br` tem 2 particularidades, ambas confirmadas ao vivo na sondagem
 * da #4973: (1) cobertura RALA (3 dias publicados em 21) é o caso NORMAL, não
 * uma falha — `syncDomain` trata "nenhuma leitura na janela" com
 * `console.log` (nunca warn/error) pra qualquer domínio, e o dashboard
 * (`renderBrevoDiariaPostmasterSpam`) mostra "aguardando publicação"
 * explícito em vez de célula vazia; (2) a query de `FEEDBACK_LOOP_ID` devolve
 * ZERO dias pra este domínio — `collectCampaignSpam: false` pula a coleta
 * por-campanha INTEIRA (nem a query base é tentada), nunca gastando N
 * queries que sempre voltariam vazias. Também vale notar: `lastVerifyTime` do
 * domínio vem como epoch zero (`1970-01-01`) mesmo com `verificationState:
 * VERIFIED` — nenhum código deste módulo lê esse campo (não é usado pra
 * decidir nada aqui), citado só pra quem for estender esta sondagem no
 * futuro não confiar nele como timestamp real.
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
import { uploadTextToWorkerKV, getTextFromWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { DASHBOARD_KV_NAMESPACE_ID } from "./lib/dashboard-kv.ts";
import { POSTMASTER_SPAM_KV_KEY } from "./postmaster-spam-entry.ts";
import { HEALTH_SAMPLE_DAYS } from "../workers/brevo-dashboard/src/weekly-plan.ts";
import { additionalPostmasterSpamKvKey } from "./lib/dashboard-kv-types.ts";
import type { PostmasterSpamEntry, PostmasterCampaignSpamRecord } from "./lib/dashboard-kv-types.ts";
import {
  queryDomainStatsV2,
  extractSpamRateReadingsV2,
  extractFeedbackLoopIdsV2,
  calendarDateToEntryDate,
  type CalendarDate,
  type DateRangeV2,
  type QueryDomainStatsResponseV2,
} from "./lib/postmaster-v2-client.ts";
import {
  collectCampaignFeedbackLoopIds,
  aggregateCampaignSpamReadings,
  findWorstCampaignSpam,
  toCampaignSpamRecords,
  mergeCampaignSpamRecords,
  DEFAULT_POSTMASTER_ACCOUNT_ID,
  type CampaignSpamAggregate,
  type ParsedFeedbackLoopId,
  type WorstCampaignSpam,
} from "./lib/postmaster-campaign-spam.ts";

loadProjectEnv();

/** Mesma janela das outras métricas da aba Rampa (HEALTH_SAMPLE_DAYS) — pedido do editor, 260730. */
const DEFAULT_WINDOW_DAYS = HEALTH_SAMPLE_DAYS;
/**
 * #5446: janela SEPARADA pra descoberta de campanha por-`FEEDBACK_LOOP_ID`
 * (`collectWorstCampaignSpam`, usada por `syncDomain`) — NUNCA reunificar com
 * `DEFAULT_WINDOW_DAYS`. `FEEDBACK_LOOP_ID` não é série diária: o Postmaster só
 * publica o id no dia em que ele cruza um limiar (não divulgado) de volume E
 * de reclamações distintas — confirmado ao vivo em 16/08/2026, janela de 25
 * dias devolveu FBL em só 3 (23/07, 27/07, 02/08). Com `DEFAULT_WINDOW_DAYS`
 * (10 dias, pensado pra MÉDIA de domínio) a descoberta nunca alcançava esses
 * dias, e `worstCampaignSpamRatePct`/`campaignSpam` ficavam pra sempre
 * ausentes do KV — sintoma idêntico a "sem onda essa semana", mascarando o
 * breaker do ramp atrás da média de domínio indefinidamente (#4704/#5368).
 * 90 dias alinha com o horizonte que a tabela Envios já mostra
 * (`PostmasterSpamEntry.campaignSpam` é acumulado via merge, #4970 — ver
 * `dashboard-kv-types.ts`) e fica dentro dos 120 dias de retenção do
 * Postmaster. É 1 query com range, não N — alargar não multiplica chamadas.
 */
export const CAMPAIGN_DISCOVERY_WINDOW_DAYS = 90;

/**
 * #5487: janela SEPARADA, mais curta, só pro que ALIMENTA O BREAKER
 * (`worstCampaignSpamRatePct`/`worstCampaignFeedbackLoopId`) — NUNCA
 * reunificar com `CAMPAIGN_DISCOVERY_WINDOW_DAYS`. A descoberta de 90 dias
 * (acima) segue existindo pra tabela Envios (`campaignSpam`, decisão do
 * #5368 — publicação esparsa do Postmaster exige janela larga pra achar o
 * `FEEDBACK_LOOP_ID`), mas usar a MESMA janela pro breaker faz um pico
 * isolado de campanha continuar governando `Math.max`/`stop` por até 90 dias
 * sem nenhum decaimento — achado ao vivo em 16/08/2026: um pico de 27/06
 * (quase 7 semanas antes) segurou o freio em `stop` sozinho, com a média de
 * domínio (0,24%) nem chegando perto do limiar.
 *
 * Decisão do editor (delegada — "investigue online para propor soluções",
 * sessão /diaria-develop 260817, registrada em comentário na #5487):
 * pesquisa sobre deliverability real mostra que o Gmail suaviza reputação
 * numa janela de ~7-30 dias (não 90) e trata pico isolado sem tendência
 * sustentada como candidato a verificação, não resposta prolongada — uma
 * janela discreta mais curta pro breaker é o que mais se aproxima de como o
 * próprio Gmail se comporta, sem reintroduzir a precedência assimétrica que
 * o #4779 já removeu do `Math.max` simples (opção descartada: peso
 * decrescente por idade).
 *
 * 21 dias (3 semanas): cobre com folga a janela de recuperação real do
 * Gmail, exclui com folga qualquer pico de 6+ semanas (o caso desta issue),
 * e evita reagir de menos a uma degradação que começou há 10-14 dias (o que
 * uma janela de 7 dias faria).
 */
export const BREAKER_CAMPAIGN_RECENCY_WINDOW_DAYS = 21;

/** Nome arbitrário ecoado de volta em `DomainStatV2.metric` — só precisa bater entre a query e `extractSpamRateReadingsV2`. */
const SPAM_RATE_METRIC_NAME = "spam_rate";
/** Idem, pra `FEEDBACK_LOOP_ID` (#4705). */
const FEEDBACK_LOOP_ID_METRIC_NAME = "feedback_loop_id";
/** Idem, pra `FEEDBACK_LOOP_SPAM_RATE` por campanha (#4705). */
const CAMPAIGN_SPAM_RATE_METRIC_NAME = "campaign_spam_rate";

/**
 * #4973: 1 domínio sondado por execução deste produtor — generaliza o antigo
 * `POSTMASTER_DOMAIN` hardcoded (`clarice.ai`) pra uma lista.
 */
export interface PostmasterDomainConfig {
  domain: string;
  /** Chave KV onde a leitura deste domínio é gravada — `clarice.ai` usa a chave legada (`POSTMASTER_SPAM_KV_KEY`, INTOCADA); domínios novos usam `additionalPostmasterSpamKvKey`. */
  kvKey: string;
  /**
   * `false` pula a coleta por-campanha INTEIRA pra este domínio — nunca chama
   * `collectWorstCampaignSpam` (nem a query base de `FEEDBACK_LOOP_ID`, nem
   * as N queries de `FEEDBACK_LOOP_SPAM_RATE` por campanha que ela dispararia
   * em cascata). `diar.ia.br` (#4973): a sondagem que motivou esta issue
   * confirmou que a query de `FEEDBACK_LOOP_ID` devolve ZERO dias pra este
   * domínio — não há hoje nenhuma campanha atribuível por feedback loop,
   * então tentar de novo a cada execução só gastaria 1 chamada de API que
   * sempre volta vazia. Diferente de `attempted===0` (que `collectWorstCampaignSpam`
   * já trata sozinho quando a query DEVOLVE zero campanhas) — aqui a decisão
   * de nem tentar é tomada ANTES da chamada, por configuração estática, não
   * por resultado observado nesta execução.
   */
  collectCampaignSpam: boolean;
}

export const POSTMASTER_DOMAINS: PostmasterDomainConfig[] = [
  { domain: "clarice.ai", kvKey: POSTMASTER_SPAM_KV_KEY, collectCampaignSpam: true },
  { domain: "diar.ia.br", kvKey: additionalPostmasterSpamKvKey("diar.ia.br"), collectCampaignSpam: false },
  // #6046: reativa.diar.ia.br substitui diar.ia.br como domínio de envio do
  // brevo_diaria a partir de 260824. Listado aqui pra não repetir o blind
  // spot que o #4973 fechou pro apex. Registrado e VERIFICADO no Postmaster
  // via `postmaster-register-domain.ts --verify --domain reativa.diar.ia.br`
  // (260824) — mas ainda sem histórico de envio, então `syncDomain` só vai
  // logar "nenhuma leitura na janela" (fail-soft, comportamento normal de
  // domínio recém-verificado) até a primeira campanha real sair daqui.
  { domain: "reativa.diar.ia.br", kvKey: additionalPostmasterSpamKvKey("reativa.diar.ia.br"), collectCampaignSpam: false },
];

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
 *
 * #4970: `campaignSpam` (opcional, `null` por default — mesma disciplina de
 * `worstCampaign` acima) grava o mapa por-campanha JÁ MESCLADO (ver
 * `mergeCampaignSpamRecords` — o chamador, `main()`, faz o merge ANTES de
 * chegar aqui; esta função só copia o resultado pra dentro da entry). Um
 * objeto vazio (`{}`, ex: 1ª execução sem KV anterior e sem campanha nesta
 * janela) também vira `undefined` — nunca gravar um mapa vazio onde
 * `undefined` já comunica "sem dado" (mesma disciplina do resto do módulo).
 */
export function buildAveragedEntry(
  readings: DayReading[],
  now: Date,
  daysProbed: number,
  worstCampaign: WorstCampaignSpam | null = null,
  campaignSpam: Record<string, PostmasterCampaignSpamRecord> | null = null,
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
    ...(campaignSpam && Object.keys(campaignSpam).length > 0 ? { campaignSpam } : {}),
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
  /**
   * #4970: TODOS os agregados válidos desta execução (não só o pior) — base
   * do mapa por-campanha da tabela Envios (`PostmasterSpamEntry.campaignSpam`,
   * via `toCampaignSpamRecords`). Superset de `worst` (derivado deste mesmo
   * array via `findWorstCampaignSpam`) — campo separado em vez de recalculado
   * a partir de `worst`, que já descarta a identidade das demais campanhas.
   */
  aggregates: CampaignSpamAggregate[];
  /** Quantas campanhas (da conta `accountId` configurada) foram encontradas na janela e tiveram uma query de `FEEDBACK_LOOP_SPAM_RATE` tentada. `0` = nenhuma campanha atribuível a esta conta — ver `otherAccountsSeen` pra distinguir "não houve campanha na janela" de "accountId hardcoded desatualizado". */
  attempted: number;
  /** Dentre as `attempted`, quantas queries de `FEEDBACK_LOOP_SPAM_RATE` lançaram (429/5xx/timeout) — cada uma já foi pulada e logada via `console.warn` no momento da falha (fail-soft por campanha, preservado). `attempted>0 && failed===attempted` é o cenário "toda query por-campanha falhou" da issue #4780 — real, não deveria virar o mesmo log do caso benigno. */
  failed: number;
  /** #4780: quantas campanhas com `feedback_loop_id` no formato `{conta}_{campanha}` apareceram na janela mas de OUTRA conta ESP (`account !== accountId`) — `>0` junto com `attempted===0` é o sinal de que `DEFAULT_POSTMASTER_ACCOUNT_ID` pode estar desatualizado (havia campanha atribuível na resposta bruta, só não bateu a conta configurada); `0` é o caso benigno "nenhuma campanha (de nenhuma conta) na janela". */
  otherAccountsSeen: number;
}

/**
 * Pura (#5487): `sinceDateInclusive` no mesmo formato `YYYY-MM-DD` de
 * `CampaignSpamAggregate.peakDate` — comparação lexicográfica funciona
 * porque o formato é de largura fixa. Usada só pra decidir QUAL agregado
 * entra na disputa do breaker (`findWorstCampaignSpam`); nunca filtra o
 * array que alimenta a tabela Envios (`aggregates`/`campaignSpam`), que
 * continua cobrindo a janela de descoberta inteira (`CAMPAIGN_DISCOVERY_WINDOW_DAYS`).
 */
export function filterAggregatesByRecency(
  aggregates: CampaignSpamAggregate[],
  sinceDateInclusive: string,
): CampaignSpamAggregate[] {
  return aggregates.filter((a) => a.peakDate >= sinceDateInclusive);
}

/**
 * I/O/testável (#4705, retorno estruturado desde #4780): coleta o PICO de
 * spam por campanha na mesma janela do domínio — `queryFeedbackLoopIds`/
 * `queryCampaignSpamRate` injetáveis (mesmo padrão do resto do arquivo),
 * produção passa `gFetch` via `queryDomainStatsV2` (ver `main()`), testes
 * passam fakes sem bater rede/token real.
 *
 * `now`/`breakerWindowDays` (#5487): `worst` — o único campo que alimenta o
 * breaker — é calculado só sobre os agregados cujo `peakDate` cai dentro dos
 * últimos `breakerWindowDays` (default `BREAKER_CAMPAIGN_RECENCY_WINDOW_DAYS`),
 * mesmo que a coleta em si (`range`, tipicamente 90 dias) tenha alcançado
 * campanhas mais antigas. `aggregates` no retorno continua sendo o array
 * COMPLETO (sem esse filtro) — é a tabela Envios que precisa do histórico
 * cheio, não o breaker.
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
  now: Date,
  breakerWindowDays: number = BREAKER_CAMPAIGN_RECENCY_WINDOW_DAYS,
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
    return { worst: null, aggregates: [], attempted: 0, failed: 0, otherAccountsSeen };
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
  const breakerSince = calendarDateToEntryDate(toCalendarDate(new Date(now.getTime() - (breakerWindowDays - 1) * 86_400_000)));
  const recentAggregates = filterAggregatesByRecency(aggregates, breakerSince);
  return { worst: findWorstCampaignSpam(recentAggregates), aggregates, attempted: campaigns.length, failed, otherAccountsSeen };
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

/**
 * #4785 (fix do achado CRITICAL do fleet review pré-merge do #4780): decide
 * qual das 6 mensagens de diagnóstico imprimir sobre a coleta de spam
 * por-campanha — extraído do corpo de `main()` pra ser testável sem mockar
 * `console.*`/rede (mesmo padrão de `describeSpamSignalLine` em
 * `clarice-schedule-ramp.ts`).
 *
 * Quando a query BASE (`queryFeedbackLoopIds`, dentro de
 * `collectWorstCampaignSpam`) lança, `main()` já loga um `console.warn` real
 * no `catch` externo ("falha ao coletar spam por campanha... seguindo só com
 * a média de domínio") — mas `campaignResult` fica no valor default
 * `{worst: null, attempted: 0, failed: 0, otherAccountsSeen: 0}`, um shape
 * IDÊNTICO ao do cenário benigno "sem campanha atribuível na janela". Sem o
 * parâmetro `baseQueryFailed`, esta função cairia no ramo benigno e
 * imprimiria uma 2ª linha contradizendo o warn que acabou de sair — a última
 * linha do log pareceria dizer que está tudo bem justamente no cenário mais
 * grave. `baseQueryFailed` intercepta esse caso ANTES do resto da seleção e
 * retorna uma 6ª mensagem dedicada, nunca a benigna.
 */
export interface CampaignSpamCollectionLine {
  level: "warn" | "log";
  message: string;
}

export function describeCampaignSpamCollectionLine(
  result: CollectWorstCampaignSpamResult,
  baseQueryFailed: boolean,
): CampaignSpamCollectionLine {
  const { worst, attempted, failed, otherAccountsSeen } = result;
  if (baseQueryFailed) {
    return {
      level: "warn",
      message:
        "[postmaster-spam-sync] coleta por-campanha OFFLINE nesta execução (query base de FEEDBACK_LOOP_ID falhou — ver o warn " +
        "acima com o motivo) — não é \"sem campanha atribuível\", é falha real (#4785). Breaker segue usando só a média de domínio.",
    };
  }
  if (worst) {
    return {
      level: "log",
      message:
        `[postmaster-spam-sync] pior campanha nos últimos ${BREAKER_CAMPAIGN_RECENCY_WINDOW_DAYS} dias: feedback_loop_id="${worst.feedbackLoopId}" ` +
        `pico=${worst.spamRatePct.toFixed(3)}% em ${worst.date} (cobertura: ${worst.daysWithData} dia(s) com dado) — ` +
        `este valor governa o breaker (precedência sobre a média de domínio; #5487 — janela do breaker é mais curta que a de descoberta/tabela Envios).`,
    };
  }
  if (attempted > 0 && failed === attempted) {
    return {
      level: "warn",
      message:
        `[postmaster-spam-sync] TODAS as ${attempted} campanha(s) atribuível(is) na janela falharam na query de FEEDBACK_LOOP_SPAM_RATE ` +
        `(#4780) — enriquecimento por-campanha ficou OFFLINE nesta execução (não é "sem campanha", é falha real). ` +
        `Breaker segue usando só a média de domínio.`,
    };
  }
  if (attempted === 0 && otherAccountsSeen > 0) {
    return {
      level: "warn",
      message:
        `[postmaster-spam-sync] ${otherAccountsSeen} campanha(s) com feedback_loop_id de OUTRA conta ESP apareceram na janela, ` +
        `nenhuma da conta configurada (DEFAULT_POSTMASTER_ACCOUNT_ID="${DEFAULT_POSTMASTER_ACCOUNT_ID}") — este valor hardcoded pode estar ` +
        `desatualizado (#4780). Breaker segue usando só a média de domínio.`,
    };
  }
  if (attempted === 0) {
    return {
      level: "log",
      message: "[postmaster-spam-sync] sem campanha atribuível na janela (#4705) — breaker segue usando a média de domínio.",
    };
  }
  return {
    level: "log",
    message:
      `[postmaster-spam-sync] ${attempted - failed}/${attempted} campanha(s) consultada(s) com sucesso, mas nenhuma teve leitura de ` +
      `FEEDBACK_LOOP_SPAM_RATE na janela — breaker segue usando a média de domínio.`,
  };
}

/** 1 linha de log produzida por `syncDomain` — `main()` decide o console.* certo, mantendo `syncDomain` puro/testável (mesmo padrão de `CampaignSpamCollectionLine`). */
export interface SyncLogLine {
  level: "log" | "warn";
  message: string;
}

/** Dependências I/O de `syncDomain`, todas injetáveis (mesmo padrão do resto do arquivo) — produção passa as reais (ver `main()`), testes passam fakes sem bater rede/KV real. */
export interface SyncDomainDeps {
  queryDomainSpam: (range: DateRangeV2) => Promise<QueryDomainStatsResponseV2>;
  queryFeedbackLoopIds: (range: DateRangeV2) => Promise<QueryDomainStatsResponseV2>;
  queryCampaignSpamRate: (parsed: ParsedFeedbackLoopId, range: DateRangeV2) => Promise<QueryDomainStatsResponseV2>;
  /** Lê o mapa `campaignSpam` já gravado no KV deste domínio (ou lança — `syncDomain` trata a falha como fail-soft, mesmo padrão do `main()` anterior ao #4973). `null`/ausente = "sem mapa anterior". */
  readPreviousCampaignSpam: () => Promise<Record<string, PostmasterCampaignSpamRecord> | null>;
}

export interface SyncDomainResult {
  domain: string;
  kvKey: string;
  /** `null` = nenhuma leitura válida na janela (comum pra domínios de cobertura rala, ex: `diar.ia.br` — #4973) — `main()` NÃO escreve no KV neste caso, preservando a última leitura válida (mesmo comportamento pré-#4973). */
  entry: PostmasterSpamEntry | null;
  logLines: SyncLogLine[];
}

/**
 * #4973: coleta + monta a `PostmasterSpamEntry` de UM domínio — extraído do
 * corpo de `main()` (que antes só conhecia `clarice.ai` hardcoded) pra ser
 * reusável por N domínios com deps injetáveis, testável sem I/O real. Toda a
 * lógica de negócio é idêntica à versão pré-#4973 pra `clarice.ai`
 * (`config.collectCampaignSpam: true`) — só parametrizada por `config` em vez
 * de constantes de módulo, então o resultado pra `clarice.ai` não muda em
 * nada (ver teste de regressão "clarice.ai idêntico ao comportamento
 * pré-#4973").
 *
 * `config.collectCampaignSpam === false` (ex: `diar.ia.br`, sem
 * `FEEDBACK_LOOP_ID` atribuível conhecido) pula a coleta por-campanha
 * INTEIRA — nem a query base (`queryFeedbackLoopIds`) é chamada, então
 * `deps.queryFeedbackLoopIds`/`deps.queryCampaignSpamRate` nunca são
 * invocadas pra esse domínio (ver teste "collectCampaignSpam:false nunca
 * chama as queries de campanha").
 */
export async function syncDomain(
  config: PostmasterDomainConfig,
  windowDays: number,
  now: Date,
  deps: SyncDomainDeps,
): Promise<SyncDomainResult> {
  const logLines: SyncLogLine[] = [];
  const log = (message: string) => logLines.push({ level: "log", message });
  const warn = (message: string) => logLines.push({ level: "warn", message });
  const tag = `[postmaster-spam-sync] domínio ${config.domain}:`;

  const { readings, daysProbed } = await collectSpamReadingsV2(windowDays, now, deps.queryDomainSpam);

  // #5446: janela de DESCOBERTA de campanha é `CAMPAIGN_DISCOVERY_WINDOW_DAYS`
  // (90 dias), NÃO `windowDays` (média de domínio, tipicamente 10) — ver
  // docstring da constante. Antes deste fix as duas janelas eram a mesma
  // `range`, e a descoberta nunca alcançava os dias esparsos em que o
  // Postmaster publica `FEEDBACK_LOOP_ID`.
  const campaignRange = buildWindowRange(CAMPAIGN_DISCOVERY_WINDOW_DAYS, now);

  // #4705: pico de spam POR CAMPANHA — fail-soft (ver docstring do módulo):
  // uma falha aqui nunca derruba a sync principal, só deixa a entry sem os 2
  // campos novos (fallback pro comportamento anterior ao #4705,
  // resolveSpamSignal usa a média de domínio).
  let campaignResult: CollectWorstCampaignSpamResult = {
    worst: null,
    aggregates: [],
    attempted: 0,
    failed: 0,
    otherAccountsSeen: 0,
  };
  let previousCampaignSpam: Record<string, PostmasterCampaignSpamRecord> | null = null;

  if (config.collectCampaignSpam) {
    // #4785: rastreado explicitamente pra `describeCampaignSpamCollectionLine`
    // nunca confundir "query base falhou" (real, já logado abaixo) com "sem
    // campanha atribuível" (benigno) — os dois deixavam `campaignResult` no
    // mesmo shape default antes deste fix (achado CRITICAL do fleet review
    // pré-merge do #4780).
    let baseQueryFailed = false;
    try {
      campaignResult = await collectWorstCampaignSpam(campaignRange, DEFAULT_POSTMASTER_ACCOUNT_ID, deps.queryFeedbackLoopIds, deps.queryCampaignSpamRate, now);
    } catch (e) {
      baseQueryFailed = true;
      warn(`${tag} falha ao coletar spam por campanha (#4705) — seguindo só com a média de domínio: ${e instanceof Error ? e.message : String(e)}`);
    }

    // #4780/#4785: seleção da mensagem de diagnóstico é pura/testável (ver
    // `describeCampaignSpamCollectionLine`) — 3 casos benignos (`console.log`:
    // pico achado, sem campanha na janela, campanhas consultadas sem leitura)
    // e 3 casos reais de ATENÇÃO (`console.warn`: todas as queries por-campanha
    // falharam, accountId hardcoded suspeito, query BASE falhou).
    const collectionLine = describeCampaignSpamCollectionLine(campaignResult, baseQueryFailed);
    (collectionLine.level === "warn" ? warn : log)(`${tag} ${collectionLine.message}`);

    // #4970: mescla o mapa por-campanha desta execução com o que já está
    // gravado no KV — sem isso, cada execução reescreveria o mapa do zero e só
    // as campanhas dentro da janela sondada (`CAMPAIGN_DISCOVERY_WINDOW_DAYS`,
    // 90 dias desde #5446) reteriam valor, apagando silenciosamente o restante
    // do histórico que a tabela Envios mostra (ver docstring de `PostmasterSpamEntry.campaignSpam`,
    // dashboard-kv-types.ts, pro racional completo). FAIL-SOFT na leitura
    // (mesmo padrão do resto do enriquecimento por-campanha, #4705/#4780):
    // credenciais ausentes, rede, KV vazio (1ª execução pós-#4970) ou JSON
    // corrompido nunca derrubam a sync — degradam pra "sem mapa anterior",
    // que ainda assim grava o lote desta execução (nunca perde o que acabou
    // de coletar por causa de uma leitura que falhou).
    try {
      previousCampaignSpam = await deps.readPreviousCampaignSpam();
    } catch (e) {
      warn(`${tag} falha ao ler o mapa por-campanha anterior do KV (#4970) — seguindo sem merge, gravando só o lote desta execução: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    // #4973: domínio configurado SEM atribuição por FEEDBACK_LOOP_ID conhecida
    // (ex: diar.ia.br) — nem a query base é tentada, nunca N queries que
    // sempre voltam vazias (ver docstring de `PostmasterDomainConfig.collectCampaignSpam`).
    log(`${tag} coleta por-campanha pulada (#4973) — sem atribuição por FEEDBACK_LOOP_ID conhecida pra este domínio, breaker/tabela seguem só com a média de domínio.`);
  }

  const { worst: worstCampaign } = campaignResult;
  const freshCampaignSpam = toCampaignSpamRecords(campaignResult.aggregates, now);
  const mergedCampaignSpam = mergeCampaignSpamRecords(previousCampaignSpam, freshCampaignSpam);
  if (config.collectCampaignSpam) {
    log(
      `${tag} mapa por-campanha (#4970): ${Object.keys(freshCampaignSpam).length} campanha(s) nesta execução, ` +
        `${previousCampaignSpam ? Object.keys(previousCampaignSpam).length : 0} preservada(s) do KV anterior, ` +
        `${Object.keys(mergedCampaignSpam).length} no total após merge.`,
    );
  }

  const entry = buildAveragedEntry(readings, now, daysProbed, worstCampaign, mergedCampaignSpam);

  if (!entry) {
    // #4973: pra domínios de cobertura rala (diar.ia.br), este é o caso
    // COMUM, não uma exceção — a mensagem é `console.log` (nunca warn/error)
    // de propósito, e o dashboard trata a ausência de entry como "aguardando
    // publicação" explícito (ver renderBrevoDiariaPostmasterSpam), nunca como
    // erro. `main()` não escreve no KV neste caso — mantém a última leitura
    // válida (expira em 48h e vira indeterminate, nunca verde falso).
    log(`${tag} nenhuma leitura válida na janela sondada (${daysProbed} dias, nenhum dia com dado publicado ainda). NÃO escrevendo no KV — mantendo a última leitura válida (expira em 48h e vira indeterminate, nunca verde falso).`);
    return { domain: config.domain, kvKey: config.kvKey, entry: null, logLines };
  }

  if (!entry.dailyReadings || entry.dailyReadings.length === 0) {
    // `buildAveragedEntry` sempre popula `dailyReadings` quando `entry` não é
    // `null` (guard acima) — chegar aqui vazio seria um bug de regressão
    // naquela função, não um caso normal. `dailyReadings` continua opcional
    // no TYPE (schema evolution, entries manuais/pré-#4704), então o
    // acesso abaixo não pode assumir presença via non-null assertion (#4716).
    warn(`${tag} entry sem dailyReadings apesar de ter leituras — inesperado, buildAveragedEntry deveria sempre populá-lo.`);
  }
  const daysDetail = (entry.dailyReadings ?? []).map((r) => `${r.date}=${r.spamRatePct.toFixed(3)}%`).join(", ");
  log(`${tag} média de ${readings.length}/${daysProbed} dias da janela: ${daysDetail}`);

  return { domain: config.domain, kvKey: config.kvKey, entry, logLines };
}

/** I/O real de `SyncDomainDeps.readPreviousCampaignSpam` — produção passa isto pra `syncDomain` (ver `main()`); testes injetam um fake. */
function makeReadPreviousCampaignSpam(kvKey: string): SyncDomainDeps["readPreviousCampaignSpam"] {
  return async () => {
    const rawPrevious = await getTextFromWorkerKV(kvKey, {
      kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      token: process.env.CLOUDFLARE_WORKERS_TOKEN ?? "",
    });
    if (!rawPrevious) return null;
    const parsedPrevious: unknown = JSON.parse(rawPrevious);
    const candidate =
      parsedPrevious && typeof parsedPrevious === "object"
        ? (parsedPrevious as { campaignSpam?: unknown }).campaignSpam
        : undefined;
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as Record<string, PostmasterCampaignSpamRecord>)
      : null;
  };
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

  // #4973: N domínios, sondados sequencialmente (não em paralelo) — mantém o
  // log legível por domínio e evita qualquer preocupação de concorrência
  // sobre a MESMA quota de API do Postmaster (mesma conta OAuth pros 2
  // domínios). Um erro NUM domínio nunca derruba a sondagem dos demais —
  // mas o exit code final continua honesto (#4973 self-review): uma falha
  // real (ex: 403 de escopo insuficiente, outage) é registrada e propagada
  // via process.exit(1) só depois de TODOS os domínios terem sido
  // tentados, preservando o contrato pré-#4973 documentado em
  // run-postmaster-spam-sync.ps1 (silêncio no exit code seria pior que o
  // warning de cobertura baixa que já existia).
  let hadDomainFailure = false;
  for (const config of POSTMASTER_DOMAINS) {
    const deps: SyncDomainDeps = {
      queryDomainSpam: (range) =>
        queryDomainStatsV2(config.domain, [{ name: SPAM_RATE_METRIC_NAME, standardMetric: "SPAM_RATE" }], range, gFetch),
      queryFeedbackLoopIds: (range) =>
        queryDomainStatsV2(config.domain, [{ name: FEEDBACK_LOOP_ID_METRIC_NAME, standardMetric: "FEEDBACK_LOOP_ID" }], range, gFetch),
      queryCampaignSpamRate: (parsed, range) =>
        queryDomainStatsV2(
          config.domain,
          [
            {
              name: CAMPAIGN_SPAM_RATE_METRIC_NAME,
              standardMetric: "FEEDBACK_LOOP_SPAM_RATE",
              filter: `feedback_loop_id="${parsed.feedbackLoopId}"`,
            },
          ],
          range,
          gFetch,
        ),
      readPreviousCampaignSpam: makeReadPreviousCampaignSpam(config.kvKey),
    };

    let result: SyncDomainResult;
    try {
      result = await syncDomain(config, windowDays, now, deps);
    } catch (e) {
      console.error(
        `[postmaster-spam-sync] domínio ${config.domain}: erro inesperado na sondagem — pulando este domínio, seguindo com os demais: ${e instanceof Error ? e.message : String(e)}`,
      );
      hadDomainFailure = true;
      continue;
    }

    for (const line of result.logLines) {
      (line.level === "warn" ? console.warn : console.log)(line.message);
    }

    if (!result.entry) continue;

    const json = JSON.stringify(result.entry, null, 2);
    console.log(`[postmaster-spam-sync] domínio ${config.domain}: leitura: ${json}`);

    if (isDryRun) {
      console.log(`[postmaster-spam-sync] domínio ${config.domain}: --dry-run: não gravou no KV.`);
      continue;
    }

    await uploadTextToWorkerKV(json, result.kvKey, {
      kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      token: process.env.CLOUDFLARE_WORKERS_TOKEN ?? "",
    });
    console.log(
      `[postmaster-spam-sync] domínio ${config.domain}: KV atualizado: ${result.kvKey} (spamRatePct=${result.entry.spamRatePct.toFixed(3)}, date=${result.entry.date}, ${result.entry.daysWithData ?? 0}/${result.entry.daysProbed ?? 0} dias).`,
    );
  }

  // Propaga a falha só DEPOIS de tentar todos os domínios (#4973 self-review)
  // — nenhum domínio saudável perde seu write por causa de outro quebrado,
  // mas o processo não sai silenciosamente com 0 se algo real falhou.
  if (hadDomainFailure) {
    console.error("[postmaster-spam-sync] pelo menos 1 domínio falhou na sondagem — ver erros acima.");
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[postmaster-spam-sync] erro:", e);
    process.exit(1);
  });
}
