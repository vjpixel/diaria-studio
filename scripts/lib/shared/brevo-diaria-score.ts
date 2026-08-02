/**
 * brevo-diaria-score.ts (#4266, reescrito no #4476 item 1)
 *
 * Fórmula de saída (promoção/supressão) do canal Brevo separado do editor
 * (conta própria, distinta da parceria Clarice) — decisão do editor, sessão
 * /diaria-develop 260802 (issue #4476, "O que muda em relação ao #4398" item
 * 1). SUBSTITUI a fórmula aditiva original (#4266, +20 abertura/-10
 * não-abertura, sem piso de amostra) por TAXA de abertura com piso mínimo de
 * amostra, assimétrico entre as duas direções:
 *
 *   Promoção:  sends_count >= 2 E openRate >= 50%
 *   Supressão: sends_count >= 5 E openRate <= 20%
 *   Entre os dois (ou piso de amostra não atingido): mantém (`keep`).
 *
 * ## Por que assimétrico (piso 2 pra promover, 5 pra suprimir)
 *
 * Errar promovendo é barato (a pessoa só não abre os e-mails "oficiais"
 * depois, mesmo custo de qualquer assinante inativo); errar suprimindo é
 * caro e quase irreversível (descarta de vez alguém que só teve azar
 * pontual — ex: 1 email perdido no meio de 2 recebidos não deveria
 * sentenciar ninguém). Por isso supressão exige mais evidência (n>=5) que
 * promoção (n>=2).
 *
 * ## Por que 20% é o piso de supressão
 *
 * Ancorado em dado real (issue #4476): a pior origem "normal" da planilha de
 * score de origem (`www.cfec.news`) já tem 18,4% de abertura agregada — cair
 * abaixo disso INDIVIDUALMENTE (não como média de origem) é sinal forte de
 * desinteresse genuíno, não ruído amostral.
 *
 * ## Casos abaixo do piso de amostra NUNCA agem, mesmo que a taxa já bata o
 * threshold (#4476 self-review — este é o caso que a fórmula aditiva antiga
 * não tinha: 1 envio/1 aberto era openRate=100% mas sends_count=1 < 2, então
 * "keep", não promove; 3 envios/0 abertos é openRate=0% mas sends_count=3 <
 * 5, então "keep", não suprime).
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
 * (`sends_count >= 2` E `openRate >= 0.5`, texto literal da decisão #4476). */
export const BREVO_DIARIA_PROMOTE_MIN_SENDS = 2;
export const BREVO_DIARIA_PROMOTE_MIN_OPEN_RATE = 0.5;

/** Piso de amostra + threshold de SUPRESSÃO — inclusivos nos dois lados
 * (`sends_count >= 5` E `openRate <= 0.2`). Piso de amostra maior que o da
 * promoção — ver rationale "por que assimétrico" acima. */
export const BREVO_DIARIA_SUPPRESS_MIN_SENDS = 5;
export const BREVO_DIARIA_SUPPRESS_MAX_OPEN_RATE = 0.2;

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

/**
 * Pura — classifica a ação a partir dos contadores brutos (não de um score
 * pré-computado — diferença deliberada da versão #4266: a decisão agora
 * depende de DOIS valores independentes, taxa E tamanho de amostra, que não
 * cabem num único número sem perder informação).
 *
 * Promoção e supressão são mutuamente exclusivas por construção (openRate
 * >= 0.5 e openRate <= 0.2 nunca são simultaneamente verdadeiros), mas a
 * ordem de checagem (promoção primeiro) é preservada como convenção — não
 * afeta o resultado.
 */
export function classifyBrevoDiariaAction(i: BrevoDiariaRateInput): BrevoDiariaAction {
  const openRate = computeBrevoDiariaOpenRate(i);
  if (i.sends_count >= BREVO_DIARIA_PROMOTE_MIN_SENDS && openRate >= BREVO_DIARIA_PROMOTE_MIN_OPEN_RATE) {
    return "promote_to_beehiiv";
  }
  if (i.sends_count >= BREVO_DIARIA_SUPPRESS_MIN_SENDS && openRate <= BREVO_DIARIA_SUPPRESS_MAX_OPEN_RATE) {
    return "suppress";
  }
  return "keep";
}
