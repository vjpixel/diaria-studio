/**
 * scripts/lib/issue-depends-on.ts (#7137)
 *
 * Marcador `<!-- depends-on: #N[, #M...] -->` no CORPO de uma issue — a
 * primitiva que faltava pra declarar "esta issue só pode ser trabalhada
 * depois que #N fechar" de forma MACHINE-READABLE, mesma família do
 * `<!-- aguardando-ate: AAAA-MM-DD -->` de `issue-exec-track.ts`, que
 * `classifyExecTrack` já entende e que desarma sozinho pela data.
 *
 * ─── O incidente que motivou (02/09/2026) ──────────────────────────────────
 *
 * A #7124 declarava em PROSA que sua liberação era manual: quem fechasse a
 * #6798 precisaria remover a label `bloqueio-execucao` à mão. A #6798 fechou
 * — ninguém removeu a label. Enquanto ela esteve posta, `classifyExecTrack`
 * roteava a #7124 como `bloqueada` — mecanicamente invisível pras rodadas —
 * apesar de já estar sendo implementada. Uma sessão coordenadora removeu à
 * mão ~15min depois; sem essa intervenção, ficaria presa indefinidamente. O
 * padrão — "label de bloqueio que depende de alguém lembrar de remover" —
 * falha em silêncio, e o custo é issue viva classificada como morta.
 *
 * ─── Desenho: `classifyExecTrack` continua puro ───────────────────────────
 *
 * `classifyExecTrack` (`issue-exec-track.ts`) tem contrato explícito: sem
 * I/O, sem rede, sem `gh`. Saber se a dependência #N fechou EXIGE consultar
 * o GitHub — isso não pode entrar ali. O desenho é o mesmo que
 * `wait-until-sync.ts` já usa pra `aguardando-ate:`, um nível abaixo: a
 * função pura (`classifyExecTrack`) só aprende UMA LABEL
 * (`DEPENDS_ON_BLOCK_LABEL`, ver `issue-exec-track.ts` — entra em
 * `BLOCKED_LABELS`, então uma issue com a label classifica `bloqueada`
 * exatamente como `external-blocker`/`kit-migration`/`bloqueio-execucao`); um
 * script de reconciliação COM I/O (`scripts/reconcile-issue-dependencies.ts`)
 * lê o marcador, consulta o estado real das dependências via `gh`, e
 * aplica/remove a label — o auto-desarme mecânico que faltava na #7124.
 *
 * Label DEDICADA (`dependencia-aberta`), não reuso de `bloqueio-execucao`
 * — decisão deliberada, documentada aqui porque diverge do texto literal da
 * issue de origem ("aplica/remove `bloqueio-execucao`"): `bloqueio-execucao`
 * é aplicada manualmente por MUITAS razões, sem nenhum campo que diga QUAL.
 * Se o reconciliador tratasse essa label como "minha para remover", uma
 * issue bloqueada por `bloqueio-execucao` por um motivo NÃO relacionado a
 * `depends-on:` (credencial pendente, decisão do editor) teria a label
 * removida assim que a dependência declarada fechasse — desbloqueando por
 * um motivo que nada tem a ver com o que de fato a bloqueava. Uma label
 * própria elimina essa ambiguidade de proveniência sem custo — o
 * classificador já trata as duas como `bloqueada` de qualquer forma.
 *
 * ─── Regra de segurança (não-negociável) ──────────────────────────────────
 *
 * A consulta ao estado de uma dependência pode FALHAR (rede, `gh`
 * indisponível/desautenticado, rate limit). `decideDependsOnLabelAction`
 * abaixo nunca lê "falha de consulta" como "fechada": o estado de uma
 * dependência é `"closed"` | `"open"` | `"unknown"`, e só `"closed"` conta
 * como resolvida — `"unknown"` se comporta EXATAMENTE como `"open"` na
 * decisão (mantém/aplica o bloqueio). A label nunca é removida enquanto
 * qualquer dependência não estiver confirmada `"closed"`; nunca é aplicada
 * por padrão quando não há marcador. Ver docstring de
 * `decideDependsOnLabelAction` pro racional completo.
 *
 * @see scripts/lib/issue-exec-track.ts (classifyExecTrack, BLOCKED_LABELS, DEPENDS_ON_BLOCK_LABEL)
 * @see scripts/lib/wait-until-sync.ts (mesmo padrão de marcador + sync via gh, pra data em vez de issue)
 * @see scripts/reconcile-issue-dependencies.ts (CLI de I/O que usa este módulo)
 */

/**
 * `<!-- depends-on: #7113 -->` ou `<!-- depends-on: #7113, #6798 -->` — uma
 * ou mais issues, separadas por vírgula, `#` opcional em cada número.
 *
 * Mesma âncora de linha própria (`^...$`, flag `m`) que `WAIT_UNTIL_RE`
 * (`issue-exec-track.ts`) usa, pelo mesmo motivo documentado lá: sem ela,
 * uma issue que só CITA o marcador em prosa/code-span como exemplo (esta
 * mesma issue #7137 documenta o mecanismo citando-o) se auto-bloquearia —
 * falso positivo silencioso, a issue some da fila sem nenhum sinal de que
 * foi um exemplo citado que a tirou de lá.
 */
export const DEPENDS_ON_MARKER_RE =
  /^[ \t]*<!--\s*depends-on:\s*(#?\d+(?:\s*,\s*#?\d+)*)\s*-->[ \t]*$/gim;

/** Estado de UMA dependência, conforme observado por consulta real ao
 * GitHub. `"unknown"` é o valor pra "a consulta falhou" — NUNCA equivalente
 * a `"closed"` em nenhuma decisão deste módulo (ver `decideDependsOnLabelAction`). */
export type DependencyState = "open" | "closed" | "unknown";

/**
 * Extrai os números de issue declarados em TODOS os marcadores
 * `depends-on:` do corpo (podem existir vários, cada um com 1+ números;
 * duplicatas são deduplicadas). `[]` se não houver marcador — distinto de
 * "issue sem dependência conhecida ainda não checada", que é responsabilidade
 * do caller (reconciliador) representar.
 *
 * `excludeIssueNumber` descarta uma auto-referência (`depends-on: #N` no
 * corpo da própria issue #N) — declaração sem sentido que, se não filtrada,
 * prenderia a issue esperando ela mesma fechar pra sempre.
 */
export function parseDependsOn(
  body: string | null | undefined,
  excludeIssueNumber?: number,
): number[] {
  const src = body ?? "";
  const nums = new Set<number>();
  const re = new RegExp(DEPENDS_ON_MARKER_RE.source, "gim");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    for (const part of m[1].split(",")) {
      const n = Number.parseInt(part.trim().replace(/^#/, ""), 10);
      if (Number.isInteger(n) && n > 0 && n !== excludeIssueNumber) {
        nums.add(n);
      }
    }
  }
  return [...nums].sort((a, b) => a - b);
}

/** Resultado de avaliar TODAS as dependências declaradas de uma issue contra
 * seus estados observados. */
export interface DependsOnAssessment {
  dependsOn: number[];
  /** Dependências que NÃO estão confirmadas `"closed"` — inclui `"open"` e
   * `"unknown"` (consulta falhou/nunca rodou) igualmente. `[]` só quando
   * TODAS as dependências foram confirmadas fechadas — o único caso em que
   * a issue deixa de estar bloqueada por dependência. */
  unresolved: number[];
  /** Subconjunto de `unresolved` cujo estado é `"unknown"` — só pra
   * relatório/log ("N dependências não puderam ser verificadas"), nunca
   * consultado pela decisão de label (que trata `"unknown"` como `"open"`
   * de qualquer forma). */
  indeterminate: number[];
}

/** Avalia as dependências de uma issue contra o mapa de estados observados
 * (`states[N]` ausente é equivalente a `"unknown"` — dependência que o
 * reconciliador não conseguiu/não chegou a consultar). Pura. */
export function assessDependsOn(
  dependsOn: number[],
  states: Readonly<Record<number, DependencyState>>,
): DependsOnAssessment {
  const unresolved = dependsOn.filter((n) => (states[n] ?? "unknown") !== "closed");
  const indeterminate = unresolved.filter((n) => (states[n] ?? "unknown") === "unknown");
  return { dependsOn, unresolved, indeterminate };
}

/** Ação que o reconciliador deve tomar sobre `DEPENDS_ON_BLOCK_LABEL` nesta
 * issue. `"noop"` cobre tanto "já está no estado certo" quanto "nada pra
 * fazer" — o reconciliador só chama `gh issue edit` pra `"add"`/`"remove"`. */
export type DependsOnLabelAction = "add" | "remove" | "noop";

/**
 * Decide o que fazer com `DEPENDS_ON_BLOCK_LABEL` nesta issue — o núcleo do
 * mecanismo de auto-desarme. Pura (recebe os estados já consultados, nunca
 * consulta nada sozinha).
 *
 * Contrato de segurança, nesta ordem de prioridade:
 *
 *   1. Sem marcador (`dependsOn.length === 0`) — a issue não declara
 *      dependência nenhuma. Se carregar a label mesmo assim (marcador
 *      removido depois de aplicada, ou aplicação manual por engano),
 *      `"remove"` — não há razão pra mantê-la bloqueada por um mecanismo
 *      que não se aplica mais a ela. Sem a label, `"noop"`.
 *   2. Com marcador, TODAS as dependências confirmadas `"closed"` —
 *      `unresolved.length === 0` é o ÚNICO jeito de chegar aqui, e só
 *      acontece quando `assessDependsOn` conseguiu resolver CADA
 *      dependência positivamente (`"unknown"` sempre entra em
 *      `unresolved`, nunca em silêncio vira `"closed"`). Se a issue tem a
 *      label, `"remove"` — o auto-desarme. Sem a label, `"noop"` (já está
 *      correto, sem custo de API).
 *   3. Com marcador, QUALQUER dependência não confirmada fechada (aberta OU
 *      desconhecida) — `"add"` se a issue ainda não tem a label (bloqueio
 *      novo, ou 1ª reconciliação depois da issue ganhar o marcador); `"noop"`
 *      se já tem (nada muda, sem chamada de API redundante).
 *
 * **Nunca desarma por falha de consulta, nunca trata indeterminado como
 * fechada**: como o passo 3 trata `"open"` e `"unknown"` de forma IDÊNTICA
 * (ambos entram em `unresolved` via `assessDependsOn`), uma dependência cuja
 * consulta falhou nunca — em nenhuma combinação — resulta em `"remove"`. A
 * label só sai quando TODA dependência foi POSITIVAMENTE confirmada fechada.
 */
export function decideDependsOnLabelAction(
  assessment: Pick<DependsOnAssessment, "dependsOn" | "unresolved">,
  hasLabel: boolean,
): DependsOnLabelAction {
  const { dependsOn, unresolved } = assessment;
  if (dependsOn.length === 0) {
    return hasLabel ? "remove" : "noop";
  }
  if (unresolved.length === 0) {
    return hasLabel ? "remove" : "noop";
  }
  return hasLabel ? "noop" : "add";
}
