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
import { hasMeasuredOpens } from "./clarice-segment.ts";
import {
  cohortDisplayLabel,
  compareCohortEntriesByRecency,
  isMvExemptCohort,
} from "./cohorts.ts";

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
 * de uma campanha real na Brevo — corrigir depois de agendado exige cancelar
 * (API ou painel) e recriar, não é gratuito (#4935).
 */
export const SEND_HOUR_UTC = 9;

/**
 * `YYYY-MM-DD` → ISO UTC do horário canônico de envio. Lança em data
 * malformada ou inexistente (ex: `2026-02-31`) — nunca devolve uma data
 * "corrigida" em silêncio — campanha Brevo agendada é cancelável e
 * recriável via API/painel (#4935), mas não é gratuito, e um off-by-one
 * aqui só é descoberto depois do disparo (incidente 260703), quando o
 * envio já saiu de verdade e aí sim não tem volta.
 *
 * `hourUtc` (#5140) existe pro teste de horário da onda `ramp-warm`: duas
 * células do MESMO dia agendadas em horas diferentes (06:00 × 10:00 BRT).
 * Omitir preserva `SEND_HOUR_UTC` — todo chamador de hoje passa por esse
 * ramo, então o default é o comportamento histórico, não uma escolha nova.
 *
 * A hora é validada aqui e não no chamador porque é este valor que vira
 * `scheduledAt` de campanha real: um `hourUtc` fracionário ou fora de 0–23
 * produziria um ISO que a Brevo aceita interpretar do jeito dela (ou
 * rejeita tarde, depois do `--create`), e o modo de falha seria o mesmo
 * off-by-one silencioso que o round-trip de data abaixo existe pra impedir.
 */
export function scheduledAtForDate(date: string, hourUtc: number = SEND_HOUR_UTC): string {
  const m = ISO_DATE_RE.exec(date);
  if (!m) {
    throw new Error(`data inválida: "${date}" — esperado YYYY-MM-DD (data é sempre explícita).`);
  }
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) {
    throw new Error(`hora UTC inválida: ${hourUtc} — esperado inteiro entre 0 e 23.`);
  }
  const [, y, mo, d] = m;
  const iso = `${y}-${mo}-${d}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`;
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
 * Fragmento `{dia}{DD}` (ex: `qui06`) embutido em toda `waveKey` — extraído
 * pra cá (#5064) porque o guard de onda em DRAFT
 * (`detectExistingWaveForSendDate` em clarice-envio-run.ts) precisa comparar
 * este MESMO fragmento contra a chave de uma campanha sem `scheduledAt`
 * (rascunho: `--create` rodou, `--schedule` ainda não — só a data embutida
 * na key identifica pra qual dia ela foi montada).
 */
export function waveDateFragment(date: string): string {
  const dd = ISO_DATE_RE.exec(date)![3];
  return `${brtDayLabel(date)}${dd}`;
}

/**
 * Célula do teste de HORÁRIO (#5140) — `H` + hora BRT zero-padded (`H06`,
 * `H10`). Dimensão distinta do A/B/C **de propósito**, não por estética:
 *
 *   - `parseAbcAudienceCampaign` (dashboard) casa `([ABC])\b`, então `H06`
 *     nunca é lido como célula de assunto. Sem isso, um teste de horário
 *     apareceria no painel rotulado como teste de assunto — a confusão que a
 *     #5140 lista como guardrail.
 *   - `clarice-abc-state.json` continua `encerrado` sem que este teste o
 *     toque. Reabri-lo traria de volta a ressalva de poder baixo do #4559,
 *     que zera o passo de volume (fixo desde #6888, ver docs/clarice-envio-daily-setup.md).
 */
export type HourCell = `H${string}`;

/** Célula de assunto (`A`/`B`/`C`, #4449) ou de horário (`H06`…, #5140).
 *  O nome `AbcCell` NÃO é reexportado aqui de propósito — ele já é dono de
 *  `clarice-abc-state.ts`, e dois tipos homônimos em módulos irmãos é a
 *  espécie de ambiguidade que faz alguém importar do lugar errado. */
export type WaveCell = "A" | "B" | "C" | HourCell;

/** Hora BRT (0–23) → rótulo de célula de horário (`6` → `H06`). */
export function hourCellLabel(hourBrt: number): HourCell {
  if (!Number.isInteger(hourBrt) || hourBrt < 0 || hourBrt > 23) {
    throw new Error(`hora BRT inválida: ${hourBrt} — esperado inteiro entre 0 e 23.`);
  }
  return `H${String(hourBrt).padStart(2, "0")}`;
}

/**
 * Hora BRT → hora UTC do MESMO dia-calendário (BRT = UTC-3, fixo o ano todo).
 *
 * LANÇA a partir de 21:00 BRT, que em UTC já é o dia seguinte. Sem este
 * guard, `scheduledAtForDate(date, (h + 3) % 24)` montaria o ISO no dia
 * ERRADO — 22:00 BRT viraria 01:00 UTC do próprio `date`, ou seja 22:00 BRT
 * do dia ANTERIOR: uma campanha real agendada 24h antes do pretendido, e o
 * tipo de erro que só aparece depois do disparo (mesma classe do incidente
 * 260703 citado em `scheduledAtForDate`).
 *
 * Restringir em vez de fazer a aritmética de data completa é deliberado: a
 * janela útil do teste de horário é diurna (a análise da #5140 mostra a
 * conversão concentrada entre 09h e 17h), então 21:00+ não é um caso que se
 * queira suportar — é um caso que se quer recusar alto.
 */
export function brtHourToUtcHourSameDay(hourBrt: number): number {
  if (!Number.isInteger(hourBrt) || hourBrt < 0 || hourBrt > 23) {
    throw new Error(`hora BRT inválida: ${hourBrt} — esperado inteiro entre 0 e 23.`);
  }
  if (hourBrt > 20) {
    throw new Error(
      `hora BRT ${hourBrt}:00 cai no dia seguinte em UTC (${hourBrt + 3 - 24}:00) e agendaria a campanha no dia errado. ` +
        "O teste de horário suporta 00:00–20:00 BRT.",
    );
  }
  return hourBrt + 3;
}

/** `H06` → `6`; qualquer outra coisa → null (não é célula de horário). */
export function parseHourCell(cell: string): number | null {
  const m = /^H(\d{2})$/.exec(cell);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}

const ABC_CELLS: readonly string[] = ["A", "B", "C"];

/**
 * Chave determinística de uma onda: `d{N}-{dia}{DD}` (ex: `d6-qui06`) —
 * mesmo formato que o ciclo 2607-08 usou à mão (`d1-sab01` … `d5-qua05`),
 * agora GERADO. `cell` sufixa `-A`/`-B`/`-C` (assunto) ou `-H06`/`-H10`
 * (horário, #5140), que é exatamente o que `groupCellListNameFor` exige pra
 * derivar a célula do nome da lista (nunca digitar o sufixo à parte — ver
 * #4449/#4471).
 *
 * A célula é VALIDADA aqui: esta chave vira nome de lista e de campanha
 * Brevo, e um sufixo fora dos dois formatos conhecidos passaria por
 * `isGroupCellWave` como "sem célula", colapsando duas células na mesma
 * lista — falha silenciosa, descoberta só depois do disparo.
 */
export function waveKey(n: number, date: string, cell?: WaveCell): string {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`número de onda inválido: ${n} — esperado inteiro > 0.`);
  }
  if (cell !== undefined && !ABC_CELLS.includes(cell) && parseHourCell(cell) === null) {
    throw new Error(
      `célula inválida: "${cell}" — esperado "A"/"B"/"C" (assunto) ou "H{00-23}" (horário, #5140).`,
    );
  }
  const base = `d${n}-${waveDateFragment(date)}`;
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
  /**
   * Ondas ainda agendadas pro futuro. Não são estado terminal (#4935 — dá
   * pra cancelar via API/painel e recriar), mas os destinatários já estão
   * fixados na campanha corrente até alguém agir.
   */
  scheduledCount: number;
  /**
   * Campanhas com naming `grupo:` que NÃO puderam ser atribuídas a ciclo
   * nenhum, por falta de `listName` (a lista é a única fonte do ciclo mensal
   * — o nome da campanha só tem `yymm`, ambíguo entre conteúdo e envio).
   *
   * Existe porque a versão original deste filtro era `if (c.listName &&
   * !c.listName.includes(cycle)) continue` — um guard "pula-se-presente" que,
   * sem `listName`, MANTINHA a campanha em qualquer ciclo. E `listName`
   * depende de uma chamada de rede por lista que pode falhar
   * individualmente, então uma campanha de OUTRO ciclo entrava no resumo,
   * inflando `volumeSum`/`sentCount` e — pior — o `maxWaveN` que decide o
   * número da próxima onda (chave duplicada). Achado por dois reviewers
   * independentes no PR #4658.
   *
   * Agora essas campanhas são EXCLUÍDAS (dado ausente é mais seguro que dado
   * errado, mesmo critério do guard `<3 células` do painel) e contadas aqui
   * pra virar aviso — nunca sumir em silêncio.
   */
  unscopedCount: number;
}

/** Extrai a chave `{key}` de um nome de campanha `Clarice {yymm} grupo:{key}`. */
export function groupKeyFromCampaignName(name: string): string | null {
  const m = /grupo:([\w-]+)\s*$/i.exec(name.trim());
  return m ? m[1] : null;
}

/**
 * #5064 — funde campanhas SENT/QUEUED (dashboard, `/api/campaigns?includeScheduled=1`)
 * com campanhas DRAFT (Brevo direto, `fetchDraftCampaigns` em brevo-client.ts)
 * num único array, pra `summarizeCycleSends` enxergar onda PARCIALMENTE
 * MONTADA (`--create` rodou, `--schedule` não) junto do resto. `summarizeCycleSends`
 * já lida com campanha sem `scheduledAt`/`sentDate` (vira `WaveState.scheduledAt:
 * null`) — nenhuma mudança nela foi necessária, só dar-lhe visibilidade da
 * campanha. Dedup por `id` é defensivo (uma campanha não deveria aparecer em
 * dois status ao mesmo tempo), nunca contar a mesma campanha duas vezes.
 */
export function mergeCampaignSources(
  sentOrQueued: ReadonlyArray<BrevoCampaign>,
  draft: ReadonlyArray<BrevoCampaign>,
): BrevoCampaign[] {
  const seen = new Set<number>();
  const out: BrevoCampaign[] = [];
  for (const c of [...sentOrQueued, ...draft]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
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
  let unscopedCount = 0;
  for (const c of campaigns) {
    const key = groupKeyFromCampaignName(c.name ?? "");
    if (!key) continue;
    // A campanha só pertence a ESTE ciclo se a lista carrega o ciclo mensal —
    // o nome da campanha só tem `yymm`, que é ambíguo entre conteúdo e envio.
    // Sem `listName` NÃO dá pra afirmar o ciclo: excluir e contar (ver
    // `unscopedCount`). Nunca "manter na dúvida" — era esse o bug original.
    if (!c.listName) {
      unscopedCount += 1;
      continue;
    }
    if (!c.listName.includes(cycle)) continue;
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
    unscopedCount,
  };
}

/**
 * Próximo número de onda: continua a numeração do ciclo (`d5` → `d6`), nunca
 * reinicia. Extraída de `planWave` pra cá (PR #4658) porque é DECISÃO, não
 * I/O: um off-by-one aqui reusa um número já usado e produz uma chave
 * `grupo:` duplicada — que `summarizeCycleSends` depois funde ou conta duas
 * vezes, a classe do #3682.
 *
 * Chave que não casa o padrão `d{N}-` é IGNORADA de propósito (grupos
 * legítimos sem numeração, ex: `novos`, `d1-sab01-interno` já casa por
 * prefixo). Ignorar é seguro aqui porque o efeito é sempre CONSERVADOR:
 * no máximo o número proposto fica menor que o real, e aí o import aborta
 * por conflito de nome de lista (`findExistingConflicts`) em vez de
 * sobrescrever.
 */
export function computeNextWaveNumber(waves: Array<Pick<WaveState, "key">>): number {
  let max = 0;
  for (const w of waves) {
    const n = /^d(\d+)-/.exec(w.key)?.[1];
    if (n) max = Math.max(max, Number(n));
  }
  return max + 1;
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
 * Significativo recomenda `travar`, COM as ressalvas de confiança aparecendo
 * como AVISO no gate — decisão do editor (05/08): a skill dá a leitura, o
 * editor pesa a ressalva. A alternativa (rebaixar pra `continuar` sempre que
 * houvesse ressalva) foi descartada porque, na prática, ressalva quase sempre
 * existe e o efeito era um teste que nunca terminava.
 *
 * O caso 2607-08 mostra por que isso é razoável: continuar o teste até
 * concluir por CLIQUE exigiria ~217k envios adicionais contra uma fila de
 * ~26k — 8× toda a base disponível. Segurar a decisão "até ter certeza" não
 * é o lado seguro quando a certeza é inalcançável; é só gastar a fila em 3
 * braços em vez de 1.
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
    return {
      action: "travar",
      metric: "clique",
      winner: t.leaderClickRate,
      caveats,
      rationale:
        caveats.length === 0
          ? `Célula ${t.leaderClickRate} vence por CLIQUE com diferença significativa (p ${pTxt} < 0,05) e sem ressalva de confiança. Travar o assunto vencedor nas próximas ondas.`
          : `Célula ${t.leaderClickRate} vence por CLIQUE com p ${pTxt} < 0,05, mas com ${caveats.length} ressalva(s) de confiança listada(s) nos avisos — pesar antes de confirmar.`,
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
  /**
   * `created` mais recente entre os contatos `mv_unverified` deste cohort no
   * recorte agregado, ou `null`/ausente quando nenhuma linha do cohort tinha
   * `created` válido (#5179) — OPCIONAL de propósito, pra não quebrar
   * fixtures de teste/chamadores que constroem `MvBacklogEntry` sem passar
   * pelo `created` do store (ausência degrada com segurança pro fallback de
   * `compareCohortEntriesByRecency`, que já trata `undefined` como
   * desconhecido). Alimenta essa comparação — NUNCA um critério de exibição,
   * só de ORDEM de prioridade de verificação (ver `planMvOnDemand`).
   */
  mostRecentCreated?: string | null;
}

export interface MvBacklog {
  total: number;
  byCohort: MvBacklogEntry[];
  estimatedCostUsd: number;
}

/**
 * Rótulo de exibição pros contatos sem cohort conhecido (`cohort IS NULL` no
 * store) dentro de `MvBacklog.byCohort` — NUNCA um valor real da coluna
 * `cohort` (que só guarda um slug reconhecido ou `NULL`, nunca esta string).
 * Exportado (não um literal solto) porque `planMvOnDemand` precisa EXCLUIR
 * esta entrada do recorte executável: `readStoreCandidates`/`verify-emails-mv.ts`
 * fazem `WHERE cohort = ?` com o valor exato, e `cohort = '(sem cohort)'`
 * nunca bate uma linha real com `cohort IS NULL` — sem o filtro, um contato
 * sem cohort no backlog vira uma alocação no plano que `clarice-mv-ondemand.ts`
 * silenciosamente verificaria ZERO candidatos (query sem match), gastando o
 * "espaço" do alvo de verificação sem cobrir déficit nenhum (#4659, achado do
 * self-review).
 */
export const MV_BACKLOG_NO_COHORT_LABEL = "(sem cohort)";

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
  rows: Array<Pick<StoreRow, "cohort" | "mv_bucket" | "ineligible_reason" | "created">>,
): MvBacklog {
  const counts = new Map<string, number>();
  // `created` mais recente (epoch ms) já visto por cohort — usado só pra
  // popular `MvBacklogEntry.mostRecentCreated` (#5179), nunca pra decidir
  // esta contagem/ordem (`byCohort` continua por VOLUME, ver docstring de
  // `planMvOnDemand.byCohort` sobre por que os dois critérios não podem se
  // confundir).
  const mostRecentMs = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const unverified = !r.mv_bucket && r.ineligible_reason === "mv_unverified";
    if (!unverified) continue;
    const cohort = r.cohort ?? MV_BACKLOG_NO_COHORT_LABEL;
    counts.set(cohort, (counts.get(cohort) ?? 0) + 1);
    total += 1;
    const ms = r.created ? Date.parse(r.created) : NaN;
    if (Number.isFinite(ms)) {
      const prev = mostRecentMs.get(cohort);
      if (prev === undefined || ms > prev) mostRecentMs.set(cohort, ms);
    }
  }
  const byCohort = [...counts.entries()]
    .map(([cohort, count]) => {
      const ms = mostRecentMs.get(cohort);
      return { cohort, count, mostRecentCreated: ms === undefined ? null : new Date(ms).toISOString() };
    })
    .sort((a, b) => b.count - a.count || a.cohort.localeCompare(b.cohort));
  return { total, byCohort, estimatedCostUsd: total * MV_COST_PER_EMAIL_USD };
}

// ---------------------------------------------------------------------------
// Composição por safra da fila de 1º envio (#4787) — o que `availableFirstSend`
// (só um total) não dizia: DE QUE COHORT vem cada fatia da onda. Existe pra
// tornar visível a olho nu quando a fila está "cheia" (sem déficit — ver
// `computeFirstSendDeficit` abaixo) mas cheia da safra ERRADA, o caso real
// que motivou a #4787: a onda de 09/08 do ciclo 2607-08 pulou de
// `leads-2024h2` direto pra `leads-2022h1`/`leads-2021h2`, saltando por cima
// de 226.558 contatos de `leads-2023h1/2023h2/2024h1` só porque essa safra
// nunca passou pelo MillionVerifier — e nada no output avisava.
// ---------------------------------------------------------------------------

export interface CohortComposition {
  cohort: string | null;
  count: number;
  /**
   * `created` mais recente entre as linhas deste cohort no recorte agregado,
   * ou `null`/ausente quando nenhuma tinha `created` válido (#5179).
   * Alimenta `compareCohortEntriesByRecency` — ver ordenação abaixo.
   */
  mostRecentCreated?: string | null;
}

/**
 * Composição por cohort da fila de 1º envio DISPONÍVEL (já excluindo
 * comprometidos — o mesmo conjunto cuja contagem `.length` vira
 * `availableFirstSend`), ordenada por recência REAL via
 * `compareCohortEntriesByRecency` (#5179 — sucede a ordenação pura por
 * `cohortSendRank`).
 *
 * HISTÓRICO (#5169 revisão 260812, achado do review da PR #5178): antes,
 * `cohortSendRank` seguia sendo a ordem real que `segmentRampWarm` usa pra
 * consumir a fila ENTRE LEADS (bucket é derivado de `created`, os dois nunca
 * discordam), mas não era garantia pra cohorts estruturais não MV-isentos
 * (hoje só `ex-assinantes`; `assinantes-ativos` é MV-isento e nunca passa por
 * aqui, `juridico` é virtual). `segmentRampWarm` ordena por
 * `compareContactRecency` (created real, cohort não entra), então um
 * `ex-assinantes` antigo podia ficar atrás de leads mais recentes na fila de
 * fato enquanto este agregado ainda o mostrava "quente" por rank fixo — o
 * `mostRecentCreated` por cohort (calculado abaixo) fecha essa lacuna: só
 * degrada pra `cohortSendRank` quando nenhum dos dois lados comparados tem
 * `created` confiável (mesmo fallback de `compareContactRecency`).
 *
 * Puro: não assume que `rows` já chega ordenado (reordena aqui por conta
 * própria), então continua correta mesmo se o caller mudar a ordem de
 * iteração no futuro.
 */
export function summarizeAvailableFirstSendByCohort(
  rows: Array<Pick<StoreRow, "cohort" | "created">>,
): CohortComposition[] {
  const counts = new Map<string | null, number>();
  const mostRecentMs = new Map<string | null, number>();
  for (const r of rows) {
    const key = r.cohort ?? null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const ms = r.created ? Date.parse(r.created) : NaN;
    if (Number.isFinite(ms)) {
      const prev = mostRecentMs.get(key);
      if (prev === undefined || ms > prev) mostRecentMs.set(key, ms);
    }
  }
  return [...counts.entries()]
    .map(([cohort, count]) => {
      const ms = mostRecentMs.get(cohort);
      return { cohort, count, mostRecentCreated: ms === undefined ? null : new Date(ms).toISOString() };
    })
    .sort(compareCohortEntriesByRecency);
}

/**
 * Recorta `available` (já ordenado morno→frio, ver `summarizeAvailableFirstSendByCohort`)
 * até cobrir `total` contatos — a composição por cohort que a onda de fato
 * consumiria da fila, respeitando a ordem de prioridade real. A última
 * entrada pode ficar PARCIAL (o cohort onde o corte cai no meio); nunca lê
 * além de `total`. `total <= 0` devolve `[]`.
 */
export function sliceCohortComposition(available: CohortComposition[], total: number): CohortComposition[] {
  const out: CohortComposition[] = [];
  let remaining = Math.max(0, total);
  for (const entry of available) {
    if (remaining <= 0) break;
    const count = Math.min(entry.count, remaining);
    if (count > 0) {
      out.push(
        entry.mostRecentCreated !== undefined
          ? { cohort: entry.cohort, count, mostRecentCreated: entry.mostRecentCreated }
          : { cohort: entry.cohort, count },
      );
    }
    remaining -= count;
  }
  return out;
}

export interface CohortInversion {
  /** Cohort `mv_unverified` mais NOVO/morno (por `compareCohortEntriesByRecency`, #5398) que está bloqueado. */
  blockedCohort: string;
  /** Cohort mais FRIO (por `compareCohortEntriesByRecency`) que a onda efetivamente consumiria entre os slices consumidos. */
  coldestConsumedCohort: string | null;
  /** Contatos da onda vindos de cohort(s) mais frios que `blockedCohort` — a cauda substituível. */
  coldTailCount: number;
}

/**
 * Detecta INVERSÃO DE SAFRA (#4787): a onda consumiria cohort mais FRIO
 * enquanto existe cohort `mv_unverified` mais NOVO/morno BLOQUEADO no
 * MillionVerifier. O gatilho por DÉFICIT (`computeFirstSendDeficit` abaixo)
 * não pega esse caso — a fila pode estar "cheia" (déficit zero) e mesmo assim
 * cheia da safra errada, porque `mvOnDemandPlan` só era acionado quando a
 * fila total não bastava, nunca quando a ORDEM estava invertida.
 *
 * `consumed` é a composição por cohort que a onda de fato consumiria
 * (`sliceCohortComposition` sobre `availableFirstSendByCohort`). `mvBacklog`
 * é o backlog de `mv_unverified` (`summarizeMvBacklog`). `null` quando não há
 * inversão — ou porque a onda não consome nada, ou porque nenhum cohort
 * bloqueado é mais novo que o cohort mais frio que ela de fato toca.
 *
 * Cohorts MV-isentos (`isMvExemptCohort`) e o rótulo de exibição
 * `MV_BACKLOG_NO_COHORT_LABEL` NUNCA contam como "bloqueado" — mesmo guard de
 * `planMvOnDemand` (não são candidatos executáveis de verificação).
 *
 * `consumed` também filtra `cohort === null` antes de calcular o mais frio
 * (#4792 fleet review, achado silent-failure-hunter) — espelha o guard
 * equivalente do lado backlog (`MV_BACKLOG_NO_COHORT_LABEL` acima).
 * `cohortSendRank(null)` devolve `RANK_UNKNOWN`, o rank mais FRIO possível
 * (ver cohorts.ts), então uma única linha `cohort: null` em `consumed` —
 * legítima, `isRampWarm` não exige cohort não-nulo — viraria trivialmente o
 * "coldest" por construção, inflando `coldTailCount`/disparando inversão por
 * ruído de dado (contato sem cohort identificável), não por inversão real de
 * safra.
 */
export function detectCohortInversion(
  consumed: CohortComposition[],
  mvBacklog: MvBacklog,
): CohortInversion | null {
  const identified = consumed.filter((c) => c.cohort !== null);
  if (identified.length === 0) return null;

  // "coldest" = a entrada que `compareCohortEntriesByRecency` sempre coloca
  // por ÚLTIMO contra qualquer outra — recência real (`mostRecentCreated`)
  // primeiro, `cohortSendRank` só como fallback quando nenhum dos dois lados
  // tem data confiável (#5398, sucede a comparação pura por rank).
  let coldest = identified[0];
  for (const c of identified) {
    if (compareCohortEntriesByRecency(c, coldest) > 0) coldest = c;
  }

  const candidates = mvBacklog.byCohort.filter(
    (e) =>
      !isMvExemptCohort(e.cohort) &&
      e.cohort !== MV_BACKLOG_NO_COHORT_LABEL &&
      compareCohortEntriesByRecency(e, coldest) < 0,
  );
  if (candidates.length === 0) return null;

  // "blocked" = o candidato MAIS NOVO/morno (vence toda comparação de recência).
  let blocked = candidates[0];
  for (const e of candidates) {
    if (compareCohortEntriesByRecency(e, blocked) < 0) blocked = e;
  }

  const coldTailCount = identified
    .filter((c) => compareCohortEntriesByRecency(c, blocked) > 0)
    .reduce((s, c) => s + c.count, 0);

  return { blockedCohort: blocked.cohort, coldestConsumedCohort: coldest.cohort, coldTailCount };
}

// ---------------------------------------------------------------------------
// Verificação MV SOB DEMANDA (#4659) — recorte mínimo do backlog acima pra
// cobrir o déficit da ONDA ATUAL, nunca um lote sobre os ~253k `mv_unverified`
// inteiros (essa era a proposta da #4427, fechada como "aberta cedo demais").
//
// Decisão do editor (05-06/08/2026, #4659): a verificação acontece na hora de
// montar o grupo de envio, só o suficiente pra destravar a proposta ATUAL —
// "o teto é o próprio volume diário da onda" (~1k contatos/dia ≈ US$2/dia),
// sem gate de gasto adicional nessa ordem de grandeza.
// ---------------------------------------------------------------------------

/**
 * Déficit de fila de 1º envio pra UMA proposta: quanto falta pra a fila
 * disponível cobrir o volume total proposto. Nunca negativo — zero quando a
 * fila já cobre (ou excede) o volume, nesse caso não há nada a verificar.
 *
 * Espelha EXATAMENTE a condição do blocker "Fila de 1º envio... é menor que
 * o volume proposto" logo abaixo em `buildWaveProposal` — os dois precisam
 * concordar sobre o que é "déficit", senão reabre a classe de divergência
 * que a #4658 já corrigiu uma vez (2 cálculos paralelos do mesmo fato).
 */
export function computeFirstSendDeficit(availableFirstSend: number, volumeTotal: number): number {
  return Math.max(0, volumeTotal - availableFirstSend);
}

/**
 * Margem de aprovação esperada do MillionVerifier — ~90% nos cohorts já
 * verificados (medição do editor, #4659/#1297). Verificar exatamente o
 * déficit deixaria a onda curta sempre que a taxa real de aprovação caísse
 * abaixo de 100%, então o alvo de verificação é inflado por esta margem.
 */
export const MV_ONDEMAND_APPROVAL_MARGIN = 0.9;

export interface MvOnDemandAllocation {
  cohort: string;
  /** Quantos deste cohort entram no recorte a verificar nesta invocação. */
  count: number;
}

export interface MvOnDemandPlan {
  /**
   * Alvo bruto que motivou o recorte. Zero = plano vazio, nada a verificar.
   * NÃO É SEMPRE um déficit de fila literal: desde #4787, `buildWaveProposal`
   * chama `planMvOnDemand` com `Math.max(déficit de fila, cauda fria de uma
   * inversão de safra)` — este campo carrega o MAIOR dos dois, não uma das
   * duas fontes isoladamente. `renderWaveProposal` recompõe as duas partes
   * separadamente pra exibir o motivo real (ver seção "Verificação MV sob
   * demanda"); não assumir aqui que "deficit > 0" implica fila insuficiente.
   */
  deficit: number;
  /**
   * `deficit ÷ MV_ONDEMAND_APPROVAL_MARGIN`, arredondado pra cima — quantos
   * verificar pra cobrir o déficit mesmo perdendo ~10% pra rejeição/inconclusivo.
   */
  targetVerifyCount: number;
  /**
   * Alocação por cohort, na MESMA ordem de prioridade de
   * `compareCohortEntriesByRecency` (morno→frio por `created` real; degrada
   * pra `cohortSendRank` só quando nenhum lado comparado tem data confiável,
   * #5398). NUNCA a ordem por volume que `summarizeMvBacklog.byCohort` usa
   * pra exibição — a #4542 já corrigiu uma inversão dessa ordem (verificar
   * lead frio antes de um morno com backlog pendente); reordenar por volume
   * aqui reintroduziria a mesma classe de bug.
   *
   * (#5169/#5179, revisado #5398) Pra LEADS, essa ordem por recência já
   * espelha `segmentRampWarm` (clarice-segment.ts, ordena por
   * `compareContactRecency` — created real do contato). Continua sendo a
   * mesma comparação, a nível de cohort agregado em vez de contato
   * individual, então a divergência que existia quando este campo ainda
   * ordenava por `cohortSendRank` fixo (achado da revisão #5169 260812,
   * `ex-assinantes` podia ser tratado como "quente" por rank enquanto a fila
   * real já priorizava leads mais recentes) não se aplica mais.
   */
  byCohort: MvOnDemandAllocation[];
  /**
   * Soma de `byCohort` — pode ser MENOR que `targetVerifyCount` quando o
   * backlog disponível (já excluindo cohorts MV-isentos) não cobre o alvo.
   */
  totalPlanned: number;
  /**
   * `true` quando `totalPlanned < targetVerifyCount` — verificando TODO o
   * backlog disponível ainda não cobriria o déficit. Sinal pro gate: mesmo
   * rodando a verificação sob demanda, a onda pode continuar bloqueada.
   */
  backlogInsufficient: boolean;
  estimatedCostUsd: number;
}

const EMPTY_MV_ONDEMAND_PLAN: MvOnDemandPlan = {
  deficit: 0,
  targetVerifyCount: 0,
  byCohort: [],
  totalPlanned: 0,
  backlogInsufficient: false,
  estimatedCostUsd: 0,
};

/**
 * Monta o recorte MÍNIMO de verificação MV pra cobrir `deficit` — nunca o
 * backlog inteiro. Percorre `backlog.byCohort` na ordem de
 * `compareCohortEntriesByRecency` (morno→frio por recência real, #5398),
 * acumulando até `targetVerifyCount`; cohorts MV-isentos
 * (`isMvExemptCohort` — hoje só `assinantes-ativos`) NUNCA entram no plano —
 * defesa em profundidade: `summarizeMvBacklog` já não deveria contar um
 * cohort isento (`classifyEligibility` nunca atribui `mv_unverified` a ele,
 * clarice-db.ts), mas o filtro aqui torna essa garantia explícita e testável
 * sem depender de outro módulo se comportar certo (#4659, guard explícito da
 * issue: "NUNCA verificar assinantes-ativos").
 *
 * `deficit <= 0` devolve o plano vazio sem tocar `backlog` — não há nada a
 * cobrir. Puro — nunca lê disco/rede; quem EXECUTA o plano (gasta crédito de
 * verdade) é `scripts/clarice-mv-ondemand.ts`, script separado e read+write
 * por construção, nunca este planejador read-only.
 *
 * Também exclui a entrada `MV_BACKLOG_NO_COHORT_LABEL` (contatos sem cohort
 * conhecido) — não é um cohort EXECUTÁVEL: `readStoreCandidates` faz
 * `WHERE cohort = ?` com o valor exato, e essa string nunca bate uma linha
 * real (`cohort IS NULL`). Alocar orçamento pra ela produziria uma entrada no
 * plano que `clarice-mv-ondemand.ts` verificaria como ZERO candidatos —
 * gastando "espaço" do alvo sem cobrir déficit nenhum (achado do self-review,
 * #4659).
 */
export function planMvOnDemand(
  backlog: MvBacklog,
  deficit: number,
  approvalMargin: number = MV_ONDEMAND_APPROVAL_MARGIN,
): MvOnDemandPlan {
  if (deficit <= 0) return EMPTY_MV_ONDEMAND_PLAN;
  if (!(approvalMargin > 0) || approvalMargin > 1) {
    throw new Error(`approvalMargin inválido: ${approvalMargin} — esperado (0, 1].`);
  }

  const targetVerifyCount = Math.ceil(deficit / approvalMargin);

  const ordered = backlog.byCohort
    .filter((e) => !isMvExemptCohort(e.cohort) && e.cohort !== MV_BACKLOG_NO_COHORT_LABEL)
    .slice()
    .sort(compareCohortEntriesByRecency);

  const byCohort: MvOnDemandAllocation[] = [];
  let remaining = targetVerifyCount;
  for (const entry of ordered) {
    if (remaining <= 0) break;
    const count = Math.min(entry.count, remaining);
    if (count > 0) byCohort.push({ cohort: entry.cohort, count });
    remaining -= count;
  }

  const totalPlanned = byCohort.reduce((s, e) => s + e.count, 0);
  return {
    deficit,
    targetVerifyCount,
    byCohort,
    totalPlanned,
    backlogInsufficient: totalPlanned < targetVerifyCount,
    estimatedCostUsd: totalPlanned * MV_COST_PER_EMAIL_USD,
  };
}

// ---------------------------------------------------------------------------
// Não-abridor reincidente — a lacuna que o sunset (#4430) deixou aberta,
// fechada pelo #5041 (`shouldSunsetNonOpener` ligado em `classifyEligibility`,
// clarice-db.ts). Esta medição continua existindo pós-#5041 como canário.
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
 * sem implementação — o #5041 fechou essa lacuna (`shouldSunsetNonOpener`
 * agora ligado em `classifyEligibility`, clarice-db.ts, corte
 * `sunset_non_opener`). Só quem já foi excluído (`send_eligible=0`) por essa
 * razão SAI da contagem abaixo (o filtro `send_eligible !== 1` no topo do
 * loop já cuida disso) — num store recém-recomputado, esta função deve
 * tender a 0: ela vira canário operacional (acusa se um contato desse perfil
 * ainda está elegível — store desatualizado, ou uma regressão no corte).
 *
 * Reportar isso é o mínimo que dá pra fazer sem reabrir a decisão de produto:
 * é esse estoque que alimenta a reclamação de spam, que por sua vez faz
 * `decideSemaphore` FREAR o volume das ondas seguintes. O laço se fecha
 * contra o próprio alcance — antes do #5041, era invisível na hora de decidir
 * a onda; agora é o sinal de que o corte automático está fazendo o trabalho.
 *
 * #4688: só conta como não-abridor quem `hasMeasuredOpens` (já foi
 * sincronizado pela Brevo ao menos 1x) — sem isso, um contato nunca
 * sincronizado (`opens_count=0` só pelo `DEFAULT 0` do schema, nunca medido)
 * infla `count`/`fraction` artificialmente, o que por sua vez faz esta
 * medição SUPERESTIMAR a exposição real e — via `decideSemaphore`, que a
 * consome — pode frear volume de onda mais do que o comportamento real da
 * base justifica.
 *
 * #5399: exclui `mvExempt` (`isMvExemptCohort`) e `engaged`
 * (`priority_points > 0`) da contagem — são exatamente os DOIS overrides que
 * `classifyEligibility` (clarice-db.ts) já respeita ao decidir o corte de
 * sunset (`!mvExempt` é condição explícita; um engajado nunca bate o
 * predicado de não-abridor porque abriu algo em algum momento — mas
 * `priority_points > 0` também cobre engajamento por clique sem abertura
 * registrada, #4688 combinado). Sem esse filtro, os
 * `assinantes-ativos`/engajados MV-isentos por desenho apareciam como falso
 * positivo permanente do canário — medição ao vivo 16/08/2026: 750 contatos,
 * 100% `assinantes-ativos`, `sends_count=2`/`opens_count=0`, exatamente o
 * perfil que o sunset EXCLUI de propósito (ver docstring de
 * `classifyEligibility`). Depois do filtro, a contagem só sinaliza
 * não-abridor que o sunset DEVERIA ter cortado e não cortou.
 */
export function measureNonOpenerExposure(
  rows: Array<
    Pick<StoreRow, "send_eligible" | "sends_count" | "opens_count" | "brevo_modified_at"> &
      Partial<Pick<StoreRow, "cohort" | "priority_points">>
  >,
  minSends = 2,
): NonOpenerExposure {
  let eligible = 0;
  let count = 0;
  for (const r of rows) {
    if (r.send_eligible !== 1) continue;
    eligible += 1;
    if (isMvExemptCohort(r.cohort) || (r.priority_points ?? 0) > 0) continue;
    if ((r.sends_count ?? 0) >= minSends && (r.opens_count ?? 0) === 0 && hasMeasuredOpens(r))
      count += 1;
  }
  return { count, fraction: eligible > 0 ? count / eligible : 0, minSends };
}

// ---------------------------------------------------------------------------
// Frescor do /diaria-clarice-novos (#4664) — guard read-only contra montar a
// onda com o laço de cadastro novo defasado
// ---------------------------------------------------------------------------
//
// O Passo 4 de `.claude/skills/diaria-clarice-envio/SKILL.md` manda invocar
// `/diaria-clarice-novos` ANTES de fechar a proposta da onda — até #4664 isso
// era só prosa, nada verificava. Na primeira execução real (onda `d6-qui06`,
// 05/08/2026) o passo foi pulado: o último `novos` tinha rodado ~24h antes, e
// a onda saiu 99,3% leads frios de 2024, 0% cadastros recentes — porque
// cadastro novo entra com `cohortSendRank` 0 (frente da fila) e só chega lá
// se `novos` rodou antes da onda ser montada.
//
// Limiares CONFIRMADOS pelo editor no briefing overnight de 260806/07 (ver
// comentário na issue #4664): warning acima de 12h, blocker acima de 48h.

export const NOVOS_FRESHNESS_WARNING_HOURS = 12;
export const NOVOS_FRESHNESS_BLOCKER_HOURS = 48;

export type NovosFreshnessStatus = "fresh" | "warning" | "blocker" | "never-run";

/**
 * Union discriminada (não um `{status; lastRunAt: X | null; ageHours: X |
 * null}` solto): `"never-run"` é o ÚNICO estado sem idade — todo outro status
 * carrega `lastRunAt`/`ageHours` não-nulos por construção do tipo, não por
 * convenção que o caller precisa lembrar de checar. Evita a classe de bug
 * "status diz 'blocker' mas ageHours é null" — um estado que o TYPESCRIPT
 * agora rejeita, não só a lógica de quem consome.
 */
export type NovosFreshness =
  | { status: "never-run"; lastRunAt: null; ageHours: null }
  | { status: "fresh" | "warning" | "blocker"; lastRunAt: string; ageHours: number };

/**
 * Mede o frescor do último `/diaria-clarice-novos` a partir de `lastRunAt`
 * (lido de `novos-state.json` — `readNovosState().lastRunAt`, mais preciso e
 * autoritativo que mtime de arquivo: é o timestamp que a própria skill grava
 * no momento em que confirma a rodada, `clarice-novos-state.ts`). Pura —
 * `now` é sempre injetado, nunca `Date.now()` implícito.
 *
 * "Nunca rodou" (`lastRunAt` ausente/inválido) é um estado DISTINTO de
 * "rodou há muito tempo" (`status: "never-run"`, não apenas um `ageHours`
 * enorme) — critério de pronto explícito da #4664: o gate precisa dizer "isto
 * nunca aconteceu neste histórico", não computar uma idade sem sentido a
 * partir de um timestamp que não existe.
 */
export function measureNovosFreshness(
  lastRunAt: string | null | undefined,
  now: Date,
): NovosFreshness {
  if (!lastRunAt) return { status: "never-run", lastRunAt: null, ageHours: null };
  const ms = Date.parse(lastRunAt);
  if (!Number.isFinite(ms)) return { status: "never-run", lastRunAt: null, ageHours: null };
  const ageHours = (now.getTime() - ms) / (60 * 60 * 1000);
  if (ageHours > NOVOS_FRESHNESS_BLOCKER_HOURS) return { status: "blocker", lastRunAt, ageHours };
  if (ageHours > NOVOS_FRESHNESS_WARNING_HOURS) return { status: "warning", lastRunAt, ageHours };
  return { status: "fresh", lastRunAt, ageHours };
}

/** Descreve a idade em horas de forma legível ("2,3h", "51h"). */
function describeAgeHours(ageHours: number): string {
  return ageHours < 10 ? `${ageHours.toFixed(1)}h` : `${Math.round(ageHours)}h`;
}

// ---------------------------------------------------------------------------
// #5405 item 2/3 — corrige o aviso de frescor quando a ÚLTIMA tentativa do
// `novos` abortou (em vez de "nunca rodou"/"considere rodar", que descrevem
// esquecimento — não é isso), e reporta a fila represada na janela `novos`.
// ---------------------------------------------------------------------------

/** `novos-run-status.json` mais recente, só as partes que este módulo usa
 *  (evita importar `NovosRunStatusValue` inteiro pra este arquivo de tipos).
 *  #5922: só resta `other-error` — o guard D4 que produzia `semaphore-red`
 *  foi retirado do caminho `novos` no #5660, e o valor foi removido do enum
 *  em `clarice-novos-run-status.ts`. */
export interface NovosLastAbortInfo {
  status: "other-error";
  /** ISO — quando esta tentativa terminou (`checkedAt` de `last-novos-run-status.json`). */
  checkedAt: string;
  detail?: string;
}

/** #5405 item 3 — quantos cadastros estão na janela `novos` ainda sem envio,
 *  e desde quando o mais antigo deles espera. `count: 0` → fila vazia. */
export interface NovosPendingInfo {
  count: number;
  earliestCreatedIso: string | null;
}

/**
 * `lastRunAt` (novos-state.json) só avança em ENVIO CONFIRMADO — uma rodada
 * que aborta no semáforo nunca o toca. Por isso `abort.checkedAt` (que
 * avança em TODA tentativa, sucesso ou não) pode ser mais recente que
 * `lastRunAt` mesmo quando `freshness.status` ainda diz "fresh"/"warning" —
 * é exatamente esse gap que fazia o aviso ler "considere rodar" quando o
 * `novos` já tinha rodado e abortado (#5405, achado ao vivo 16/08).
 */
function isAbortMoreRecentThanLastRun(
  abort: NovosLastAbortInfo | null | undefined,
  freshness: NovosFreshness,
): abort is NovosLastAbortInfo {
  if (!abort) return false;
  if (freshness.status === "never-run") return true; // nenhum envio confirmado ainda — qualquer abort é "mais recente".
  const abortMs = Date.parse(abort.checkedAt);
  const lastRunMs = Date.parse(freshness.lastRunAt);
  if (!Number.isFinite(abortMs) || !Number.isFinite(lastRunMs)) return false;
  return abortMs > lastRunMs;
}

/** Sufixo "Fila represada: N cadastro(s) desde X." — vazio (fila vazia/dado
 *  indisponível) → string vazia, nunca um sufixo confuso "desde undefined". */
function describePendingSuffix(pending: NovosPendingInfo | null | undefined): string {
  if (!pending || pending.count <= 0) return "";
  return pending.earliestCreatedIso
    ? ` Fila represada: ${pending.count} cadastro(s) desde ${pending.earliestCreatedIso}.`
    : ` Fila represada: ${pending.count} cadastro(s).`;
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
  /**
   * #4787 — composição por cohort da MESMA fila que `availableFirstSend`
   * conta (`summarizeAvailableFirstSendByCohort`, ordenada morno→frio).
   * Existe pra tornar visível DE QUE SAFRA vem cada fatia da onda proposta —
   * `availableFirstSend` sozinho não distingue "fila cheia da safra certa" de
   * "fila cheia, mas pulando por cima de safra mais nova bloqueada no MV".
   */
  availableFirstSendByCohort: CohortComposition[];
  mvBacklog: MvBacklog;
  nonOpeners: NonOpenerExposure;
  /** Crédito Brevo restante no ciclo de cobrança. `null` = não consultado. */
  brevoCredits: number | null;
  /** Idade do dado do dashboard quando servido de cache. `null` = fresco. */
  staleNote: string | null;
  /** Índice do 1º dia da onda (continua a numeração do ciclo). */
  startingWaveNumber: number;
  /**
   * #6075 — override do volume-alvo pra fins de MV sob demanda, quando
   * `--volume N` (editor) é MAIOR que o volume que a política propôs
   * (`volumes.total`). Sem isto, `mvOnDemandPlan` é sempre dimensionado
   * contra `volumes.total` — quando o editor pede mais do que a política
   * escolheria e a fila cobre o volume da política mas não o pedido, o
   * plano de MV sob demanda sai VAZIO e o guard de `clarice-envio-run.ts`
   * nunca dispara a verificação (achado ao vivo 260824/25, onda d28).
   * `undefined`, ou `<= volumes.total`, não muda nada — só entra em jogo
   * quando é estritamente maior. Afeta SÓ o dimensionamento de
   * `mvOnDemandPlan` (déficit/`targetVerifyCount`/`byCohort`) — os
   * `blockers`/`consumedByCohort` continuam contra `volumes.total`, porque
   * é o volume que ESTA proposta (sem `--volume`) de fato executaria;
   * `clarice-envio-run.ts` já tem seu próprio guard de fila contra
   * `desiredVolume` (linha ~1066), separado deste.
   */
  targetVolume?: number;
  /**
   * #5140 — horas BRT do teste de HORÁRIO, quando ATIVO
   * (`data/clarice-hour-test.json`). `undefined`/vazio = sem teste, e a
   * proposta sai como sempre.
   *
   * Existe pra que a PRÉVIA não minta: sem isto, `buildWaveProposal` derivava
   * as chaves só de `abc.action` e, num dia com o teste ligado, mostraria
   * "1 lista" enquanto a execução criaria 2 campanhas em 2 horários. É a
   * mesma classe do #5025 ("`renderWaveProposal` mostra todo valor que vira
   * escrita na Brevo", mas o assunto nunca aparecia ali) — o editor aprova
   * lendo esta prévia.
   *
   * Ignorado quando o A/B/C de assunto NÃO está travado, espelhando o guard
   * de dimensão única de `clarice-envio-run.ts`.
   */
  hourCellsBrt?: number[];
  /**
   * `true` quando a consulta de campanhas comprometidas (`queued` ∪ `sent`)
   * FALHOU. Vira bloqueio, nunca aviso: `fetchCommittedCampaignListIds` é
   * documentada pra "falhar alto" justamente porque, sem ela, o set de
   * exclusão fica vazio e a fila disponível é SUPERESTIMADA — o caminho do
   * #3682, que reenviou 100% pra quem já tinha recebido.
   */
  committedLookupFailed: boolean;
  /** #4664 — frescor do último `/diaria-clarice-novos`. Ver seção acima. */
  novosFreshness: NovosFreshness;
  /** #5405 item 2 — desfecho da ÚLTIMA tentativa (`last-novos-run-status.json`),
   *  só quando foi um ABORT (`sent`/`empty`/`uncertain` não mudam o texto de
   *  frescor). `undefined`/`null` → comportamento pré-#5405 (sem override). */
  novosLastAbort?: NovosLastAbortInfo | null;
  /** #5405 item 3 — fila represada na janela `novos`. `undefined`/`null` →
   *  omitido dos textos (fail-soft, mesmo padrão do resto do módulo). */
  novosPending?: NovosPendingInfo | null;
}

/**
 * Marca de proveniência: só `buildWaveProposal` a produz. Impede que outro
 * call site monte `{ ...input, blockers: [] }` à mão e passe no typecheck
 * pulando toda a computação de segurança — um `blockers: []` forjado é
 * indistinguível de um "tudo certo" real (achado do review de tipos, #4658).
 */
declare const WAVE_PROPOSAL_BRAND: unique symbol;

export interface WaveProposal extends WaveProposalInput {
  waves: PlannedWave[];
  /** Bloqueios que impedem o agendamento. Não-vazio = não apresentar `sim`. */
  blockers: string[];
  /** Avisos que não impedem, mas o editor precisa ver antes de confirmar. */
  warnings: string[];
  /**
   * #4659 — recorte de verificação MV sob demanda que cobriria o déficit
   * DESTA proposta (`computeFirstSendDeficit` + `planMvOnDemand`). Vazio
   * (`byCohort: []`) quando não há déficit. Só COMPUTA — quem gasta crédito
   * de verdade é `scripts/clarice-mv-ondemand.ts`, nunca este planejador.
   */
  mvOnDemandPlan: MvOnDemandPlan;
  /**
   * #4787 — composição por cohort que a onda proposta EFETIVAMENTE
   * consumiria (`sliceCohortComposition` sobre `availableFirstSendByCohort`,
   * cortado em `volumes.total`). Renderizado como uma linha por cohort na
   * proposta — é o dado que faz o salto de safra ficar visível a olho nu.
   */
  consumedByCohort: CohortComposition[];
  /**
   * #4787 — `null` quando a onda não pula nenhuma safra mais nova bloqueada
   * no MillionVerifier; caso contrário, o cohort bloqueado + a cauda fria que
   * ele substituiria. Ver `detectCohortInversion`.
   */
  cohortInversion: CohortInversion | null;
  /** Ver `WAVE_PROPOSAL_BRAND`. Não construir à mão. */
  readonly [WAVE_PROPOSAL_BRAND]: true;
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
  // `perDay` tem que cobrir todo dia pedido. Antes isto caía num `?? 0`
  // silencioso — uma onda de volume ZERO renderizada como se fosse plano
  // legítimo. Lançar é o certo: é erro de programação do chamador, não
  // estado do mundo (achado do review de testes, #4658).
  if (input.volumes.perDay.length !== input.dates.length) {
    throw new Error(
      `volumes.perDay (${input.volumes.perDay.length}) não cobre dates (${input.dates.length}) — ` +
        `proposta inconsistente, nunca preencher volume que faltou com 0.`,
    );
  }

  const withCells = input.abc.action !== "travar";
  // #5140: o teste de HORÁRIO só vale com o de assunto travado — mesma
  // pré-condição que `clarice-envio-run.ts` aplica na execução. Replicada
  // aqui de propósito: se a PRÉVIA e a EXECUÇÃO discordassem sobre quantas
  // listas saem, a prévia viraria exatamente o tipo de mentira que o #5025
  // corrigiu (o editor aprova lendo isto).
  const hourCells = !withCells && input.hourCellsBrt && input.hourCellsBrt.length >= 2
    ? input.hourCellsBrt
    : null;
  const waves: PlannedWave[] = input.dates.map((date, i) => {
    const n = input.startingWaveNumber + i;
    const keys = hourCells
      ? hourCells.map((h) => waveKey(n, date, hourCellLabel(h)))
      : withCells
        ? (["A", "B", "C"] as const).map((cell) => waveKey(n, date, cell))
        : [waveKey(n, date)];
    return { n, date, scheduledAt: scheduledAtForDate(date), volume: input.volumes.perDay[i], keys };
  });

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (input.committedLookupFailed) {
    blockers.push(
      "Consulta de campanhas comprometidas (queued/sent) FALHOU — sem ela a fila disponível é superestimada e " +
        "quem já está agendado pode receber de novo (#3682). `fetchCommittedCampaignListIds` é documentada pra falhar alto; " +
        "não agendar até a consulta voltar.",
    );
  }

  // #4664: frescor do /diaria-clarice-novos. "Nunca rodou" e "blocker" viram
  // BLOQUEIO (a chance de haver assinante novo esperando é alta o bastante
  // pra reverter a prioridade editorial em silêncio, ver docstring da seção
  // acima); "warning" é aviso — o editor pesa. Read-only por construção: este
  // guard só DETECTA e REPORTA, nunca invoca a skill sozinho.
  // #5405 item 2: a ÚLTIMA tentativa pode ter ABORTADO (semáforo vermelho,
  // D4, ou outro motivo) sem nunca ter chegado a confirmar envio — nesse
  // caso o texto abaixo NÃO deve ler como "esqueceu de rodar"
  // ("nunca rodou"/"considere rodar"), porque rodou; só não conseguiu
  // enviar. `pendingSuffix` (#5405 item 3) mostra a fila represada.
  const pendingSuffix = describePendingSuffix(input.novosPending);

  if (isAbortMoreRecentThanLastRun(input.novosLastAbort, input.novosFreshness)) {
    // #5922: `semaphore-red` não existe mais (guard D4 saiu do caminho
    // `novos` no #5660) — todo abort registrável é estrutural. O texto antigo
    // mandava "destravar o semáforo", instrução que não tem mais alvo.
    blockers.push(
      `/diaria-clarice-novos rodou mas ABORTOU — última tentativa não confirmou nenhum envio (motivo: erro estrutural).` +
        pendingSuffix +
        " Resolva o motivo do abort antes de montar esta onda — cadastro novo continua " +
        "esperando o /diaria-clarice-novos, não a rampa (#5410); ver o relatório mais recente em " +
        "data/clarice-subscribers/novos-reports/*-abort.md (#5405).",
    );
  } else if (input.novosFreshness.status === "never-run") {
    blockers.push(
      "/diaria-clarice-novos nunca rodou neste histórico — nenhum cadastro recente foi processado. " +
        "A onda pode sair 100% leads frios sem que assinante novo receba a prioridade que o fluxo garante (#4664). " +
        "Rode /diaria-clarice-novos antes de montar esta onda.",
    );
  } else if (input.novosFreshness.status === "blocker") {
    blockers.push(
      `/diaria-clarice-novos rodou há ${describeAgeHours(input.novosFreshness.ageHours)} ` +
        `(acima do limiar de ${NOVOS_FRESHNESS_BLOCKER_HOURS}h) — cadastro novo pode estar esperando na fila com ` +
        `prioridade invertida (caso real: onda d6-qui06, 05/08, saiu 99,3% leads frios de 2024, #4664).` +
        pendingSuffix +
        " Rode /diaria-clarice-novos antes de montar esta onda.",
    );
  } else if (input.novosFreshness.status === "warning") {
    warnings.push(
      `/diaria-clarice-novos rodou há ${describeAgeHours(input.novosFreshness.ageHours)} ` +
        `(acima do limiar de ${NOVOS_FRESHNESS_WARNING_HOURS}h, abaixo do bloqueio de ${NOVOS_FRESHNESS_BLOCKER_HOURS}h) — ` +
        "considere rodar antes de montar esta onda (#4664).",
    );
  }

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
  // #4787: composição por safra da fila que ESTA onda consumiria — usada
  // tanto pra render (`consumedByCohort`) quanto pro gatilho proativo de
  // inversão abaixo.
  const consumedByCohort = sliceCohortComposition(input.availableFirstSendByCohort, input.volumes.total);
  const cohortInversion = detectCohortInversion(consumedByCohort, input.mvBacklog);

  // #6075 — o déficit que dimensiona o MV sob demanda usa `targetVolume`
  // (o `--volume N` do editor) quando ele é MAIOR que `volumes.total` (o
  // volume que a política teria proposto sozinha). Sem isto, um `--volume`
  // acima da política com fila que já cobre `volumes.total` (mas não o
  // pedido) zera `firstSendDeficit` e `mvOnDemandPlan.byCohort` sai vazio —
  // o guard de `clarice-envio-run.ts` nunca roda a verificação sob demanda.
  const mvDeficitTargetVolume =
    input.targetVolume !== undefined && input.targetVolume > input.volumes.total
      ? input.targetVolume
      : input.volumes.total;
  const firstSendDeficit = computeFirstSendDeficit(input.availableFirstSend, mvDeficitTargetVolume);
  // #4787: o alvo de verificação cobre o MAIOR entre (a) o déficit de fila
  // tradicional e (b) a cauda fria que uma inversão de safra tornaria
  // substituível — os dois usam a MESMA máquina (`planMvOnDemand`, que já
  // aloca morno→frio primeiro), então dimensionar pelo maior dos dois nunca
  // sub-cobre o menor. Isso é o que faz o plano disparar MESMO SEM déficit
  // total (a fila "cheia" da safra errada, caso real da issue).
  const proactiveMvTarget = cohortInversion?.coldTailCount ?? 0;
  const mvOnDemandPlan = planMvOnDemand(input.mvBacklog, Math.max(firstSendDeficit, proactiveMvTarget));
  if (input.availableFirstSend < input.volumes.total) {
    blockers.push(
      `Fila de 1º envio (${fmt(input.availableFirstSend)}) é menor que o volume proposto (${fmt(input.volumes.total)}) — as últimas ondas sairiam menores que o planejado ou puxariam público de outra natureza.` +
        (mvOnDemandPlan.byCohort.length > 0
          ? ` Verificação MV sob demanda ${mvOnDemandPlan.backlogInsufficient ? "reduziria (mas NÃO cobre inteiramente)" : "cobriria"}: ${fmt(mvOnDemandPlan.totalPlanned)} de ${fmt(mvOnDemandPlan.targetVerifyCount)} contato(s) alvo, em ${mvOnDemandPlan.byCohort.length} cohort(s) (~US$ ${mvOnDemandPlan.estimatedCostUsd.toFixed(2)}) — ver seção "Verificação MV sob demanda" abaixo.`
          : ` Backlog MV (${fmt(input.mvBacklog.total)} contatos, excluindo cohorts MV-isentos) não tem candidato pra cobrir o déficit — a alavanca de fila não está disponível aqui.`),
    );
  }
  if (input.brevoCredits === null) {
    blockers.push("Crédito Brevo não consultado — nunca agendar sem validar o crédito ANTES (evita agendar uma onda que falha por falta de crédito e exige cancelar/recriar, #4935).");
  }
  // #4787: gatilho PROATIVO — dispara mesmo sem déficit de fila total.
  // Diferente do blocker de déficit acima (que é sobre VOLUME), isto é sobre
  // ORDEM: a fila pode cobrir o volume pedido inteiro e ainda assim pular por
  // cima de uma safra mais nova bloqueada no MV, porque `mvOnDemandPlan` só
  // disparava por déficit total antes deste guard (#4787, caso real: onda de
  // 09/08 do 2607-08 pulou de leads-2024h2 direto pra leads-2022h1/2021h2).
  if (cohortInversion) {
    warnings.push(
      `Inversão de safra (#4787): a onda consumiria ${fmt(cohortInversion.coldTailCount)} contato(s) de ` +
        `${cohortDisplayLabel(cohortInversion.coldestConsumedCohort)} (mais FRIO) enquanto ` +
        `${cohortDisplayLabel(cohortInversion.blockedCohort)} (mais NOVO/morno) está bloqueado em mv_unverified no ` +
        `MillionVerifier — a ordem "mais novo primeiro" por recência real (\`compareCohortEntriesByRecency\`) não está sendo honrada. ` +
        `Verificação MV sob demanda dimensionada pra cobrir a diferença — ver seção "Verificação MV sob demanda" abaixo.`,
    );
  }

  if (input.staleNote) {
    warnings.push(`Dashboard serviu dado de CACHE — ${input.staleNote}. A proposta abaixo foi decidida sobre esse dado.`);
  }
  if (input.state.scheduledCount > 0) {
    warnings.push(
      `${input.state.scheduledCount} campanha(s) deste ciclo ainda AGENDADA(s) e não disparada(s) — desfazer exige cancelar via API/painel Brevo e recriar (#4935), e seus destinatários já estão fixados até alguém agir.`,
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
      `${fmt(input.nonOpeners.count)} contatos elegíveis (${(input.nonOpeners.fraction * 100).toFixed(1)}% da base elegível) já receberam ${input.nonOpeners.minSends}+ envios sem NUNCA abrir — o sunset (#5041) deveria ter cortado esses contatos da elegibilidade; se ainda aparecem aqui, o store pode estar desatualizado (rode clarice-build-db.ts) ou são exceções legítimas (ex: assinante-ativo, isento). Enquanto isso não for investigado, eles continuam voltando pra fila a cada onda e alimentando a reclamação de spam que depois freia o volume.`,
    );
  }
  if (input.state.unscopedCount > 0) {
    warnings.push(
      `${input.state.unscopedCount} campanha(s) com naming 'grupo:' foram EXCLUÍDAS do resumo por não ter metadado de lista ` +
        `(a lista é a única fonte do ciclo mensal). O quadro "já enviado" e a numeração da onda podem estar incompletos — ` +
        `confira no painel da Brevo antes de confirmar.`,
    );
  }
  for (const c of input.abc.caveats) warnings.push(`Teste A/B/C: ${c}`);

  return { ...input, waves, blockers, warnings, mvOnDemandPlan, consumedByCohort, cohortInversion } as WaveProposal;
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

  L.push("── /diaria-clarice-novos ──");
  if (isAbortMoreRecentThanLastRun(p.novosLastAbort, p.novosFreshness)) {
    // #5922: só existe um motivo de abort registrável (`other-error`) desde
    // que o guard D4 saiu do caminho `novos` (#5660) — o texto fixo substitui
    // o ternário que distinguia `semaphore-red`.
    L.push(`  ⛔ ABORTOU (erro estrutural) em ${p.novosLastAbort.checkedAt} — nenhum envio confirmado desde então (#5405).`);
  } else if (p.novosFreshness.status === "never-run") {
    L.push("  Nunca rodou neste histórico — nenhum registro de execução encontrado.");
  } else {
    const STATUS_ICON: Record<NovosFreshnessStatus, string> = {
      fresh: "✓",
      warning: "⚠️ ",
      blocker: "⛔",
      "never-run": "⛔",
    };
    L.push(
      `  ${STATUS_ICON[p.novosFreshness.status]} Última execução: ${p.novosFreshness.lastRunAt} ` +
        `(${describeAgeHours(p.novosFreshness.ageHours)} atrás)`,
    );
  }
  if (p.novosPending && p.novosPending.count > 0) {
    L.push(
      `  Fila represada: ${fmt(p.novosPending.count)} cadastro(s)` +
        (p.novosPending.earliestCreatedIso ? ` desde ${p.novosPending.earliestCreatedIso}.` : "."),
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
  // #4974: quando o PICO por campanha governa `ratePct` (Math.max de
  // `resolveSpamSignal` escolheu o pico, não a média de domínio),
  // `worstCampaignDaysWithData` leva a cobertura da janela até esta tela —
  // sem isso, um pico sustentado pela janela inteira ficava indistinguível
  // de um artefato de 1 dia isolado na única superfície onde o editor
  // confirma o envio. Decisão do editor (opção 3 da issue): sem piso de
  // cobertura no pico — o semáforo continua disparando com 1 dia — mas a
  // cobertura fica visível ao lado do número.
  const spamCoverageNote =
    p.volumes.spamSignal.source === "postmaster" && typeof p.volumes.spamSignal.worstCampaignDaysWithData === "number"
      ? ` (pico de campanha, ${p.volumes.spamSignal.worstCampaignDaysWithData} dia(s) com dado)`
      : "";
  L.push(
    `  Spam (Postmaster): ${p.volumes.spamSignal.source === "indeterminate" ? "indeterminado — o semáforo nunca fica verde às cegas" : `${p.volumes.spamSignal.ratePct?.toFixed(3)}%${p.volumes.spamSignal.breach ? " — BREAKER ESTOURADO" : ""}${spamCoverageNote}`}`,
  );
  L.push("");

  L.push("── Onda proposta ──");
  for (const w of p.waves) {
    // #5140: com teste de horário a onda NÃO tem um horário só — dizer
    // "06:00 BRT" no cabeçalho seria falso justamente na linha que o editor
    // usa pra conferir quando o envio sai. Nesse caso o horário migra pra
    // linha de cada lista, onde ele de fato varia.
    const hourCellKeys = w.keys.filter((k) => /-H\d{2}$/.test(k));
    const header = hourCellKeys.length > 0
      ? `  d${w.n} · ${w.date} · ${fmt(w.volume)} contatos · TESTE DE HORÁRIO (#5140)`
      : `  d${w.n} · ${w.date} 06:00 BRT · ${fmt(w.volume)} contatos`;
    L.push(header);
    for (const k of w.keys) {
      const abc = k.match(/-([ABC])$/);
      const hour = k.match(/-H(\d{2})$/);
      const anota = abc ? ` — célula ${abc[1]}` : hour ? ` — hora ${hour[1]}:00 BRT` : "";
      L.push(`       lista: Clarice ${p.cycle} ${k}${anota}`);
    }
  }
  L.push(`  TOTAL: ${fmt(p.volumes.total)} contatos em ${p.waves.length} dia(s)`);
  if (p.brevoCredits !== null) {
    L.push(`  Crédito Brevo: ${fmt(p.brevoCredits)} → sobraria ${fmt(p.brevoCredits - p.volumes.total)}`);
  }
  L.push(`  Fila de 1º envio disponível: ${fmt(p.availableFirstSend)}`);
  L.push("");

  // #4787: de QUE cohort/safra vem cada fatia da onda — o dado que faltava
  // pra um salto de safra (fila "cheia" mas cheia da safra errada) ficar
  // visível a olho nu, sem precisar cruzar `availableFirstSend` com o store.
  L.push("── Composição da fila consumida, por safra (#4787) ──");
  if (p.consumedByCohort.length === 0) {
    L.push("  (sem dado de composição — fila disponível vazia ou volume proposto zero)");
  } else {
    for (const c of p.consumedByCohort) {
      L.push(`  ${cohortDisplayLabel(c.cohort).padEnd(28)} ${fmt(c.count)} contato(s)`);
    }
  }
  L.push("");

  if (p.mvOnDemandPlan.byCohort.length > 0) {
    L.push("── Verificação MV sob demanda (#4659) ──");
    // #4787: `mvOnDemandPlan.deficit` agora é o MAIOR entre o déficit de fila
    // tradicional e a cauda fria de uma inversão de safra (ver buildWaveProposal)
    // — "Déficit X" sozinho ficaria enganoso quando o disparo é só por
    // inversão (fila cobre o volume inteiro, não há déficit real nenhum).
    // Recomputa os dois aqui (puro, barato) só pra render, sem inflar o
    // shape de WaveProposal com um campo cuja única serventia é esta linha.
    // #6081: o déficit de fila do render usa a MESMA base que o
    // `buildWaveProposal` usou (`mvDeficitTargetVolume` = targetVolume quando
    // maior que volumes.total, #6075) — recomputar só contra `volumes.total`
    // fazia o cenário exato do #6075 (fila cobre a política mas não o --volume
    // pedido) sair com déficit 0 e cair no ramo de "inversão de safra",
    // imprimindo um motivo falso na tela de aprovação humana.
    const renderTargetVolume =
      p.targetVolume !== undefined && p.targetVolume > p.volumes.total ? p.targetVolume : p.volumes.total;
    const queueDeficit = computeFirstSendDeficit(p.availableFirstSend, renderTargetVolume);
    const inversionTail = p.cohortInversion?.coldTailCount ?? 0;
    const volumeDriven = p.targetVolume !== undefined && p.targetVolume > p.volumes.total;
    const reason =
      queueDeficit > 0 && inversionTail > 0
        ? `déficit de fila (${fmt(queueDeficit)}) + inversão de safra (${fmt(inversionTail)}) — alvo pelo MAIOR dos dois`
        : queueDeficit > 0 && volumeDriven
          ? `déficit de fila contra --volume ${fmt(p.targetVolume ?? 0)} (${fmt(queueDeficit)}) — fila cobre a política (${fmt(p.volumes.total)}) mas não o volume pedido pelo editor`
          : queueDeficit > 0
            ? `déficit de fila: ${fmt(queueDeficit)}`
            : `inversão de safra (fila cobre o volume, sem déficit real): ${fmt(inversionTail)}`;
    L.push(
      `  Motivo: ${reason} → alvo de verificação ${fmt(p.mvOnDemandPlan.targetVerifyCount)} (margem ${(MV_ONDEMAND_APPROVAL_MARGIN * 100).toFixed(0)}%)`,
    );
    for (const a of p.mvOnDemandPlan.byCohort) {
      L.push(`    ${cohortDisplayLabel(a.cohort).padEnd(28)} ${fmt(a.count)} contato(s)`);
    }
    L.push(`  Custo estimado: ~US$ ${p.mvOnDemandPlan.estimatedCostUsd.toFixed(2)}`);
    if (p.mvOnDemandPlan.backlogInsufficient) {
      L.push("  ⚠️  Backlog insuficiente pra cobrir o alvo mesmo verificando tudo disponível.");
    }
    L.push(`  Rodar: npx tsx scripts/clarice-mv-ondemand.ts --cycle ${p.cycle} --dates ${p.dates.join(",")}`);
    L.push("  (depois: npx tsx scripts/clarice-build-db.ts — reingerir o store antes de recompor a proposta, #4362)");
    L.push("");
  }

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
