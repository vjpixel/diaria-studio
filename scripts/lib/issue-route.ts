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
 * ─── Labels de fora do escopo deste roteador ────────────────────────────────
 *
 * `ROUTABLE_LABELS` deliberadamente NÃO inclui labels donas de outro
 * mecanismo: `alarm`/`alarm-evento` (owned by `scripts/lib/alarm-issues.ts`),
 * `decisao-registrada` (owned by `scripts/lib/issue-decisions.ts`),
 * `epic-guarda-chuva`/`sem-direcao-acionavel` (fluxo dedicado da própria
 * #5968). `route-issue.ts` roteia trabalho vivo (quem pega a issue a
 * seguir), não re-implementa "essa issue já foi resolvida por outro
 * caminho" — misturar os dois faria este verbo pisar em estado que outro
 * script já gerencia com sua própria idempotência/dedup.
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

import { EXEC_TRACK_UI, type ExecTrack } from "./issue-exec-track.ts";

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
  "credencial-escopo",
  "not-this-week",
  "next-month",
  // develop — MACHINE_DEVELOP_LABELS + TRADE_OFF_LABEL + DEVELOP_HUMAN_BLOCK_LABEL
  "windows",
  "trade-off-real",
  "develop-track",
  // #6197 (3a) — labels de mecanismos paralelos que o verbo agora pode aplicar:
  // RESOLVED_BY_PROSE_LABELS (fora-de-rodada) + ALARM_EVENT_LABEL (overnight)
  "epic-guarda-chuva",
  "decisao-registrada",
  "alarm",
  "alarm-evento",
  "sem-direcao-acionavel",
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
 */
export const MOTIVO_LABEL: Readonly<Record<string, string>> = {
  // bloqueada
  "conta-de-terceiro": "external-blocker",
  "plataforma": "beehiiv",
  "kit": "kit-migration",
  "execucao": "bloqueio-execucao",
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
};

/** Labels de bloqueio específicas que `route-issue.ts` preserva ao rotear
 * pra `bloqueada` sem `--motivo` (3b) — a issue já carrega o sinal certo,
 * não há porque substituí-lo pela genérica `bloqueio-execucao`.
 *
 * NÃO inclui `credencial-escopo` (não é `BLOCKED_LABELS`, classifica
 * `overnight` sozinha) nem `bloqueio-execucao` (é a genérica — se já
 * existe, não precisa adicionar nada). */
const BLOCKED_SPECIFIC_LABELS = new Set([
  "external-blocker",
  "kit-migration",
  "beehiiv",
]);

/**
 * Label canônica ADICIONADA por veredito — a mais genérica/segura das
 * opções que produzem aquele track em `classifyExecTrack`, escolhida porque
 * `route-issue.ts` não recebe motivo estruturado o bastante pra escolher
 * entre alternativas mais específicas (`windows` vs `trade-off-real` vs
 * `develop-track` todos produzem `develop`; `develop-track` é a única sem
 * pré-condição adicional — não presume máquina específica nem julgamento de
 * trade-off já feito). `--reason` (texto livre, vira comentário na issue)
 * é onde o motivo específico fica registrado em prosa; a label continua
 * genérica de propósito.
 *
 * `agendada` não tem entrada aqui — ver docstring do módulo ("único
 * veredito sem label"). `overnight` também não tem: é o default de
 * `classifyExecTrack` quando nenhuma label de `ROUTABLE_LABELS` está
 * presente, então "rotear pra overnight" é só limpar as outras.
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
export function planRouteLabels(track: RouteTrack, motivo?: RouteMotivo): RouteLabelPlan {
  if (motivo && !(motivo in MOTIVO_LABEL)) {
    throw new Error(`--motivo desconhecido: "${motivo}". Válidos: ${Object.keys(MOTIVO_LABEL).join(", ")}`);
  }
  const addLabel = motivo ? MOTIVO_LABEL[motivo] : TRACK_ADD_LABEL[track];
  const addList = addLabel ? [addLabel] : [];
  const remove = ROUTABLE_LABELS.filter((l) => !addList.includes(l));
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
