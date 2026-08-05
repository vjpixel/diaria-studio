/**
 * clarice-wave-plan.ts (#4657) — núcleo PURO do planejamento da próxima onda
 * de envio da mensal pra base Clarice News.
 *
 * Existe porque a decisão de "pra quem a edição vai" era 100% manual: o ciclo
 * 2607-08 foi montado invocando `clarice-build-segment.ts` →
 * `clarice-import-waves.ts` → `clarice-schedule-group.ts` um por um, com
 * volume/datas/células/naming digitados na hora (ver #4449: o nome das listas
 * "foi digitado à mão pro ciclo 2607-08"). Este módulo produz uma PROPOSTA
 * determinística que o editor confirma antes de qualquer escrita na Brevo.
 *
 * TUDO AQUI É PURO — sem rede, sem disco, sem `Date.now()` implícito (todo
 * `now` é parâmetro). O I/O mora em `scripts/clarice-plan-wave.ts`. Mesma
 * separação de `weekly-plan.ts` (worker) × `clarice-schedule-ramp.ts` (CLI),
 * pelo mesmo motivo: a decisão precisa ser testável sem bater na Brevo.
 *
 * REUSO DELIBERADO — este módulo NÃO reimplementa nenhuma das duas máquinas
 * que já decidem coisas neste projeto:
 *   - Volume: `decideSemaphore`/`computeWeekPlan`/`baseVolumeFromLastSendDay`
 *     de `workers/brevo-dashboard/src/weekly-plan.ts`. Herda de graça o gate
 *     de spam do Postmaster (`resolveSpamSignal`, breaker 0,30%) — que é o
 *     que a #4428 pedia e que já está de pé, apesar da issue ter sido
 *     fechada como "aberta cedo demais".
 *   - Teste A/B/C: `aggregateAbcByAudience` de `sections-core.ts`, que já
 *     calcula p-value, poder (`minDetectableLiftRelative`) e as ressalvas de
 *     atribuição da #4559/#4567. Aqui só se TRADUZ essa tabela numa
 *     recomendação de AÇÃO (iniciar/continuar/travar) — nunca se recalcula a
 *     estatística.
 *
 * O que é genuinamente novo aqui: (a) traduzir a tabela A/B/C em ação, (b)
 * medir o backlog do MillionVerifier por cohort, (c) tornar visível o
 * não-abridor reincidente que o sunset nunca cortou, (d) montar as chaves/
 * datas da onda de forma determinística.
 */

import {
  aggregateHealth,
  baseVolumeFromLastSendDay,
  computeWeekPlan,
  decideSemaphore,
  selectMatureDayCampaigns,
  type HealthAggregate,
  type Semaphore,
} from "../../workers/brevo-dashboard/src/weekly-plan.ts";
import {
  resolveSpamSignal,
  type SpamSignal,
} from "../../workers/brevo-dashboard/src/thresholds.ts";
import {
  aggregateAbcByAudience,
  LOW_POWER_MDE_THRESHOLD,
  type AbcAudienceTable,
} from "../../workers/brevo-dashboard/src/sections-core.ts";
import type { BrevoCampaign } from "../../workers/brevo-dashboard/src/types.ts";
import type { StoreRow } from "./clarice-segment.ts";

// ---------------------------------------------------------------------------
// Datas e chaves da onda — determinístico, nunca inferido de weekday
// ---------------------------------------------------------------------------

/**
 * Rótulo pt-BR abreviado do dia da semana em BRT. Informacional (entra no
 * nome da onda, ex: `d6-qui06`), NUNCA usado pra derivar a data — "data é
 * sempre explícita" é princípio invariável do CLAUDE.md, e inferir data a
 * partir de weekday tem risco de off-by-one silencioso numa operação que
 * dispara pra dezenas de milhares de contatos.
 */
export const BRT_DAY_LABELS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"] as const;

/** Regex de data ISO simples (YYYY-MM-DD). Formato exigido de toda data de envio. */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Horário canônico do envio Clarice News: 06:00 BRT = 09:00 UTC. O Brasil não
 * tem horário de verão desde 2019, então o offset é fixo — mesma convenção
 * (e mesma justificativa) de `scheduledAtFor` em `clarice-schedule-sends.ts`
 * e `clarice-schedule-ramp.ts`. Não usar `toLocaleString` com timeZone aqui:
 * o resultado dependeria do ICU da máquina, e este valor vira `scheduledAt`
 * imutável na Brevo.
 */
export const SEND_HOUR_UTC = 9;

/**
 * `YYYY-MM-DD` → ISO UTC do horário canônico de envio. Lança em data
 * malformada ou inexistente (ex: `2026-02-31`) — nunca devolve uma data
 * "corrigida" em silêncio, porque campanha Brevo agendada é IMUTÁVEL
 * (incidente 260703) e um off-by-one aqui só é descoberto depois do disparo.
 */
export function scheduledAtForDate(date: string): string {
  const m = ISO_DATE_RE.exec(date);
  if (!m) {
    throw new Error(`data inválida: "${date}" — esperado YYYY-MM-DD (data é sempre explícita).`);
  }
  const [, y, mo, d] = m;
  const iso = `${y}-${mo}-${d}T${String(SEND_HOUR_UTC).padStart(2, "0")}:00:00.000Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`data inválida: "${date}".`);
  // Round-trip: pega 2026-02-31 → 2026-03-03 (o Date "conserta" em silêncio).
  const back = new Date(ms).toISOString().slice(0, 10);
  if (back !== `${y}-${mo}-${d}`) {
    throw new Error(`data inexistente no calendário: "${date}".`);
  }
  return iso;
}

/** Rótulo BRT do dia da semana de uma data ISO de envio. Puro (sem ICU). */
export function brtDayLabel(date: string): string {
  const ms = Date.parse(scheduledAtForDate(date));
  // 09:00 UTC = 06:00 BRT do MESMO dia — subtrair 3h nunca cruza a fronteira.
  const brt = new Date(ms - 3 * 60 * 60 * 1000);
  return BRT_DAY_LABELS[brt.getUTCDay()];
}

/**
 * Chave determinística de uma onda: `d{N}-{dia}{DD}` (ex: `d6-qui06`) —
 * mesmo formato que o ciclo 2607-08 usou à mão (`d1-sab01` … `d5-qua05`),
 * agora GERADO. `cell` sufixa `-A`/`-B`/`-C` quando a onda tem teste, o que
 * é exatamente o que `groupCellListNameFor` exige pra derivar a célula do
 * nome da lista (nunca digitar o sufixo à parte — ver #4449/#4471).
 */
export function waveKey(n: number, date: string, cell?: "A" | "B" | "C"): string {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`número de onda inválido: ${n} — esperado inteiro > 0.`);
  }
  const dd = ISO_DATE_RE.exec(date)![3];
  const base = `d${n}-${brtDayLabel(date)}${dd}`;
  return cell ? `${base}-${cell}` : base;
}

// ---------------------------------------------------------------------------
// Estado do ciclo — o que já foi enviado/agendado
// ---------------------------------------------------------------------------

export interface WaveState {
  /** Chave da onda tal como aparece no nome da campanha (`grupo:{key}`). */
  key: string;
  listId: number | null;
  subject: string;
  status: string;
  scheduledAt: string | null;
  /** Contatos da lista. `null` quando a Brevo não devolveu o tamanho. */
  volume: number | null;
}

export interface CycleSendState {
  cycle: string;
  waves: WaveState[];
  /**
   * Soma dos volumes das ondas conhecidas. NÃO é "pessoas distintas
   * alcançadas" — células A/B/C do mesmo dia são disjuntas entre si, mas
   * ondas de dias diferentes podem se sobrepor se o guard de
   * `queued`/`sent` falhar. Ver `distinctReachKnown`.
   */
  volumeSum: number;
  /**
   * `true` só quando TODA onda reportou volume. Com uma onda sem volume, a
   * soma vira um piso, não um total — e o consumidor precisa saber disso pra
   * não apresentar um número que parece exato e não é.
   */
  volumeComplete: boolean;
  /** Ondas cuja última data de envio já passou (`now`). */
  sentCount: number;
  /** Ondas ainda agendadas pro futuro — imutáveis na Brevo. */
  scheduledCount: number;
}

/** Extrai a chave `{key}` de um nome de campanha `Clarice {yymm} grupo:{key}`. */
export function groupKeyFromCampaignName(name: string): string | null {
  const m = /grupo:([\w-]+)\s*$/i.exec(name.trim());
  return m ? m[1] : null;
}

/**
 * Resume o que já saiu no ciclo. Fonte é a lista de campanhas do dashboard
 * (ao vivo), NUNCA memória de sessão nem os manifests locais — o CLAUDE.md
 * já torna isso invariável pra decisão de wave, e os manifests ficam
 * defasados quando alguma coisa é feita direto no painel da Brevo.
 */
export function summarizeCycleSends(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string,
  now: Date,
): CycleSendState {
  const waves: WaveState[] = [];
  for (const c of campaigns) {
    const key = groupKeyFromCampaignName(c.name ?? "");
    if (!key) continue;
    // A campanha só pertence a ESTE ciclo se a lista carrega o ciclo mensal —
    // o nome da campanha só tem `yymm`, que é ambíguo entre conteúdo e envio.
    if (c.listName && !c.listName.includes(cycle)) continue;
    const when = c.scheduledAt ?? c.sentDate ?? null;
    // `BrevoCampaign` não tem `listId` — a lista vive em `recipients.lists`
    // (array; o fluxo `--group` sempre mira UMA lista por campanha, então o
    // 1º elemento é o id real. Array vazio/ausente → null, nunca 0).
    const listId = c.recipients?.lists?.[0];
    waves.push({
      key,
      listId: typeof listId === "number" ? listId : null,
      subject: c.subject ?? "",
      status: c.status ?? "unknown",
      scheduledAt: when,
      volume: typeof c.listSize === "number" ? c.listSize : null,
    });
  }
  waves.sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? "") || a.key.localeCompare(b.key));

  const nowMs = now.getTime();
  let sentCount = 0;
  let scheduledCount = 0;
  for (const w of waves) {
    const ms = w.scheduledAt ? Date.parse(w.scheduledAt) : NaN;
    if (!Number.isFinite(ms)) continue;
    if (ms <= nowMs) sentCount += 1;
    else scheduledCount += 1;
  }

  return {
    cycle,
    waves,
    volumeSum: waves.reduce((s, w) => s + (w.volume ?? 0), 0),
    volumeComplete: waves.length > 0 && waves.every((w) => w.volume !== null),
    sentCount,
    scheduledCount,
  };
}

// ---------------------------------------------------------------------------
// Teste A/B/C — TRADUZ a tabela já calculada numa AÇÃO recomendada
// ---------------------------------------------------------------------------

export type AbcAction = "iniciar" | "continuar" | "travar";

export interface AbcRecommendation {
  action: AbcAction;
  /**
   * A métrica que sustenta a recomendação. Obrigatório declarar (#4657):
   * `clique` é a métrica que decide o teste por design (#2976), mas é
   * também a contaminada pela #4559 — o editor precisa saber qual foi usada
   * pra pesar a confiança.
   */
  metric: "clique" | "abertura" | "nenhuma";
  /** Célula vencedora quando `action === "travar"`. */
  winner: "A" | "B" | "C" | null;
  /** Ressalvas que rebaixam a confiança. Vazio = recomendação limpa. */
  caveats: string[];
  rationale: string;
}

/**
 * Traduz `AbcAudienceTable` (já calculada por `aggregateAbcByAudience`) numa
 * ação. NUNCA decide sozinha — quem chama apresenta isto como RECOMENDAÇÃO
 * num gate de confirmação (decisão do editor, #4657).
 *
 * A regra é deliberadamente conservadora: só recomenda `travar` quando o
 * resultado é significativo E nenhuma ressalva de confiança está de pé.
 * Significativo COM ressalva vira `continuar` — porque travar o vencedor é
 * irreversível na prática (as ondas seguintes saem todas com esse assunto) e
 * a #4559 mostrou que "significativo" por clique já apontou pra um vencedor
 * cuja evidência era 81% não-atribuível.
 */
export function recommendAbcAction(
  table: AbcAudienceTable | null,
  opts: { lockedSubject?: string | null } = {},
): AbcRecommendation {
  if (opts.lockedSubject) {
    return {
      action: "travar",
      metric: "nenhuma",
      winner: null,
      caveats: [],
      rationale: `Vencedor já travado em ciclos anteriores — as próximas ondas saem com assunto único ("${opts.lockedSubject}").`,
    };
  }

  const sampled = table?.cells.filter((c) => c.campaignCount > 0) ?? [];
  if (sampled.length < 2) {
    return {
      action: "iniciar",
      metric: "nenhuma",
      winner: null,
      caveats: [],
      rationale:
        sampled.length === 0
          ? "Nenhuma célula amostrada neste ciclo — não há teste em curso."
          : "Só 1 célula amostrada — não há comparação possível. Iniciar o teste com 3 células.",
    };
  }

  const t = table!;
  const caveats: string[] = [];
  if (t.attributionUnknown) {
    caveats.push(
      "Célula líder ou 2ª colocada teve campanha SEM `campaignStats` — parte do clique que decide este teste é NÃO-VERIFICADA (#4567).",
    );
  }
  const mde = t.minDetectableLiftRelative;
  if (typeof mde === "number" && mde > LOW_POWER_MDE_THRESHOLD) {
    caveats.push(
      `Poder baixo: a amostra atual só detectaria com confiança um lift relativo de ${(mde * 100).toFixed(0)}% ou mais (acima da âncora de ${(LOW_POWER_MDE_THRESHOLD * 100).toFixed(0)}%) — um "significativo" nessa faixa pode ser winner's curse (#4559).`,
    );
  }
  if (t.suspectedDriftDays && t.suspectedDriftDays.length > 0) {
    caveats.push(
      `${t.suspectedDriftDays.length} dia(s) excluído(s) por suspeita de DRIFT DE NAMING (${t.suspectedDriftDays.join(", ")}) — o teste pode estar comparando menos dado do que parece (#4449).`,
    );
  }

  const p = t.pValue;
  const pTxt = p !== null ? p.toFixed(4) : "?";

  if (t.significantClick && t.leaderClickRate) {
    if (caveats.length === 0) {
      return {
        action: "travar",
        metric: "clique",
        winner: t.leaderClickRate,
        caveats,
        rationale: `Célula ${t.leaderClickRate} vence por CLIQUE com diferença significativa (p ${pTxt} < 0,05) e sem ressalva de confiança. Dá pra travar o assunto vencedor nas próximas ondas.`,
      };
    }
    return {
      action: "continuar",
      metric: "clique",
      winner: t.leaderClickRate,
      caveats,
      rationale: `Célula ${t.leaderClickRate} lidera por CLIQUE com p ${pTxt} < 0,05, MAS há ressalva de confiança — tratar como indicativo, não conclusivo. Recomendado seguir com as 3 células mais uma onda antes de travar.`,
    };
  }

  // Sem significância no clique. A abertura DISCORDANDO do clique já
  // aconteceu (ver memória `teste-abc-subject-2606-07`) — reportar, nunca
  // promover a abertura a critério de decisão por conta própria.
  const openNote =
    t.leaderOpenRate && t.leaderOpenRate !== t.leaderClickRate
      ? ` (atenção: a líder por ABERTURA é a ${t.leaderOpenRate}, diferente da líder por clique — as duas métricas já discordaram em ciclos anteriores)`
      : "";
  return {
    action: "continuar",
    metric: "clique",
    winner: null,
    caveats,
    rationale: `Diferença de clique ainda NÃO é significativa (p ${pTxt} ≥ 0,05)${openNote}. Manter as 3 células e acumular amostra.`,
  };
}

// ---------------------------------------------------------------------------
// Backlog MillionVerifier — a alavanca real quando a fila de 1º envio aperta
// ---------------------------------------------------------------------------

/** Custo unitário da verificação MillionVerifier (~US$ 1,90 / 1.000, #1297). */
export const MV_COST_PER_EMAIL_USD = 0.0019;

export interface MvBacklogEntry {
  cohort: string;
  count: number;
}

export interface MvBacklog {
  total: number;
  byCohort: MvBacklogEntry[];
  estimatedCostUsd: number;
}

/**
 * Conta os contatos que nunca passaram pelo MillionVerifier, por cohort.
 *
 * Isto NÃO é enfeite de relatório: é a única alavanca de alcance que sobra
 * quando a fila de 1º envio (`ramp-warm`) seca — e ela SECA (as ondas do
 * ciclo 2607-08 caíram de ~3.300/dia pra ~350/dia em 2 dias). Decisão do
 * editor (#4657): quando a fila apertar, a proposta sinaliza este backlog em
 * vez de silenciosamente trocar o público pra reenvio, que é uma mudança de
 * natureza da onda (aquisição → retenção) disfarçada de continuidade.
 */
export function summarizeMvBacklog(
  rows: Array<Pick<StoreRow, "cohort" | "mv_bucket" | "ineligible_reason">>,
): MvBacklog {
  const counts = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const unverified = !r.mv_bucket && r.ineligible_reason === "mv_unverified";
    if (!unverified) continue;
    const cohort = r.cohort ?? "(sem cohort)";
    counts.set(cohort, (counts.get(cohort) ?? 0) + 1);
    total += 1;
  }
  const byCohort = [...counts.entries()]
    .map(([cohort, count]) => ({ cohort, count }))
    .sort((a, b) => b.count - a.count || a.cohort.localeCompare(b.cohort));
  return { total, byCohort, estimatedCostUsd: total * MV_COST_PER_EMAIL_USD };
}

// ---------------------------------------------------------------------------
// Não-abridor reincidente — a lacuna que o sunset (#4430) nunca fechou
// ---------------------------------------------------------------------------

export interface NonOpenerExposure {
  /** Elegíveis que já receberam N+ envios e nunca abriram nenhum. */
  count: number;
  /** Fração desses sobre o total de elegíveis (0-1). */
  fraction: number;
  minSends: number;
}

/**
 * Mede quantos contatos ELEGÍVEIS já receberam `minSends`+ envios sem NUNCA
 * abrir. A #4430 (sunset) propunha cortá-los da elegibilidade e foi fechada
 * sem implementação — `computeEligibility` (`clarice-db.ts`) não tem esse
 * corte, então eles continuam voltando pra fila a cada onda.
 *
 * Reportar isso é o mínimo que dá pra fazer sem reabrir a decisão de produto:
 * é esse estoque que alimenta a reclamação de spam, que por sua vez faz
 * `decideSemaphore` FREAR o volume das ondas seguintes. O laço se fecha
 * contra o próprio alcance, e hoje ele é invisível na hora de decidir a onda.
 */
export function measureNonOpenerExposure(
  rows: Array<Pick<StoreRow, "send_eligible" | "sends_count" | "opens_count">>,
  minSends = 2,
): NonOpenerExposure {
  let eligible = 0;
  let count = 0;
  for (const r of rows) {
    if (r.send_eligible !== 1) continue;
    eligible += 1;
    if ((r.sends_count ?? 0) >= minSends && (r.opens_count ?? 0) === 0) count += 1;
  }
  return { count, fraction: eligible > 0 ? count / eligible : 0, minSends };
}

// ---------------------------------------------------------------------------
// Volume — delega inteiramente ao semáforo do dashboard
// ---------------------------------------------------------------------------

export interface VolumeProposal {
  perDay: number[];
  total: number;
  semaphore: Semaphore;
  /** `true` no vermelho — o editor precisa revisar antes de prosseguir. */
  flagged: boolean;
  baseVolume: number;
  health: HealthAggregate;
  spamSignal: SpamSignal;
}

export type VolumeResult = { ok: true; proposal: VolumeProposal } | { ok: false; reason: string };

/**
 * Propõe o volume de cada dia da onda.
 *
 * Zero lógica de decisão própria: `selectMatureDayCampaigns` → `aggregateHealth`
 * → `resolveSpamSignal` → `decideSemaphore` → `computeWeekPlan`, tudo
 * importado do worker. Escrever um segundo cálculo de volume neste repo seria
 * a mesma classe de erro que a duplicação close-poll/publish-monthly causou
 * (#3226) — e aqui o custo de divergir é mandar e-mail demais com o alarme de
 * spam tocando.
 *
 * `computeWeekPlan` devolve exatamente 3 volumes (o passo da rampa). Para
 * `days > 3`, os dias seguintes repetem o 3º volume em vez de extrapolar a
 * escalada: escalar composto sem métrica nova entre um dia e outro é
 * inventar confiança que o dado não sustenta (as ondas dos dias 4+ ainda não
 * maturaram quando a proposta é montada).
 */
export function proposeVolumes(
  campaigns: BrevoCampaign[],
  days: number,
  now: Date,
  spamEntry: Parameters<typeof resolveSpamSignal>[0],
): VolumeResult {
  if (!Number.isInteger(days) || days <= 0) {
    return { ok: false, reason: `número de dias inválido: ${days} — esperado inteiro > 0.` };
  }
  const allSent = campaigns.filter((c) => c.status === "sent" && !!c.sentDate);
  if (allSent.length === 0) {
    return { ok: false, reason: "Nenhum envio registrado — sem volume-base pra escalar. Use volume explícito." };
  }
  const { mature } = selectMatureDayCampaigns(allSent, now);
  if (mature.length === 0) {
    return {
      ok: false,
      reason: "Nenhum envio maduro (>48h) ainda — as métricas de saúde não subiram. Aguardar antes de dimensionar a próxima onda.",
    };
  }
  const baseVolume = baseVolumeFromLastSendDay(allSent);
  if (baseVolume <= 0) {
    return { ok: false, reason: "Volume-base (último dia de envio) indisponível — use volume explícito." };
  }
  const health = aggregateHealth(mature);
  const spamSignal = resolveSpamSignal(spamEntry ?? null, now);
  const semaphore = decideSemaphore(health, spamSignal);
  const plan = computeWeekPlan(baseVolume, semaphore);

  const perDay: number[] = [];
  for (let i = 0; i < days; i += 1) {
    perDay.push(plan.volumes[Math.min(i, plan.volumes.length - 1)]);
  }

  return {
    ok: true,
    proposal: {
      perDay,
      total: perDay.reduce((a, b) => a + b, 0),
      semaphore,
      flagged: plan.flagged,
      baseVolume,
      health,
      spamSignal,
    },
  };
}

// ---------------------------------------------------------------------------
// Proposta consolidada
// ---------------------------------------------------------------------------

export interface PlannedWave {
  n: number;
  date: string;
  scheduledAt: string;
  volume: number;
  /** Chaves das listas a criar — 3 (A/B/C) quando há teste, 1 quando não. */
  keys: string[];
}

export interface WaveProposalInput {
  cycle: string;
  /** Datas explícitas, uma por dia de envio (YYYY-MM-DD). */
  dates: string[];
  volumes: VolumeProposal;
  abc: AbcRecommendation;
  state: CycleSendState;
  /** Fila de 1º envio disponível AGORA (pós-exclusão de comprometidos). */
  availableFirstSend: number;
  mvBacklog: MvBacklog;
  nonOpeners: NonOpenerExposure;
  /** Crédito Brevo restante no ciclo de cobrança. `null` = não consultado. */
  brevoCredits: number | null;
  /** Idade do dado do dashboard quando servido de cache. `null` = fresco. */
  staleNote: string | null;
  /** Índice do 1º dia da onda (continua a numeração do ciclo). */
  startingWaveNumber: number;
}

export interface WaveProposal extends WaveProposalInput {
  waves: PlannedWave[];
  /** Bloqueios que impedem o agendamento. Não-vazio = não apresentar `sim`. */
  blockers: string[];
  /** Avisos que não impedem, mas o editor precisa ver antes de confirmar. */
  warnings: string[];
}

/**
 * Monta a proposta completa e computa bloqueios/avisos.
 *
 * Distinção deliberada entre `blockers` e `warnings`: bloqueio é o que
 * tornaria a onda ERRADA (crédito insuficiente, fila menor que o volume,
 * semáforo vermelho) e o gate não pode oferecer "sim" com um de pé; aviso é
 * o que o editor precisa PESAR (fila apertando, não-abridores acumulando,
 * dado stale). Colapsar os dois numa lista só é como se perde a diferença
 * entre "não pode" e "olha isso".
 */
export function buildWaveProposal(input: WaveProposalInput): WaveProposal {
  const withCells = input.abc.action !== "travar";
  const waves: PlannedWave[] = input.dates.map((date, i) => {
    const n = input.startingWaveNumber + i;
    const volume = input.volumes.perDay[i] ?? input.volumes.perDay[input.volumes.perDay.length - 1] ?? 0;
    const keys = withCells
      ? (["A", "B", "C"] as const).map((cell) => waveKey(n, date, cell))
      : [waveKey(n, date)];
    return { n, date, scheduledAt: scheduledAtForDate(date), volume, keys };
  });

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (input.volumes.flagged || input.volumes.semaphore === "red") {
    blockers.push(
      "Semáforo VERMELHO — um circuit breaker de entregabilidade está estourado. O volume já foi podado 30%, mas a onda não deve sair sem revisão explícita do editor.",
    );
  }
  if (input.brevoCredits !== null && input.volumes.total > input.brevoCredits) {
    blockers.push(
      `Crédito Brevo insuficiente: a onda pede ${fmt(input.volumes.total)} e restam ${fmt(input.brevoCredits)} no ciclo de cobrança.`,
    );
  }
  if (input.availableFirstSend < input.volumes.total) {
    blockers.push(
      `Fila de 1º envio (${fmt(input.availableFirstSend)}) é menor que o volume proposto (${fmt(input.volumes.total)}) — as últimas ondas sairiam menores que o planejado ou puxariam público de outra natureza.`,
    );
  }
  if (input.brevoCredits === null) {
    blockers.push("Crédito Brevo não consultado — nunca agendar sem validar o crédito ANTES (campanha agendada é imutável).");
  }

  if (input.staleNote) {
    warnings.push(`Dashboard serviu dado de CACHE — ${input.staleNote}. A proposta abaixo foi decidida sobre esse dado.`);
  }
  if (input.state.scheduledCount > 0) {
    warnings.push(
      `${input.state.scheduledCount} campanha(s) deste ciclo ainda AGENDADA(s) e não disparada(s) — na Brevo elas são imutáveis, e seus destinatários já estão congelados.`,
    );
  }
  if (!input.state.volumeComplete && input.state.waves.length > 0) {
    warnings.push(
      "Nem toda onda anterior reportou tamanho de lista — o total já enviado é um PISO, não um número exato.",
    );
  }
  const queueAfter = input.availableFirstSend - input.volumes.total;
  if (queueAfter >= 0 && queueAfter < input.volumes.total) {
    warnings.push(
      `Fila de 1º envio acaba logo: sobram ${fmt(queueAfter)} depois desta onda — menos que uma onda inteira. A alavanca pra continuar é verificar o backlog do MillionVerifier (${fmt(input.mvBacklog.total)} contatos, ~US$ ${input.mvBacklog.estimatedCostUsd.toFixed(0)}), não trocar o público pra reenvio.`,
    );
  }
  if (input.nonOpeners.count > 0) {
    warnings.push(
      `${fmt(input.nonOpeners.count)} contatos elegíveis (${(input.nonOpeners.fraction * 100).toFixed(1)}% da base elegível) já receberam ${input.nonOpeners.minSends}+ envios sem NUNCA abrir — o sunset da #4430 nunca foi implementado, então eles voltam pra fila a cada onda e alimentam a reclamação de spam que depois freia o volume.`,
    );
  }
  for (const c of input.abc.caveats) warnings.push(`Teste A/B/C: ${c}`);

  return { ...input, waves, blockers, warnings };
}

function fmt(n: number): string {
  return n.toLocaleString("pt-BR");
}

const SEMAPHORE_LABEL: Record<Semaphore, string> = {
  green: "🟢 verde",
  yellow: "🟡 amarelo",
  red: "🔴 vermelho",
};

const ACTION_LABEL: Record<AbcAction, string> = {
  iniciar: "INICIAR teste A/B/C (3 células)",
  continuar: "CONTINUAR teste A/B/C (3 células)",
  travar: "TRAVAR no vencedor (assunto único)",
};

/**
 * Renderiza a tela de confirmação. É a superfície onde o editor aprova tudo
 * de uma vez — por isso mostra TODO valor que vira escrita na Brevo (datas,
 * volumes, listas a criar com o nome já gerado, crédito consumido), não um
 * resumo. Um valor que não aparece aqui é um valor que o editor não confirmou.
 */
export function renderWaveProposal(p: WaveProposal): string {
  const L: string[] = [];
  L.push(`📋 Proposta de onda — Clarice News, ciclo ${p.cycle}`);
  L.push("");

  L.push("── Já enviado neste ciclo ──");
  if (p.state.waves.length === 0) {
    L.push("  (nenhuma onda registrada — esta seria a primeira)");
  } else {
    for (const w of p.state.waves) {
      const when = w.scheduledAt ? w.scheduledAt.slice(0, 10) : "sem data";
      const vol = w.volume === null ? "?" : fmt(w.volume);
      L.push(`  ${w.key.padEnd(16)} ${when}  ${vol.padStart(7)} contatos  [${w.status}]`);
    }
    L.push(
      `  ${p.state.waves.length} campanha(s) · ${fmt(p.state.volumeSum)} contatos${p.state.volumeComplete ? "" : " (PISO — nem toda onda reportou tamanho)"}`,
    );
  }
  L.push("");

  L.push("── Teste de assunto A/B/C ──");
  L.push(`  Recomendação: ${ACTION_LABEL[p.abc.action]}`);
  L.push(`  Métrica: ${p.abc.metric}${p.abc.winner ? ` · líder: célula ${p.abc.winner}` : ""}`);
  L.push(`  ${p.abc.rationale}`);
  L.push("");

  L.push("── Saúde e volume ──");
  L.push(`  Semáforo: ${SEMAPHORE_LABEL[p.volumes.semaphore]} · volume-base (último dia): ${fmt(p.volumes.baseVolume)}`);
  L.push(
    `  Abertura ${p.volumes.health.openRate.toFixed(1)}% · hard bounce ${p.volumes.health.hardBounceRate.toFixed(2)}% · bounce total ${p.volumes.health.bounceRate.toFixed(2)}% · unsub ${p.volumes.health.unsubRate.toFixed(2)}%`,
  );
  L.push(
    `  Spam (Postmaster): ${p.volumes.spamSignal.source === "indeterminate" ? "indeterminado — o semáforo nunca fica verde às cegas" : `${p.volumes.spamSignal.ratePct?.toFixed(3)}%${p.volumes.spamSignal.breach ? " — BREAKER ESTOURADO" : ""}`}`,
  );
  L.push("");

  L.push("── Onda proposta ──");
  for (const w of p.waves) {
    L.push(`  d${w.n} · ${w.date} 06:00 BRT · ${fmt(w.volume)} contatos`);
    for (const k of w.keys) L.push(`       lista: Clarice ${p.cycle} ${k}${k.match(/-[ABC]$/) ? ` — célula ${k.slice(-1)}` : ""}`);
  }
  L.push(`  TOTAL: ${fmt(p.volumes.total)} contatos em ${p.waves.length} dia(s)`);
  if (p.brevoCredits !== null) {
    L.push(`  Crédito Brevo: ${fmt(p.brevoCredits)} → sobraria ${fmt(p.brevoCredits - p.volumes.total)}`);
  }
  L.push(`  Fila de 1º envio disponível: ${fmt(p.availableFirstSend)}`);
  L.push("");

  if (p.warnings.length > 0) {
    L.push("── Avisos ──");
    for (const w of p.warnings) L.push(`  ⚠️  ${w}`);
    L.push("");
  }
  if (p.blockers.length > 0) {
    L.push("── BLOQUEIOS ──");
    for (const b of p.blockers) L.push(`  ⛔ ${b}`);
    L.push("");
    L.push("Não é possível agendar com bloqueio de pé. Resolva ou ajuste os parâmetros.");
  } else {
    L.push("Confirmar e agendar? sim / ajustar / abortar");
  }
  return L.join("\n");
}
