/**
 * Thresholds dos circuit breakers do doc "Parceria Editorial Clarice.ai ×
 * Diar.ia" (métricas de reavaliação definidas pelo editor) — FONTE ÚNICA
 * (#3078) consumida pela aba Rampa (`weekly-plan.ts`), pela tabela Envios
 * (`sections-core.ts`) e por "Totais por mês" (`sections-kv.ts`) — EXCETO
 * `spamRate`, que desde #4154 é exceção parcial nesta "fonte única": "Totais
 * por mês" NUNCA colore spam (o número ali segue vindo de `complaints` da
 * Brevo, que subconta o spam real em ~120× — medido em #4972, era ~50× na
 * medição original do #4063 — e não tem granularidade por campanha pra
 * trocar de fonte, ver `sections-kv.ts`), e o guardrail por braço do
 * experimento CTA (`experiment-cta.ts::CTA_SPAM_BREACH_YELLOW_PCT`) mantém
 * seu próprio valor fixo, deliberadamente desacoplado deste. A tabela Envios
 * migrou (#4970): a coluna Spam agora lê o PICO por campanha do Postmaster
 * v2 (`resolveEnvioCampaignSpamCell` abaixo) em vez de `complaints`, e
 * `spamRate` aqui passou a governar TANTO a aba Rampa QUANTO a tabela
 * Envios — não mais só a Rampa.
 *
 * Antes do #3078 cada superfície fixava o threshold de bounce por conta
 * própria: a Rampa usava os 2 breakers reais do doc (hard ≥2%, total
 * hard+soft ≥5%, deliberadamente separados — #2981, hard-alto/total-baixo é
 * um cenário real que a soma sozinha mascara), enquanto Envios/Totais
 * alertavam num "≥3% combinado" que não existe no doc — um envio com hard
 * 2.5%/total 2.8% (breaker de hard já estourado) não colorria nada nelas.
 * Extraído de `weekly-plan.ts` (que reexporta os mesmos nomes pra não quebrar
 * consumidores existentes).
 */
import type { PostmasterSpamEntry, PostmasterProducer, PostmasterCampaignSpamRecord } from "./types.ts";

export interface HealthThresholds {
  /** Abertura: >= green é 🟢; >= yellow (e < green) é 🟡; abaixo de yellow é 🔴. Maior é melhor. */
  openRate: { green: number; yellow: number };
  /** Hard bounce / bounce total / spam / unsub: < green é 🟢; < yellow é 🟡; >= yellow é 🔴. Menor é melhor. */
  hardBounceRate: { green: number; yellow: number };
  bounceRate: { green: number; yellow: number };
  spamRate: { green: number; yellow: number };
  unsubRate: { green: number; yellow: number };
}

/**
 * 🔴 = o breaker do doc (nível de PAUSA — o doc tem UM nível só); 🟡 = zona de
 * alerta que adicionamos ("olhar com cuidado / segurar o crescimento" chegando
 * perto do breaker). Hard bounce e bounce total SEPARADOS: o doc tem dois
 * breakers (hard ≥2%, total hard+soft ≥5%) — juntar perderia o caso
 * hard-alto/total-baixo.
 */
export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  openRate: { green: 17, yellow: 15 }, // 🔴 <15% (breaker do doc)
  hardBounceRate: { green: 1.5, yellow: 2 }, // 🔴 ≥2% (breaker)
  bounceRate: { green: 4, yellow: 5 }, // 🔴 ≥5% total hard+soft (breaker)
  // #4154 (260730): atualizado pelo editor pros limiares oficiais do Google
  // Postmaster Tools (verde <0,10%, amarelo <0,30%, 🔴 ≥0,30%) agora que a
  // leitura automática via API está em produção — substitui o par 0,05/0,1
  // anterior, calibrado sobre o número (subcontado) da Brevo.
  spamRate: { green: 0.1, yellow: 0.3 }, // 🔴 ≥0,3% (limiar oficial do Postmaster Tools)
  unsubRate: { green: 2, yellow: 3 }, // 🔴 ≥3% (breaker)
};

/**
 * Circuit breaker de bounce combinado (#3078) — usado por superfícies que só
 * exibem 1 número de bounce (soma hard+soft numa célula só), diferente da
 * Rampa que mostra hard e total lado a lado. Dispara quando hard bounce
 * SOZINHO já estoura (>= `hardBounceRate.yellow`) OU quando o total hard+soft
 * estoura (>= `bounceRate.yellow`) — regra "OR" entre os 2 breakers reais do
 * doc, nunca um threshold combinado inventado. É isso que garante o caso
 * hard-alto/total-baixo (ex: hard 2.5%, total 2.8%) alertar mesmo com o total
 * ainda longe de 5%.
 */
export function isBounceBreach(
  hardBounceRatePct: number,
  totalBounceRatePct: number,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): boolean {
  return hardBounceRatePct >= t.hardBounceRate.yellow || totalBounceRatePct >= t.bounceRate.yellow;
}

/**
 * #4063: o circuit breaker de spam da Rampa lia `globalStats.complaints` da
 * Brevo — que subconta o spam real em ~50× (a Brevo só enxerga feedback
 * loops; o "marcar como spam" do Gmail não passa por FBL, e 73% da base é
 * Gmail). Medido no Google Postmaster Tools (domínio `clarice.ai`): ~1,0%,
 * pico 1,5%, contra ≤0,02% reportado pela Brevo — o breaker do doc (≥0,1%)
 * nunca disparou.
 *
 * Decisão do editor: o breaker NUNCA reporta 🟢 usando o número da Brevo. A
 * fonte que governa é uma leitura do Postmaster (`PostmasterSpamEntry`,
 * gravada automaticamente via API por `scripts/postmaster-spam-sync.ts` a
 * cada 12h desde #4154, ou manualmente por `scripts/postmaster-spam-entry.ts`
 * como fallback) — com PRECEDÊNCIA sobre `complaints`. Sem leitura (ausente
 * OU velha demais pra confiar), o sinal é `indeterminate`: nunca
 * `breach=true` (não é um bloqueio automático — a trava fica pra depois),
 * mas também nunca colorido verde (ver `classifySpamSignal` em
 * `weekly-plan.ts`, que força 🟡 nesse caso).
 */
export type SpamSignalSource = "postmaster" | "indeterminate";

/**
 * #4544 (achado HIGH do fleet review pré-merge do #4541): as 4 causas de
 * `source==="indeterminate"` — entry ausente, entry malformada (`spamRatePct`
 * não-finito), gravação stale (`recordedAt`/`POSTMASTER_STALE_MS`), medição
 * stale (`date`/`POSTMASTER_DATA_STALE_MS`) e cobertura baixa
 * (`daysWithData`/`daysProbed`/`POSTMASTER_MIN_COVERAGE_RATIO`) — colapsavam
 * todas no mesmo `{ source: "indeterminate", ratePct: null, breach: false }`,
 * indistinguível na UI. O incidente 260803 só foi diagnosticado puxando a
 * entry crua do KV manualmente; sem este campo, o PRÓXIMO incidente (ex:
 * cobertura caindo por erro de API, ou `date` stale por outro bug) repete a
 * mesma arqueologia manual, agora com ainda mais causas candidatas.
 */
export type SpamSignalIndeterminateReason =
  | "missing"
  | "malformed"
  | "recorded-stale"
  | "date-stale"
  | "low-coverage";

export interface SpamSignal {
  source: SpamSignalSource;
  /** % da leitura do Postmaster usada nesta avaliação — `null` quando `source==="indeterminate"`. */
  ratePct: number | null;
  /** `true` quando a leitura do Postmaster cruzou o breaker (`>= thresholds.spamRate.yellow`). Sempre `false` quando indeterminado. */
  breach: boolean;
  /** Qual produtor gravou a leitura (#4154) — `undefined` quando indeterminado ou entry pré-#4154 sem o campo. Só informativo (label da UI), nunca entra na classificação. */
  producedBy?: PostmasterProducer;
  /**
   * #4544: qual dos 5 branches de `resolveSpamSignal` produziu
   * `source==="indeterminate"` — `undefined` quando `source==="postmaster"`
   * (nunca populado nesse caso). Só informativo (tooltip da UI), nunca entra
   * em nenhuma decisão de classificação/semáforo.
   */
  reason?: SpamSignalIndeterminateReason;
  /**
   * #4974: `feedback_loop_id` da campanha cujo pico governou `ratePct` (só
   * quando `Math.max` de `resolveSpamSignal` escolheu o pico por campanha,
   * não a média de domínio) — `undefined` quando a média de domínio governa,
   * quando `source==="indeterminate"`, ou em entries sem campanha atribuível
   * na janela. Existe pra levar a ORIGEM do número até a superfície de
   * decisão (CLI `clarice-schedule-ramp.ts`/`clarice-wave-plan.ts` e o
   * dashboard) — decisão do editor na #4974 (opção 3: sem piso de cobertura
   * pro pico por campanha, mas cobertura VISÍVEL onde o número aparece,
   * julgamento fica com o editor).
   */
  worstCampaignFeedbackLoopId?: string;
  /**
   * #4974: cobertura (`daysWithData`) da janela sondada da campanha acima —
   * junto com o campo acima, é o que permite distinguir "pico sustentado
   * pela janela" de "artefato de 1 dia isolado" no ponto onde o editor
   * decide. Populado na MESMA condição de `worstCampaignFeedbackLoopId`
   * (pico por campanha governando `ratePct`); `undefined` fora dela ou
   * quando a entry é anterior ao #4780 (campo não existia ainda). Só
   * informativo — nunca entra em `resolveSpamSignal` nem em `breach` (a
   * issue #4974 decidiu explicitamente NÃO adicionar um guard de cobertura
   * equivalente ao `POSTMASTER_MIN_COVERAGE_RATIO` do domínio pro pico por
   * campanha — ver docstring de `resolveSpamSignal` abaixo).
   */
  worstCampaignDaysWithData?: number;
}

/**
 * Além de "campo ausente", uma GRAVAÇÃO mais velha que isto é tratada como se
 * não existisse — sinal de que o processo que escreve no KV (sync automático
 * ou entrada manual) parou de rodar, OU rodou mas não teve nenhuma leitura
 * válida pra gravar (`postmaster-spam-sync.ts` pula a escrita nesse caso —
 * ver docstring de `main()` lá — então "gravação stale" também cobre "rodou
 * sem achar dado"). Continua útil como um segundo guard
 * (independente do de `POSTMASTER_DATA_STALE_MS` abaixo), mas **não é** o que
 * garante que o DADO em si é recente — ver #4541: `postmaster-spam-sync.ts`
 * roda a cada 12h e reescreve a entry mesmo quando a janela sondada não trouxe
 * nenhum dia novo, então `recordedAt` fica sempre fresco mesmo com uma
 * MEDIÇÃO (`entry.date`) de dias atrás. Por isso `resolveSpamSignal` abaixo
 * exige os dois: gravação recente (`recordedAt`, este guard) E medição
 * recente (`date`, `POSTMASTER_DATA_STALE_MS`).
 */
export const POSTMASTER_STALE_MS = 48 * 60 * 60 * 1000;

/**
 * #4541: guard de frescor do DADO MEDIDO (`entry.date`), separado do guard de
 * frescor da GRAVAÇÃO (`POSTMASTER_STALE_MS`/`recordedAt` acima). É este que
 * fecha o buraco do #4541 — sem ele, uma medição de dias atrás carimbada como
 * "gravada agora" passava como 🟢 confiável.
 *
 * Folga maior que `POSTMASTER_STALE_MS` (5 dias vs 48h) de propósito: o
 * Postmaster publica com ~2 dias de atraso (dado de hoje não existe ainda na
 * API), então uma janela de 48h contada a partir de `date` deixaria o sinal
 * PERMANENTEMENTE indeterminate mesmo em operação normal. 5 dias dá folga pro
 * atraso de publicação + fins de semana sem sync (Task Scheduler roda a cada
 * 12h, então isso não deveria acontecer, mas a folga cobre uma falha de 1-2
 * ciclos) sem deixar uma medição de semanas atrás perpetuar um falso
 * "confiável" — mesmo raciocínio do guard original, aplicado ao campo certo.
 */
export const POSTMASTER_DATA_STALE_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * #4541 (2ª causa da issue): cobertura mínima da janela usada pra calcular a
 * média (`entry.daysWithData` / `entry.daysProbed`, gravados por
 * `postmaster-spam-sync.ts`). Uma média sobre 1 dia de 10 (ex: incidente de
 * 260803 — só 1/10 dias com leitura válida: 7 dias 404/não publicados ainda
 * (comportamento esperado) + 2 dias com erro HTTP transitório, ver #4541) não
 * é mais confiável que "sem dado" — degrada pra `indeterminate` do mesmo jeito que
 * staleness, em vez de colorir com base em amostra pequena demais. 50% dá
 * folga a uma falha parcial pontual (ex: 2/10 dias com erro HTTP) sem deixar
 * uma média de 1-2 dias colorir o semáforo. Campos ausentes (entry manual —
 * 1 leitura não é "janela" — ou entry pré-#4541) não acionam este guard: só
 * se aplica quando o produtor de fato declarou a cobertura.
 */
export const POSTMASTER_MIN_COVERAGE_RATIO = 0.5;

/**
 * #5059: predicado puro "o pico por campanha foi o valor que governou"
 * — extraído pra ser a ÚNICA implementação da comparação `Math.max` de
 * `resolveSpamSignal` reproduz (`effectiveRatePct === worstCampaignSpamRatePct`,
 * com `Number.isFinite` guardando contra campo ausente/malformado). Antes do
 * #5059 esta mesma comparação existia duplicada em `describeSpamSignalLine`
 * (`scripts/clarice-schedule-ramp.ts`), recalculada a partir de
 * `spamSignal.ratePct` já resolvido em vez de reusar esta função — ver #5059.
 */
export function isCampaignPeakGoverning(
  worstCampaignSpamRatePct: number | null | undefined,
  effectiveRatePct: number,
): boolean {
  return Number.isFinite(worstCampaignSpamRatePct) && effectiveRatePct === worstCampaignSpamRatePct;
}

/**
 * Resolve o sinal de spam que GOVERNA a avaliação de guardrail — nunca o
 * `complaints`/`spamRate` derivado da Brevo. `entry` é o que está gravado sob
 * a chave KV `postmaster:spam` (ou `null`/ausente). `now` injetado (não
 * `new Date()` interno) para determinismo em teste.
 *
 * Regressão coberta (#633, exigida pela própria issue #4063): um `spamRatePct`
 * de Postmaster acima do limite resolve para `breach: true` MESMO com
 * `complaints` da Brevo em zero — esta função nem recebe o dado da Brevo,
 * então a garantia é estrutural (não há como o número da Brevo influenciar
 * o resultado).
 *
 * #4541: frescor exige AMBOS — gravação recente (`recordedAt`,
 * `POSTMASTER_STALE_MS`) E medição recente (`date`, `POSTMASTER_DATA_STALE_MS`)
 * — e, quando a entry declara cobertura, cobertura mínima da janela
 * (`POSTMASTER_MIN_COVERAGE_RATIO`). Qualquer um falhando → `indeterminate`.
 *
 * #4544: `SpamSignal.reason` grava QUAL dos 5 branches abaixo produziu o
 * `indeterminate` (`missing` | `malformed` | `recorded-stale` | `date-stale` |
 * `low-coverage`) — ver docstring do tipo. Populado em toda saída
 * `indeterminate`, nunca em `postmaster`.
 *
 * #4705: das 2 leituras que uma entry pode carregar — a média de domínio
 * inteiro (`spamRatePct`, sempre presente) e o PICO por campanha
 * (`worstCampaignSpamRatePct`, opcional — schema evolution, entries antigas,
 * ou dias sem `FEEDBACK_LOOP_ID` na resposta) — esta função usa o MAIOR dos
 * dois quando o de campanha está presente, nunca o de campanha sozinho.
 * Achado do fleet review pré-merge (`pr-test-analyzer`): pura precedência do
 * pico por campanha (sem `Math.max`) teria o efeito INVERSO do pretendido
 * num cenário real — se o domínio inteiro piorar mas a pior campanha
 * ATRIBUÍVEL individualmente ficar abaixo dele (ex: spam concentrado em
 * tráfego sem `feedback_loop_id` na resposta), a troca cega mascararia um
 * domínio pior por um pico "melhor". `Math.max` garante que nenhum dos dois
 * sinais nunca fica pior fazendo o breaker parecer mais seguro do que é —
 * qualquer um dos dois cruzando o limiar aciona `breach`. Racional original
 * (achado da própria issue #4705): a média de domínio dilui uma campanha
 * ruim isolada entre campanhas boas — o pico por campanha é o sinal de
 * risco real nesse sentido (mesmo racional de
 * `aggregateCampaignSpamReadings`/`findWorstCampaignSpam` em
 * `scripts/lib/postmaster-campaign-spam.ts`, que reportam PICO, não média).
 * Todos os guards de staleness/cobertura ACIMA continuam avaliados sobre os
 * campos de domínio (`spamRatePct`/`recordedAt`/`date`/`daysWithData`/
 * `daysProbed`) — a entry inteira (domínio + por-campanha) é produzida na
 * MESMA execução do produtor "auto", então o frescor de um vale pro outro;
 * só a escolha de QUAL número vira `ratePct`/`breach` muda.
 */
export function resolveSpamSignal(
  entry:
    | Pick<
        PostmasterSpamEntry,
        | "spamRatePct"
        | "recordedAt"
        | "producedBy"
        | "date"
        | "daysWithData"
        | "daysProbed"
        | "worstCampaignSpamRatePct"
        | "worstCampaignFeedbackLoopId"
        | "worstCampaignDaysWithData"
      >
    | null
    | undefined,
  now: Date = new Date(),
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): SpamSignal {
  if (!entry || !Number.isFinite(entry.spamRatePct)) {
    return { source: "indeterminate", ratePct: null, breach: false, reason: entry ? "malformed" : "missing" };
  }
  const recordedMs = Date.parse(entry.recordedAt);
  if (!Number.isFinite(recordedMs) || now.getTime() - recordedMs > POSTMASTER_STALE_MS) {
    return { source: "indeterminate", ratePct: null, breach: false, reason: "recorded-stale" };
  }
  const dateMs = Date.parse(entry.date);
  if (!Number.isFinite(dateMs) || now.getTime() - dateMs > POSTMASTER_DATA_STALE_MS) {
    return { source: "indeterminate", ratePct: null, breach: false, reason: "date-stale" };
  }
  if (
    typeof entry.daysWithData === "number" &&
    typeof entry.daysProbed === "number" &&
    entry.daysProbed > 0 &&
    entry.daysWithData / entry.daysProbed < POSTMASTER_MIN_COVERAGE_RATIO
  ) {
    return { source: "indeterminate", ratePct: null, breach: false, reason: "low-coverage" };
  }
  // #4705: usa o MAIOR entre a média de domínio e o pico por campanha
  // quando este último está presente e válido — `Number.isFinite` guarda
  // contra um campo malformado (nunca confiar que "presente" implica
  // "número válido", mesma disciplina do guard de `spamRatePct` acima).
  // `Math.max`, não precedência cega do pico: um domínio pior nunca deve
  // ser mascarado por uma campanha atribuível melhor (ver docstring acima).
  const effectiveRatePct = Number.isFinite(entry.worstCampaignSpamRatePct)
    ? Math.max(entry.spamRatePct, entry.worstCampaignSpamRatePct as number)
    : entry.spamRatePct;
  // #4974/#5059: o pico por campanha "governa" quando foi ele que o
  // `Math.max` acima escolheu (não basta estar presente — o domínio pode
  // ter sido pior, ver docstring da função). `isCampaignPeakGoverning` é a
  // ÚNICA implementação deste predicado no repo — `describeSpamSignalOrigin`
  // abaixo (usado pelo CLI `clarice-schedule-ramp.ts`) chama a MESMA função
  // sobre `signal.ratePct` já resolvido, em vez de recalcular a comparação
  // localmente (a duplicação que existia antes do #5059).
  const usesCampaignPeak = isCampaignPeakGoverning(entry.worstCampaignSpamRatePct, effectiveRatePct);
  return {
    source: "postmaster",
    ratePct: effectiveRatePct,
    producedBy: entry.producedBy,
    breach: effectiveRatePct >= t.spamRate.yellow,
    worstCampaignFeedbackLoopId: usesCampaignPeak ? entry.worstCampaignFeedbackLoopId : undefined,
    worstCampaignDaysWithData:
      usesCampaignPeak && Number.isFinite(entry.worstCampaignDaysWithData) ? entry.worstCampaignDaysWithData : undefined,
  };
}

/** Saída de {@link describeSpamSignalOrigin} — origem do número que governa `SpamSignal.ratePct` + o texto já formatado pros 2 consumidores (CLI `clarice-schedule-ramp.ts`, dashboard). */
export interface SpamSignalOrigin {
  /** `true` quando o pico por campanha (não a média de domínio) governou `signal.ratePct` — mesmo predicado usado internamente por `resolveSpamSignal` via `isCampaignPeakGoverning`. */
  usesCampaignPeak: boolean;
  /** `"pico da campanha {id}{coverageSuffix}"` ou `"média de domínio"` — pronto pra interpolar numa linha de texto. */
  label: string;
  /** `" ({N} dia(s) com dado)"` quando o pico governa e a cobertura está disponível; string vazia caso contrário — já embutido em `label`, exposto solto pra quem quiser compor o texto de outro jeito (ex: badge separado na UI). */
  coverageSuffix: string;
}

/**
 * #5059: fonte única da ORIGEM/formatação do sinal de spam — extraída de
 * `describeSpamSignalLine` (`scripts/clarice-schedule-ramp.ts`), que antes
 * recalculava `usesCampaignPeak` localmente comparando `spamSignal.ratePct`
 * contra `worstCampaignSpamRatePct` (a mesma comparação que
 * `resolveSpamSignal` já fazia acima, via `isCampaignPeakGoverning`).
 *
 * Não basta ler `signal.worstCampaignFeedbackLoopId`/`worstCampaignDaysWithData`
 * como discriminador — os dois são opcionais também na ENTRADA (`entry`), então
 * `undefined` na saída de `resolveSpamSignal` pode significar tanto "o domínio
 * governou" quanto "o pico governou mas a entrada não trazia o campo". Por
 * isso esta função recebe `entry` (a leitura crua) + `signal` (já resolvido)
 * e refaz a MESMA comparação de `resolveSpamSignal`, via `isCampaignPeakGoverning`,
 * em vez de tentar inferir a partir dos campos opcionais de `signal`.
 *
 * `signal.source !== "postmaster"` ou `signal.ratePct === null` (stale,
 * malformada, indeterminate) → `usesCampaignPeak: false`, `label: "média de
 * domínio"` — valor default seguro; nenhum consumidor atual chama esta função
 * nesses casos (ambos guardam antes), mas o comportamento fica definido pra
 * uso futuro sem precisar repetir o guard em cada call site.
 */
export function describeSpamSignalOrigin(
  entry: Pick<PostmasterSpamEntry, "worstCampaignSpamRatePct" | "worstCampaignFeedbackLoopId" | "worstCampaignDaysWithData"> | null | undefined,
  signal: SpamSignal,
): SpamSignalOrigin {
  const usesCampaignPeak =
    signal.source === "postmaster" &&
    signal.ratePct !== null &&
    isCampaignPeakGoverning(entry?.worstCampaignSpamRatePct, signal.ratePct);
  const coverageSuffix =
    usesCampaignPeak && typeof entry?.worstCampaignDaysWithData === "number" && Number.isFinite(entry.worstCampaignDaysWithData)
      ? ` (${entry.worstCampaignDaysWithData} dia(s) com dado)`
      : "";
  const label = usesCampaignPeak ? `pico da campanha ${entry?.worstCampaignFeedbackLoopId ?? "?"}${coverageSuffix}` : "média de domínio";
  return { usesCampaignPeak, label, coverageSuffix };
}

/**
 * #4970: o Google Postmaster Tools publica dado com ~2-3 dias de atraso
 * (confirmado ao vivo em várias docstrings deste módulo/`postmaster-spam-sync.ts`
 * — dia ausente na resposta da API é "não publicado ainda", nunca 0%). Uma
 * campanha enviada há menos tempo que isto SEM registro em `campaignSpam`
 * está "aguardando publicação" (estado pending) — mais tempo que isto SEM
 * registro é "sem dado atribuível" (estado unavailable, ver
 * `resolveEnvioCampaignSpamCell`). Folga de 5 dias (não 2-3 cravado) pelo
 * mesmo motivo de `POSTMASTER_DATA_STALE_MS`: cobre fim de semana + 1-2
 * ciclos de sync perdidos sem virar "sem dado" precocemente. Constante
 * PRÓPRIA (mesmo valor de `POSTMASTER_DATA_STALE_MS`, mas nome/propósito
 * distintos) — aquela governa staleness do agregado de DOMÍNIO (1 entry),
 * esta classifica o estado de UMA LINHA da tabela Envios por campanha.
 */
export const ENVIO_SPAM_PENDING_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * #4970: os 3 estados possíveis da célula Spam de UMA linha da tabela Envios
 * — nunca célula em branco (regra da issue #4970 item 4: em branco se
 * confunde com zero, e as linhas mais recentes, que são as mais olhadas, são
 * justamente as que mais caem nos 2 estados sem valor numérico).
 */
export type EnvioSpamCellState = "rate" | "pending" | "unavailable";

/**
 * União discriminada por `state` (não uma interface achatada com campos
 * opcionais) — `ratePct`/`daysWithData`/`peakDate` só EXISTEM no branch
 * `"rate"`; o compilador impede acesso fora dele sem checar `state` primeiro
 * (`spamCell.ratePct` fora de um narrowing por `state === "rate"` é erro de
 * tipo, não um `undefined` silencioso em runtime). `breach` é sempre `false`
 * fora de `"rate"` — refletido no próprio tipo (literal `false`, não
 * `boolean`), não só em comentário.
 */
export type EnvioSpamCell =
  | {
      state: Extract<EnvioSpamCellState, "rate">;
      /** O PICO da campanha (mesmo racional de pico > média usado no resto do enriquecimento por-campanha). */
      ratePct: number;
      /** Cobertura (dias com leitura válida, acumulada entre execuções) da campanha. */
      daysWithData: number;
      /** YYYY-MM-DD do dia em que o pico ocorreu. */
      peakDate: string;
      /** `true` quando `ratePct` cruzou `thresholds.spamRate.yellow`. */
      breach: boolean;
    }
  | {
      state: Extract<EnvioSpamCellState, "pending" | "unavailable">;
      breach: false;
    };

/**
 * Pura/testável (#4970): resolve o estado da célula Spam de UMA linha da
 * tabela Envios a partir do mapa por-campanha (`PostmasterSpamEntry.campaignSpam`,
 * já mesclado entre execuções por `postmaster-spam-sync.ts`).
 *
 * `campaignId` é o id numérico da campanha na Brevo (`BrevoCampaign.id`) —
 * a chave de busca no mapa é `String(campaignId)` (mesma convenção do
 * produtor, ver `toCampaignSpamRecords`). `sentOrScheduledIso` é
 * `c.sentDate ?? c.scheduledAt` (mesma fonte de "quando" já usada pro resto
 * da linha em `sections-core.ts`) — usado só pra decidir `pending` vs
 * `unavailable` quando não há registro; `null`/não-parseável degrada pra
 * `unavailable` (sem data confiável, não dá pra afirmar "ainda aguardando").
 */
export function resolveEnvioCampaignSpamCell(
  campaignId: number,
  sentOrScheduledIso: string | null,
  campaignSpam: Record<string, PostmasterCampaignSpamRecord> | null | undefined,
  now: Date,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): EnvioSpamCell {
  const record = campaignSpam?.[String(campaignId)];
  if (record) {
    return {
      state: "rate",
      ratePct: record.peakSpamRatePct,
      daysWithData: record.daysWithData,
      peakDate: record.peakDate,
      breach: record.peakSpamRatePct >= t.spamRate.yellow,
    };
  }
  const sentMs = sentOrScheduledIso ? Date.parse(sentOrScheduledIso) : NaN;
  if (Number.isFinite(sentMs) && now.getTime() - sentMs < ENVIO_SPAM_PENDING_WINDOW_MS) {
    return { state: "pending", breach: false };
  }
  return { state: "unavailable", breach: false };
}
