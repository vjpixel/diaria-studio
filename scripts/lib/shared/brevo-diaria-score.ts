/**
 * brevo-diaria-score.ts (#4266)
 *
 * Fórmula de pontuação do canal Brevo separado do editor (conta própria,
 * distinta da parceria Clarice) — decisão do editor, sessão /diaria-develop
 * 260731 (ver comentário mais recente da issue #4266).
 *
 * Mesmos FATORES do `computePriorityPoints` da Clarice
 * (`scripts/lib/clarice-db.ts`, ~L285-305):
 *   +20  por email aberto
 *   -10  por email recebido e NÃO aberto
 *   ponto de partida 0
 *
 * DIFERENÇA deliberada: o bônus `+40 priority_optin` da Clarice é específico
 * da lista de prioridade manual dela — não existe equivalente pro diar.ia
 * neste canal (contatos aqui vêm 100% da triagem de Pending da Beehiiv, sem
 * mecanismo de opt-in manual). Por isso esta fórmula é a fatia
 * abertura/não-abertura isolada, não uma reexportação de
 * `computePriorityPoints` — reimplementada aqui (não importada de
 * `clarice-db.ts`) por 2 motivos: (1) `clarice-db.ts` é acoplado a
 * `node:sqlite` (a Clarice guarda estado em SQLite; este canal usa um JSON
 * store simples, ver `brevo-diaria-store.ts`), e (2) a fórmula da Clarice tem
 * o termo `priority_optin` que NÃO se aplica aqui — reexportar exigiria um
 * wrapper só pra zerar esse termo, mais confuso que uma função própria de 2
 * linhas com o próprio comentário explicando a diferença.
 *
 * Módulo em `lib/shared/` (não `lib/diaria/`): é usado por scripts fora do
 * pipeline de edição diária propriamente dito (triagem/scoring do canal
 * Brevo rodam independente de qualquer edição específica) e não depende de
 * nada em `diaria/` nem `mensal/` — genérico por construção (test/lib-boundary.test.ts).
 */

export interface BrevoDiariaScoreInput {
  opens_count: number;
  sends_count: number;
}

/**
 * +20 por email aberto, -10 por email recebido e NÃO aberto, 0 de partida.
 * Aditivo (não corte duro) — mesmo racional da Clarice: um contato que abre
 * uma vez e depois ignora 3 decai, mas não é descartado até cruzar o piso.
 */
export function computeBrevoDiariaScore(i: BrevoDiariaScoreInput): number {
  const notOpened = Math.max(0, i.sends_count - i.opens_count);
  return 20 * i.opens_count - 10 * notOpened;
}

/**
 * Thresholds da decisão do editor (#4266, comentário 260731):
 *   score >= PROMOTE  → migra de volta pra Beehiiv (lista confirmada)
 *   score <= SUPPRESS → suprimido (para de receber, não deletado)
 *   caso contrário    → mantém no canal Brevo, sem ação
 */
export const BREVO_DIARIA_PROMOTE_THRESHOLD = 60;
export const BREVO_DIARIA_SUPPRESS_THRESHOLD = -30;

export type BrevoDiariaAction = "promote_to_beehiiv" | "suppress" | "keep";

/** Pura — classifica a ação a partir do score já computado. Limiares
 * INCLUSIVOS nos dois extremos ("score >= 60" e "score <= -30", texto
 * literal da decisão do editor). */
export function classifyBrevoDiariaAction(score: number): BrevoDiariaAction {
  if (score >= BREVO_DIARIA_PROMOTE_THRESHOLD) return "promote_to_beehiiv";
  if (score <= BREVO_DIARIA_SUPPRESS_THRESHOLD) return "suppress";
  return "keep";
}
