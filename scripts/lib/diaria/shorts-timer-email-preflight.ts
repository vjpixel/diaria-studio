/**
 * Pre-flight da credencial de e-mail nos timers de Shorts do 300 (#14370).
 *
 * Em 18/11 um alarme `publish-failed` do Instagram não saiu por e-mail porque
 * faltava `data/.credentials.json` no 300. A issue de alarme abriu (o GitHub
 * não depende desse arquivo) e o e-mail ficou pendente, mas nada dizia que a
 * credencial tinha sumido.
 *
 * Decisão do editor (briefing overnight 261128): o canal alternativo é a
 * PRÓPRIA issue de alarme, com rótulo e título dizendo que o e-mail está sem
 * credencial. Sem canal novo, sem infra-watchdog. Antes de abrir a issue, o
 * timer confere se a credencial existe; se faltar, o alarme sai com o prefixo
 * `EMAIL_NO_CREDENTIAL_TITLE_PREFIX` no título, a label
 * `ALARM_EMAIL_NO_CREDENTIAL_LABEL` e uma nota no corpo.
 *
 * Limite: título e label só entram na CRIAÇÃO da issue (`ensureAlarmIssue`
 * não reescreve issue já aberta). Credencial que some depois da issue aberta
 * não marca a issue existente; a nota do corpo também só entra na criação.
 */

import { ALARM_EMAIL_NO_CREDENTIAL_LABEL } from "../alarm-issues.ts";
import type { NotifyEditorDeps } from "../editor-notify.ts";
import { googleCredentialsPresent } from "../google-auth.ts";

export { ALARM_EMAIL_NO_CREDENTIAL_LABEL };

export const EMAIL_NO_CREDENTIAL_TITLE_PREFIX = "[e-mail sem credencial]";

export const EMAIL_NO_CREDENTIAL_BODY_NOTE =
  "**E-mail sem credencial:** `data/.credentials.json` não existe nesta máquina, então o e-mail deste alarme não sai; esta issue é o único aviso. Restaure a credencial (`npx tsx scripts/oauth-setup.ts` ou a sincronização do `data/`); o e-mail pendente é reenviado na execução seguinte do timer.";

/** Injeção da checagem (testes); o default lê o disco via `googleCredentialsPresent`. */
export interface EmailCredentialPreflightDeps {
  emailCredentialsPresent?: () => boolean;
}

/** Deps de notificação dos timers de Shorts: as do `notifyEditor` + a checagem da credencial. */
export type ShortsTimerNotifyDeps = NotifyEditorDeps & EmailCredentialPreflightDeps;

/** Pre-flight: a credencial de envio de e-mail existe? Erro na checagem conta como presente (não marca à toa). */
export function emailCredentialPresent(deps: EmailCredentialPreflightDeps = {}): boolean {
  try {
    return (deps.emailCredentialsPresent ?? googleCredentialsPresent)();
  } catch {
    return true;
  }
}

/** Puro: marca título, labels e corpo do alarme quando a credencial falta; com ela presente, devolve o alarme intacto. */
export function markAlarmEmailWithoutCredential<T extends { subject: string; body: string; labels?: string[] }>(
  alarm: T,
  credentialPresent: boolean,
): T {
  if (credentialPresent) return alarm;
  const subject = alarm.subject.startsWith(EMAIL_NO_CREDENTIAL_TITLE_PREFIX) ? alarm.subject : `${EMAIL_NO_CREDENTIAL_TITLE_PREFIX} ${alarm.subject}`;
  const labels = [...new Set([...(alarm.labels ?? []), ALARM_EMAIL_NO_CREDENTIAL_LABEL])];
  const body = alarm.body.includes(EMAIL_NO_CREDENTIAL_BODY_NOTE) ? alarm.body : `${EMAIL_NO_CREDENTIAL_BODY_NOTE}\n\n${alarm.body}`;
  return { ...alarm, subject, labels, body };
}

/** Pre-flight + marcação numa chamada só, para o ponto em que cada timer monta o `notifyEditor`. */
export function withEmailCredentialPreflight<T extends { subject: string; body: string; labels?: string[] }>(
  alarm: T,
  deps: EmailCredentialPreflightDeps = {},
): T {
  return markAlarmEmailWithoutCredential(alarm, emailCredentialPresent(deps));
}
