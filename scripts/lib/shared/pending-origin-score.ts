/**
 * pending-origin-score.ts (#4476 item 4)
 *
 * *** NÃO USADO PELO PIPELINE (desde 260802) — ver `scripts/score-pending-origin.ts` ***
 * Rodada ao vivo contra os 627 registros reais de `pending-scored.csv`, esta
 * fórmula divergiu MATERIALMENTE do score já confirmado pelo editor na
 * planilha manual (`pts_abertura`/`pts_clique` saturando no peso máximo com
 * frequência muito maior que o original; `penalidade_bounce` ~10x mais
 * fraca; correlação de RANKING de só 0,83 contra o score confirmado —
 * algumas linhas mudavam até 514 posições de 627). `score-pending-origin.ts`
 * foi reescrito pra LER o score já confirmado em vez de recalcular via este
 * módulo. Os testes deste arquivo continuam válidos (a fórmula faz o que diz
 * que faz — o problema é que "o que diz que faz" não bate com o método
 * original desconhecido da planilha), mas não use isto num pipeline real sem
 * antes revalidar contra uma fonte de verdade nova.
 *
 * Formaliza em código a fórmula de score de ORIGEM que priorizava a fila de
 * entrada do canal Brevo (segmento Pending da Beehiiv) até 260802 só como
 * planilha manual (`data/pending-reativacao/pending-scored.csv`, 627 linhas,
 * snapshot 260802). Decisão do editor (sessão /diaria-develop 260802,
 * comentário 260802 da issue #4476): a fórmula abaixo é a fórmula EXATA já
 * confirmada — "não recalcular, só formalizar em código o que já está
 * certo".
 *
 * ## Fórmula (0-100)
 *
 *   score = pts_confirmacao + pts_ativo + pts_abertura + pts_clique
 *         + pts_recencia + penalidade_bounce
 *
 *   pts_confirmacao   (peso máx. 25) — conv_confirmacao_pct da origem
 *   pts_ativo         (peso máx. 20) — conv_ativo_pct da origem
 *   pts_abertura      (peso máx. 25) — abertura_origem_pct normalizada
 *                     contra a base da lista inteira (35,8%)
 *   pts_clique        (peso máx. 15) — clique_origem_pct normalizada contra
 *                     a base da lista (5,2%)
 *   pts_recencia      (peso máx. 15) — decai com dias_desde_cadastro
 *   penalidade_bounce (até -12 no pior caso observado) — função de
 *                     invalido_origem_pct da origem
 *
 * ## Assunções de implementação — JÁ VALIDADAS (260802) e CONFIRMADAS ERRADAS
 * (#4494 review — esta seção descrevia essas assunções como "não
 * confirmadas", pergunta em aberto; a validação foi feita nesta sessão
 * (banner no topo do arquivo) e a resposta é negativa — pelo menos 1 das 3
 * assunções abaixo não bate com o método original desconhecido da planilha.
 * Mantida como registro histórico de QUAL era a hipótese testada, não como
 * pergunta pendente):
 *
 * 1. "Normalizada contra a base" (abertura/clique) — implementado como
 *    `min(origem_pct / base_pct, 1) * peso_max`: uma origem que iguala ou
 *    supera a média da base ganha o peso MÁXIMO do fator; abaixo da média,
 *    escala linear. O clamp em 1 é necessário pra nunca violar "peso máx."
 *    (uma origem com o dobro da abertura da base não deveria valer o dobro
 *    do peso).
 * 2. Decaimento de recência — linear, pontos máximos em dias_desde_cadastro=0,
 *    zero a partir de `PENDING_RECENCY_HORIZON_DAYS` (365 — 1 ano, escolhido
 *    porque a idade MEDIANA do pool é 218 dias, então um horizonte de 1 ano
 *    ainda distingue a maioria do pool em vez de zerar todo mundo).
 * 3. Penalidade de bounce — linear em `invalido_origem_pct/100` até o teto
 *    de -12 pontos em invalido_origem_pct=100% (pior caso teórico, não o
 *    pior caso OBSERVADO real da planilha — que a issue não informa
 *    numericamente).
 *
 * Módulo em `lib/shared/`: não depende de `diaria/` nem `mensal/` — usado
 * por `scripts/score-pending-origin.ts`, fora do pipeline de edição diária
 * (test/lib-boundary.test.ts).
 */

export interface PendingOriginMetrics {
  /** % (0-100) de confirmação de double opt-in histórica da origem. */
  conv_confirmacao_pct: number;
  /** % (0-100) de conversão pra assinante ATIVO da origem. */
  conv_ativo_pct: number;
  /** % (0-100) de taxa de abertura agregada da origem. */
  abertura_origem_pct: number;
  /** % (0-100) de taxa de clique agregada da origem. */
  clique_origem_pct: number;
  /** Dias desde o cadastro deste CONTATO específico (não da origem). */
  dias_desde_cadastro: number;
  /** % (0-100) de taxa de bounce/inválido agregada da origem. */
  invalido_origem_pct: number;
}

export interface PendingOriginScoreBreakdown {
  pts_confirmacao: number;
  pts_ativo: number;
  pts_abertura: number;
  pts_clique: number;
  pts_recencia: number;
  penalidade_bounce: number;
  score: number;
}

/** Pesos máximos por fator (issue #4476 item 4 — "não recalcular"). */
export const PENDING_SCORE_WEIGHT_CONFIRMACAO = 25;
export const PENDING_SCORE_WEIGHT_ATIVO = 20;
export const PENDING_SCORE_WEIGHT_ABERTURA = 25;
export const PENDING_SCORE_WEIGHT_CLIQUE = 15;
export const PENDING_SCORE_WEIGHT_RECENCIA = 15;
export const PENDING_SCORE_MAX_BOUNCE_PENALTY = 12;

/** Benchmarks da base da lista inteira (issue #4476, medidos 260802). */
export const PENDING_SCORE_BASE_ABERTURA_PCT = 35.8;
export const PENDING_SCORE_BASE_CLIQUE_PCT = 5.2;

/** Horizonte de decaimento de recência — ver assunção 2 no header do módulo. */
export const PENDING_RECENCY_HORIZON_DAYS = 365;

/** Pura — clamp genérico. */
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Pura — fator normalizado contra um benchmark, capado em [0,1] (ver
 * assunção 1 no header do módulo: nunca deixa a origem valer mais que o
 * peso máximo do fator, mesmo superando o benchmark). `basePct <= 0` → 0
 * (benchmark inválido não deveria inflar ninguém). */
function normalizedRatio(originPct: number, basePct: number): number {
  if (basePct <= 0) return 0;
  return clamp(originPct / basePct, 0, 1);
}

export function computeConfirmacaoPoints(conv_confirmacao_pct: number): number {
  return clamp(conv_confirmacao_pct, 0, 100) / 100 * PENDING_SCORE_WEIGHT_CONFIRMACAO;
}

export function computeAtivoPoints(conv_ativo_pct: number): number {
  return clamp(conv_ativo_pct, 0, 100) / 100 * PENDING_SCORE_WEIGHT_ATIVO;
}

export function computeAberturaPoints(abertura_origem_pct: number): number {
  return normalizedRatio(abertura_origem_pct, PENDING_SCORE_BASE_ABERTURA_PCT) * PENDING_SCORE_WEIGHT_ABERTURA;
}

export function computeCliquePoints(clique_origem_pct: number): number {
  return normalizedRatio(clique_origem_pct, PENDING_SCORE_BASE_CLIQUE_PCT) * PENDING_SCORE_WEIGHT_CLIQUE;
}

/** Pura — decaimento LINEAR: pontos máximos em dias=0, zero a partir de
 * `PENDING_RECENCY_HORIZON_DAYS`. Dias negativos (cadastro no futuro —
 * dado corrompido) tratados como 0 dias (máximo de pontos, nunca lança). */
export function computeRecenciaPoints(dias_desde_cadastro: number): number {
  const dias = Math.max(0, dias_desde_cadastro);
  const ratio = clamp(1 - dias / PENDING_RECENCY_HORIZON_DAYS, 0, 1);
  return ratio * PENDING_SCORE_WEIGHT_RECENCIA;
}

/** Pura — penalidade NEGATIVA (0 a -12), linear em invalido_origem_pct/100. */
export function computeBouncePenalty(invalido_origem_pct: number): number {
  const ratio = clamp(invalido_origem_pct, 0, 100) / 100;
  // 0 - x (não -x) evita produzir -0 quando ratio=0 — -0 é aritmeticamente
  // idêntico a 0, mas falha comparação estrita (Object.is) em testes.
  return 0 - ratio * PENDING_SCORE_MAX_BOUNCE_PENALTY;
}

/**
 * Pura — score completo (0-100 no caso normal; a penalidade pode levar o
 * total abaixo de 0 no pior caso teórico — não clampado, o consumidor
 * (`sync-pending-to-brevo.ts`) só usa o score pra ORDENAR, um valor negativo
 * ordena corretamente por último de qualquer forma).
 */
export function computePendingOriginScore(m: PendingOriginMetrics): PendingOriginScoreBreakdown {
  const pts_confirmacao = computeConfirmacaoPoints(m.conv_confirmacao_pct);
  const pts_ativo = computeAtivoPoints(m.conv_ativo_pct);
  const pts_abertura = computeAberturaPoints(m.abertura_origem_pct);
  const pts_clique = computeCliquePoints(m.clique_origem_pct);
  const pts_recencia = computeRecenciaPoints(m.dias_desde_cadastro);
  const penalidade_bounce = computeBouncePenalty(m.invalido_origem_pct);
  const score = pts_confirmacao + pts_ativo + pts_abertura + pts_clique + pts_recencia + penalidade_bounce;
  return { pts_confirmacao, pts_ativo, pts_abertura, pts_clique, pts_recencia, penalidade_bounce, score };
}
