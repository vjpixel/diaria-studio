/**
 * scripts/lib/linkedin-weekly-staleness-alarm.ts (#5111)
 *
 * Lógica PURA do alarme de staleness da newsletter semanal do LinkedIn
 * (`/diaria-linkedin-semanal`). Achado ao vivo 260812: o ciclo `26w32`
 * (conteúdo 03-07/08, publicação prevista segunda 10/08) simplesmente não
 * rodou — o editor só percebeu 2 dias depois, por memória própria, porque
 * nada alarma quando a semanal não é produzida. Mesmo padrão dos outros
 * `*-Alarm` do repo (`clarice-envio-alarm.ts`, `apoios-diff-alarm.ts`,
 * `geo-citation-staleness-alarm.ts`): sensor local + e-mail, sem chamada
 * externa nenhuma.
 *
 * **O que este alarme NÃO faz** (escopo reduzido da issue #5111, itens 2-3
 * ficam de fora, registrados como follow-up): não agenda a produção da
 * semanal (a skill tem gate humano com 3 textos autorais do editor — uma
 * task que só chegasse até o gate teria valor incerto, avaliação futura), e
 * não trata "semana perdida" de forma especial (a skill segue sem noção de
 * atraso — rodar `--publish-monday` de uma segunda já passada produz
 * normalmente, sem aviso).
 *
 * **Estratégia:** dado `now`, calcula qual foi a última semana de CONTEÚDO
 * (segunda a sexta) que já terminou — `mostRecentContentMonday` — deriva o
 * `cycle` dela (mesma convenção `{YY}w{WW}` de `weekly-linkedin-cycle.ts`) e
 * checa se `data/weekly/{cycle}/ln-{cycle}.json` existe (o artefato final
 * escrito por `render-linkedin-weekly.ts`, Passo 5/7 da skill — existir é
 * prova de que a produção chegou ATÉ O FIM, não só que o Passo 2 rodou).
 * Roda semanalmente (domingo à noite, ver `scripts/lib/scheduled-tasks.ts`)
 * depois da janela em que a produção normal (domingo) deveria ter
 * acontecido — mas a função de cálculo do ciclo é robusta a qualquer dia
 * (task atrasada/máquina fora por dias continua apontando pra ÚLTIMA semana
 * completa, nunca pra uma semana ainda em curso).
 */

import { cycleFromContentMonday } from "./weekly-linkedin-cycle.ts";
import type { AlarmIssueResult } from "./alarm-issues.ts";

/**
 * Pure: dado `now`, retorna a segunda-feira (meia-noite local) da última
 * semana de CONTEÚDO (segunda a sexta) que já terminou — isto é, a semana
 * cuja sexta-feira é a mais recente ≤ `now`. Só opera em componentes de
 * calendário (ano/mês/dia) de `now`, hora do dia é ignorada.
 *
 * Exemplos (assumindo `now` em qualquer hora do dia indicado):
 *   domingo   → a segunda desta MESMA semana (sexta foi 2 dias atrás).
 *   segunda   → a segunda da semana ANTERIOR (a sexta desta semana ainda não chegou).
 *   terça-sábado → a segunda da semana ANTERIOR (mesma razão).
 */
export function mostRecentContentMonday(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = d.getDay(); // 0=domingo .. 6=sábado
  const daysSinceFriday = ((dow - 5) % 7 + 7) % 7; // 5 = sexta
  const friday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysSinceFriday);
  return new Date(friday.getFullYear(), friday.getMonth(), friday.getDate() - 4);
}

/** Pure: ciclo `{YY}w{WW}` da última semana de conteúdo completa, a partir de `now`. */
export function mostRecentCompletedCycle(now: Date): string {
  return cycleFromContentMonday(mostRecentContentMonday(now));
}

export type LinkedinWeeklyStalenessVerdict = "ok" | "alarm-missing";

export interface LinkedinWeeklyStalenessEvaluation {
  verdict: LinkedinWeeklyStalenessVerdict;
  cycle: string;
}

/** Pure: `artifactExists` é o resultado de checar `data/weekly/{cycle}/ln-{cycle}.json` no disco (I/O feito pelo caller). */
export function evaluateLinkedinWeeklyStalenessAlarm(
  cycle: string,
  artifactExists: boolean,
): LinkedinWeeklyStalenessEvaluation {
  return { verdict: artifactExists ? "ok" : "alarm-missing", cycle };
}

// ---------------------------------------------------------------------------
// Idempotência — 1 alarme por ciclo, nunca reenviado (mesmo padrão de
// EnvioAlarmState/GeoCitationStalenessAlarmState).
// ---------------------------------------------------------------------------

export interface LinkedinWeeklyStalenessAlarmState {
  lastAlarmedCycle: string | null;
}

export function emptyLinkedinWeeklyStalenessAlarmState(): LinkedinWeeklyStalenessAlarmState {
  return { lastAlarmedCycle: null };
}

export function shouldSendLinkedinWeeklyStalenessAlarm(
  evaluation: LinkedinWeeklyStalenessEvaluation,
  state: LinkedinWeeklyStalenessAlarmState,
): boolean {
  if (evaluation.verdict === "ok") return false;
  return state.lastAlarmedCycle !== evaluation.cycle;
}

export function markLinkedinWeeklyStalenessAlarmed(cycle: string): LinkedinWeeklyStalenessAlarmState {
  return { lastAlarmedCycle: cycle };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

export function buildLinkedinWeeklyStalenessAlarmEmail(
  cycle: string,
  /** #5339, opcional — `{issueNumber, url, action, error}` de
   * `applyAlarmReconciliation`, pra citar a issue deste achado. `undefined`
   * preserva o corpo pré-#5339. */
  issueRef?: AlarmIssueResult,
): { subject: string; body: string } {
  const issueLine = issueRef
    ? issueRef.action === "failed"
      ? `\n\nIssue: falha ao criar/reusar (${issueRef.error})`
      : `\n\nIssue: #${issueRef.issueNumber} (${issueRef.url})`
    : "";
  return {
    subject: `⚠️ LinkedIn semanal: ciclo ${cycle} não foi produzido`,
    body:
      `A newsletter semanal do LinkedIn (/diaria-linkedin-semanal) deveria ter produzido ` +
      `data/weekly/${cycle}/ln-${cycle}.json pra semana de conteúdo do ciclo ${cycle}, e o arquivo ` +
      `não existe. Isso significa que ninguém rodou a skill (produção normal é domingo, publicação ` +
      `segunda ~09:30 BRT), ou que a rodada parou antes do Passo de renderização (gate humano do Passo 3 ` +
      `sem resposta, por exemplo).\n\n` +
      `Rode manualmente: /diaria-linkedin-semanal --publish-monday {AAMMDD da próxima segunda útil}.\n\n` +
      `Este alarme só checa SE o artefato final existe — não agenda a produção nem trata a semana como ` +
      `"perdida" de forma especial (escopo reduzido da #5111; ver a issue pra follow-up).` +
      issueLine,
  };
}
