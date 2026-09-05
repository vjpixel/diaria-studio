/**
 * scripts/lib/issue-route.ts (#5969 Fase 1)
 *
 * Lógica PURA (sem I/O) do verbo único de roteamento `scripts/route-issue.ts`.
 * Responde a pergunta inversa de `classifyExecTrack`
 * (`scripts/lib/issue-exec-track.ts`): dado o veredito que uma sessão (ou o
 * editor) quer para uma issue, qual o conjunto MÍNIMO de labels a
 * ADICIONAR e qual conjunto a REMOVER pra fazer `classifyExecTrack` devolver
 * exatamente esse veredito (assumindo nenhum bloqueio mais forte
 * sobrepondo, ex: `state === "CLOSED"`)?
 *
 * ─── Por que isto existe (RC1 da #5969) ─────────────────────────────────────
 *
 * Antes deste módulo, "aplicar label X + comentar" era instrução em prosa
 * espalhada pelas SKILLs (overnight, develop) — cada julgamento feito sem o
 * passo extra de `gh issue edit --add-label` deixava a issue na categoria
 * errada, silenciosamente. Um verbo único, testado, é mais difícil de
 * esquecer que 3 passos soltos.
 *
 * ─── Fonte única: os Sets de `issue-exec-track.ts` ──────────────────────────
 *
 * O mapeamento veredito→labels aqui NUNCA redigita a lista de labels — ele
 * importa os mesmos Sets que `classifyExecTrack` já usa
 * (`BLOCKED_LABELS`/`OUT_OF_ROUND_LABELS`/etc. não são exportados
 * individualmente porque o consumo de leitura não precisa deles soltos; em
 * vez disso este módulo declara `ROUTABLE_LABELS` como a UNIÃO dos valores
 * que o próprio `issue-exec-track.ts` documenta como "labels que uma sessão
 * aplica pra rotear" — literalmente os mesmos literais citados na docstring
 * de `classifyExecTrack`). Um teste (`test/issue-route.test.ts`) trava essa
 * lista contra os literais usados por `classifyExecTrack` via
 * `EXEC_TRACK_UI`/`EXEC_TRACK_LABELS`/round-trip de `classifyExecTrack`, não
 * contra os nomes internos dos Sets (não exportados) — o round-trip
 * (aplicar o plano → `classifyExecTrack` devolve o track pedido) é a
 * garantia mais forte disponível: se os dois módulos divergirem, o teste de
 * round-trip quebra antes de qualquer coisa chegar a produção.
 *
 * ─── Labels de proveniência: preservadas, nunca removidas ───────────────────
 *
 * #6223 — `alarm`/`alarm-evento`/`decisao-registrada` estão em
 * `ROUTABLE_LABELS` (podem ser ADICIONADAS via `--motivo` — #6197), mas são
 * PROVENIÊNCIA: registram de onde/de como a issue chegou a este veredito,
 * não o próprio veredito. `route-issue` NUNCA as remove — são managed por
 * outro mecanismo (`alarm-issues.ts`, `issue-decisions.ts`) com sua própria
 * idempotência/dedup. Removi-las ao rotear (como o código fazia antes)
 * apagava estado que identifica a issue, sem nenhum ganho de corretude na
 * classificação (`PROVENIENCE_LABELS` é excluída do conjunto `remove`).
 *
 * `epic-guarda-chuva`/`sem-direcao-acionavel` seguem fora deste conjunto —
 * são labels de fluxo dedicado (#5968) e também não são removidas por
 * routing (não estão em `ROUTABLE_LABELS` como candidatas a `remove`).
 *
 * Consequência de validação (#6223): se uma issue carrega um provenance
 * label cujo track vence o `--track` pedido, a validação pós-escrita
 * (`classifyExecTrack`) falhará ruidosamente — correto, é um conflito de
 * precedência. Ex.: issue com `alarm` rotreada pra `overnight`: `alarm`
 * (RESOLVED_BY_PROSE_LABELS → `fora-de-rodada`) vence o default `overnight`
 * na ordem de precedência, então `classifyExecTrack` devolve
 * `fora-de-rodada` ≠ `overnight` → validação falha. Roteie pra
 * `fora-de-rodada` nesse caso (o track que `classifyExecTrack` realmente
 * devolve).
 *
 * ─── `agendada` é o único veredito sem label ─────────────────────────────────
 *
 * `agendada` não tem uma label própria — o sinal é o marcador
 * `aguardando-ate:` no CORPO da issue (`scripts/lib/wait-until-sync.ts`),
 * não uma label. `planRouteLabels("agendada")` devolve `add: []`; o CALLER
 * (`scripts/route-issue.ts`) é quem invoca `syncWaitUntilMarkerOnIssue`
 * separadamente quando `--until` é passado (e recusa `--track agendada` sem
 * `--until` — sem data não tem como produzir esse veredito).
 *
 * ─── Idempotência ────────────────────────────────────────────────────────
 *
 * `applyRouteLabelPlan` (função pura auxiliar, usada só em teste/preview) é
 * idempotente por construção: `add` insere só o que falta, `remove` tira só
 * o que sobra — chamar duas vezes com o mesmo plano sobre o resultado já
 * convergido devolve o MESMO array (mesmo conjunto, comparado
 * ordenado — a ORDEM não é garantida estável entre chamadas).
 */

import { EXEC_TRACK_UI, DEPENDS_ON_BLOCK_LABEL, type ExecTrack } from "./issue-exec-track.ts";

/** Veredito que uma invocação de `route-issue.ts` pode pedir — mesmo union de
 * `ExecTrack` (`issue-exec-track.ts`), re-exportado com o nome que o CLI usa
 * (`--track`) pra deixar claro, no ponto de uso, que os dois são o MESMO
 * conjunto de valores por construção (não uma coincidência a manter
 * sincronizada à mão — é um alias de tipo, não uma redeclaração). */
export type RouteTrack = ExecTrack;

/** Todos os valores válidos de `--track`, na mesma ordem/fonte de
 * `EXEC_TRACK_UI` — usado pelo CLI pra validar o argumento sem duplicar a
 * lista de strings à mão. */
export const ROUTE_TRACKS: readonly RouteTrack[] = EXEC_TRACK_UI.map((e) => e.track);

/**
 * União de toda label que este roteador gerencia — candidata a ser
 * ADICIONADA por algum veredito, ou REMOVIDA como sinal conflitante de outro
 * veredito. Cada literal aqui é citado por `classifyExecTrack`
 * (`scripts/lib/issue-exec-track.ts`) como parte de um dos Sets que decidem
 * o veredito — não uma lista nova, uma cópia dos literais que já existem
 * lá, mantida sincronizada pelo teste de round-trip (ver docstring do
 * módulo).
 *
 * #6197 (3a) — as 5 labels abaixo foram ADICIONADAS:
 * `epic-guarda-chuva`, `decisao-registrada`, `alarm`, `alarm-evento`,
 * `sem-direcao-acionavel`. Antes, estavam "donas de outro mecanismo" e
 * não podiam ser aplicadas via verbo — #6197 mostra casos reais onde
 * precisavam (épica decomposta, alarme de estado, etc.). Agora o editor
 * pode aplicá-las explicitamente via `--motivo`, e o round-trip garante
 * que o `track` resultante bate com o pedido.
 */
export const ROUTABLE_LABELS: readonly string[] = [
  // fora-de-rodada — OUT_OF_ROUND_LABELS
  "on-hold",
  "wontfix",
  // bloqueada — BLOCKED_LABELS + companheira credencial-escopo + DEFERRED_LABELS
  "external-blocker",
  "kit-migration",
  "beehiiv",
  "bloqueio-execucao",
  // #7316 review (P1) — DEPENDS_ON_BLOCK_LABEL ("dependencia-aberta", #7137)
  // faltava aqui apesar de já estar em BLOCKED_LABELS (issue-exec-track.ts)
  // desde a #7270 passar a poder aplicá-la via `--depends-on`. Sem entrar em
  // ROUTABLE_LABELS, `planRouteLabels` nunca a inclui no conjunto `remove`
  // (que é inteiramente derivado desta lista) — uma issue que ganhasse
  // `dependencia-aberta` ficaria PRESA em `bloqueada` pra sempre, mesmo
  // roteada depois pra `develop`/`overnight`/qualquer outro track, porque
  // `classifyExecTrack` checa BLOCKED_LABELS antes de qualquer outro
  // veredito — o EXATO defeito que esta PR existe pra corrigir, reproduzido
  // dentro da própria correção. Ver test "round-trip — dependencia-aberta
  // é removida ao rotear pra outro track" em test/issue-route.test.ts.
  DEPENDS_ON_BLOCK_LABEL,
  "credencial-escopo",
  "not-this-week",
  "next-month",
  // develop — MACHINE_DEVELOP_LABELS + DEVELOP_HUMAN_BLOCK_LABEL
  "windows",
  "develop-track",
  // overnight — #7493: `trade-off-real` migrou do grupo develop pra cá. A
  // label continua ROTEÁVEL (aplicável/removível pelo verbo), só mudou o
  // veredito que ela produz em `classifyExecTrack`: overnight (entra na fila
  // de perguntas do briefing da Fase 0), não develop cat. C.
  "trade-off-real",
  // #6197 (3a) — labels de mecanismos paralelos que o verbo agora pode aplicar:
  // RESOLVED_BY_PROSE_LABELS (fora-de-rodada) + ALARM_EVENT_LABEL (overnight)
  "epic-guarda-chuva",
  "decisao-registrada",
  "alarm",
  "alarm-evento",
  "sem-direcao-acionavel",
];

/** #6223 — Labels de PROVENIÊNCIA, nunca removidas por `route-issue`. São
 * gerenciadas por outro mecanismo (`alarm-issues.ts`, `issue-decisions.ts`)
 * e registram de onde/de como uma issue chegou a um veredito, não o veredito
 * em si. Removê-las ao rotear apagava esse estado sem ganho de corretude. */
export const PROVENIENCE_LABELS: readonly string[] = [
  "alarm",
  "alarm-evento",
  "decisao-registrada",
];

/**
 * Mapeamento estruturado de `--motivo` → label (#6197 item 2).
 *
 * `--motivo` é um argumento opcional do verbo que seleciona a label Mais
 * específica pra um veredito, em vez de deixar o `TRACK_ADD_LABEL` escolher
 * a genérica. Ex.: `--track bloqueada --motivo conta-de-terceiro` aplica
 * `external-blocker` (não `bloqueio-execucao`). Pra épica, use `--track
 * epica` diretamente (#6201) — `TRACK_ADD_LABEL.epica` já aplica
 * `epic-guarda-chuva` sem precisar de `--motivo`.
 *
 * A escolha de cada motivo mapeia pra exatamente uma label que
 * `classifyExecTrack` reconhece — garantido pelo teste de round-trip:
 * aplicar o plano → `classifyExecTrack` devolve o track pedido.
 *
 * `credencial` NÃO está aqui: `credencial-escopo` sozinha classifica
 * `overnight` (não `bloqueada`) — só faz sentido PAIADA com
 * `external-blocker` (downgrade de `bloqueada` → `develop`, cat. A, #5694).
 * Pra aplicar o par, use `--motivo conta-de-terceiro` (que adiciona
 * `external-blocker`): o `credencial-escopo` sobrevive no plano só se já
 * estiver na issue.
 *
 * `not-this-week`/`next-month` (#6272) — motivo = label (nome idêntico, ao
 * contrário dos demais): são as duas únicas entradas cujo veredito
 * (`bloqueada`) `routeIssue` (`scripts/route-issue.ts`) PAREIA
 * automaticamente com um marcador `aguardando-ate:` auto-computado (ver
 * `VAGUE_DEFERRAL_AUTO_DEFER_DAYS` abaixo) — o gap que a #6272 fechou: antes,
 * a única forma de aplicar estas duas labels era `gh issue edit` manual, sem
 * nenhum mecanismo de expiração.
 */
export const MOTIVO_LABEL: Readonly<Record<string, string>> = {
  // bloqueada
  "conta-de-terceiro": "external-blocker",
  "plataforma": "beehiiv",
  "kit": "kit-migration",
  "execucao": "bloqueio-execucao",
  // #7270 — bloqueio por DEPENDÊNCIA de outra issue usa a label dedicada
  // `dependencia-aberta` (#7137), não a genérica `bloqueio-execucao`. Auto-
  // derivado por `routeIssue` (`scripts/route-issue.ts`) quando `--depends-on`
  // é passado sem `--motivo` explícito — ver docstring de `routeIssue`.
  "dependencia": "dependencia-aberta",
  "not-this-week": "not-this-week",
  "next-month": "next-month",
  // epica — #6201: `epic-guarda-chuva` ganhou track próprio (era motivo de
  // `fora-de-rodada`). O motivo `epica` continua aqui por compatibilidade
  // (`--track epica --motivo epica` é equivalente a `--track epica` sozinho,
  // já que `TRACK_ADD_LABEL.epica` aplica a mesma label por default) —
  // nenhum caller precisa dele, mas remover quebraria uma chamada antiga
  // que ainda passasse `--motivo epica` explicitamente.
  "epica": "epic-guarda-chuva",
  // fora-de-rodada
  "sem-direcao": "sem-direcao-acionavel",
  "decisao": "decisao-registrada",
  "alarme-estado": "alarm",
  // overnight
  "alarme-evento": "alarm-evento",
  // #7493 — o único motivo que APLICA uma label mantendo o veredito
  // `overnight`. Existe porque o briefing precisa registrar "já triei: é
  // trade-off real, mas o editor respondeu 'decido depois'" de forma durável;
  // sem ele, a issue voltaria ao briefing seguinte indistinguível de uma que
  // ninguém olhou (`matched: "default"`), e o julgamento seria refeito do
  // zero a cada rodada — exatamente o que `issue-decisions.ts` (#5373) evita.
  "trade-off": "trade-off-real",
};

/**
 * #6272 — "not-this-week"/"next-month" são deferimento VAGO (sem data): a
 * #6272 identificou que essas duas labels não tinham mecanismo de retorno —
 * uma vez aplicadas, a issue ficava `bloqueada` pra sempre até o editor
 * lembrar de remover a label à mão (achado: 10 issues, todas aplicadas
 * manualmente em 48h, #6191). `routeIssue` (`scripts/route-issue.ts`) usa
 * este mapa pra parear a label com um marcador `aguardando-ate:`
 * auto-computado (`now + N dias`) sempre que `--track bloqueada --motivo`
 * for uma destas duas chaves — o marcador **desarma sozinho** (mecanismo já
 * existente e testado de `wait-until-sync.ts`), e o padrão 1 de
 * `backlog-reconcile.ts` (#6198, marcador × label de deferimento em
 * conflito) já sabe resolver a coexistência: enquanto o marcador for futuro,
 * ele vence na precedência de `classifyExecTrack` (`agendada` antes de
 * `bloqueada`, passo 4 < passo 5) e a reconciliação diária remove a label
 * vaga como sinal obsoleto; expirado o marcador, a issue volta sozinha ao
 * fluxo normal (`overnight`) sem ninguém precisar lembrar. Nenhuma lógica
 * NOVA de expiração foi necessária em `backlog-reconcile.ts` — só garantir
 * que o marcador exista desde a escrita, que é o que faltava.
 *
 * `next-month` usa 30 dias (não um cálculo de calendário exato — "~1 mês" é
 * granularidade suficiente pro propósito de "reaparecer na fila", igual ao
 * resto do mecanismo, que já trabalha em dias corridos, não em meses de
 * calendário).
 */
export const VAGUE_DEFERRAL_AUTO_DEFER_DAYS: Readonly<Record<string, number>> = {
  "not-this-week": 7,
  "next-month": 30,
};

/** Labels de bloqueio específicas que `route-issue.ts` preserva ao rotear
 * pra `bloqueada` sem `--motivo` (3b) — a issue já carrega o sinal certo,
 * não há porque substituí-lo pela genérica `bloqueio-execucao`.
 *
 * NÃO inclui `credencial-escopo` (não é `BLOCKED_LABELS`, classifica
 * `overnight` sozinha) nem `bloqueio-execucao` (é a genérica — se já
 * existe, não precisa adicionar nada). `DEPENDS_ON_BLOCK_LABEL`
 * (`dependencia-aberta`, #7137) entrou no #7316 review — mesmo motivo das
 * outras 3: preservar o sinal específico em vez de substituí-lo pela
 * genérica ao re-rotear sem `--motivo` explícito. */
const BLOCKED_SPECIFIC_LABELS = new Set([
  "external-blocker",
  "kit-migration",
  "beehiiv",
  DEPENDS_ON_BLOCK_LABEL,
]);

/**
 * Label canônica ADICIONADA por veredito — a mais genérica/segura das
 * opções que produzem aquele track em `classifyExecTrack`, escolhida porque
 * `route-issue.ts` não recebe motivo estruturado o bastante pra escolher
 * entre alternativas mais específicas (`windows` e `develop-track` produzem
 * `develop`; `develop-track` é a única sem pré-condição adicional — não
 * presume máquina específica). `--reason` (texto livre, vira comentário na issue)
 * é onde o motivo específico fica registrado em prosa; a label continua
 * genérica de propósito.
 *
 * `agendada` não tem entrada aqui — ver docstring do módulo ("único
 * veredito sem label"). `overnight` também não tem: é o default de
 * `classifyExecTrack` quando nenhuma label de `ROUTABLE_LABELS` está
 * presente, então "rotear pra overnight" é só limpar as outras — quem quiser
 * o overnight COM sinal positivo (#7493) passa `--motivo trade-off`, que
 * aplica `trade-off-real` sem sair do track.
 */
const TRACK_ADD_LABEL: Partial<Record<RouteTrack, string>> = {
  develop: "develop-track",
  bloqueada: "bloqueio-execucao",
  // #6201 — `epica` é o único veredito onde a label default e a única opção
  // plausível são a mesma coisa (`epic-guarda-chuva`); diferente de
  // `bloqueada`/`develop`, não há uma 2ª label mais específica a escolher
  // via `--motivo` sem que ela seja, na prática, o mesmo literal.
  epica: "epic-guarda-chuva",
  "fora-de-rodada": "on-hold",
};

export interface RouteLabelPlan {
  /** Labels a adicionar (0 ou 1 — nunca mais de uma, ver `TRACK_ADD_LABEL`). */
  readonly add: readonly string[];
  /** Labels a remover — todo o resto de `ROUTABLE_LABELS`, pra nenhum sinal
   * conflitante de um veredito anterior sobreviver à troca. */
  readonly remove: readonly string[];
}

/** Tipo `|`-union explícito pra `--motivo` (chaves de `MOTIVO_LABEL`). */
export type RouteMotivo = keyof typeof MOTIVO_LABEL;

/**
 * Mapeamento puro veredito→labels. Não faz I/O, não conhece o estado atual
 * da issue — devolve sempre o MESMO plano pro mesmo `track` (determinístico,
 * por isso idempotente: aplicar o mesmo plano duas vezes sobre o estado já
 * convergido não muda nada).
 *
 * `motivo` (#6197 item 2) substitui a label genérica do veredito pela mais
 * específica: `--track bloqueada --motivo conta-de-terceiro` adiciona
 * `external-blocker` (não `bloqueio-execucao`). Sem `motivo`, usa o
 * default genérico de `TRACK_ADD_LABEL`.
 */
/**
 * `labelsForNewIssue` (#6205) — o subconjunto de `planRouteLabels` útil na
 * CRIAÇÃO de uma issue nova, quando não existe estado anterior a diffar
 * contra (não há `remove` — a issue ainda não tem nenhuma label). Devolve
 * só `add`, pronto pra `gh issue create --label {labelsForNewIssue(...).join(",")}`.
 *
 * `track === "agendada"` não tem label própria (ver docstring do módulo) —
 * `add` sai vazio; o CALLER precisa inserir o marcador `aguardando-ate:` no
 * CORPO da issue separadamente (`upsertWaitUntilMarker`,
 * `scripts/lib/wait-until-sync.ts`) — este helper não conhece o corpo.
 */
export function labelsForNewIssue(track: RouteTrack, motivo?: RouteMotivo): readonly string[] {
  return planRouteLabels(track, motivo).add;
}

export function planRouteLabels(track: RouteTrack, motivo?: RouteMotivo): RouteLabelPlan {
  if (motivo && !(motivo in MOTIVO_LABEL)) {
    throw new Error(`--motivo desconhecido: "${motivo}". Válidos: ${Object.keys(MOTIVO_LABEL).join(", ")}`);
  }
  const addLabel = motivo ? MOTIVO_LABEL[motivo] : TRACK_ADD_LABEL[track];
  const addList = addLabel ? [addLabel] : [];
  const remove = ROUTABLE_LABELS.filter(
    (l) => !addList.includes(l) && !(PROVENIENCE_LABELS as readonly string[]).includes(l),
  );
  return { add: addList, remove };
}

/**
 * Auto-deriva `--motivo` a partir das labels atuais da issue (#6197 item 3b).
 * Quando o editor roteia pra `bloqueada` sem `--motivo` e a issue já carrega
 * uma label específica de bloqueio (`external-blocker`, `kit-migration`,
 * `beehiiv`), preserva-a em vez de substituir por `bloqueio-execucao`.
 *
 * Retorna `undefined` quando não há motivo a derivar — aí o caller usa o
 * `TRACK_ADD_LABEL` genérico.
 */
export function autoMotivoForTrack(track: RouteTrack, currentLabels: readonly string[]): RouteMotivo | undefined {
  if (track === "bloqueada") {
    const found = currentLabels.find((l) => BLOCKED_SPECIFIC_LABELS.has(l));
    if (found) {
      return Object.entries(MOTIVO_LABEL).find(([, label]) => label === found)?.[0] as RouteMotivo | undefined;
    }
  }
  return undefined;
}

/**
 * Aplica um `RouteLabelPlan` a um array de labels atuais, devolvendo o
 * próximo estado — função pura auxiliar usada por teste (idempotência) e
 * pelo preview do CLI (`--dry-run`, se algum dia existir). O CALLER real
 * (`scripts/route-issue.ts`) não usa isto pra decidir o que mandar pro
 * `gh` — ele calcula o diff (`add` que falta, `remove` que sobra) direto
 * contra as labels atuais da issue, pra só emitir `gh issue edit` quando
 * há mudança real (evita side-effect vazio e barulho de auditoria).
 */
export function applyRouteLabelPlan(currentLabels: readonly string[], plan: RouteLabelPlan): string[] {
  const kept = currentLabels.filter((l) => !plan.remove.includes(l));
  const next = new Set(kept);
  for (const l of plan.add) next.add(l);
  return [...next];
}

/** Diff entre o estado atual e o alvo do plano — só o que precisa mudar de
 * verdade. `toAdd`/`toRemove` vêm SEMPRE ordenados (determinístico pra
 * teste e pra log), mesmo que a ordem não importe pro `gh`. */
export function diffRouteLabelPlan(
  currentLabels: readonly string[],
  plan: RouteLabelPlan,
): { toAdd: string[]; toRemove: string[] } {
  const current = new Set(currentLabels);
  const toAdd = plan.add.filter((l) => !current.has(l)).sort();
  const toRemove = plan.remove.filter((l) => current.has(l)).sort();
  return { toAdd, toRemove };
}

// ─── Marcador `<!-- route-issue: track=X -->` (#6283) ──────────────────────
//
// `routeIssue` (`scripts/route-issue.ts`, `buildCommentBody`) sempre prefixa
// o comentário de roteamento com este marcador. Exportar o par
// formatador/parser aqui (em vez de deixá-lo só como literal inline em
// `route-issue.ts`) permite que outros consumidores detectem "esta issue já
// tem um roteamento explícito posterior a X" sem duplicar o formato — mesmo
// motivo de `parseDecisionMarkers` (`issue-decisions.ts`) ser exportado.
// Consumidor concreto: `scripts/lib/decision-label-drift.ts`, que usa
// `parseRouteIssueMarker` pra não reportar drift quando um `route-issue`
// mais recente que o comentário candidato já resolveu o veredito (julgamento
// registrado por quem tem contexto vence heurística de regex — mesma
// disciplina de `issue-decisions.ts`).

const ROUTE_ISSUE_MARKER_PREFIX = "<!-- route-issue: track=";
const ROUTE_ISSUE_MARKER_SUFFIX = " -->";

/** Constrói o marcador `<!-- route-issue: track=X -->` — fonte única do
 * formato, usada tanto por quem grava (`route-issue.ts`) quanto por quem lê
 * (`parseRouteIssueMarker` abaixo). */
export function formatRouteIssueMarker(track: RouteTrack): string {
  return `${ROUTE_ISSUE_MARKER_PREFIX}${track}${ROUTE_ISSUE_MARKER_SUFFIX}`;
}

/**
 * Extrai o `track` do marcador `<!-- route-issue: track=X -->` de um corpo
 * de comentário, se presente e válido (um dos `ROUTE_TRACKS`). Tolerante a
 * marcador ausente ou malformado — nunca lança, devolve `null` — mesma
 * postura de `parseDecisionMarkers` (`issue-decisions.ts`). Um body pode
 * conter no máximo 1 marcador (é sempre o prefixo do comentário gerado por
 * `routeIssue`); o primeiro encontrado é o único considerado.
 */
export function parseRouteIssueMarker(body: string): RouteTrack | null {
  const start = body.indexOf(ROUTE_ISSUE_MARKER_PREFIX);
  if (start === -1) return null;
  const trackStart = start + ROUTE_ISSUE_MARKER_PREFIX.length;
  const end = body.indexOf(ROUTE_ISSUE_MARKER_SUFFIX, trackStart);
  if (end === -1) return null;
  const track = body.slice(trackStart, end).trim();
  return (ROUTE_TRACKS as readonly string[]).includes(track) ? (track as RouteTrack) : null;
}

/**
 * Como `parseRouteIssueMarker`, mas só reconhece o marcador quando ele
 * ABRE o corpo do comentário (espaço em branco antes é tolerado) — não em
 * qualquer posição (#6301 finding 2 do fleet review da PR que introduziu
 * `decision-label-drift.ts` consumindo este marcador).
 *
 * Por quê: `buildCommentBody` (`scripts/route-issue.ts`) sempre grava o
 * marcador como a PRIMEIRA linha do comentário que `routeIssue` posta — é
 * invariante do formato real, não suposição (ver `buildCommentBody`: a
 * primeira entrada do array `lines` é sempre `formatRouteIssueMarker(track)`).
 * Um comentário humano ou de outra sessão que apenas CITE o literal em
 * prosa como exemplo ("o marcador `<!-- route-issue: track=develop -->`
 * já...") — coisa comum neste repo, que cita literais de código em prosa o
 * tempo todo — faz isso no MEIO do texto, nunca na abertura. A posição
 * estrutural distingue os dois casos sem heurística de conteúdo nenhuma.
 *
 * `parseRouteIssueMarker` genérico (usado só por este arquivo — nenhum
 * outro consumidor real hoje) continua tolerante a qualquer posição; esta
 * variante é a que `decision-label-drift.ts` usa pra decidir supressão, que
 * é o único lugar onde a posição importa pra corretude.
 */
export function parseRouteIssueMarkerAtStart(body: string): RouteTrack | null {
  const track = parseRouteIssueMarker(body);
  if (track === null) return null;
  const prefixIndex = body.indexOf(ROUTE_ISSUE_MARKER_PREFIX);
  return body.slice(0, prefixIndex).trim() === "" ? track : null;
}
