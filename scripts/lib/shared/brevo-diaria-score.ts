/**
 * brevo-diaria-score.ts (#4266, reescrito no #4476 item 1; threshold de
 * supressão e janela de maturação corrigidos no self-review pós-merge, ver
 * comentário na issue #4476)
 *
 * Fórmula de saída (promoção/supressão) do canal Brevo separado do editor
 * (conta própria, distinta da parceria Clarice) — decisão do editor, sessão
 * /diaria-develop 260802 (issue #4476, "O que muda em relação ao #4398" item
 * 1). SUBSTITUI a fórmula aditiva original (#4266, +20 abertura/-10
 * não-abertura, sem piso de amostra) por TAXA de abertura com piso mínimo de
 * amostra:
 *
 *   Promoção:  sends_count >= 3 E openRate >= 50% — contadores INSTANTÂNEOS
 *              (todos os envios, sem filtro de idade). Reage na hora —
 *              abertura já é evidência consumada, não há "ainda pode
 *              acontecer". Piso de amostra revisado de `n>=2` pra `n>=3`
 *              (decisão do editor, sessão 260804) — 1/2=50% já promovia com
 *              uma amostra rasa demais.
 *   Supressão: sends_count >= 3 E openRate <= 20% — contadores MADUROS
 *              (só envios com >=48h de idade, ver "Janela de maturação"
 *              abaixo). Errar suprimindo é caro/quase irreversível, então
 *              exige mais evidência (piso de amostra maior E só sobre dado
 *              que já teve tempo de virar sinal real).
 *   Entre os dois (ou piso de amostra não atingido): mantém (`keep`).
 *
 * ## Pisos de amostra agora iguais (n>=3 pros dois lados, 260804)
 *
 * Até 260804 o piso de promoção era `n>=2` (menor que o de supressão,
 * `n>=3`) — a assimetria original vinha do racional "errar promovendo é
 * barato (a pessoa só não abre os e-mails 'oficiais' depois); errar
 * suprimindo é caro e quase irreversível (descarta de vez alguém que só
 * teve azar pontual)". Decisão do editor (sessão 260804) igualou os dois
 * pisos em `n>=3` — a diferença de risco entre as duas direções continua
 * existindo (por isso a supressão ainda usa contadores MADUROS, com janela
 * de 48h, e a promoção não), mas o piso de AMOSTRA deixou de ser o lugar
 * onde essa assimetria se expressa.
 *
 * ## Por que 20% é o piso de supressão
 *
 * Ancorado em dado real (issue #4476): a pior origem "normal" da planilha de
 * score de origem (`www.cfec.news`) já tem 18,4% de abertura agregada — cair
 * abaixo disso INDIVIDUALMENTE (não como média de origem) é sinal forte de
 * desinteresse genuíno, não ruído amostral.
 *
 * ## Por que `n>=3` e não `n>=5` (revisão pós-merge da issue #4476 — texto
 * literal: "revisado de n>=5 — ver justificativa abaixo")
 *
 * Com piso de 20%, só `0/3` (0%) e `0/4` (0%) qualificam pra supressão —
 * `1/3`=33% e `1/4`=25% já passam do piso. O piso de 20% só permite "1
 * abertura tolerada" a partir de `n=5` (`1/5`=20%). Ou seja, a escolha entre
 * `n>=3` e `n>=5` NÃO muda quanto engajamento é tolerado — só muda quanto
 * tempo alguém com ZERO aberturas continua recebendo antes do corte (2
 * envios/dias a mais sob `n>=5`). Quem abriu pelo menos 1 e-mail não é
 * afetado pela escolha, porque só pode ser avaliado a partir de `n=5` de
 * qualquer jeito. `n>=3` é portanto uma mudança cirúrgica: só acelera o
 * corte de quem mostrou zero sinal de vida, sem tocar em ninguém que abriu
 * ao menos 1 e-mail.
 *
 * ## Janela de maturação (48h) — só pra supressão, implementada no #4476
 * self-review (dado confirmado disponível, ver `computeMatureCountsFromBrevoStatistics`
 * em `scripts/evaluate-brevo-diaria.ts`)
 *
 * Um envio recém-mandado não teve tempo de ser aberto ainda — contar isso
 * como "não abriu" na hora seria julgar com dado incompleto (a pessoa pode
 * abrir horas depois e a gente já ter suprimido por engano). Por isso, pro
 * cálculo de SUPRESSÃO, `sends_count`/`opens_count` só contam envios com
 * >=48h de idade (`BREVO_DIARIA_MATURATION_HOURS` abaixo) — envio mais novo
 * que isso fica de fora da conta até amadurecer. Promoção NÃO tem essa
 * janela (abertura já é evidência consumada, reage na hora) — por isso esta
 * função recebe DOIS conjuntos de contadores (`instant` e `mature`), nunca
 * um só.
 *
 * ## Casos abaixo do piso de amostra NUNCA agem, mesmo que a taxa já bata o
 * threshold (#4476 self-review — este é o caso que a fórmula aditiva antiga
 * não tinha: 1 envio/1 aberto era openRate=100% mas sends_count=1 < 2, então
 * "keep", não promove; 2 envios maduros/0 abertos é openRate=0% mas
 * sends_count=2 < 3, então "keep", não suprime).
 *
 * Reimplementada aqui (não importada de `clarice-db.ts`) pelos mesmos 2
 * motivos do módulo original: (1) `clarice-db.ts` é acoplado a `node:sqlite`
 * (este canal usa um JSON store simples, ver `brevo-diaria-store.ts`), e (2)
 * a mecânica de "envia → avalia → promove/suprime" é a mesma da Clarice só
 * na FORMA, não na fórmula literal — a issue #4476 registrou explicitamente
 * (seção "Resolvido em 260802") que uma proposta de reusar a fórmula aditiva
 * da Clarice foi REJEITADA em favor desta.
 *
 * Módulo em `lib/shared/` (não `lib/diaria/`): usado por scripts fora do
 * pipeline de edição diária propriamente dito e não depende de nada em
 * `diaria/` nem `mensal/` — genérico por construção (test/lib-boundary.test.ts).
 */

export interface BrevoDiariaRateInput {
  opens_count: number;
  sends_count: number;
}

/** Piso de amostra + threshold de PROMOÇÃO — inclusivos nos dois lados
 * (`sends_count >= 3` E `openRate >= 0.5`; piso revisado de `n>=2` pra
 * `n>=3` na sessão 260804 — ver "Pisos de amostra agora iguais" acima).
 * Avaliado contra contadores INSTANTÂNEOS (`instant`) — sem janela de
 * maturação. */
export const BREVO_DIARIA_PROMOTE_MIN_SENDS = 3;
export const BREVO_DIARIA_PROMOTE_MIN_OPEN_RATE = 0.5;

/** Piso de amostra + threshold de SUPRESSÃO — inclusivos nos dois lados
 * (`sends_count >= 3` E `openRate <= 0.2`; revisado de `n>=5` pra `n>=3` na
 * decisão final da issue #4476 — ver "Por que n>=3" acima). Avaliado contra
 * contadores MADUROS (`mature`, só envios >=48h) — nunca instantâneos. */
export const BREVO_DIARIA_SUPPRESS_MIN_SENDS = 3;
export const BREVO_DIARIA_SUPPRESS_MAX_OPEN_RATE = 0.2;

/** Janela de maturação (issue #4476, "Janela de maturação (48h)") — só
 * envios com esta idade ou mais entram na contagem usada pra SUPRESSÃO.
 * Promoção nunca usa esta constante (reage instantaneamente). */
export const BREVO_DIARIA_MATURATION_HOURS = 48;

export type BrevoDiariaAction = "promote_to_beehiiv" | "suppress" | "keep";

/**
 * Pura — taxa de abertura (0-1). `sends_count <= 0` → 0 (nunca divide por
 * zero; sem envios não há taxa observável, tratado como "0% de abertura"
 * por convenção — mas o piso de amostra de ambos os thresholds já garante
 * que nenhuma ação é tomada com sends_count tão baixo).
 */
export function computeBrevoDiariaOpenRate(i: BrevoDiariaRateInput): number {
  if (i.sends_count <= 0) return 0;
  return i.opens_count / i.sends_count;
}

export interface BrevoDiariaEvaluationInput {
  /** Contadores INSTANTÂNEOS — TODOS os envios, sem filtro de idade. Único
   * input usado pra avaliar PROMOÇÃO (issue #4476: "avaliada
   * INSTANTANEAMENTE a cada novo envio, sem janela de espera"). Também é o
   * par (opens/sends, open_rate) reportado/persistido no store — o que o
   * editor vê como "taxa de abertura atual" nunca é a taxa recortada pela
   * janela de maturação. */
  instant: BrevoDiariaRateInput;
  /** Contadores MADUROS — só envios com >=`BREVO_DIARIA_MATURATION_HOURS` de
   * idade (issue #4476, "Janela de maturação"). Único input usado pra
   * avaliar SUPRESSÃO — nunca promoção. Ver
   * `computeMatureCountsFromBrevoStatistics` em `scripts/evaluate-brevo-diaria.ts`
   * pra como isto é calculado a partir da API da Brevo. */
  mature: BrevoDiariaRateInput;
}

/**
 * Pura — classifica a ação a partir de DOIS conjuntos de contadores brutos
 * (não de um score pré-computado — diferença deliberada da versão #4266: a
 * decisão agora depende de valores independentes — taxa E tamanho de
 * amostra, cada um em 2 variantes, instantânea e madura — que não cabem num
 * único número sem perder informação).
 *
 * Promoção usa `input.instant`; supressão usa `input.mature`; nunca o
 * inverso. As duas continuam mutuamente exclusivas por construção dentro de
 * CADA conjunto (openRate >= 0.5 e openRate <= 0.2 nunca são simultaneamente
 * verdadeiros para o MESMO input), mas como agora são 2 conjuntos
 * potencialmente diferentes, a ordem de checagem (promoção primeiro) deixa
 * de ser só convenção: um contato com poucos envios maduros mas muitos
 * envios recentes todos abertos pode legitimamente qualificar pra promoção
 * (instantâneo) mesmo que o subconjunto maduro (se avaliado isoladamente)
 * não tivesse amostra suficiente pra dizer nada — o que é o comportamento
 * correto (abertura é sinal positivo consumado, não espera).
 */
export function classifyBrevoDiariaAction(input: BrevoDiariaEvaluationInput): BrevoDiariaAction {
  const instantRate = computeBrevoDiariaOpenRate(input.instant);
  if (
    input.instant.sends_count >= BREVO_DIARIA_PROMOTE_MIN_SENDS &&
    instantRate >= BREVO_DIARIA_PROMOTE_MIN_OPEN_RATE
  ) {
    return "promote_to_beehiiv";
  }
  const matureRate = computeBrevoDiariaOpenRate(input.mature);
  if (
    input.mature.sends_count >= BREVO_DIARIA_SUPPRESS_MIN_SENDS &&
    matureRate <= BREVO_DIARIA_SUPPRESS_MAX_OPEN_RATE
  ) {
    return "suppress";
  }
  return "keep";
}
