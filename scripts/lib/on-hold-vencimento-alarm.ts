/**
 * scripts/lib/on-hold-vencimento-alarm.ts (#5317)
 *
 * Lógica PURA (sem I/O) do alarme de vencimento das issues `on-hold`.
 * Achado ao vivo 14/08/2026: 4 issues abertas (#4556, #4469, #4554, #4549)
 * carregam a label `on-hold` com uma data de vencimento escrita só no
 * TÍTULO — nada no repo lê essa data, e o overnight trata `on-hold` como
 * sinal de pular, então a fila autônoma nunca devolve essas issues sozinha.
 * Mesma classe de falha do #5111 (semanal do LinkedIn perdida em silêncio).
 *
 * **Fonte da data, decisão tomada na própria issue:** um campo EXPLÍCITO no
 * CORPO da issue, `Vencimento: AAAA-MM-DD` em linha própria — nunca parseia
 * o título (formatos variados: "~16/08", "30/09", "~29/set/2026", frágil).
 * Uma issue `on-hold` pode declarar 3 estados nesse campo:
 *
 *   1. `Vencimento: AAAA-MM-DD` — data válida. Vira achado (`reason: "due"`)
 *      quando `now >= data` (meia-noite local do dia declarado).
 *   2. `Vencimento: sem data` — declaração EXPLÍCITA de que não há prazo
 *      conhecido (caso do #4549, `external-blocker`: só volta quando a
 *      amostra física chegar). Sempre achado (`reason: "no-date-declared"`)
 *      — sem prazo pra checar contra `now`, o único jeito de não esquecer a
 *      issue é o alarme continuar citando ela a cada rodada semanal.
 *   3. Linha ausente — a issue tem `on-hold` mas nunca declarou nada. Sempre
 *      achado (`reason: "vencimento-line-missing"`) — é exatamente o gap que
 *      a issue #5317 descreve pro #4549 antes de ser retroalimentado: a
 *      ausência não pode ser silenciosamente ignorada, senão o alarme cria o
 *      MESMO buraco que veio consertar.
 *
 * **Sem estado/idempotência persistente de propósito.** A task roda semanal
 * (cadência já baixa o bastante pra não ser spam) e o alarme é um DIGEST — 1
 * e-mail por rodada listando TODOS os achados pendentes, sempre que houver
 * pelo menos 1. Diferente de `apoios-diff-alarm.ts` (fingerprint + supressão
 * de reenvio do MESMO diff), aqui a repetição semanal É o comportamento
 * desejado: uma issue vencida/sem-data continua vencida/sem-data até o
 * editor agir, e o ponto do alarme é justamente lembrar recorrentemente —
 * suprimir o reenvio reintroduziria a falha original ("só sai da geladeira
 * se alguém lembrar"), agora como "só sai da geladeira se alguém lembrar do
 * PRIMEIRO e-mail". O script (`scripts/on-hold-vencimento-alarm.ts`) é só
 * I/O: `gh issue list --label on-hold`, `sendGmailMessage`.
 *
 * **Este alarme NÃO remove a label sozinho** — decisão explícita do editor,
 * registrada na própria #5317: menos autonomia aqui é deliberado, uma issue
 * que volta sozinha pra fila do overnight vira trabalho não pedido.
 */

export interface OnHoldIssueInput {
  number: number;
  title: string;
  url: string;
  body: string;
}

export type VencimentoParseResult =
  | { kind: "date"; date: string } // "AAAA-MM-DD"
  | { kind: "explicit-no-date" }
  | { kind: "absent" };

/** Pure: extrai a linha `Vencimento: ...` do corpo da issue — nunca o
 * título. Só a PRIMEIRA linha que bate o padrão `Vencimento:` conta (uma
 * issue nunca deveria declarar 2, mas se declarar, a 1ª vence). */
export function parseVencimentoLine(body: string): VencimentoParseResult {
  const match = body.match(/^Vencimento:\s*(.+?)\s*$/m);
  if (!match) return { kind: "absent" };
  const raw = match[1].trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { kind: "date", date: raw };
  }
  return { kind: "explicit-no-date" };
}

export type OnHoldAlarmReason = "due" | "no-date-declared" | "vencimento-line-missing" | "invalid-date";

export interface OnHoldFinding {
  number: number;
  title: string;
  url: string;
  reason: OnHoldAlarmReason;
  /** "AAAA-MM-DD" quando `reason === "due"`; `null` nos outros 2 casos. */
  vencimento: string | null;
}

/** Pure: uma string "AAAA-MM-DD" (já validada pelo regex de formato em
 * `parseVencimentoLine`) representa uma data de CALENDÁRIO real? `Date`
 * normaliza mês/dia fora do intervalo em vez de rejeitar (ex: `2026-02-30`
 * vira `2026-03-02` silenciosamente) — comparar os componentes de volta
 * contra a string original é o único jeito de pegar isso. Também cobre o
 * caso `NaN` (ex: mês `13`), que `getFullYear()` etc. devolveriam `NaN` e
 * a comparação `!==` já reprova. */
function isValidCalendarDateString(dateStr: string, parsedDate: Date): boolean {
  const [year, month, day] = dateStr.split("-").map(Number);
  return (
    parsedDate.getFullYear() === year &&
    parsedDate.getMonth() + 1 === month &&
    parsedDate.getDate() === day
  );
}

/** Pure: avalia 1 issue `on-hold` contra `now` — devolve o achado (se
 * alarmável) ou `null` (data declarada, calendarialmente válida, e ainda
 * não chegou). */
export function evaluateOnHoldIssue(issue: OnHoldIssueInput, now: Date): OnHoldFinding | null {
  const parsed = parseVencimentoLine(issue.body);

  if (parsed.kind === "absent") {
    return { number: issue.number, title: issue.title, url: issue.url, reason: "vencimento-line-missing", vencimento: null };
  }
  if (parsed.kind === "explicit-no-date") {
    return { number: issue.number, title: issue.title, url: issue.url, reason: "no-date-declared", vencimento: null };
  }

  const due = new Date(`${parsed.date}T00:00:00`);
  if (!isValidCalendarDateString(parsed.date, due)) {
    // Mês fora do intervalo (NaN) ou dia fora do intervalo (rollover
    // silencioso pra outra data real) — nunca cai no caminho "ainda não
    // venceu" (NaN > now é sempre false, o que suprimiria o alarme pra
    // sempre). Sempre achado, mesmo bucket "sempre alarma" dos outros 2
    // estados sem data confiável.
    return { number: issue.number, title: issue.title, url: issue.url, reason: "invalid-date", vencimento: parsed.date };
  }
  if (due.getTime() > now.getTime()) return null;
  return { number: issue.number, title: issue.title, url: issue.url, reason: "due", vencimento: parsed.date };
}

/** Pure: avalia todas as issues `on-hold` — só os achados (não `null`),
 * ordenados por número crescente (determinístico, independente da ordem que
 * `gh issue list` devolveu). */
export function evaluateOnHoldIssues(issues: readonly OnHoldIssueInput[], now: Date): OnHoldFinding[] {
  return issues
    .map((issue) => evaluateOnHoldIssue(issue, now))
    .filter((f): f is OnHoldFinding => f !== null)
    .sort((a, b) => a.number - b.number);
}

/** Pure: há pelo menos 1 achado pra alarmar nesta rodada? */
export function shouldSendOnHoldVencimentoAlarm(findings: readonly OnHoldFinding[]): boolean {
  return findings.length > 0;
}

const REASON_LABEL: Record<OnHoldAlarmReason, string> = {
  due: "venceu",
  "no-date-declared": "sem data (declarada explicitamente)",
  "vencimento-line-missing": "sem linha 'Vencimento:' declarada",
  "invalid-date": "data inválida no calendário — corrigir a linha 'Vencimento:'",
};

/** Pure: monta assunto + corpo (texto puro, mesmo padrão dos outros
 * `*-alarm.ts` deste repo) do e-mail-digest com todos os achados. */
export function buildOnHoldVencimentoAlarmEmail(findings: readonly OnHoldFinding[]): { subject: string; body: string } {
  const subject = `⚠️ ${findings.length} issue(ns) on-hold pedindo revisão de vencimento`;

  const lines: string[] = [
    "As issues abaixo têm a label on-hold e, ou a data de vencimento declarada",
    "no corpo (linha 'Vencimento: AAAA-MM-DD') já chegou, ou nunca foi declarada.",
    "",
    "Este alarme só avisa — NÃO remove a label on-hold sozinho. Decidir se a",
    "issue volta pra fila do overnight é sempre ação do editor.",
    "",
  ];

  for (const f of findings) {
    const detail =
      f.reason === "due"
        ? `venceu em ${f.vencimento}`
        : f.reason === "invalid-date"
          ? `${REASON_LABEL[f.reason]} — valor declarado: "${f.vencimento}"`
          : REASON_LABEL[f.reason];
    lines.push(`#${f.number} — ${f.title} (${detail})`);
    lines.push(`  ${f.url}`);
  }

  lines.push(
    "",
    "Pra declarar/atualizar o vencimento, editar o corpo da issue com uma linha",
    "'Vencimento: AAAA-MM-DD' (ou 'Vencimento: sem data' se for external-blocker",
    "sem prazo conhecido) — npx tsx scripts/on-hold-vencimento-alarm.ts re-lê o",
    "corpo a cada rodada, nada fica em cache.",
  );

  return { subject, body: lines.join("\n") };
}
