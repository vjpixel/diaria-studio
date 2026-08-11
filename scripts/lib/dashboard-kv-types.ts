/**
 * dashboard-kv-types.ts — tipos dos payloads KV compartilhados entre os
 * scripts que os PRODUZEM (`clarice-engagement-cohorts.ts`, `clarice-mv-status.ts`,
 * `clarice-db-summary.ts`) e o worker `brevo-dashboard` que os CONSOME (#3081).
 *
 * Antes cada um desses 4 tipos (`EngagementCohorts`, `MvGroupStatus`, `MvStatus`,
 * `ContactsSummary`, `CohortStatsRow`) era declarado DUAS vezes — uma no script
 * que grava o KV, outra em `workers/brevo-dashboard/src/types.ts` que lê —
 * sincronizadas manualmente via comentário "MANTER EM SINCRONIA". Fonte única
 * aqui elimina o drift silencioso.
 *
 * Dependency-free / Workers-safe (como `clarice-segment.ts`/`cohorts.ts`) —
 * nenhum import de `node:sqlite` ou outra API só-Node, então tanto os scripts
 * quanto o worker (runtime `workerd`, sem Node) podem importar daqui.
 */

/**
 * #2426: coortes de engajamento por contato. Pré-computadas por
 * `scripts/clarice-engagement-cohorts.ts` (que faz os ~40k GETs per-contato
 * fora do Worker) e gravadas no KV sob `cohorts:engagement`. O Worker só lê e
 * renderiza — nunca recomputa no render. As 5 coortes são mutuamente exclusivas
 * (cada contato em exatamente uma); "saídas" (bounce/unsub) têm precedência.
 */
export interface EngagementCohorts {
  /** ISO timestamp da geração (dado é pré-computado, não live) */
  generatedAt: string;
  /** total de pessoas únicas alcançadas (recebeu ≥1 OU teve saída) — cada contato conta 1× (≠ eventos de envio) */
  universe: number;
  /** abriu 2+ e-mails (sem saída) */
  opened2plus: number;
  /** abriu exatamente 1 e-mail (sem saída) */
  opened1: number;
  /** recebeu 1, não abriu nenhum (sem saída) */
  received1_opened0: number;
  /** recebeu 2+, não abriu nenhum (sem saída) */
  received2_opened0: number;
  /** saídas: bounce OU descadastro (precedência sobre tudo) */
  exits: number;
  /** breakdown DISJUNTO das saídas (bounced + optedOut = exits) */
  exitsBreakdown: { bounced: number; optedOut: number };
  /**
   * maior nº de e-mails recebidos por um único contato (valida o rótulo "2+").
   * #3081: DEAD CODE de exibição — nenhum render do worker consome este campo
   * (o rótulo "2+" nos buckets ≥2 é hardcoded, sempre exato por definição).
   * Mantido no payload por ora — não remover nem adicionar exibição sem pedido
   * do editor (decisão de produto, fora de escopo do #3081).
   */
  maxReceived: number;
}

// #2609: status MillionVerifier por grupo de contatos, gravado por
// scripts/clarice-mv-status.ts sob a chave KV `mv:status`.
export interface MvGroupStatus {
  /** Identificador do grupo (ex: "t01-assinantes-ativos", "t02-ex-assinantes"). */
  group: string;
  /** Ciclo em que a verificação foi feita (ex: "2605-06"). */
  cycle: string;
  /** "verified" = tem mv-export-*-verified.csv; "t01" = N/A por pagamento Stripe; "pending" = sem arquivo. */
  status: "verified" | "t01" | "pending";
  /** ISO date do mtime do arquivo verified.csv (ou null). */
  verifiedAt: string | null;
  verified: number;
  rejected: number;
  unknown: number;
}

export interface MvStatus {
  generatedAt: string;
  groups: MvGroupStatus[];
}

/**
 * #2864: 1 linha agregada por cohort pra aba "Cohorts" do dashboard. Contagens
 * BRUTAS (não percentuais) — o render calcula as taxas (opened/received,
 * clicked/received, etc.) e trata denominador 0 como "—", nunca NaN/Infinity.
 *
 * Gravada por `scripts/clarice-db-summary.ts` (sempre populada — `computeCohortStats`
 * faz `SUM(CASE ...)` sobre todo o universo, nunca omite campo); consumida pelo
 * worker, que precisa tolerar payloads KV mais antigos sem os campos opcionais.
 */
export interface CohortStatsRow {
  /** COUNT(*) do cohort (menos internos). */
  contacts: number;
  /** send_eligible=1. */
  eligible: number;
  /** sends_count>0 — "já recebeu ao menos 1 envio". */
  received: number;
  /** #4406: send_eligible=1 AND sends_count=0 ("Falta 1º envio") — elegível
   * que nunca recebeu nenhum envio, a fila real de 1º envio (mesma definição
   * de `isFirstSend`, scripts/lib/clarice-segment.ts). Opcional (`?`): KV
   * pré-#4406 não tem o campo — render trata AUSENTE como "—" (dado
   * desconhecido), nunca como 0 (que leria como "não falta ninguém"). */
  eligible_never_sent?: number;
  /** sends_count>0 AND opens_count>0 — abriu ≥1, dentre quem recebeu. */
  opened: number;
  /** sends_count>0 AND clicks_count>0 — clicou ≥1, dentre quem recebeu. */
  clicked: number;
  /** #2880: separados a pedido do editor (antes: par unsub_bounce). */
  unsub: number;
  /** sends_count>0 AND hard_bounced=1 — deu hard bounce, dentre quem recebeu. */
  hard_bounce: number;
  /** #2880: brevo_list_ids IS NOT NULL sobre o total do cohort. Opcional (`?`)
   * pra degradar em KV antigo sem o campo — render trata ausência como 0. */
  brevo?: number;
}

/**
 * #2653: sumário agregado do store único de contatos (#2647), gravado por
 * `scripts/clarice-db-summary.ts` sob a chave KV `contacts:summary`
 * (payload = `{generated_at, ...StoreSummary}` — `StoreSummary`, o tipo
 * usado internamente pelo script pra computar cada bloco, permanece local a
 * `clarice-db-summary.ts`; suas propriedades sempre populadas satisfazem
 * estruturalmente os campos opcionais aqui).
 *
 * Campos opcionais (`?`) refletem SCHEMA EVOLUTION — payload gravado antes do
 * campo existir simplesmente não o tem; o render degrada graciosamente
 * (nunca confundir "ausente" com "zero").
 */
/**
 * #4063/#4154: leitura do spamRate diário do Google Postmaster Tools
 * (domínio `clarice.ai`). Gravada sob a chave KV `postmaster:spam` por UM dos
 * dois produtores (`producedBy` distingue qual): `scripts/postmaster-spam-sync.ts`
 * (automático, via API, a cada 12h — caminho primário desde #4154) ou
 * `scripts/postmaster-spam-entry.ts` (manual, leitura do painel — fallback pra
 * outage da API ou checagem pontual). Único registro (a leitura mais
 * recente), não histórico — o breaker da Rampa
 * (`workers/brevo-dashboard/src/thresholds.ts::resolveSpamSignal`) usa este
 * valor com PRECEDÊNCIA sobre `globalStats.complaints` da Brevo, que subconta
 * o spam em ~50× (a Brevo só enxerga feedback loops; o "marcar como spam" do
 * Gmail não passa por FBL, e 73% da base é Gmail).
 */
/**
 * Qual dos dois produtores de `PostmasterSpamEntry` gravou uma leitura
 * (#4154) — compartilhado com `SpamSignal.producedBy` (workers/brevo-dashboard/src/thresholds.ts)
 * pra que os dois nunca divirjam silenciosamente (achado do self-review do #4342).
 */
export type PostmasterProducer = "manual" | "auto";

/**
 * Bucket de reputação — a API devolve `BAD`/`LOW`/`MEDIUM`/`HIGH`
 * (confirmado no payload de exemplo da issue #4703), mas o tipo aceita
 * qualquer string (`string & {}` — mesmo truque de "literal union aberta"
 * documentado em vários lugares do TS) porque nunca observamos ao vivo se a
 * API pode introduzir um bucket novo sem aviso; travar num union fechado
 * quebraria o parse silenciosamente nesse caso.
 */
export type PostmasterReputationLevel = "BAD" | "LOW" | "MEDIUM" | "HIGH" | (string & {});

/**
 * Um item de `ipReputations` na resposta de `trafficStats.get` (v1) — a API
 * devolve um bucket por faixa de reputação, cada um opcionalmente com
 * `ipCount` (contagem como STRING — mesma serialização protobuf int64→string
 * usada em `StatisticValueV2.intValue`, scripts/lib/postmaster-v2-client.ts)
 * e uma amostra de IPs. O exemplo da #4703 só mostrou esses dois campos
 * presentes quando o bucket tinha ≥1 IP — não confirmado como regra da API,
 * só o que foi observado numa amostra. `[key: string]: unknown` absorve
 * campos futuros sem quebrar o parse — mesmo espírito do antigo
 * `TrafficStatsResponse` (v1, removido em #4704) em postmaster-spam-sync.ts.
 */
export interface PostmasterIpReputation {
  reputation: PostmasterReputationLevel;
  ipCount?: string;
  sampleIps?: string[];
  [key: string]: unknown;
}

/**
 * #4703: sinal de reputação capturado da v1 (`trafficStats.get`) — hoje
 * puramente diagnóstico, `resolveSpamSignal` não consome nenhum dos dois
 * campos. Fatorado num tipo próprio (em vez de repetir `{domainReputation?;
 * ipReputations?}` em `PostmasterSpamEntry` e no antigo `TrafficStatsResponse`/
 * `DayReading` v1 de `postmaster-spam-sync.ts`) pra que os 2 lugares fiquem
 * amarrados pelo compilador, não só por convenção — um campo novo adicionado
 * aqui se propaga sem precisar lembrar de editar o outro. #4704 (260806):
 * `postmaster-spam-sync.ts` migrou pra v2 e NENHUM produtor popula estes 2
 * campos hoje (ver nota na definição de `PostmasterSpamEntry` abaixo) — o
 * tipo continua existindo pra entries antigas (schema evolution) e pro
 * retorno via `getComplianceStatus` v2, ainda não implementado.
 */
export interface PostmasterReputationSignal {
  domainReputation?: PostmasterReputationLevel;
  ipReputations?: PostmasterIpReputation[];
}

export interface PostmasterSpamEntry extends PostmasterReputationSignal {
  /** Data (YYYY-MM-DD) a que a leitura se refere. Manual: o dia do painel Postmaster consultado. Auto (#4345): o dia mais recente dentro da janela usada pra calcular a média — não o único dia da leitura. */
  date: string;
  /** spamRate (%) lido no painel do Google Postmaster Tools. */
  spamRatePct: number;
  /** ISO timestamp de quando esta entrada foi registrada (gravação, não `date`). */
  recordedAt: string;
  /** Qual dos dois produtores gravou esta leitura — opcional pra entries pré-#4154 (schema evolution, nunca inferir um valor). */
  producedBy?: PostmasterProducer;
  /** #4541: quantos dias da janela sondada tiveram leitura válida usada no cálculo da média. #4704 (v2): produzido por UMA chamada `domainStats:query` pro range inteiro — o dia "tem leitura válida" quando aparece na resposta com a métrica `SPAM_RATE`; ausência do dia na resposta (não erro HTTP por dia, que não existe mais na v2) é o único jeito de faltar cobertura. Junto com `daysProbed`, permite `resolveSpamSignal` degradar pra `indeterminate` quando a cobertura é baixa demais (ex: 1/10 dias). `undefined` pra entries manuais (1 leitura, não é média de janela) ou pré-#4541. */
  daysWithData?: number;
  /** #4541: tamanho da janela sondada (dias-calendário), independente de quantos tiveram leitura válida — ver `daysWithData`. `undefined` no mesmo caso acima. */
  daysProbed?: number;
  // `domainReputation`/`ipReputations` herdados de PostmasterReputationSignal
  // (#4703): snapshot do dia mais recente da janela com leitura válida —
  // ausente quando a API não devolveu o campo naquele dia (schema evolution,
  // nunca inferir um valor, mesmo tratamento de daysWithData/daysProbed).
  // #4704 (260806): o produtor "auto" migrou de v1 (`trafficStats.get`, tinha
  // esses campos no payload) pra v2 (`domainStats:query`, não tem) — desde a
  // migração, NENHUM produtor popula domainReputation/ipReputations (nem
  // "manual", que nunca populou). Ficam no tipo por schema evolution (entries
  // pré-migração ainda podem tê-los) e porque a v2 tem um caminho de volta —
  // `getComplianceStatus`, endpoint próprio, explicitamente fora do escopo do
  // #4704 — não são código morto, são um produtor pausado.
  /**
   * #4704 (260806): série diária persistida — um item por dia da janela
   * sondada que teve leitura publicada (v2 `domainStats:query`, métrica
   * `SPAM_RATE`), mais antigo primeiro. Antes da migração v2,
   * `collectSpamReadings`/`buildAveragedEntry` descartavam o detalhe diário e
   * gravavam só a média — esta série é o que falta pra um consumidor futuro
   * (ex: coluna de spam por dia na tabela Envios do painel, ver comentário na
   * #4703) sem precisar reconstruir o dia-a-dia a partir da média. `undefined`
   * pra entries manuais (1 única leitura, não é janela) ou pré-#4704.
   */
  dailyReadings?: Array<{ date: string; spamRatePct: number }>;
  /**
   * #4705: pior (pico) `FEEDBACK_LOOP_SPAM_RATE` dentre TODAS as campanhas com
   * feedback_loop_id atribuível na mesma janela sondada — ver
   * `scripts/lib/postmaster-campaign-spam.ts` (`aggregateCampaignSpamReadings`/
   * `findWorstCampaignSpam`) pro racional completo de "pico, não média de
   * domínio" (o achado original da #4704: a média do domínio mascarou uma
   * campanha específica com spam bem mais alto). `resolveSpamSignal`
   * (workers/brevo-dashboard/src/thresholds.ts) prefere este valor sobre
   * `spamRatePct` (domínio) quando presente — `undefined` quando não há
   * nenhuma campanha atribuível na janela (fallback pro domínio) ou em
   * entries pré-#4705 (schema evolution) — nunca inferir um valor.
   */
  worstCampaignSpamRatePct?: number;
  /**
   * `feedback_loop_id` (`{conta}_{campanha}`) da campanha que produziu
   * `worstCampaignSpamRatePct` — só informativo (debug/auditoria), nunca
   * entra em nenhuma decisão de classificação. Produzido em PAR com o campo
   * acima pelo único produtor hoje (`buildAveragedEntry`), mas não é um
   * invariante estrutural do tipo — no boundary do KV
   * (`normalizePostmasterSpamEntry`) cada campo é validado
   * independentemente e pode divergir sob payload corrompido (mesmo padrão
   * de `daysWithData`/`daysProbed`, #4544; ver teste
   * `postmaster-spam-normalize.test.ts` pro caso `worstCampaignSpamRatePct`
   * NaN sobrevivendo como `undefined` enquanto este campo sobrevive como
   * string).
   */
  worstCampaignFeedbackLoopId?: string;
  /**
   * #4780: cobertura da janela da campanha vencedora (`WorstCampaignSpam.daysWithData`,
   * `scripts/lib/postmaster-campaign-spam.ts`) — mesma classe de risco de
   * `worstCampaignFeedbackLoopId` acima (par produzido junto pelo mesmo
   * produtor, mas validado independentemente no boundary do KV). Sem este
   * campo, um pico por-campanha de 1 dia isolado (baixa cobertura) fica
   * indistinguível de um pico sustentado pela janela inteira — nenhum dos 2
   * outros campos (`worstCampaignSpamRatePct`/`worstCampaignFeedbackLoopId`)
   * carrega esse sinal. Só informativo (auditoria/log/CLI), nunca entra em
   * `resolveSpamSignal` — não existe hoje um guard de cobertura mínima
   * equivalente ao `POSTMASTER_MIN_COVERAGE_RATIO` do domínio pro pico por
   * campanha, e a #4974 (que discutiu as 4 opções pra isso) decidiu
   * explicitamente NÃO adicionar um: o semáforo continua disparando com 1
   * dia, mas este campo agora chega até a superfície de decisão (CLI
   * `clarice-schedule-ramp.ts`/`clarice-wave-plan.ts` e o dashboard, via
   * `SpamSignal.worstCampaignDaysWithData` em
   * `workers/brevo-dashboard/src/thresholds.ts`), deixando o julgamento com
   * o editor em vez de um piso automático. `undefined` quando não há
   * campanha atribuível na janela ou em entries pré-#4780.
   */
  worstCampaignDaysWithData?: number;
  /**
   * #4970: mapa por-campanha (chave = `campaignId` da Brevo, COMO STRING —
   * limitação de `Record`/JSON, que só aceita chaves string) de TODA
   * campanha atribuível vista em QUALQUER execução do produtor "auto" — não
   * só a pior da janela sondada (`worstCampaignSpamRatePct`/
   * `worstCampaignFeedbackLoopId`/`worstCampaignDaysWithData` acima, que
   * continuam existindo tal como estão — servem só o breaker da aba Rampa,
   * que precisa do PIOR, não de um mapa completo). A tabela Envios (#4970)
   * precisa de UMA leitura por LINHA (campanha), não só a pior de toda a
   * janela — daí este mapa.
   *
   * Chave é `campaignId` puro (não `feedback_loop_id`, que também carrega o
   * prefixo de conta ESP, ex: `"11130585_107"`) de propósito — o consumidor
   * (`sections-core.ts`, tabela Envios) já tem `campaignId` disponível
   * (`BrevoCampaign.id`) sem precisar conhecer `DEFAULT_POSTMASTER_ACCOUNT_ID`
   * (constante hardcoded em `scripts/lib/postmaster-campaign-spam.ts`, um
   * módulo Node-only que o Worker não importa). `feedbackLoopId` continua
   * disponível DENTRO de cada registro (auditoria/debug), só não é mais a
   * chave do mapa.
   *
   * ACUMULA entre execuções (merge, nunca overwrite) — ver
   * `mergeCampaignSpamRecords` em `scripts/lib/postmaster-campaign-spam.ts`.
   * A janela sondada por execução é `HEALTH_SAMPLE_DAYS` (10 dias), mas a
   * tabela Envios mostra ~90 dias de campanhas — sem merge, só as ~10
   * campanhas mais recentes ganhariam valor a cada execução, e o resto
   * ficaria permanentemente vazio (o Postmaster nunca re-sonda uma janela já
   * passada). `postmaster-spam-sync.ts` lê o mapa atual do KV ANTES de
   * escrever, mescla com o lote desta execução (chaves da execução atual
   * SUBSTITUEM a entrada antiga — a mesma campanha só ganha mais cobertura
   * com o tempo enquanto está dentro da janela sondada; chaves ausentes
   * nesta execução mas presentes no KV são PRESERVADAS intactas).
   *
   * `undefined` em entries pré-#4970 (schema evolution) ou quando a coleta
   * por-campanha desta execução não achou NENHUMA campanha nova E o KV
   * também não tinha nada anterior — nunca um objeto vazio inventado onde
   * cabe `undefined`.
   */
  campaignSpam?: Record<string, PostmasterCampaignSpamRecord>;
}

/**
 * #4970: um registro do mapa `PostmasterSpamEntry.campaignSpam` — espelha os
 * campos de `CampaignSpamAggregate` (`scripts/lib/postmaster-campaign-spam.ts`)
 * que fazem sentido persistir por campanha (a série `dailyReadings` completa
 * fica de fora — cobertura já basta como sinal auditável, e persistir todos os
 * dias de TODAS as campanhas cresceria o payload do KV sem limite conforme o
 * histórico acumula). Tipo próprio aqui (não um import de
 * `CampaignSpamAggregate`) porque este arquivo é dependency-free/Workers-safe
 * por convenção (ver docstring do módulo) — `postmaster-campaign-spam.ts` é
 * Node-only (importa `postmaster-v2-client.ts` → `postmaster-register-domain.ts`).
 */
export interface PostmasterCampaignSpamRecord {
  /** Redundante com a chave do mapa (`String(campaignId) === chave`) — mantido no valor pra o registro ficar auto-descritivo fora do contexto do mapa (ex: log, export avulso). */
  campaignId: number;
  /** `{conta}_{campanha}` — só informativo (debug/auditoria), nunca entra em nenhuma decisão de classificação. */
  feedbackLoopId: string;
  /** Média simples do ratio diário da campanha na(s) janela(s) sondada(s) em que apareceu. */
  avgSpamRatePct: number;
  /** PICO diário da campanha — é este número que a tabela Envios exibe/colore (mesmo racional de `worstCampaignSpamRatePct`: o pico é o sinal de risco real, a média dilui). */
  peakSpamRatePct: number;
  /** YYYY-MM-DD do dia em que o pico ocorreu. */
  peakDate: string;
  /** Quantos dias (cumulativos, entre TODAS as execuções que capturaram esta campanha) tiveram leitura válida — cresce conforme o Postmaster publica mais dias e o sync roda de novo, nunca encolhe (merge nunca descarta cobertura já vista). */
  daysWithData: number;
  /** ISO timestamp de quando este registro foi calculado (recomputado) pela última vez — só diagnóstico/auditoria, nunca entra em nenhuma decisão de classificação (diferente de `PostmasterSpamEntry.recordedAt`, que governa staleness do agregado de DOMÍNIO). */
  updatedAt: string;
}

/**
 * #4973: chave KV pra um domínio ADICIONAL sondado pelo Postmaster Tools —
 * generaliza `scripts/postmaster-spam-sync.ts` de 1 domínio hardcoded
 * (`clarice.ai`) pra N. O domínio ORIGINAL continua usando a chave literal
 * `"postmaster:spam"` (declarada separadamente como `POSTMASTER_SPAM_KV_KEY`
 * em `scripts/postmaster-spam-entry.ts` e `workers/brevo-dashboard/src/types.ts`
 * — INTOCADA por esta função, de propósito: preservar essa chave exata, sem
 * sufixo de domínio, é o que garante migração zero pro breaker existente
 * (`resolveSpamSignal`, thresholds.ts) — nenhuma entry precisa mover, nenhum
 * consumidor muda de leitura). Esta função serve só domínios NOVOS
 * (ex: `"diar.ia.br"`, #4973): `postmaster:spam:{domain}`, um namespace que
 * nunca colide com a chave legada (que não tem `:` depois de `spam`).
 *
 * Fonte única entre o produtor (`postmaster-spam-sync.ts`) e o consumidor
 * (`workers/brevo-dashboard/src/brevo-diaria.ts`) — os dois importam esta
 * função em vez de cada um hardcodar o formato da chave separadamente,
 * eliminando o risco de drift (mesmo racional de `PostmasterProducer`, acima,
 * pro par produtor/consumidor de `producedBy`).
 */
export function additionalPostmasterSpamKvKey(domain: string): string {
  return `postmaster:spam:${domain}`;
}

/**
 * #4184: seção editorial de origem de um link dentro do digest MENSAL.
 * Fonte: `data/monthly/{ciclo}/prioritized.md` — a estrutura de seções MUDA
 * por ciclo (corrigido na 2ª rodada da #4184, depois de generalizar errado a
 * partir de 1 arquivo só):
 *
 *   2603-04: destaques, lancamentos, pesquisas, outras-noticias
 *   2604-05: destaques, outras-noticias
 *   2605-06: destaques, use-melhor, radar
 *   2606-07: destaques, use-melhor, radar
 *
 * `use-melhor`/`radar` (pool ranqueado por cliques, #1901/#1902) e
 * `lancamentos`/`pesquisas`/`outras-noticias` (pool de standalones legado,
 * anterior a #1901/#1902) são seções DISTINTAS, nunca fundidas entre si —
 * ver `scripts/lib/mensal/monthly-link-sections.ts` pro parser. Não cobre a
 * diária (sem `prioritized.md` equivalente) nem CTA/rodapé/links de sistema
 * — esses casos caem no fallback "sem seção conhecida" no render
 * (`workers/brevo-dashboard/src/link-section.ts`).
 */
export type LinkSectionName =
  | "destaques"
  | "use-melhor"
  | "radar"
  | "lancamentos"
  | "pesquisas"
  | "outras-noticias";

/**
 * Payload gravado no KV sob a chave `secao:{ciclo}` (ex: `secao:2605-06`),
 * um POR CICLO mensal — não um singleton como os demais tipos deste arquivo.
 * Gravado por `scripts/push-link-sections-kv.ts` (script explícito, nunca
 * pelo caminho de render — decisão do editor, #4184, mesmo cuidado do #4186)
 * e lido pelo worker `brevo-dashboard` (`readLinkSectionsByCycle`,
 * brevo-api.ts) OU montado em memória (sem KV) pelo painel Studio local, a
 * partir do `prioritized.md` em disco (`scripts/studio-ui/dashboard-clarice.ts`).
 *
 * Chave = rótulo de CONTEÚDO (`classifyLinkContent(url).content`, #4053) —
 * NUNCA a URL crua, pra casar com o agrupamento já feito pelas tabelas de
 * link do dashboard (`render-links.ts`). Valor = lista de seções onde aquele
 * conteúdo apareceu no `prioritized.md` do ciclo — mais de uma quando o mesmo
 * conteúdo é citado em 2 seções na mesma edição (ex: um link do Radar também
 * citado num destaque); a precedência de exibição é resolvida por
 * `resolveLinkSection` (workers/brevo-dashboard/src/link-section.ts).
 */
export type LinkSectionMap = Record<string, LinkSectionName[]>;

export interface ContactsSummary {
  generated_at: string;
  total: number;
  brevo: { synced_rows: number; has_signal: boolean };
  eligibility: {
    eligible: number;
    ineligible: number;
    by_reason: Record<string, number>;
  };
  priority_points: {
    lt0: number;
    eq0: number;
    p1_40: number;
    p41_80: number;
    gt80: number;
    optin: number;
    // #3081: quantos emails internos (INTERNAL_EMAILS) foram EXCLUÍDOS deste
    // bloco + do histograma (script `clarice-db-summary.ts`, calculado desde
    // #2809 mas nunca propagado até aqui). Opcional — KV pré-#3081 não tem o
    // campo; render trata ausência como "—" (não 0 — 0 excluídos e "dado
    // ausente" não são a mesma coisa).
    internal_excluded?: number;
  };
  // #2731: distribuição por valor exato (opcional — KV pré-#2731 não tem).
  priority_points_histogram?: Record<string, number>;
  // 260702: coluna "verified" (mv_bucket='verified') por valor exato (opcional
  // — KV antigo não tem; render degrada sem coluna).
  priority_points_histogram_verified?: Record<string, number>;
  // #2880: coluna "elegíveis" (send_eligible=1) do histograma — par opcional,
  // degrade gracioso (KV antigo sem o campo → sem a coluna).
  priority_points_histogram_eligible?: Record<string, number>;
  // #2865: coluna "Brevo" (brevo_list_ids IS NOT NULL) do histograma — par
  // opcional, degrade gracioso (KV antigo sem o campo → sem a coluna).
  priority_points_histogram_brevo?: Record<string, number>;
  // #2864: comparativo de envio/engajamento por cohort. Opcional — KV antigo
  // sem o campo faz a aba renderizar o stub "dados ainda não gerados". Chave
  // "juridico" (#4406, COHORT_JURIDICO): contato jurídico entra aqui em vez
  // da safra real — mesma linha, não uma tabela separada.
  cohort_stats?: Record<string, CohortStatsRow>;
  mv: Record<string, number>;
  engagement: { with_opens: number; with_clicks: number };
}
