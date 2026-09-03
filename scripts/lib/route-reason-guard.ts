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
 * `aguardando-ate:` sem nenhum evento de calendário por trás. Só 10 dessas
 * 11 têm número de issue citado explicitamente na tabela de motivos da
 * #7288 (a 11ª entra na contagem "11 das 20" do corpo da issue, mas não é
 * nomeada na tabela) — os 10 nomeados são o corpus VERIFICÁVEL usado aqui
 * e em `test/route-reason-guard.test.ts`. `#7201` aparece entre parênteses
 * na tabela original da issue (sinal de caso menos certo que os outros 3
 * de escopo) — MANTIDO no corpus mesmo assim: incerteza no julgamento
 * original não é motivo pra apagar o caso da contagem, só pra marcá-lo (o
 * teste correspondente documenta isso explicitamente).
 *
 *   | padrão do motivo                                    | issues        | mecanismo certo         |
 *   |------------------------------------------------------|---------------|--------------------------|
 *   | "fatia própria" / "grande demais pra uma unidade"    | #7206, #7204, #7137, #7201 (menos certo) | fatiar em issue própria |
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
 * usa os 10 motivos reais NOMEADOS da auditoria (dos 11 totais medidos —
 * ver tabela acima) como corpus de regressão (#633) — qualquer
 * relaxamento de regex que deixe de pegar um deles quebra o teste.
 *
 * Falso positivo é esperado e aceitável (a issue já previa isso: "escape
 * hatch explícito... recusar sem saída vira contorno criativo, não
 * disciplina") — por isso o `--force` existe, não por isso a detecção deve
 * ser mais frouxa.
 *
 * ─── Falsos positivos/negativos conhecidos, aceitos, NÃO consertados ───────
 * (achado do review do #7316 — registrado aqui em vez de "descoberto de
 * novo" pela próxima pessoa que ler o código; cobertos por teste dedicado,
 * `test/route-reason-guard.test.ts`, describe "limitações conhecidas"):
 *
 *   1. `CONDITIONAL_RE`/`SCOPE_RE` colidem com razão que TEM uma data real
 *      mas também usa vocabulário parecido (ex: "só volto a olhar isso se
 *      a Beehiiv responder até 2026-09-10" casa `CONDITIONAL_RE` via "só
 *      ... se"; "ficou grande demais até fecharmos a fatia em 09/09" casa
 *      `SCOPE_RE` via "grande demais") — FALSO POSITIVO, recusa uma razão
 *      legítima. `--force` é o escape hatch — é exatamente pra este caso
 *      que ele existe.
 *   2. Razão vaga sem `#N` e sem nenhum dos 2 gatilhos de texto passa
 *      batida (`null`, aceita) mesmo quando não é uma data de verdade —
 *      FALSO NEGATIVO, o guard não pega toda vaguidão, só os 3 padrões de
 *      texto medidos na auditoria original.
 *
 * Os dois são consequência direta de detectar por REGEX sobre vocabulário
 * observado, não por entendimento semântico — trade-off deliberado (ver
 * seção acima), não uma lacuna a fechar sem antes medir a taxa real de
 * falsos positivos/negativos em produção que justificaria trocar de
 * abordagem. **É também a razão direta pela qual `scripts/backlog-reconcile.ts`
 * precisou de `force: true` incondicional** (não foi escolha de desenho
 * daquele módulo — o texto que ele gera sempre cita `#6198` por
 * atribuição própria, batendo o falso positivo (1) acima toda vez).
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
