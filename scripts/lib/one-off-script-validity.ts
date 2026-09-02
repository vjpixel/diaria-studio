/**
 * scripts/lib/one-off-script-validity.ts (#7114)
 *
 * "Todos os órfãos que a auditoria encontrou vieram do mesmo padrão" — um
 * script `analyze-*`/`diagnose-*`/`probe-*`/`measure-*`/`compare-*` criado
 * pra responder uma pergunta pontual e nunca aposentado depois. Este módulo
 * define o MARCADOR de validade declarada que um script novo desse padrão
 * precisa carregar, e o parser que verifica isso mecanicamente.
 *
 * ─── Formato do marcador ────────────────────────────────────────────────
 *
 * Uma linha de comentário (em qualquer lugar do arquivo, tipicamente no
 * docblock de topo) no formato:
 *
 *   @one-off-validity: expira=AAAA-MM-DD pergunta="<a pergunta que o script responde>"
 *
 * ou, pra um script que só COINCIDE com o padrão de nome mas é permanente
 * (roda toda rodada/todo dia, não é sonda pontual — ex:
 * `measure-round-diff-stats.ts`, #7113):
 *
 *   @one-off-validity: permanente motivo="<por que não é efêmero>"
 *
 * As duas formas satisfazem o guard (`check-one-off-script-validity.ts`) —
 * a distinção que importa pro guard é "a intenção foi DECLARADA", não "é
 * genuinamente efêmero". Só a forma `expira=` entra na varredura periódica
 * de vencidos (`list-expired-one-off-scripts.ts`).
 */

/** Scripts em `scripts/` (nível raiz, não `scripts/lib/`) cujo nome bate
 * este padrão são o alvo do guard — mesma lista de prefixos citada no
 * corpo da #7114. */
export const ONE_OFF_SCRIPT_NAME_PATTERN = /^(analyze|diagnose|probe|measure|compare)-[a-z0-9-]+\.ts$/;

export function isOneOffScriptFilename(basename: string): boolean {
  return ONE_OFF_SCRIPT_NAME_PATTERN.test(basename);
}

export type OneOffValidityMarker =
  | { kind: "expires"; question: string; expiresAt: string }
  | { kind: "permanent"; reason: string };

const MARKER_LINE_RE = /@one-off-validity:\s*(.+)/;
const EXPIRES_RE = /expira=(\d{4}-\d{2}-\d{2})/;
const QUESTION_RE = /pergunta="([^"]*)"/;
const PERMANENT_RE = /^permanente\s+motivo="([^"]*)"/;

export type OneOffValidityCheck =
  | { status: "not-applicable" }
  | { status: "missing" }
  | { status: "malformed"; raw: string }
  | { status: "valid"; marker: OneOffValidityMarker };

/**
 * Pura — decide o status do marcador de validade pra um arquivo. `source`
 * é o conteúdo já lido (nenhum I/O aqui). `basename` decide se o padrão de
 * nome sequer se aplica (`not-applicable` pra qualquer script fora de
 * `scripts/lib/one-off-script-validity.ts`'s `ONE_OFF_SCRIPT_NAME_PATTERN`).
 */
export function checkOneOffScriptValidity(basename: string, source: string): OneOffValidityCheck {
  if (!isOneOffScriptFilename(basename)) return { status: "not-applicable" };
  const lineMatch = source.match(MARKER_LINE_RE);
  if (!lineMatch) return { status: "missing" };
  const rest = lineMatch[1].trim();

  const permanentMatch = rest.match(PERMANENT_RE);
  if (permanentMatch) {
    return { status: "valid", marker: { kind: "permanent", reason: permanentMatch[1] } };
  }

  const expiresMatch = rest.match(EXPIRES_RE);
  const questionMatch = rest.match(QUESTION_RE);
  if (expiresMatch && questionMatch) {
    return {
      status: "valid",
      marker: { kind: "expires", expiresAt: expiresMatch[1], question: questionMatch[1] },
    };
  }
  return { status: "malformed", raw: rest };
}

/** ISO `YYYY-MM-DD` de `now` — comparação lexicográfica de string funciona
 * pra datas ISO (mesma técnica usada em `on-hold-vencimento-alarm.ts` e
 * afins deste repo). */
export function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Pura — `true` só pra marcador `expires` cuja data já passou; `permanent`
 * nunca vence. */
export function isExpiredMarker(marker: OneOffValidityMarker, now: Date = new Date()): boolean {
  if (marker.kind === "permanent") return false;
  return marker.expiresAt < isoDate(now);
}

/** Mensagem acionável pro guard de criação (#7114 escopo item 2) — texto
 * único usado tanto pelo CLI quanto pelos testes, pra não divergir. */
export function missingMarkerMessage(path: string): string {
  return (
    `${path}: script novo bate o padrão one-off (analyze-*/diagnose-*/probe-*/measure-*/compare-*) ` +
    `mas não declara \`@one-off-validity\`. Adicione uma linha no docblock de topo:\n` +
    `  @one-off-validity: expira=AAAA-MM-DD pergunta="<a pergunta que este script responde>"\n` +
    `ou, se o script for permanente (roda toda rodada/todo dia, só o nome coincide com o padrão):\n` +
    `  @one-off-validity: permanente motivo="<por que não é efêmero>"`
  );
}

export function malformedMarkerMessage(path: string, raw: string): string {
  return (
    `${path}: \`@one-off-validity\` presente mas em formato não reconhecido ('${raw}'). ` +
    `Use \`expira=AAAA-MM-DD pergunta="..."\` ou \`permanente motivo="..."\`.`
  );
}
