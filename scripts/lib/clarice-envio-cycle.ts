/**
 * clarice-envio-cycle.ts (#5026)
 *
 * Resolve determinísticamente qual ciclo `{conteúdo}-{envio}` a automação
 * diária DEVERIA estar distribuindo HOJE — puro cálculo de calendário, sem
 * tocar disco/rede. Existe para separar duas perguntas que
 * `resolveLatestMonthlyCycleFromDisk` (scripts/lib/mensal/monthly-paths.ts)
 * responde juntas, mas que a automação precisa comparar:
 *
 *   1. "Qual ciclo o CALENDÁRIO diz que deveria estar em curso agora?"
 *      — `computeExpectedEnvioCycle` (este arquivo).
 *   2. "Qual o ciclo mais recente com conteúdo PRONTO (preview + gabarito É
 *      IA? + assunto conhecido)?" — `resolveLatestMonthlyCycleFromDisk`.
 *
 * A função (2) tem fallback DELIBERADO pro ciclo anterior quando o mais
 * recente não está pronto (D3, #4347) — correto pra invocação MANUAL (o
 * editor decide se aceita o fallback), mas errado pra automação desassistida:
 * decisão do editor (260811) é **parar** quando o ciclo vira e a edição nova
 * ainda não passou pela revisão do `/diaria-mensal`, nunca continuar
 * distribuindo o ciclo antigo indefinidamente. `clarice-envio-run.ts` chama
 * as duas e compara — só prossegue quando `resolveLatestMonthlyCycleFromDisk()
 * .cycle === computeExpectedEnvioCycle(now)`; qualquer divergência (inclusive
 * fallback de 1 mês só, que a #4621 tolera pra invocação manual) vira "ciclo
 * novo ainda não pronto — pausando" pra automação.
 *
 * Fórmula: mês de ENVIO = mês corrente (BRT); mês de CONTEÚDO = mês anterior
 * (com rollover de ano). Ex: hoje 2026-08-11 (BRT) => conteúdo "2607", envio
 * "08" => ciclo "2607-08". Valida contra `isValidCycle` antes de devolver —
 * a fórmula não pode produzir um ciclo inválido por construção (dezembro/
 * janeiro testado explicitamente), mas o guard fica de qualquer forma.
 */
import { datePartsInTz, BRT_TIMEZONE } from "./next-edition-date.ts";
import { isValidCycle } from "./clarice-paths.ts";

/** `now` sempre injetado — nunca `new Date()` interno (mesma disciplina de `clarice-envio-policy.ts`). */
export function computeExpectedEnvioCycle(now: Date, timeZone: string = BRT_TIMEZONE): string {
  const { year, month } = datePartsInTz(now, timeZone); // month é 1-based

  const sendMM = String(month).padStart(2, "0");

  let contentYear = year;
  let contentMonth = month - 1;
  if (contentMonth === 0) {
    contentMonth = 12;
    contentYear -= 1;
  }
  const contentYY = String(contentYear).slice(-2);
  const contentMM = String(contentMonth).padStart(2, "0");

  const cycle = `${contentYY}${contentMM}-${sendMM}`;
  if (!isValidCycle(cycle)) {
    // Não deveria ser alcançável (a fórmula acima sempre produz
    // sendMonth = contentMonth + 1) — guard defensivo, nunca "silenciosamente
    // aceita um ciclo mal formado".
    throw new Error(`[clarice-envio-cycle] fórmula produziu ciclo inválido: "${cycle}" (bug na função, reportar).`);
  }
  return cycle;
}
