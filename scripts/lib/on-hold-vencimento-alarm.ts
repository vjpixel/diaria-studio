/**
 * scripts/lib/on-hold-vencimento-alarm.ts (#5317, unificação de convenção #6199)
 *
 * Lógica PURA (sem I/O) do alarme de vencimento das issues `on-hold`.
 * Achado ao vivo 14/08/2026: 4 issues abertas (#4556, #4469, #4554, #4549)
 * carregam a label `on-hold` com uma data de vencimento escrita só no
 * TÍTULO — nada no repo lê essa data, e o overnight trata `on-hold` como
 * sinal de pular, então a fila autônoma nunca devolve essas issues sozinha.
 * Mesma classe de falha do #5111 (semanal do LinkedIn perdida em silêncio).
 *
 * ─── Duas convenções de data, unificadas na LEITURA (#6199) ────────────────
 *
 * Este módulo coexistia com `<!-- aguardando-ate: AAAA-MM-DD -->`
 * (`WAIT_UNTIL_RE`/`parseWaitUntil`, `scripts/lib/issue-exec-track.ts` —
 * lido por `classifyExecTrack`, que DESARMA sozinho quando a data chega) sem
 * nunca lê-lo: uma issue `on-hold` que só tivesse o marcador (sem a linha
 * `Vencimento:`) era invisível pra este alarme. Pior: quando as DUAS
 * coexistiam com a MESMA data (convenção que a auditoria #6191 encontrou em
 * #4469/#4554/#4556), `on-hold` vence a 1ª regra de `classifyExecTrack` e
 * torna o marcador inerte pro painel — o alarme continuava sendo o ÚNICO
 * lugar que de fato lembrava do prazo.
 *
 * **Decisão (#6199 item 1): duas convenções ACOPLADAS, não uma substituindo
 * a outra.** A linha `Vencimento:` continua existindo porque só ELA sabe
 * expressar "sem prazo conhecido" (`Vencimento: sem data` — não há
 * marcador equivalente, `aguardando-ate:` é sempre uma data concreta). O
 * que muda é a LEITURA: `resolveVencimento` (abaixo) consulta a linha
 * `Vencimento:` primeiro (fonte explícita, permite "sem data") e, só
 * quando ela está AUSENTE, cai pro marcador `aguardando-ate:` como
 * equivalente — uma issue `on-hold` que só carrega o marcador (convenção
 * mais nova, e a que `route-issue.ts --track agendada` escreve) passa a
 * ser vista por este alarme sem precisar duplicar a data em duas linhas.
 * `parseVencimentoLine` (a extração da linha crua) fica intocada — é
 * consumida por `resolveVencimento`, não removida.
 *
 * Uma issue `on-hold` pode chegar a este alarme em 3 estados:
 *
 *   1. `Vencimento: AAAA-MM-DD` OU só o marcador `aguardando-ate:
 *      AAAA-MM-DD` — data válida. Vira achado (`reason: "due"`) quando
 *      `now >= data` (meia-noite local do dia declarado).
 *   2. `Vencimento: sem data` — declaração EXPLÍCITA de que não há prazo
 *      conhecido (caso do #4549, `external-blocker`: só volta quando a
 *      amostra física chegar). **NUNCA mais achado (#6199 item 2, ver
 *      abaixo)** — silencia de verdade, como o próprio e-mail deste
 *      alarme sempre prometeu.
 *   3. Nenhuma das duas — a issue tem `on-hold` mas nunca declarou nada.
 *      Sempre achado (`reason: "vencimento-line-missing"`) — é exatamente
 *      o gap que a issue #5317 descreve pro #4549 antes de ser
 *      retroalimentado: a ausência não pode ser silenciosamente ignorada,
 *      senão o alarme cria o MESMO buraco que veio consertar.
 *
 * ─── `Vencimento: sem data` agora silencia DE VERDADE (#6199 item 2) ───────
 *
 * Antes desta unidade, `no-date-declared` era **sempre achado** — o
 * docstring anterior dizia isso explicitamente ("sem prazo pra checar
 * contra `now`, o único jeito de não esquecer a issue é o alarme continuar
 * citando ela"). O problema: o PRÓPRIO e-mail que este alarme envia
 * instrui o editor a escrever "Vencimento: sem data" pra "declarar/
 * atualizar o vencimento" — e a #4549 seguiu essa instrução ao pé da
 * letra e virou o ÚNICO achado do alarme, domingo após domingo,
 * indefinidamente (medido: "on-hold abertas: 4, achados: 1" em 26/08).
 * Um alarme cujo digest nunca fica vazio ensina o leitor a ignorá-lo — o
 * pior estado possível pra um mecanismo de lembrete.
 *
 * A correção escolhida (das duas propostas pela issue): fazer o silêncio
 * ser real, não reescrever a instrução do e-mail pra "isso não silencia
 * de verdade". `evaluateOnHoldIssue` devolve `null` (nenhum achado) pro
 * caso `explicit-no-date` — o texto do e-mail final da função já dizia
 * "sem prazo conhecido" como estado válido; ele descreve exatamente o que
 * o código agora faz. **Sem introduzir estado/distinção "achado novo vs.
 * conhecido"** (a alternativa mais complexa que a issue também descrevia)
 * — mantém a filosofia "sem idempotência persistente" do módulo inteiro
 * (ver seção abaixo): `sem data` deixa de ser um "achado que sempre se
 * repete" e vira, simplesmente, o mesmo tipo de estado terminal que uma
 * data FUTURA já era (`null`, sem alarme).
 *
 * **Sem estado/idempotência persistente de propósito.** A task roda semanal
 * (cadência já baixa o bastante pra não ser spam) e o alarme é um DIGEST — 1
 * e-mail por rodada listando TODOS os achados pendentes, sempre que houver
 * pelo menos 1. Diferente de `apoios-diff-alarm.ts` (fingerprint + supressão
 * de reenvio do MESMO diff), aqui a repetição semanal É o comportamento
 * desejado: uma issue vencida continua vencida até o editor agir, e o ponto
 * do alarme é justamente lembrar recorrentemente — suprimir o reenvio
 * reintroduziria a falha original ("só sai da geladeira se alguém
 * lembrar"), agora como "só sai da geladeira se alguém lembrar do PRIMEIRO
 * e-mail". O script (`scripts/on-hold-vencimento-alarm.ts`) é só I/O:
 * `gh issue list --label on-hold`, `sendGmailMessage`.
 *
 * **Este alarme NÃO remove a label sozinho** — decisão explícita do editor,
 * registrada na própria #5317: menos autonomia aqui é deliberado, uma issue
 * que volta sozinha pra fila do overnight vira trabalho não pedido.
 */
import { parseWaitUntil } from "./issue-exec-track.ts";

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
 * issue nunca deveria declarar 2, mas se declarar, a 1ª vence). Intocada
 * por #6199 — a unificação de convenção acontece em `resolveVencimento`,
 * uma camada acima, não aqui. */
export function parseVencimentoLine(body: string): VencimentoParseResult {
  const match = body.match(/^Vencimento:\s*(.+?)\s*$/m);
  if (!match) return { kind: "absent" };
  const raw = match[1].trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { kind: "date", date: raw };
  }
  return { kind: "explicit-no-date" };
}

/**
 * Pure (#6199 item 1): resolve o vencimento de uma issue combinando as DUAS
 * convenções — `Vencimento:` explícita primeiro (única capaz de expressar
 * "sem data conhecida"), e só na ausência dela o marcador `aguardando-ate:`
 * (`parseWaitUntil`, mesma fonte que `classifyExecTrack` lê) como
 * equivalente. Não há mistura/merge de datas conflitantes: se a linha
 * `Vencimento:` existir (mesmo com uma data DIFERENTE do marcador), ela
 * vence — é a convenção mais antiga e mais explícita, e uma issue que
 * declarou as duas com propósito (ex: estendendo o prazo só na linha, sem
 * tocar o marcador que `route-issue.ts` gerencia) não deveria ter a
 * intenção mais recente ignorada silenciosamente.
 */
export function resolveVencimento(body: string): VencimentoParseResult {
  const explicit = parseVencimentoLine(body);
  if (explicit.kind !== "absent") return explicit;
  const marker = parseWaitUntil(body);
  if (!marker) return { kind: "absent" };
  return { kind: "date", date: marker.toISOString().slice(0, 10) };
}

export type OnHoldAlarmReason = "due" | "vencimento-line-missing" | "invalid-date";

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
 * alarmável) ou `null` (data declarada — via `Vencimento:` OU
 * `aguardando-ate:`, ver `resolveVencimento` — calendarialmente válida e
 * ainda não chegou; OU `Vencimento: sem data` explícito, #6199 item 2:
 * silencia de verdade, nunca mais um achado permanente). */
export function evaluateOnHoldIssue(issue: OnHoldIssueInput, now: Date): OnHoldFinding | null {
  const parsed = resolveVencimento(issue.body);

  if (parsed.kind === "absent") {
    return { number: issue.number, title: issue.title, url: issue.url, reason: "vencimento-line-missing", vencimento: null };
  }
  if (parsed.kind === "explicit-no-date") {
    // #6199 item 2 — "Vencimento: sem data" é o caso legítimo (external-
    // blocker sem prazo conhecido, ex: #4549) que o próprio e-mail deste
    // alarme instrui o editor a declarar pra "silenciar". Antes desta
    // unidade isso continuava achado toda semana, para sempre — o e-mail
    // mentia. Silenciar de verdade é o comportamento correto: `null`, mesmo
    // tratamento de uma data futura ainda não vencida (linha abaixo).
    return null;
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
  "vencimento-line-missing": "sem 'Vencimento:' nem marcador 'aguardando-ate:' declarado",
  "invalid-date": "data inválida no calendário — corrigir a linha 'Vencimento:'",
};

/** Pure: monta assunto + corpo (texto puro, mesmo padrão dos outros
 * `*-alarm.ts` deste repo) do e-mail-digest com todos os achados. */
export function buildOnHoldVencimentoAlarmEmail(findings: readonly OnHoldFinding[]): { subject: string; body: string } {
  const subject = `⚠️ ${findings.length} issue(ns) on-hold pedindo revisão de vencimento`;

  const lines: string[] = [
    "As issues abaixo têm a label on-hold e a data de vencimento declarada",
    "(linha 'Vencimento: AAAA-MM-DD' no corpo, ou marcador 'aguardando-ate:')",
    "já chegou, ou nunca foi declarada. 'Vencimento: sem data' não aparece",
    "aqui — esse estado silencia de verdade (#6199), não é mais um achado.",
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
