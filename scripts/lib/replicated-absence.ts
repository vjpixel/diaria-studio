/**
 * scripts/lib/replicated-absence.ts (#7083)
 *
 * ─── A classe de erro que este módulo existe pra fechar ─────────────────────
 *
 * `data/` é uma junction/symlink pro OneDrive, compartilhada entre máquinas
 * (`helios`, a máquina do editor, etc.). Um arquivo escrito por uma task
 * agendada roda numa máquina EXECUTORA (ex: `helios`) e chega em qualquer
 * outra máquina só depois de replicar via sync — com atraso, e ocasionalmente
 * sem replicar de jeito nenhum (#5548: serviço do OneDrive morto; achado
 * ainda mais estreito no #7083: um arquivo ESPECÍFICO falhou em replicar
 * mesmo com o sync geral saudável — outros dotfiles de alarme chegaram
 * normalmente na mesma janela).
 *
 * Duas sessões independentes, no mesmo turno (#7083), leram a AUSÊNCIA local
 * de `data/.session-registry-safebackup-alarm-issues.json` numa máquina que
 * NÃO executa a task e concluíram "o alarme nunca rodou" — quando na
 * verdade a task rodava normalmente todo dia em `helios` (timer armado,
 * store de 15.714 bytes escrito no mesmo minuto da última execução). O erro:
 * tratar "não vejo o arquivo aqui" como equivalente a "o arquivo nunca foi
 * escrito", quando a pergunta certa ("esta task rodou?") só tem resposta
 * autoritativa na máquina que a executa.
 *
 * ─── Por que a heurística "cheque o canário de sync" NÃO basta sozinha ──────
 *
 * A sugestão óbvia é consultar `data/.onedrive-sync-canary.json`
 * (`scripts/lib/onedrive-sync-alarm.ts`) antes de concluir "ausente" — se o
 * canário está fresco, o sync geral está saudável, e a ausência do arquivo
 * específico pesaria mais como "genuinamente nunca escrito". **Isso teria
 * enganado exatamente no incidente do #7083**: o canário geral estava
 * saudável (outros dotfiles de alarme chegaram normalmente) e ainda assim
 * ESTE arquivo específico não replicou — um buraco de sync estreito,
 * arquivo-a-arquivo, não uma falha geral do serviço. Um veredito "canário
 * fresco → confio na ausência" teria reproduzido o mesmo erro.
 *
 * Por isso este módulo NUNCA promove uma ausência observada numa máquina
 * não-executora a "confirmada" — nem com o canário fresco. O único caminho
 * pra confirmar não-execução é checar a MÁQUINA QUE EXECUTA. `canaryFreshness`
 * entra só como contexto informativo na mensagem (plausibiliza "é sync lag" vs.
 * "pode ser um buraco estreito como o do #7083"), nunca como sinal que resolve
 * o veredito sozinho.
 */

import type { CanaryFreshnessVerdict } from "./onedrive-sync-alarm.ts";

/**
 * - `"not-absent"`: `fileExists` era `true` — não há ausência pra classificar
 *   (uso incorreto do helper, tratado sem lançar).
 * - `"confirmed-absent-on-executing-machine"`: `isExecutingMachine` é `true`
 *   — não existe camada de replicação entre "a task escreveu" e "eu leio"
 *   nesse caso, então a ausência É prova de não-execução (ou de execução
 *   sem escrita, a distinção que a caller ainda precisa fazer via outros
 *   sinais, ex: log da própria task).
 * - `"inconclusive-non-executing-machine"`: checado numa máquina que NÃO
 *   executa a task — a ausência pode ser replicação atrasada/quebrada, não
 *   prova de não-execução. **Nunca** vira "confirmed" só por causa do
 *   canário fresco (ver docstring do módulo).
 */
export type ReplicatedAbsenceVerdict =
  | "not-absent"
  | "confirmed-absent-on-executing-machine"
  | "inconclusive-non-executing-machine";

export interface ReplicatedAbsenceInput {
  /** `true` quando esta checagem roda NA máquina que deveria ter executado
   * a task/escrito o arquivo investigado — sem camada de sync entre a
   * escrita e esta leitura. */
  isExecutingMachine: boolean;
  /** O arquivo/store investigado existe (do ponto de vista de quem chama)? */
  fileExists: boolean;
  /** Sinal OPCIONAL e só informativo (freshness do canário de
   * `scripts/lib/onedrive-sync-alarm.ts`) — nunca usado pra decidir o
   * veredito, só pra compor a explicação (ver docstring do módulo pra por
   * quê: um canário fresco não descarta um buraco de sync estreito
   * arquivo-específico, #7083). */
  canaryFreshness?: CanaryFreshnessVerdict | null;
}

/**
 * Pura — classifica uma ausência de arquivo observada, distinguindo
 * "genuinamente nunca escrito" de "pode não ter replicado ainda". Ver
 * docstring do módulo pro incidente que motivou o desenho.
 */
export function classifyReplicatedAbsence(input: ReplicatedAbsenceInput): ReplicatedAbsenceVerdict {
  if (input.fileExists) return "not-absent";
  if (input.isExecutingMachine) return "confirmed-absent-on-executing-machine";
  return "inconclusive-non-executing-machine";
}

/** `true` só quando o veredito é prova real de não-execução — o único caso
 * em que é seguro afirmar "a task nunca rodou"/"o alarme está morto" a
 * partir da ausência observada. */
export function isConclusiveNonExecution(verdict: ReplicatedAbsenceVerdict): boolean {
  return verdict === "confirmed-absent-on-executing-machine";
}

/** Mensagem legível — inclui o `canaryFreshness` só como contexto (nunca
 * como justificativa pra promover o veredito), reforçando por que ele não
 * resolve sozinho o caso inconclusivo. */
export function explainReplicatedAbsenceVerdict(
  verdict: ReplicatedAbsenceVerdict,
  canaryFreshness?: CanaryFreshnessVerdict | null,
): string {
  switch (verdict) {
    case "not-absent":
      return "Arquivo existe — não há ausência para classificar.";
    case "confirmed-absent-on-executing-machine":
      return (
        "Ausência confirmada na própria máquina executora — sem camada de replicação " +
        "entre a escrita e esta leitura, é seguro concluir que a task não escreveu o arquivo."
      );
    case "inconclusive-non-executing-machine": {
      const canaryNote =
        canaryFreshness === "fresh"
          ? " O canário de sync geral está fresco, mas isso NÃO descarta um buraco de sync " +
            "estreito arquivo-específico (#7083) — não promove esta ausência a confirmada."
          : canaryFreshness === "stale"
            ? " O canário de sync geral está obsoleto — reforça a hipótese de sync atrasado/quebrado."
            : "";
      return (
        "Ausência observada numa máquina que NÃO executa a task — inconclusivo. " +
        "A ponta autoritativa pra responder 'esta task rodou?' é a máquina executora; " +
        "confirme lá (ex: `ls`/log/timer na máquina que roda a task) antes de concluir " +
        "'nunca rodou'." +
        canaryNote
      );
    }
  }
}
