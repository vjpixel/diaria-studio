/**
 * scripts/lib/route-reason-guard.ts (#7288 Parte A)
 *
 * Lógica PURA (sem I/O) que detecta quando um `--reason` passado a
 * `--track agendada` (`scripts/route-issue.ts`) na verdade descreve algo
 * que NÃO é uma data — dependência de outra issue, gatilho condicional sem
 * data, ou tamanho de escopo — e deveria ter usado outro mecanismo.
 *
 * ─── A medição que motivou (#7288, 03/09/2026) ─────────────────────────────
 *
 * Auditoria de 20 issues `agendada`: 11 (55%) tinham o marcador
 * `aguardando-ate:` sem nenhum evento de calendário por trás — o `--reason`
 * registrado (via comentário `route-issue`) descrevia, na prática, uma das
 * 3 famílias abaixo, nunca uma data real:
 *
 *   | padrão do motivo                                    | issues        | mecanismo certo         |
 *   |------------------------------------------------------|---------------|--------------------------|
 *   | "fatia própria" / "grande demais pra uma unidade"    | #7206, #7204, #7137 | fatiar em issue própria |
 *   | "segurar até o #N fechar" / "mesma cautela que #A/#B"| #6771, #7043, #6624  | `depends-on:` (#7137)  |
 *   | "só morde quando X voltar" / "reavaliar se..."       | #7036, #6783         | `--track bloqueada`    |
 *   | motivo em branco                                      | #6674                | (nenhum — recusa incondicional, ver `routeIssue`) |
 *
 * `detectNonDateReason` cobre as 3 primeiras famílias (a 4ª — motivo em
 * branco — é checada separadamente em `routeIssue`, ANTES desta função
 * rodar, porque não tem "padrão" a detectar, só ausência). Escape hatch:
 * `--force` no CLI bypassa só esta detecção de PADRÃO — nunca o motivo em
 * branco.
 *
 * ─── Por que regex, não NLP/heurística mais sofisticada ────────────────────
 *
 * Os 4 padrões são citados literalmente no corpo da issue de origem —
 * vocabulário observado em texto real escrito por sessões diferentes ao
 * longo de ~3 semanas, não inventado. `test/route-reason-guard.test.ts`
 * usa os 11 motivos reais da auditoria como corpus de regressão (#633) —
 * qualquer relaxamento de regex que deixe de pegar um deles quebra o teste.
 *
 * Falso positivo é esperado e aceitável (a issue já previa isso: "escape
 * hatch explícito... recusar sem saída vira contorno criativo, não
 * disciplina") — por isso o `--force` existe, não por isso a detecção deve
 * ser mais frouxa.
 *
 * @see scripts/route-issue.ts (routeIssue — chama isto pra `--track agendada`)
 * @see scripts/lib/issue-depends-on.ts (mecanismo certo pra dependência)
 * @see scripts/lib/route-marker-staleness.ts (Parte B — varredura periódica irmã)
 */

export type NonDateReasonCategory = "dependencia" | "gatilho-condicional" | "escopo";

export interface NonDateReasonFinding {
  category: NonDateReasonCategory;
  message: string;
}

/** Cita outra issue como condição ("segurar até #N fechar", "mesma cautela
 * que já adia #A/#B") — qualquer referência `#N` no motivo já é sinal
 * suficiente: uma data real não precisa citar o número de outra issue. */
const DEPENDENCY_RE = /#\d+|segurar\s+at[ée]|mesma\s+cautela/i;

/** Gatilho condicional sem data ("só morde quando X voltar", "reavaliar só
 * se a assinatura recorrer") — a condição de retomada é um EVENTO, não uma
 * data no calendário. `\bs[oó](?=\s|$)[^.]*\b(se|quando)\b` casa "só" e
 * "se"/"quando" na MESMA frase mesmo quando não adjacentes (ex: "só morde
 * quando..."), delimitado por ponto final pra não vazar pra frase seguinte.
 * `(?=\s|$)` no lugar de um 2º `\b` depois de `[oó]` de propósito — `\b` do
 * JS usa `\w` ASCII (sem diacríticos sem a flag `/u` + `\p{}`), então "ó"
 * não conta como caractere de palavra e `\b` logo depois dele falha em
 * combinar com o espaço seguinte (dois lados "não-palavra" não é fronteira)
 * — bug medido ao vivo no corpus de teste (#7036: "só morde quando" não
 * batia até este ajuste). */
const CONDITIONAL_RE = /\bs[oó](?=\s|$)[^.]*\b(se|quando)\b|\breavaliar\b[^.]*\bse\b|\bcautela\b/i;

/** Tamanho de escopo ("fatia própria", "grande demais pra uma unidade de
 * rodada") — a issue precisa ser fatiada, não agendada pra uma data
 * arbitrária. */
const SCOPE_RE = /fatia\s+pr[oó]pria|escopo\s+residual|grande[s]?\s+demais|unidade\s+de\s+rodada/i;

/**
 * Detecta se `reason` (já sabido não-vazio pelo caller) descreve uma das 3
 * famílias de não-data. Ordem de checagem importa quando o texto casa mais
 * de um padrão (ex: "mesma cautela que #6621" casa DEPENDENCY_RE via `#\d+`
 * E CONDITIONAL_RE via "cautela") — dependência é sempre o veredito mais
 * específico e o mecanismo mais acionável (`depends-on:` desarma sozinho),
 * então checa primeiro. `null` = nenhum padrão bateu, reason aceito.
 */
export function detectNonDateReason(reason: string): NonDateReasonFinding | null {
  if (DEPENDENCY_RE.test(reason)) {
    return {
      category: "dependencia",
      message:
        'razão cita outra issue como condição — isso é dependência, não data: use "--track bloqueada --depends-on N" ' +
        "(marcador depends-on:, #7137), que desarma sozinho quando #N fechar",
    };
  }
  if (CONDITIONAL_RE.test(reason)) {
    return {
      category: "gatilho-condicional",
      message:
        'razão descreve um gatilho condicional sem data — use "--track bloqueada --reason \\"...\\"" ' +
        "(bloqueio externo, revisado no alarme periódico de #7270) em vez de uma data arbitrária",
    };
  }
  if (SCOPE_RE.test(reason)) {
    return {
      category: "escopo",
      message:
        "razão descreve tamanho de escopo (fatia própria/escopo residual), não uma data — " +
        'fatie em issue(s) própria(s) ("gh issue create") em vez de agendar',
    };
  }
  return null;
}
