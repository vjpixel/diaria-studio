/**
 * cohort-retention.ts (#4556)
 *
 * Checkpoint de retenção da COORTE DE LANÇAMENTO (21/07–02/08/2026) contra a
 * base que já existia antes dela. Script de análise read-only.
 *
 * Responde a pergunta da #4556: a campanha fechou com 560 ativos contra meta
 * de ≥1000, e a leitura registrada na época foi "a base cresceu pouco, mas
 * quem chegou lê mais". Essa leitura valia pra base inteira no período, não
 * pra coorte — e nunca foi verificada. Se a coorte retiver e ler como a base
 * antiga, o resultado da campanha foi melhor do que a meta de volume sugere;
 * se ela evaporar, os líquidos da campanha eram menos do que pareciam.
 *
 * ## O que este script faz que `cohort-engagement.ts` não faz
 *
 * `cohort-engagement.ts` (#4464) agrupa por ORIGEM (`utm_source`) e recorta
 * por janela de cadastro (`--since`/`--until`, adicionados por esta mesma
 * issue). Ele responde "de onde veio quem lê". Só que a comparação que a
 * #4556 pede é outra: COORTE contra RESTO DA BASE, os dois lados saindo da
 * mesma leitura, com a mesma métrica e o mesmo recorte. Com `--since/--until`
 * sozinhos isso exige duas rodadas e uma subtração à mão — e a segunda rodada
 * não tem como expressar "todo mundo MENOS esta janela".
 *
 * Aqui a janela não filtra: ela PARTICIONA. Todo assinante cai em exatamente
 * um de três baldes, por `created`:
 *
 *   base_anterior  created <  --since            (o grupo de controle)
 *   coorte         --since <= created <= --until (a coorte de lançamento)
 *   pos_coorte     created >  --until            (quem chegou depois)
 *
 * `pos_coorte` é reportado SEPARADO e nunca somado ao controle — de
 * propósito. Misturar quem chegou depois com a base antiga é exatamente a
 * contaminação que a issue existe pra evitar: quem entrou em agosto é ainda
 * mais novo que a coorte, e diluiria o controle na direção que favorece a
 * conclusão que se quer testar.
 *
 * ## Métricas, e por que estas
 *
 * **Retenção** — `ativos ÷ (ativos + inativos)`. O denominador exclui
 * `pending` (nunca confirmou o opt-in — não chegou a entrar) e `invalid`
 * (e-mail ruim). Contar esses dois como "saída" mede qualidade de captura,
 * não retenção; contá-los como "base" afunda a taxa de qualquer coorte
 * adquirida por canal pago. Os quatro status saem no output em separado —
 * quem quiser outro denominador tem os números.
 *
 * **Abertura agregada** — `Σ total_unique_opened ÷ Σ total_received` sobre os
 * ativos considerados. Agregada por COORTE, não por edição: a issue chama a
 * atenção pra isso porque as duas dão números diferentes e já inverteram uma
 * conclusão antes (o comparativo de canais pagos de 02/ago corrigiu um
 * "coorte do Google abre acima da média" que virou 24,9% contra 35,8% quando
 * medido no critério certo).
 *
 * **CTR agregado** — `Σ total_unique_clicked ÷ Σ total_received`, calculado à
 * mão. NUNCA `stats.click_rate`, que é click-to-open (ver a armadilha
 * documentada em `scripts/lib/leitor.ts`).
 *
 * **Leitores-v1** — a unidade canônica do projeto desde o #5235
 * (`scripts/lib/leitor.ts`, `docs/definicao-leitor.md`): ativo, `>= 20`
 * recebidas, CTR real `>= 2%`. É o corte que decide se a coorte virou
 * audiência ou só cadastro.
 *
 * ## Comparabilidade — ler o bloco `comparabilidade` antes do delta
 *
 * As duas comparações deste script têm viés ESTRUTURAL conhecido, em direções
 * opostas, e nenhum dos dois é corrigível com o dado que a Beehiiv expõe.
 * O output carrega os dois como texto, sempre, pra que o número nunca
 * circule sozinho:
 *
 * 1. **Retenção compara exposições desiguais.** A coorte teve semanas pra
 *    sair; a base anterior teve meses ou anos. Retenção alta na coorte é em
 *    parte só idade. A correção seria sobrevivência em `t = N dias`, que
 *    exige a DATA de cada saída — a API não expõe (verificado ao vivo em
 *    17/08/2026: `/subscriptions` devolve `status` e `created`, nenhum
 *    campo de descadastro/desativação, com ou sem `expand[]=stats`).
 *
 * 2. **Engajamento compara início de vida contra vida inteira.** A coorte só
 *    tem as primeiras edições; a base tem a média de tudo, o próprio começo
 *    dela incluído e já decaído. Isso pende a favor da coorte. A correção
 *    seria medir a base nas PRIMEIRAS N recebidas dela — o dado é cumulativo
 *    por assinante, não uma série temporal, então também não é derivável.
 *    Os snapshots locais (`data/beehiiv-backup/`) só começam em 06/2026,
 *    quando a base antiga já passava de 100 edições recebidas — não dá pra
 *    reconstruir o início dela nem por aí.
 *
 * Ou seja: os dois vieses inflam a coorte. Um resultado em que a coorte NÃO
 * se destaca é forte; um em que ela se destaca pouco é fraco. Está no output.
 *
 * ## Maturidade da amostra
 *
 * `coorte_imatura` fica `true` enquanto a mediana de edições recebidas da
 * coorte não alcança o piso de `--min-received`. Enquanto for `true`, o corte
 * derruba quase todo mundo e a taxa que sobra é de um punhado de pessoas —
 * o motivo pelo qual o editor adiou a leitura desta issue duas vezes (comentários
 * de 11/08 e 14/08). O campo existe pra que essa decisão seja um número no
 * output, e não memória de sessão.
 *
 * ## Uso
 *
 *   npx tsx scripts/cohort-retention.ts
 *   npx tsx scripts/cohort-retention.ts --min-received 0        # sem corte
 *   npx tsx scripts/cohort-retention.ts --snapshot 2026-08-16
 *   npx tsx scripts/cohort-retention.ts --live --json
 *
 * Flags:
 *   --since AAAA-MM-DD  início INCLUSIVO da coorte. Default 2026-07-21.
 *   --until AAAA-MM-DD  fim INCLUSIVO da coorte (o dia entra inteiro).
 *                       Default 2026-08-02.
 *   --min-received N    piso de `total_received` pra entrar no denominador de
 *                       engajamento. Default 20 (o piso do leitor-v1). `0`
 *                       desliga o corte.
 *   --snapshot AAAA-MM-DD  lê este snapshot de `data/beehiiv-backup/` em vez do
 *                       mais recente.
 *   --live              busca da API Beehiiv em vez do snapshot local.
 *   --json              emite JSON em stdout.
 *
 * A fonte default é o snapshot local (`data/beehiiv-backup/`, gerado com
 * `expand[]=stats` desde o #5229) e não a API: o checkpoint é reproduzível,
 * não gasta chamada, e roda em sessão sem credencial. `--live` existe pra
 * quando o snapshot do dia ainda não rodou.
 *
 * Env (só com `--live`):
 *   BEEHIIV_API_KEY           obrigatório
 *   BEEHIIV_PUBLICATION_ID    opcional — fallback p/ platform.config.json
 *
 * Exit codes: 0=sucesso, 1=erro de leitura/API, 2=config inválida, 3=args inválidos.
 */

import "dotenv/config";
import { loadBeehiivConfig } from "./lib/beehiiv-config.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  fetchAllSubscribers,
  mean,
  median,
  parseSinceToEpochSeconds,
  parseUntilToEpochSecondsExclusive,
  resolveWindowGuardError,
  type CohortWindow,
} from "./cohort-engagement.ts";
import { isLeitorV1, LEITOR_V1_THRESHOLDS, DEFAULT_BACKUP_ROOT } from "./lib/leitor.ts";
import {
  latestSnapshotDate,
  readSnapshotSubscribers,
} from "./lib/beehiiv-backup-snapshots.ts";

/**
 * Janela da coorte de lançamento (#4556). Default e não constante escondida:
 * o script serve pra qualquer coorte fechada, mas o caso que o motivou é
 * este, e digitá-lo toda vez convida a errar um dia da borda.
 */
export const LAUNCH_COHORT_SINCE = "2026-07-21";
export const LAUNCH_COHORT_UNTIL = "2026-08-02";

/**
 * Abaixo de quantas PESSOAS no denominador de engajamento a taxa é
 * indefensável. Mesmo valor e mesma razão do `AMOSTRA_PEQUENA_THRESHOLD` de
 * `cohort-engagement.ts` (#4761) — duplicado aqui em vez de importado porque
 * lá ele não é exportado, e exportá-lo acoplaria dois scripts que só
 * compartilham a heurística, não o cálculo.
 */
export const AMOSTRA_PEQUENA_THRESHOLD = 5;

/** Segundos num dia. UTC não tem horário de verão e o Unix time não tem
 *  segundo bissexto — todo dia do calendário tem exatamente 86400 aqui. */
const SECONDS_PER_DAY = 86_400;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/**
 * Forma mínima que os dois caminhos de entrada satisfazem — o subscriber
 * vivo da API (`EngagementSubscriber`) e o do snapshot local
 * (`BeehiivBackupSubscriber`). Estreita de propósito: `stats.click_rate`
 * existe no dado real dos dois lados e NÃO aparece aqui, pela mesma
 * disciplina de `LeitorInput` (ver `scripts/lib/leitor.ts`).
 */
export interface RetentionSubscriber {
  status?: string | null;
  /** Epoch em segundos (UTC), como a Beehiiv devolve. */
  created?: number | null;
  stats?: {
    total_received?: number | null;
    total_unique_opened?: number | null;
    total_unique_clicked?: number | null;
  } | null;
}

/** Rótulos dos três baldes. União fechada — o balde de um assinante é
 *  função total de `created`, nunca "outro". */
export type BucketLabel = "base_anterior" | "coorte" | "pos_coorte";

export const BUCKET_ORDER: readonly BucketLabel[] = [
  "coorte",
  "base_anterior",
  "pos_coorte",
] as const;

export interface RetentionGroup {
  cadastros: number;
  ativos: number;
  inativos: number;
  pending: number;
  invalid: number;
  /** Status fora dos quatro acima (validating, paused, needs_attention…) —
   *  contados, nunca descartados em silêncio. */
  outros_status: number;

  /** `ativos + inativos` — quem confirmou o opt-in e ou ficou ou saiu. É o
   *  denominador de `retencao`; ver docstring do módulo pro porquê. */
  base_confirmada: number;
  /** `ativos ÷ base_confirmada`, fração 0-1. `null` se ninguém confirmou. */
  retencao: number | null;
  /** `inativos` — saídas ACUMULADAS até a data da leitura, não saídas no
   *  período. A API não expõe data de descadastro (ver docstring). */
  saidas: number;

  /** Ativos com `stats` que entraram no denominador de engajamento, após o
   *  corte de `--min-received`. */
  amostra_considerada: number;
  /** Ativos com `stats` ANTES do corte. A diferença pro campo acima é
   *  quantas pessoas o piso derrubou — distingue "não tem dado" de "não
   *  alcançou o piso" sem re-rodar (mesma razão do #4752/#4757). */
  pre_corte_considerado: number;

  /** `Σ total_unique_opened ÷ Σ total_received`, fração 0-1. */
  abertura_agregada: number | null;
  /** `Σ total_unique_clicked ÷ Σ total_received`, fração 0-1. Calculado à
   *  mão — nunca `stats.click_rate`. */
  ctr_agregado: number | null;
  /** Ativos que passam no predicado `leitor-v1` (`scripts/lib/leitor.ts`).
   *  Avaliado sobre TODOS os ativos do balde, não só os considerados: o
   *  próprio predicado já carrega o piso de 20 recebidas, e aplicar o corte
   *  de `--min-received` por cima mudaria a definição canônica. */
  leitores_v1: number;
  /** `leitores_v1 ÷ ativos`, fração 0-1. `null` se o balde não tem ativos. */
  densidade_leitores: number | null;

  media_recebidas: number | null;
  mediana_recebidas: number | null;
  /**
   * Mediana de `total_received` sobre os ativos com `stats` ANTES do corte
   * de `--min-received`. É esta — e nunca `mediana_recebidas` — que responde
   * "a coorte já amadureceu pro corte?": depois do corte a mediana é `>=`
   * piso por construção, então a pergunta se responde sozinha com "sim" e o
   * marcador `coorte_imatura` nunca dispararia (achado ao rodar a primeira
   * leitura ao vivo: pré-corte 18, pós-corte 20, piso 20).
   */
  mediana_recebidas_pre_corte: number | null;
  /** Mediana de dias entre `created` e a data da leitura — a EXPOSIÇÃO do
   *  balde. É o número que torna `retencao` incomparável entre baldes. */
  mediana_dias_expostos: number | null;

  amostra_vazia: boolean;
  amostra_pequena: boolean;
  amostra_instavel: boolean;
}

export interface ComparabilityNotes {
  /** `true` quando a mediana de exposição de dois baldes com ativos difere
   *  por mais de 2×. Marcador mecânico do viés 1 da docstring. */
  exposicao_desigual: boolean;
  /** `true` enquanto `mediana_recebidas` da coorte < `min_received` — o
   *  corte derruba quase todo mundo e a taxa restante é de poucas pessoas. */
  coorte_imatura: boolean;
  /** Texto que acompanha o número em qualquer superfície. Nunca vazio. */
  notas: string[];
}

export interface RetentionResult {
  /** `"snapshot:AAAA-MM-DD"` ou `"live"`. */
  fonte: string;
  since: string;
  until: string;
  min_received: number;
  grupos: Record<BucketLabel, RetentionGroup>;
  /** Descartados por não terem `created` — não dá pra atribuir balde. */
  excluidos_sem_created: number;
  total_subscribers: number;
  comparabilidade: ComparabilityNotes;
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Particionamento
// ---------------------------------------------------------------------------

/**
 * Atribui o balde de um assinante por `created`. `null` quando não há
 * `created` — o chamador conta esses em `excluidos_sem_created` em vez de
 * chutar um balde.
 *
 * @pure
 */
export function bucketOf(
  sub: RetentionSubscriber,
  window: CohortWindow,
): BucketLabel | null {
  if (typeof sub.created !== "number") return null;
  const { since, untilExclusive } = window;
  if (since != null && sub.created < since) return "base_anterior";
  if (untilExclusive != null && sub.created >= untilExclusive) return "pos_coorte";
  return "coorte";
}

/**
 * Particiona a base inteira nos três baldes. Diferente de `filterWindow`
 * (`cohort-engagement.ts`), que DESCARTA quem está fora da janela: aqui o
 * "fora" é o grupo de controle, e é a metade que interessa.
 *
 * @pure
 */
export function partitionByCohort(
  subs: RetentionSubscriber[],
  window: CohortWindow,
): { buckets: Record<BucketLabel, RetentionSubscriber[]>; semCreated: number } {
  const buckets: Record<BucketLabel, RetentionSubscriber[]> = {
    coorte: [],
    base_anterior: [],
    pos_coorte: [],
  };
  let semCreated = 0;
  for (const sub of subs) {
    const bucket = bucketOf(sub, window);
    if (bucket == null) semCreated++;
    else buckets[bucket].push(sub);
  }
  return { buckets, semCreated };
}

// ---------------------------------------------------------------------------
// Métricas por balde
// ---------------------------------------------------------------------------

function statNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Calcula retenção + engajamento de UM balde. Contagens de status usam o
 * balde inteiro; engajamento usa só os ATIVOS com `stats` (e, se
 * `minReceived > 0`, só os que alcançam o piso).
 *
 * `nowEpochSeconds` entra por parâmetro pra manter a função pura e testável
 * — a mediana de exposição depende de "agora" e cravar `Date.now()` aqui
 * dentro tornaria o resultado impossível de fixar em teste.
 *
 * @pure
 */
export function computeRetentionGroup(
  subs: RetentionSubscriber[],
  opts: { minReceived: number; nowEpochSeconds: number },
): RetentionGroup {
  let ativos = 0;
  let inativos = 0;
  let pending = 0;
  let invalid = 0;
  let outros_status = 0;
  let leitores_v1 = 0;

  const ativosComStats: Array<{ received: number; opened: number; clicked: number }> = [];
  const diasExpostos: number[] = [];
  // Guarda contra `nowEpochSeconds` não-finito vindo de um chamador exótico:
  // contaminaria a mediana de exposição com `NaN` e, por ela, o JSON inteiro.
  const now = Number.isFinite(opts.nowEpochSeconds) ? opts.nowEpochSeconds : 0;

  for (const sub of subs) {
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

    if (typeof sub.created === "number") {
      diasExpostos.push((now - sub.created) / SECONDS_PER_DAY);
    }

    if (sub.status !== "active") continue;

    if (
      isLeitorV1({
        status: "active",
        totalReceived: statNumber(sub.stats?.total_received),
        totalUniqueClicked: statNumber(sub.stats?.total_unique_clicked),
      })
    ) {
      leitores_v1++;
    }

    if (!sub.stats) continue; // conta em `ativos`, fora do denominador de engajamento
    ativosComStats.push({
      received: statNumber(sub.stats.total_received),
      opened: statNumber(sub.stats.total_unique_opened),
      clicked: statNumber(sub.stats.total_unique_clicked),
    });
  }

  const considerados =
    opts.minReceived > 0
      ? ativosComStats.filter((a) => a.received >= opts.minReceived)
      : ativosComStats;

  const totalReceived = considerados.reduce((sum, a) => sum + a.received, 0);
  const totalOpened = considerados.reduce((sum, a) => sum + a.opened, 0);
  const totalClicked = considerados.reduce((sum, a) => sum + a.clicked, 0);

  const receivedValues = considerados.map((a) => a.received);
  const mediana_recebidas = median(receivedValues);
  const amostra_considerada = considerados.length;
  const base_confirmada = ativos + inativos;

  return {
    cadastros: subs.length,
    ativos,
    inativos,
    pending,
    invalid,
    outros_status,
    base_confirmada,
    retencao: base_confirmada > 0 ? ativos / base_confirmada : null,
    saidas: inativos,
    amostra_considerada,
    pre_corte_considerado: ativosComStats.length,
    abertura_agregada: totalReceived > 0 ? totalOpened / totalReceived : null,
    ctr_agregado: totalReceived > 0 ? totalClicked / totalReceived : null,
    leitores_v1,
    densidade_leitores: ativos > 0 ? leitores_v1 / ativos : null,
    media_recebidas: mean(receivedValues),
    mediana_recebidas,
    mediana_recebidas_pre_corte: median(ativosComStats.map((a) => a.received)),
    mediana_dias_expostos: median(diasExpostos),
    amostra_vazia: amostra_considerada === 0,
    amostra_pequena:
      amostra_considerada > 0 && amostra_considerada < AMOSTRA_PEQUENA_THRESHOLD,
    amostra_instavel: mediana_recebidas != null && mediana_recebidas < 10,
  };
}

// ---------------------------------------------------------------------------
// Comparabilidade
// ---------------------------------------------------------------------------

/** Acima de quantas vezes de diferença na mediana de exposição as retenções
 *  deixam de ser comparáveis nem de longe. 2× é o ponto em que o delta de
 *  idade sozinho já explica um delta de retenção plausível. */
export const EXPOSICAO_DESIGUAL_RATIO = 2;

/**
 * Monta o bloco de ressalvas. As duas notas estruturais saem SEMPRE — não
 * são condicionais a um limiar, porque o viés existe em qualquer leitura
 * deste script (ver docstring do módulo). Os marcadores booleanos são o que
 * varia.
 *
 * @pure
 */
export function buildComparabilityNotes(
  grupos: Record<BucketLabel, RetentionGroup>,
  minReceived: number,
): ComparabilityNotes {
  const coorte = grupos.coorte;
  const base = grupos.base_anterior;

  const expostosCoorte = coorte.mediana_dias_expostos;
  const expostosBase = base.mediana_dias_expostos;
  const exposicao_desigual =
    expostosCoorte != null &&
    expostosBase != null &&
    expostosCoorte > 0 &&
    Math.max(expostosBase / expostosCoorte, expostosCoorte / expostosBase) >
      EXPOSICAO_DESIGUAL_RATIO;

  const coorte_imatura =
    minReceived > 0 &&
    coorte.mediana_recebidas_pre_corte != null &&
    coorte.mediana_recebidas_pre_corte < minReceived;

  const notas = [
    "Retenção compara exposições desiguais: a coorte teve menos tempo pra sair que a base anterior. " +
      "A correção (sobrevivência em t=N dias) exigiria a DATA de cada saída, que a API Beehiiv não expõe.",
    "Engajamento compara início de vida (coorte) contra vida inteira (base anterior), o que pende a favor da coorte. " +
      "Medir a base nas primeiras N recebidas dela não é derivável: o dado por assinante é cumulativo, não série temporal.",
    "Os dois vieses inflam a coorte. Coorte que NÃO se destaca é sinal forte; coorte que se destaca pouco é sinal fraco.",
  ];

  if (exposicao_desigual) {
    notas.push(
      `Exposição mediana: coorte ${fmtDias(expostosCoorte)} vs base anterior ${fmtDias(expostosBase)} — ` +
        `mais de ${EXPOSICAO_DESIGUAL_RATIO}× de diferença. NÃO ler o delta de retenção como mérito da coorte.`,
    );
  }
  if (coorte_imatura) {
    notas.push(
      `Coorte imatura pro corte atual: mediana de ${coorte.mediana_recebidas_pre_corte} recebidas < piso de ${minReceived}. ` +
        `O corte deixou ${coorte.amostra_considerada} de ${coorte.pre_corte_considerado} ativos no denominador — ` +
        `taxa de amostra pequena demais pra decidir. Rodar de novo quando a mediana passar o piso.`,
    );
  }
  if (grupos.pos_coorte.cadastros > 0) {
    notas.push(
      `${grupos.pos_coorte.cadastros} cadastros posteriores à coorte estão em \`pos_coorte\` e NÃO entram no ` +
        `controle — somá-los à base anterior diluiria o controle na direção que favorece a coorte.`,
    );
  }

  return { exposicao_desigual, coorte_imatura, notas };
}

function fmtDias(dias: number | null): string {
  return dias == null ? "n/d" : `${dias.toFixed(0)}d`;
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------

/**
 * Particiona + calcula + monta as ressalvas. Pura sobre a lista já carregada
 * — o I/O (snapshot ou API) fica no chamador, o que deixa o miolo inteiro
 * testável com um array literal.
 *
 * @pure
 */
export function computeRetention(
  subs: RetentionSubscriber[],
  opts: {
    window: CohortWindow;
    since: string;
    until: string;
    minReceived: number;
    nowEpochSeconds: number;
    fonte: string;
  },
): RetentionResult {
  const { buckets, semCreated } = partitionByCohort(subs, opts.window);

  const grupos = {
    coorte: computeRetentionGroup(buckets.coorte, opts),
    base_anterior: computeRetentionGroup(buckets.base_anterior, opts),
    pos_coorte: computeRetentionGroup(buckets.pos_coorte, opts),
  } satisfies Record<BucketLabel, RetentionGroup>;

  return {
    fonte: opts.fonte,
    since: opts.since,
    until: opts.until,
    min_received: opts.minReceived,
    grupos,
    excluidos_sem_created: semCreated,
    total_subscribers: subs.length,
    comparabilidade: buildComparabilityNotes(grupos, opts.minReceived),
    fetched_at: new Date(opts.nowEpochSeconds * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

function pct(value: number | null): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function num(value: number | null, digits = 0): string {
  return value == null ? "—" : value.toFixed(digits);
}

function flags(g: RetentionGroup): string {
  const out: string[] = [];
  if (g.amostra_vazia) out.push("⚠vazio");
  if (g.amostra_pequena) out.push("⚠poucos");
  if (g.amostra_instavel) out.push("⚠instável");
  return out.join(" ");
}

const BUCKET_TITLES: Record<BucketLabel, string> = {
  coorte: "COORTE (lançamento)",
  base_anterior: "BASE ANTERIOR (controle)",
  pos_coorte: "PÓS-COORTE (fora do controle)",
};

/**
 * Tabela legível. Uma seção por balde, na ordem `BUCKET_ORDER`, seguida das
 * ressalvas — que vêm no MESMO output, e não num doc à parte, porque o
 * número sozinho é o que produz a leitura errada que esta issue existe pra
 * evitar.
 *
 * @pure
 */
export function formatRetentionReport(result: RetentionResult): string {
  const lines: string[] = [];
  lines.push(
    `Coorte ${result.since} → ${result.until} · fonte: ${result.fonte} · min-received: ${result.min_received}`,
  );
  lines.push("");

  for (const label of BUCKET_ORDER) {
    const g = result.grupos[label];
    lines.push(`## ${BUCKET_TITLES[label]}`);
    lines.push(
      `  cadastros ${g.cadastros}  ·  ativos ${g.ativos}  inativos ${g.inativos}  ` +
        `pending ${g.pending}  invalid ${g.invalid}` +
        (g.outros_status > 0 ? `  outros ${g.outros_status}` : ""),
    );
    lines.push(
      `  retenção ${pct(g.retencao)} (${g.ativos}/${g.base_confirmada} confirmados)  ·  ` +
        `saídas ${g.saidas}  ·  exposição mediana ${fmtDias(g.mediana_dias_expostos)}`,
    );
    lines.push(
      `  abertura agregada ${pct(g.abertura_agregada)}  ·  CTR agregado ${pct(g.ctr_agregado)}  ·  ` +
        `leitores-v1 ${g.leitores_v1} (${pct(g.densidade_leitores)} dos ativos)`,
    );
    lines.push(
      `  denominador ${g.amostra_considerada}/${g.pre_corte_considerado} ativos com stats  ·  ` +
        `recebidas média ${num(g.media_recebidas, 1)} mediana ${num(g.mediana_recebidas, 1)} ` +
        `(pré-corte ${num(g.mediana_recebidas_pre_corte, 1)})` +
        (flags(g) ? `  ${flags(g)}` : ""),
    );
    lines.push("");
  }

  lines.push("## Ressalvas de comparabilidade");
  for (const nota of result.comparabilidade.notas) lines.push(`  - ${nota}`);
  lines.push("");
  lines.push(
    `total ${result.total_subscribers} subscribers` +
      (result.excluidos_sem_created > 0
        ? `  ·  ${result.excluidos_sem_created} descartados sem \`created\``
        : ""),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Resolve a lista de subscribers e o rótulo da fonte. Não é `@pure` (I/O). */
export async function loadSubscribers(opts: {
  live: boolean;
  snapshot: string | null;
  backupRoot: string;
}): Promise<{ subs: RetentionSubscriber[]; fonte: string }> {
  if (opts.live) {
    const cfg = loadBeehiivConfig("[cohort-retention]");
    const subs = await fetchAllSubscribers(cfg.publicationId, cfg.apiKey);
    return { subs, fonte: "live" };
  }
  const date = opts.snapshot ?? latestSnapshotDate(opts.backupRoot);
  if (!date) {
    throw new Error(
      `nenhum snapshot em ${opts.backupRoot} — rodar \`npx tsx scripts/backup-beehiiv.ts\` ou usar --live`,
    );
  }
  const subs = readSnapshotSubscribers(opts.backupRoot, date);
  if (subs.length === 0) {
    throw new Error(`snapshot ${date} não tem subscribers.jsonl legível em ${opts.backupRoot}`);
  }
  return { subs, fonte: `snapshot:${date}` };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const { flags: cliFlags, values } = parseArgs(argv);

  // `parseArgs` só grava em `values` quando o token seguinte não começa com
  // `--`; senão a flag vira booleana em silêncio. Sem esta checagem,
  // `--since 2026-07-21 --until --json` mede uma janela diferente da pedida,
  // com exit 0 e nenhuma mensagem — o pior desfecho num script de medição
  // (mesmo guard do `cohort-engagement.ts`, achado da PR #4751).
  for (const flag of ["since", "until", "min-received", "snapshot"]) {
    if (cliFlags.has(flag)) {
      process.stderr.write(`[cohort-retention] --${flag} requer um valor\n`);
      process.exit(3);
    }
  }

  const sinceRaw = values["since"] ?? LAUNCH_COHORT_SINCE;
  const untilRaw = values["until"] ?? LAUNCH_COHORT_UNTIL;

  let cohortWindow: CohortWindow;
  try {
    cohortWindow = {
      since: parseSinceToEpochSeconds(sinceRaw),
      untilExclusive: parseUntilToEpochSecondsExclusive(untilRaw),
    };
  } catch (e) {
    process.stderr.write(`[cohort-retention] ${(e as Error).message}\n`);
    process.exit(3);
  }

  const guardError = resolveWindowGuardError(cohortWindow, { since: sinceRaw, until: untilRaw });
  if (guardError != null) {
    process.stderr.write(`[cohort-retention] ${guardError}\n`);
    process.exit(3);
  }

  const minReceivedRaw = values["min-received"];
  const minReceived =
    minReceivedRaw != null ? Number(minReceivedRaw) : LEITOR_V1_THRESHOLDS.receivedMin;
  if (!Number.isFinite(minReceived) || minReceived < 0) {
    process.stderr.write(
      `[cohort-retention] --min-received inválido: "${minReceivedRaw}" (esperado número >= 0)\n`,
    );
    process.exit(3);
  }

  loadSubscribers({
    live: cliFlags.has("live"),
    snapshot: values["snapshot"] ?? null,
    backupRoot: DEFAULT_BACKUP_ROOT,
  })
    .then(({ subs, fonte }) => {
      const result = computeRetention(subs, {
        window: cohortWindow,
        since: sinceRaw,
        until: untilRaw,
        minReceived,
        nowEpochSeconds: Math.floor(Date.now() / 1000),
        fonte,
      });
      if (cliFlags.has("json")) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }
      process.stdout.write(formatRetentionReport(result) + "\n");
    })
    .catch((err) => {
      process.stderr.write(`[cohort-retention] ERRO: ${String(err)}\n`);
      process.exit(1);
    });
}
