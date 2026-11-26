/**
 * publish-session-boundary.ts (#14038) — a Etapa 5 roda numa sessão nova.
 *
 * Desde o #6171 a sessão do `/diaria-edicao` termina no gate 4 e as Etapas 5
 * e 6 rodam numa sessão nova, a partir do `/diaria-publica` ou do
 * `/diaria-5-publicacao`. Nada conferia isso: no transcript 760277da (261119)
 * a publicação rodou na mesma sessão do gate, com o contexto em 591k no início
 * da Etapa 5 contra ~173k de uma sessão nova (cerca de 11M tokens de
 * cache_read a mais só nas Etapas 5 e 6).
 *
 * O `pipeline-sentinel.ts write` grava em `.step-4-done.json` o `session_id`
 * da sessão que aprovou o gate (`CLAUDE_CODE_SESSION_ID`). O Passo 0 das duas
 * skills compara com a sessão corrente; iguais = halt pedindo uma sessão nova
 * do Claude Code (nova conversa ou janela). Refazer a Etapa 4 dentro da sessão
 * de publicação regrava o sentinel com o id dela e também conta como "sessão
 * do gate".
 *
 * O id vem do ambiente HERDADO pelo Bash tool (`CLAUDE_CODE_SESSION_ID`), não
 * de uma consulta ao harness: nada garante que `/clear` troque o valor visto
 * pelo Bash (na sessão develop de 261125 ele persistiu até depois de um
 * reinício). Por isso o halt pede sessão nova e cita `/clear` só como algo
 * que pode não bastar; `--allow-same-session` é a saída explícita do editor.
 *
 * Fail-open por desenho: sentinel sem `session_id` (anterior ao #14038, ou
 * gravado fora do Claude Code) ou sessão corrente desconhecida viram
 * `unknown` e a publicação segue com aviso. A regra só bloqueia quando há
 * prova de que é a mesma sessão. Pura.
 */

export type PublishSessionBoundary =
  /** Sessões diferentes: a regra do #6171 está cumprida. */
  | { verdict: "new-session"; stage4SessionId: string; currentSessionId: string }
  /** A Etapa 5 está na mesma sessão que aprovou o gate 4: parar. */
  | { verdict: "same-session"; sessionId: string }
  /** Sem como comparar: seguir com aviso. */
  | {
      verdict: "unknown";
      reason: "sentinel_missing" | "sentinel_unreadable" | "sentinel_without_session" | "current_session_unknown";
    };

function clean(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function assessPublishSessionBoundary(input: {
  /** O sentinel do Stage 4 existe nesta máquina. */
  sentinelPresent: boolean;
  /** O arquivo existe mas não é JSON legível (`readSentinel` devolveu null). */
  sentinelUnreadable?: boolean;
  /** `session_id` do `.step-4-done.json` (ausente em sentinel antigo). */
  stage4SessionId: string | null | undefined;
  /** Sessão corrente (`CLAUDE_CODE_SESSION_ID` ou `--session-id`). */
  currentSessionId: string | null | undefined;
}): PublishSessionBoundary {
  if (!input.sentinelPresent) return { verdict: "unknown", reason: "sentinel_missing" };
  if (input.sentinelUnreadable) return { verdict: "unknown", reason: "sentinel_unreadable" };
  const stage4 = clean(input.stage4SessionId);
  if (!stage4) return { verdict: "unknown", reason: "sentinel_without_session" };
  const current = clean(input.currentSessionId);
  if (!current) return { verdict: "unknown", reason: "current_session_unknown" };
  if (stage4 === current) return { verdict: "same-session", sessionId: current };
  return { verdict: "new-session", stage4SessionId: stage4, currentSessionId: current };
}

/** Linha de stderr de cada veredito (nenhuma para `new-session`). Pura. */
export function describePublishSessionBoundary(b: PublishSessionBoundary, edition: string): string | null {
  if (b.verdict === "new-session") return null;
  if (b.verdict === "same-session") {
    return (
      `[halt] a Etapa 5 da edição ${edition} está na mesma sessão que aprovou o gate 4 (${b.sessionId}); ` +
      `refazer a Etapa 4 dentro da sessão de publicação também conta como sessão do gate. ` +
      `Desde o #6171 as Etapas 5 e 6 rodam numa sessão nova: abrir uma sessão nova do Claude Code (nova conversa ou janela) e invocar de novo o mesmo comando; /clear pode não bastar (o id vem do ambiente herdado pelo Bash). ` +
      `Seguir nesta sessão só se o editor pedir explicitamente: --allow-same-session. ` +
      `O contexto acumulado da revisão custa cerca de 11M tokens de cache_read a mais nas Etapas 5 e 6 (#14038).`
    );
  }
  const reasons: Record<typeof b.reason, string> = {
    sentinel_missing: "sentinel do Stage 4 ausente nesta máquina",
    sentinel_unreadable: "sentinel do Stage 4 ilegível (JSON inválido)",
    sentinel_without_session: "sentinel do Stage 4 sem session_id (gravado antes do #14038 ou fora do Claude Code)",
    current_session_unknown: "sessão corrente desconhecida (CLAUDE_CODE_SESSION_ID ausente)",
  };
  const why = reasons[b.reason];
  return `[aviso] fronteira de sessão da Etapa 5 não conferida: ${why}. Seguindo (#14038).`;
}
