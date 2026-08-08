/**
 * cohort-engagement.ts (#4464)
 *
 * Script de análise read-only: mede LEITORES (não só cadastros) por origem de
 * aquisição (`utm_source`, com `referring_site` como fallback), usando a API
 * v2 da Beehiiv com `expand[]=stats`.
 *
 *   GET /publications/{pub}/subscriptions?expand[]=stats&expand[]=utm_params&limit=100&page=N
 *   → data[].stats = { total_sent, total_received, total_unique_opened,
 *                       total_clicked, total_unique_clicked, open_rate, click_rate }
 *
 * `open_rate` vem da Beehiiv em escala 0-100 (percentual), não fração 0-1 —
 * daí o default de `--threshold` ser 40 (= 40%), comparável direto.
 *
 * O plano de aquisição de 29/jul registrou esse recorte como bloqueado (item
 * 12, "criar segmentos por referring_site"). Não está bloqueado: rodou ao
 * vivo em 02/08/2026, ~1 min para drenar 1.413 assinaturas, sem tocar em
 * segmento nenhum. Ver issue #4464 para o achado que motivou (Google Ads e
 * Beehiiv Boosts compraram base, não leitor).
 *
 * ## Uso
 *
 *   npx tsx scripts/cohort-engagement.ts
 *   npx tsx scripts/cohort-engagement.ts --threshold 50
 *   npx tsx scripts/cohort-engagement.ts --min-received 10
 *   npx tsx scripts/cohort-engagement.ts --since 2026-07-31
 *   npx tsx scripts/cohort-engagement.ts --since 2026-07-21 --until 2026-08-02
 *   npx tsx scripts/cohort-engagement.ts --json
 *
 * Flags:
 *   --threshold N     open_rate mínimo (0-100) para contar como "leitor". Default 40.
 *   --min-received N  refaz o corte de leitores/abertura/média só com ativos
 *                      cujo total_received >= N (amostra com histórico suficiente).
 *   --since AAAA-MM-DD Filtra assinantes por `created` (epoch, UTC) >= início do dia
 *                      informado (inclusivo). Ex: verificar a meta da #4295.
 *   --until AAAA-MM-DD Borda superior INCLUSIVA da mesma janela (#4556) — o dia
 *                      informado entra inteiro. Combinada com `--since`, isola uma
 *                      COORTE fechada. Sem ela, `--since` sozinho pega tudo daquele
 *                      dia pra frente e mistura quem chegou depois — que costuma ser
 *                      justamente o grupo de controle da comparação.
 *                      Ex: coorte da campanha de lançamento, `--since 2026-07-21
 *                      --until 2026-08-02` (checkpoint de retenção da #4556).
 *   --json            Emite o resultado como JSON (stdout) para uso em pipelines.
 *
 * ## Agrupamento
 *
 * Chave de grupo = `utm_source` normalizado; se ausente, cai para
 * `referring_site` normalizado (mesmo tratamento null/vazio → "__none__").
 *
 * ## Saída por grupo
 *
 *   cadastros           total de assinantes no grupo (todos os status, após --since)
 *   ativos / inativos / pending / invalid   contagem por status
 *   leitores            ativos com stats.open_rate >= threshold
 *   abertura_agregada   Σ total_unique_opened ÷ Σ total_received (fração 0-1) dos
 *                       ativos considerados (após --min-received, se houver)
 *   media_recebidas     média de total_received dos ativos considerados
 *   mediana_recebidas   mediana de total_received dos ativos considerados
 *   amostra_instavel    true se mediana_recebidas < 10 (poucas edições recebidas
 *                       → taxa não confiável)
 *   amostra_considerada quantos ativos entraram no denominador acima (depois do
 *                       corte de --min-received, se houver)
 *   pre_corte_considerado  quantos ativos TINHAM stats, antes do corte de
 *                       --min-received. Igual a amostra_considerada quando a flag
 *                       não foi passada. A diferença entre os dois é quantos o
 *                       piso cortou (#4752/#4757)
 *   amostra_vazia       true se amostra_considerada === 0 — o denominador está
 *                       vazio, que amostra_instavel NÃO sinaliza (mediana null
 *                       nunca é < 10). Mutuamente exclusivo com amostra_instavel
 *   amostra_pequena     true se 0 < amostra_considerada < 5 (#4761) — poucas
 *                       PESSOAS na amostra, sinal independente de
 *                       amostra_instavel (que mede a mediana de edições
 *                       RECEBIDAS por pessoa, não quantas pessoas há). 1
 *                       pessoa com mediana alta passa amostra_instavel=false
 *                       e amostra_vazia=false sem este campo — taxa de
 *                       abertura de N=1 fica indistinguível de N=300 na saída.
 *
 * Assinante sem `stats` (campo ausente na resposta) nunca conta como leitor e
 * é excluído do denominador de abertura_agregada/media/mediana — mas ainda
 * entra em cadastros/ativos (contagem de status independe de stats).
 *
 * Env:
 *   BEEHIIV_API_KEY           obrigatório
 *   BEEHIIV_PUBLICATION_ID    opcional — fallback p/ platform.config.json
 *   BEEHIIV_API_URL           opcional — override para tests
 *
 * Exit codes: 0=sucesso, 1=erro de API/truncamento, 2=config inválida, 3=args inválidos.
 */

import "dotenv/config";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";

const BEEHIIV_API = beehiivApiBase();
const PER_PAGE = 100;
const RATE_LIMIT_DELAY_MS = 300;
const MAX_RETRIES = 5;
const DEFAULT_THRESHOLD = 40;
const NEWLINE = "\n";
/**
 * Piso de `amostra_pequena` (#4761) — número de PESSOAS no denominador de
 * leitores/abertura/média abaixo do qual a taxa é indefensável mesmo com
 * `amostra_instavel` (mediana de edições recebidas) dizendo que está tudo
 * bem. N=5 é o candidato conservador da issue: pega os casos gritantes
 * (1 a 4 pessoas) sem marcar canais de cauda legítimos (N=10/N=30 dispararia
 * em vários grupos reais da base atual).
 */
const AMOSTRA_PEQUENA_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Subconjunto de `stats` que nos interessa (expand[]=stats). */
export interface SubscriberStats {
  total_sent?: number | null;
  total_received?: number | null;
  total_unique_opened?: number | null;
  total_clicked?: number | null;
  total_unique_clicked?: number | null;
  open_rate?: number | null;
  click_rate?: number | null;
}

/** Subscription com os campos que este script consome. */
export interface EngagementSubscriber {
  id?: string;
  status?: string | null;
  /** Epoch em segundos (UTC) — igual ao usado pela API Beehiiv. */
  created?: number | null;
  utm_source?: string | null;
  referring_site?: string | null;
  stats?: SubscriberStats | null;
}

export interface GroupEngagement {
  cadastros: number;
  ativos: number;
  inativos: number;
  pending: number;
  invalid: number;
  /** Outros status (ex: validating, paused, needs_attention) — não descartados silenciosamente. */
  outros_status: number;
  leitores: number;
  /** Fração 0-1, ou null se não há denominador (nenhum ativo considerado recebeu email). */
  abertura_agregada: number | null;
  media_recebidas: number | null;
  mediana_recebidas: number | null;
  amostra_instavel: boolean;
  /** Quantos ativos entraram no denominador de leitores/abertura/média (após --min-received). */
  amostra_considerada: number;
  /**
   * Quantos ativos TINHAM `stats`, ANTES do corte de `--min-received`. Igual a
   * `amostra_considerada` quando a flag não foi passada.
   *
   * Existe porque, sem ele, os dois caminhos que produzem `amostra_vazia`
   * geram saída idêntica e pedem ações opostas (achado do fleet review da PR
   * #4757): um grupo sem tracking de `stats` nenhum e um grupo cujos dados
   * existem mas ficaram abaixo do piso escolhido na linha de comando aparecem
   * os dois como `considerados: 0` + `⚠vazio`. Com este campo, a diferença
   * `pre_corte_considerado - amostra_considerada` diz quantos o piso cortou —
   * quem lê distingue "investigar por que não há stats" de "baixar o
   * --min-received", sem precisar re-rodar o script.
   */
  pre_corte_considerado: number;
  /**
   * true quando `amostra_considerada === 0` (#4752) — nenhum ativo elegível
   * entrou no denominador de leitores/abertura/média, seja porque o grupo não
   * tem nenhum ativo com `stats`, seja porque `--min-received` cortou todos.
   * Campo SEPARADO de `amostra_instavel` de propósito: aditivo, não muda o
   * significado de um campo já consumido em pipeline (opção 2 da issue).
   * `mediana_recebidas` é `null` nesse caso, o que fazia `amostra_instavel`
   * ficar `false` — o denominador zero (pior caso) parecia mais "normal" na
   * saída do que uma amostra de 1-9 (`⚠instável`).
   */
  amostra_vazia: boolean;
  /**
   * true quando `0 < amostra_considerada < AMOSTRA_PEQUENA_THRESHOLD` (#4761)
   * — poucas PESSOAS entraram no denominador, independente de
   * `amostra_instavel` (que mede a mediana de EDIÇÕES RECEBIDAS por pessoa,
   * não quantas pessoas há). O caso motivador: 1 pessoa que recebeu 12
   * edições produz `amostra_instavel: false` (12 >= 10) e
   * `amostra_vazia: false` (1 !== 0) — sem este campo, `abertura: 50,0%`
   * saía sem marcador nenhum, visualmente idêntica a uma linha com 300
   * pessoas na mesma taxa. Campo SEPARADO de `amostra_instavel` de propósito
   * (aditivo, mesma disciplina do `amostra_vazia` — #4752 rejeitou
   * redefinir campo já serializado em JSON). Sempre `false` quando
   * `amostra_vazia` é `true` (0 não é `> 0`) — não mutuamente exclusivo com
   * `amostra_instavel`, que pode coexistir (ex: 3 pessoas, mediana 3).
   */
  amostra_pequena: boolean;
}

export interface EngagementOptions {
  /** open_rate mínimo (escala 0-100) para contar como leitor. */
  threshold: number;
  /** Se definido, restringe leitores/abertura/média a ativos com total_received >= minReceived. */
  minReceived?: number;
}

/**
 * Janela FECHADA de cadastro. Campos nomeados em vez de dois `number | null`
 * posicionais de propósito (achado do fleet review da PR #4751): as duas bordas
 * têm semânticas diferentes — uma inclusiva, outra exclusiva — e posicionais
 * adjacentes do mesmo tipo são trocáveis sem o compilador reclamar. Mesmo shape
 * já usado por `AggregateOptions` em `scripts/aggregate-costs.ts`.
 */
export interface CohortWindow {
  /** Epoch em segundos do início do dia de `--since`. Inclusivo. `null` = sem borda inferior. */
  since: number | null;
  /** Epoch em segundos do início do dia SEGUINTE ao de `--until`. Exclusivo. `null` = sem borda superior. */
  untilExclusive: number | null;
}

export interface EngagementResult {
  groups: Record<string, GroupEngagement>;
  total_cadastros: number;
  threshold: number;
  min_received: number | null;
  /** Borda inferior INCLUSIVA da janela de cadastro, como o usuário passou. */
  since: string | null;
  /** Borda superior INCLUSIVA da janela de cadastro, como o usuário passou. #4556 */
  until: string | null;
  /**
   * Quantos assinantes foram descartados por não terem `created` quando alguma
   * borda de janela estava ativa (#4556). Sem este número, o viés que
   * `filterWindow` assume conscientemente ficava invisível — e ele pesa mais
   * justamente em janela estreita, que é o caso de uso que `--until` viabiliza.
   * `0` quando nenhuma borda foi informada.
   */
  excluded_missing_created: number;
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Helpers puros — normalização, agrupamento, estatística
// ---------------------------------------------------------------------------

/**
 * Normaliza um valor de atribuição (utm_source ou referring_site):
 * null/undefined/"" → "__none__"; qualquer outro valor → lowercase trimmed.
 *
 * @pure
 */
export function normalizeKey(raw: unknown): string {
  if (raw == null) return "__none__";
  const s = String(raw).trim().toLowerCase();
  return s === "" ? "__none__" : s;
}

/**
 * Resolve a chave de grupo de um assinante: `utm_source` normalizado; se
 * ausente (__none__), cai para `referring_site` normalizado.
 *
 * @pure
 */
export function resolveGroupKey(sub: Pick<EngagementSubscriber, "utm_source" | "referring_site">): string {
  const utm = normalizeKey(sub.utm_source);
  if (utm !== "__none__") return utm;
  return normalizeKey(sub.referring_site);
}

/**
 * Converte "AAAA-MM-DD" no epoch (segundos, UTC) do INÍCIO daquele dia.
 * Lança se o formato for inválido — CLI guard trata a mensagem.
 *
 * @pure
 */
function parseDayToEpochSeconds(day: string, flag: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) {
    throw new Error(`${flag} inválido: "${day}" (esperado AAAA-MM-DD)`);
  }
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
  // `Date.UTC` NÃO devolve NaN para mês/dia fora de faixa — ele ROLA
  // (Date.UTC(2026, 12, 45) = 2027-02-14). O regex aceita qualquer `\d{2}`,
  // então sem esta verificação de ida-e-volta `--since 2026-13-45` era aceito
  // em silêncio e media uma janela completamente diferente da pedida — e a
  // mensagem "data não existe" abaixo era inalcançável. Achado ao estender
  // este parser para `--until` (#4556).
  const dt = new Date(ms);
  if (
    dt.getUTCFullYear() !== Number(y) ||
    dt.getUTCMonth() !== Number(mo) - 1 ||
    dt.getUTCDate() !== Number(d)
  ) {
    throw new Error(`${flag} inválido: "${day}" (data não existe)`);
  }
  return Math.floor(ms / 1000);
}

/**
 * Converte "AAAA-MM-DD" no epoch (segundos, UTC) do INÍCIO daquele dia — borda
 * INFERIOR inclusiva da janela. Lança se o formato ou a data for inválida; o
 * CLI guard trata a mensagem. Ver `parseDayToEpochSeconds` para o porquê da
 * verificação de ida-e-volta.
 *
 * @pure
 */
export function parseSinceToEpochSeconds(since: string): number {
  return parseDayToEpochSeconds(since, "--since");
}

/**
 * Converte "AAAA-MM-DD" no epoch (segundos, UTC) que serve de limite
 * superior EXCLUSIVO — o início do dia SEGUINTE.
 *
 * A exclusividade é detalhe interno; a semântica exposta ao usuário é
 * inclusiva: `--until 2026-08-02` inclui o dia 02 inteiro, até 23:59:59 UTC.
 * Somar 86400 a uma meia-noite UTC é seguro por duas razões independentes: UTC
 * não tem horário de verão, e o Unix time em que `Date`/`Date.UTC` operam por
 * definição NUNCA representa segundo bissexto — todo dia do calendário tem
 * exatamente 86400 nesse modelo, aconteça o que acontecer no tempo real.
 *
 * @pure
 */
export function parseUntilToEpochSecondsExclusive(until: string): number {
  return parseDayToEpochSeconds(until, "--until") + 86_400;
}

/**
 * Filtra assinantes com `created` >= sinceEpochSeconds (inclusivo na borda).
 * Assinante sem `created` é excluído quando `sinceEpochSeconds` é informado —
 * não há como verificar a condição, e assumir presente enviesaria a métrica.
 *
 * @pure
 */
export function filterSince(
  subs: EngagementSubscriber[],
  sinceEpochSeconds: number | null,
): EngagementSubscriber[] {
  return filterWindow(subs, { since: sinceEpochSeconds, untilExclusive: null });
}

/**
 * Filtra assinantes por uma janela FECHADA de cadastro: `created` >= `since`
 * (inclusivo) e `created` < `untilExclusive`.
 *
 * Por que a janela fechada existe (#4556): com só `--since`, "a coorte de
 * lançamento 21/07–02/08" não é isolável — o recorte pega tudo de 21/07 pra
 * frente e mistura quem chegou depois, que é justamente o grupo de controle
 * contra o qual a coorte deveria ser comparada.
 *
 * Assinante sem `created` é excluído quando QUALQUER borda é informada — não
 * há como verificar a condição, e assumir presente enviesaria a métrica.
 *
 * @pure
 */
export function filterWindow(
  subs: EngagementSubscriber[],
  window: CohortWindow,
): EngagementSubscriber[] {
  const { since, untilExclusive } = window;
  if (since == null && untilExclusive == null) return subs;
  return subs.filter((s) => {
    if (typeof s.created !== "number") return false;
    if (since != null && s.created < since) return false;
    if (untilExclusive != null && s.created >= untilExclusive) return false;
    return true;
  });
}

/**
 * Quantos assinantes seriam descartados por falta de `created` sob esta janela.
 * Separado de `filterWindow` de propósito: o filtro devolve QUEM entra, este
 * conta QUEM SUMIU e por qual motivo — sem isso o viés fica invisível no output.
 *
 * @pure
 */
export function countMissingCreated(
  subs: EngagementSubscriber[],
  window: CohortWindow,
): number {
  if (window.since == null && window.untilExclusive == null) return 0;
  return subs.filter((s) => typeof s.created !== "number").length;
}

/**
 * Valida a janela ANTES de rodar. Devolve a mensagem de erro, ou `null` se a
 * janela é coerente.
 *
 * Extraída do bloco `isMainModule` (achado do fleet review da PR #4751): a
 * validação vivia inline e por isso não tinha teste nenhum — e é exatamente a
 * categoria que quebra em silêncio num refactor futuro (trocar `>=` por `>`
 * reabriria a janela de um único dia como erro).
 *
 * @pure
 */
export function resolveWindowGuardError(
  window: CohortWindow,
  labels: { since?: string | null; until?: string | null } = {},
): string | null {
  const { since, untilExclusive } = window;
  if (since == null || untilExclusive == null) return null;
  if (since >= untilExclusive) {
    return `janela inválida: --since ${labels.since ?? since} é depois de --until ${labels.until ?? untilExclusive}`;
  }
  return null;
}

/** Mediana de uma lista de números. Retorna null para lista vazia. @pure */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/** Média de uma lista de números. Retorna null para lista vazia. @pure */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Calcula as métricas de engajamento de UM grupo (assinantes já filtrados
 * pra essa origem). Contagens de status usam TODO o grupo; leitores/
 * abertura_agregada/media/mediana usam só os ATIVOS com `stats` presente
 * (e, se `minReceived` for informado, só os que atingem esse piso).
 *
 * @pure
 */
export function computeGroupEngagement(
  subsInGroup: EngagementSubscriber[],
  opts: EngagementOptions,
): GroupEngagement {
  let ativos = 0;
  let inativos = 0;
  let pending = 0;
  let invalid = 0;
  let outros_status = 0;

  const ativosComStats: Array<{ received: number; opened: number; open_rate: number | null }> = [];

  for (const sub of subsInGroup) {
    switch (sub.status) {
      case "active":
        ativos++;
        break;
      case "inactive":
        inativos++;
        break;
      case "pending":
        pending++;
        break;
      case "invalid":
        invalid++;
        break;
      default:
        outros_status++;
        break;
    }

    if (sub.status !== "active") continue;
    const stats = sub.stats;
    if (!stats) continue; // sem stats: conta em ativos acima, mas fora do denominador de engajamento

    const received = typeof stats.total_received === "number" ? stats.total_received : 0;
    const opened = typeof stats.total_unique_opened === "number" ? stats.total_unique_opened : 0;
    const openRate = typeof stats.open_rate === "number" ? stats.open_rate : null;
    ativosComStats.push({ received, opened, open_rate: openRate });
  }

  const considerados =
    opts.minReceived != null
      ? ativosComStats.filter((a) => a.received >= opts.minReceived!)
      : ativosComStats;

  const leitores = considerados.filter(
    (a) => a.open_rate != null && a.open_rate >= opts.threshold,
  ).length;

  const totalReceived = considerados.reduce((sum, a) => sum + a.received, 0);
  const totalOpened = considerados.reduce((sum, a) => sum + a.opened, 0);
  const abertura_agregada = totalReceived > 0 ? totalOpened / totalReceived : null;

  const receivedValues = considerados.map((a) => a.received);
  const media_recebidas = mean(receivedValues);
  const mediana_recebidas = median(receivedValues);
  const amostra_instavel = mediana_recebidas != null && mediana_recebidas < 10;
  const amostra_considerada = considerados.length;
  const pre_corte_considerado = ativosComStats.length;
  const amostra_vazia = amostra_considerada === 0;
  const amostra_pequena = amostra_considerada > 0 && amostra_considerada < AMOSTRA_PEQUENA_THRESHOLD;

  return {
    cadastros: subsInGroup.length,
    ativos,
    inativos,
    pending,
    invalid,
    outros_status,
    leitores,
    abertura_agregada,
    media_recebidas,
    mediana_recebidas,
    amostra_instavel,
    amostra_considerada,
    pre_corte_considerado,
    amostra_vazia,
    amostra_pequena,
  };
}

/**
 * Agrupa por `resolveGroupKey` e calcula `computeGroupEngagement` por grupo.
 *
 * @pure
 */
export function aggregateEngagement(
  subs: EngagementSubscriber[],
  opts: EngagementOptions,
): Record<string, GroupEngagement> {
  const byGroup = new Map<string, EngagementSubscriber[]>();
  for (const sub of subs) {
    const key = resolveGroupKey(sub);
    const arr = byGroup.get(key);
    if (arr) arr.push(sub);
    else byGroup.set(key, [sub]);
  }

  const out: Record<string, GroupEngagement> = {};
  for (const [key, group] of byGroup) {
    out[key] = computeGroupEngagement(group, opts);
  }
  return out;
}

/**
 * Formata o resultado agregado como tabela legível (stdout), ordenada por
 * `cadastros` decrescente — mesma convenção do script irmão.
 *
 * @pure
 */
/**
 * Rodapé com os parâmetros efetivamente aplicados. Extraído pra ser emitido
 * TAMBÉM no caminho de resultado vazio (#4751) — ver comentário lá.
 *
 * @pure
 */
function windowFooter(result: EngagementResult): string[] {
  const lines = [
    `TOTAL cadastros: ${result.total_cadastros}`,
    `threshold (open_rate >=): ${result.threshold}`,
  ];
  if (result.min_received != null) lines.push(`min-received: ${result.min_received}`);
  if (result.since != null) lines.push(`since: ${result.since}`);
  if (result.until != null) lines.push(`until: ${result.until}`);
  if (result.excluded_missing_created > 0) {
    lines.push(`descartados sem \`created\`: ${result.excluded_missing_created}`);
  }
  return lines;
}

export function formatEngagementTable(result: EngagementResult): string {
  const rows = Object.entries(result.groups).sort((a, b) => b[1].cadastros - a[1].cadastros);

  // Resultado vazio SEM ecoar a janela é indistinguível de "essa coorte não
  // existe" — e o caso comum é typo de mês (`--since 2026-06-21` no lugar de
  // `07`). No modo texto, que é o que o editor usa na mão, o rodapé era a única
  // pista e sumia junto. Achado do fleet review da PR #4751.
  if (rows.length === 0) {
    const vazio = ["(nenhum assinante encontrado)", ...windowFooter(result)];
    return vazio.join(NEWLINE);
  }

  const maxKeyLen = Math.max(...rows.map(([k]) => k.length), "origem".length);
  const header =
    `${"origem".padEnd(maxKeyLen)}  cadastros  ativos  inativos  pending  invalid  ` +
    `leitores  abertura%  media_recebidas  considerados`;
  const sep = "-".repeat(header.length);
  const lines = [header, sep];

  for (const [key, g] of rows) {
    const abertura = g.abertura_agregada != null ? `${(g.abertura_agregada * 100).toFixed(1)}%` : "n/a";
    const media = g.media_recebidas != null ? g.media_recebidas.toFixed(1) : "n/a";
    // #4752: amostra_vazia (considerados === 0) é o caso PIOR que amostra_instavel
    // (1-9 considerados) — mas antes só o segundo tinha marcador visual, o que
    // fazia o denominador vazio parecer mais "normal" que uma amostra pequena.
    // amostra_vazia é mutuamente exclusivo com os outros dois (mediana só é
    // != null e amostra_pequena só é true com >=1 considerado).
    //
    // O marcador de vazio diz QUAL dos dois caminhos produziu o zero (#4757):
    // sem esse detalhe, "não há stats nenhum neste grupo" e "--min-received
    // cortou todo mundo" saem byte-a-byte iguais — e pedem ações opostas
    // (investigar tracking vs. baixar o piso). O dado já estava em
    // `pre_corte_considerado`; só não chegava a quem lê.
    //
    // amostra_instavel (mediana de edições RECEBIDAS por pessoa) e
    // amostra_pequena (#4761 — quantas PESSOAS há) medem dimensões
    // diferentes e PODEM coexistir (ex: 3 pessoas, mediana 3) — por isso os
    // dois marcadores se acumulam em vez de se excluírem, ao contrário do
    // par vazio/instável.
    let flag = "";
    if (g.amostra_vazia) {
      flag = g.pre_corte_considerado > 0
        ? ` ⚠vazio(${g.pre_corte_considerado} cortados por --min-received)`
        : " ⚠vazio(sem stats)";
    } else {
      if (g.amostra_instavel) flag += " ⚠instável";
      if (g.amostra_pequena) flag += ` ⚠pequena(${g.amostra_considerada})`;
    }
    lines.push(
      `${key.padEnd(maxKeyLen)}  ${String(g.cadastros).padStart(9)}  ${String(g.ativos).padStart(6)}  ` +
        `${String(g.inativos).padStart(8)}  ${String(g.pending).padStart(7)}  ${String(g.invalid).padStart(7)}  ` +
        `${String(g.leitores).padStart(8)}  ${abertura.padStart(9)}  ${media.padStart(15)}  ` +
        `${String(g.amostra_considerada).padStart(12)}${flag}`,
    );
  }
  lines.push(sep);
  lines.push(...windowFooter(result));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTTP helpers (mesmo padrão do count-subscriptions-by-utm.ts / backup-beehiiv.ts)
// ---------------------------------------------------------------------------

interface FetchResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
}

interface Page<T> {
  data?: T[];
  total_results?: number;
  limit?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiFetch<T>(path: string, apiKey: string, retries = 0): Promise<FetchResult<T>> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetch(`${BEEHIIV_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });

  if (res.status === 429 && retries < MAX_RETRIES) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    const wait = Math.max(retryAfter * 1000, 30_000);
    process.stderr.write(
      `[cohort-engagement] rate-limited — esperando ${Math.round(wait / 1000)}s (tentativa ${retries + 1}/${MAX_RETRIES})\n`,
    );
    await sleep(wait);
    return apiFetch<T>(path, apiKey, retries + 1);
  }

  if (!res.ok) return { ok: false, status: res.status, body: null };
  return { ok: true, status: res.status, body: (await res.json()) as T };
}

/**
 * Drena TODAS as páginas de `/subscriptions?expand[]=stats&expand[]=utm_params`.
 * Mesmo guard anti-truncamento do `count-subscriptions-by-utm.ts` (#2457):
 * respeita `total_results` quando presente; se a API não o reportar, usa o
 * `limit` REPORTADO na página (não `PER_PAGE`) pra decidir se há mais.
 * Aborta com erro (nunca retorna contagem parcial) se a drenagem terminar
 * truncada.
 */
export async function fetchAllSubscribers(
  publicationId: string,
  apiKey: string,
): Promise<EngagementSubscriber[]> {
  const all: EngagementSubscriber[] = [];
  let page = 1;
  let more = true;
  let totalResults: number | null = null;

  while (more) {
    const path =
      `/publications/${publicationId}/subscriptions` +
      `?expand[]=stats&expand[]=utm_params&limit=${PER_PAGE}&page=${page}`;
    const res = await apiFetch<Page<EngagementSubscriber>>(path, apiKey);

    if (!res.ok) {
      throw new Error(`[cohort-engagement] Beehiiv API ${res.status} em subscriptions página ${page}`);
    }

    const body = res.body!;
    const chunk = body.data ?? [];
    all.push(...chunk);
    if (body.total_results != null) totalResults = body.total_results;

    if (chunk.length === 0) {
      more = false;
    } else if (totalResults != null) {
      more = all.length < totalResults;
    } else {
      const apiLimit = typeof body.limit === "number" && body.limit > 0 ? body.limit : PER_PAGE;
      more = chunk.length >= apiLimit;
    }

    process.stderr.write(
      `[cohort-engagement] página ${page}: ${chunk.length} subscriptions (${all.length}${totalResults != null ? `/${totalResults}` : ""} total)\n`,
    );
    page++;
  }

  // Guard anti-truncamento pós-loop: total_results reportado mas não drenado
  // por completo (página vazia mid-drain, hiccup) → truncamento silencioso →
  // falhar em vez de retornar contagem parcial autoritativa.
  if (totalResults != null && all.length < totalResults) {
    throw new Error(
      `[cohort-engagement] truncado: ${all.length}/${totalResults} subscriptions drenadas — contagem incompleta, abortando.`,
    );
  }

  return all;
}

/** Orquestra fetch + filtro da janela `--since`/`--until` + agregação. Não é `@pure` (I/O). */
export async function runCohortEngagement(
  publicationId: string,
  apiKey: string,
  opts: EngagementOptions & {
    sinceEpochSeconds?: number | null;
    sinceLabel?: string | null;
    untilEpochSecondsExclusive?: number | null;
    untilLabel?: string | null;
  },
): Promise<EngagementResult> {
  const all = await fetchAllSubscribers(publicationId, apiKey);
  const window: CohortWindow = {
    since: opts.sinceEpochSeconds ?? null,
    untilExclusive: opts.untilEpochSecondsExclusive ?? null,
  };
  const filtered = filterWindow(all, window);
  const groups = aggregateEngagement(filtered, opts);

  return {
    groups,
    total_cadastros: filtered.length,
    threshold: opts.threshold,
    min_received: opts.minReceived ?? null,
    since: opts.sinceLabel ?? null,
    until: opts.untilLabel ?? null,
    excluded_missing_created: countMissingCreated(all, window),
    fetched_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CLI guard
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const { flags, values } = parseArgs(argv);
  const jsonMode = flags.has("json");

  const thresholdRaw = values["threshold"];
  const threshold = thresholdRaw != null ? Number(thresholdRaw) : DEFAULT_THRESHOLD;
  if (Number.isNaN(threshold)) {
    process.stderr.write(`[cohort-engagement] --threshold inválido: "${thresholdRaw}"\n`);
    process.exit(3);
  }

  const minReceivedRaw = values["min-received"];
  let minReceived: number | undefined;
  if (minReceivedRaw != null) {
    minReceived = Number(minReceivedRaw);
    if (Number.isNaN(minReceived)) {
      process.stderr.write(`[cohort-engagement] --min-received inválido: "${minReceivedRaw}"\n`);
      process.exit(3);
    }
  }

  // `parseArgs` só grava em `values` quando o token seguinte não começa com
  // `--`; senão a flag cai em `flags` e vira booleana. Sem esta checagem,
  // `--since 2026-07-21 --until --json` roda como se `--until` nunca tivesse
  // sido passado: devolve a consulta CONTAMINADA que esta issue existe pra
  // evitar, com exit 0 e nenhuma mensagem. Num script de medição, esse é o pior
  // desfecho possível — alguém decide em cima de um número errado.
  // Achado do fleet review da PR #4751.
  for (const flag of ["since", "until", "threshold", "min-received"]) {
    if (flags.has(flag)) {
      process.stderr.write(
        `[cohort-engagement] --${flag} requer um valor (ex: --${flag} 2026-07-21)\n`,
      );
      process.exit(3);
    }
  }

  const sinceRaw = values["since"];
  let sinceEpochSeconds: number | null = null;
  if (sinceRaw != null) {
    try {
      sinceEpochSeconds = parseSinceToEpochSeconds(sinceRaw);
    } catch (e) {
      process.stderr.write(`[cohort-engagement] ${(e as Error).message}\n`);
      process.exit(3);
    }
  }

  const untilRaw = values["until"];
  let untilEpochSecondsExclusive: number | null = null;
  if (untilRaw != null) {
    try {
      untilEpochSecondsExclusive = parseUntilToEpochSecondsExclusive(untilRaw);
    } catch (e) {
      process.stderr.write(`[cohort-engagement] ${(e as Error).message}\n`);
      process.exit(3);
    }
  }

  // Janela invertida devolveria zero assinantes com exit 0 — resultado vazio
  // que parece uma coorte que não existe, em vez de um erro de digitação.
  const guardError = resolveWindowGuardError(
    { since: sinceEpochSeconds, untilExclusive: untilEpochSecondsExclusive },
    { since: sinceRaw, until: untilRaw },
  );
  if (guardError != null) {
    process.stderr.write(`[cohort-engagement] ${guardError}\n`);
    process.exit(3);
  }

  const cfg = loadBeehiivConfig("[cohort-engagement]");

  runCohortEngagement(cfg.publicationId, cfg.apiKey, {
    threshold,
    minReceived,
    sinceEpochSeconds,
    sinceLabel: sinceRaw ?? null,
    untilEpochSecondsExclusive,
    untilLabel: untilRaw ?? null,
  })
    .then((result) => {
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }
      process.stderr.write(`\n[cohort-engagement] Resultado (fetched_at=${result.fetched_at})\n\n`);
      process.stdout.write(formatEngagementTable(result) + "\n");
    })
    .catch((err) => {
      process.stderr.write(`[cohort-engagement] ERRO: ${String(err)}\n`);
      process.exit(1);
    });
}
