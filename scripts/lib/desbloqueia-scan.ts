/**
 * scripts/lib/desbloqueia-scan.ts (#6628)
 *
 * Miolo puro (sem I/O) de `/diaria-desbloqueia`. Responde, por issue
 * candidata — `bloqueada`, `develop`, `overnight` com `matched: "default"`
 * (#7694), ou `fora-de-rodada` não-engavetada (#7708) —, uma pergunta: **a
 * thread já resolve isso, ou ainda falta algo do editor?**
 *
 * Existe porque as duas superfícies que já coletam desbloqueio do editor
 * (`/diaria-develop` Fase 0.5, `/diaria-overnight` briefing da Fase 0) só
 * fazem isso acopladas a uma sessão que também vai IMPLEMENTAR em seguida —
 * não há como só destravar e sair. E as duas classificam a partir de
 * corpo+labels; nenhuma lê a thread de comentário INTEIRA antes de decidir
 * se ainda falta perguntar, o que faz o coordenador perguntar de novo algo
 * que um comentário anterior já respondeu (exatamente o problema que
 * `scripts/lib/issue-decisions.ts`, #5373, existe pra evitar — mas só se
 * alguém consultar os marcadores ANTES de perguntar).
 *
 * ## As 8 saídas
 *
 *   - `ja-destravada`      — existe `decisao-editor` e ela é o marcador MAIS
 *     RECENTE da thread (seu `decided_at` não é anterior ao `recorded_at`
 *     de um eventual `bloqueio-execucao`). A decisão que resolve o
 *     trade-off já está na thread; nenhuma pergunta nova é necessária — o
 *     chamador re-rotea direto (`route-issue.ts`).
 *   - `bloqueio-confirmado` — existe um `bloqueio-execucao` mais recente que
 *     qualquer `decisao-editor` presente (ou sem decisão nenhuma). O que
 *     falta já está documentado (token que não chegou, conta que não
 *     existe) — perguntar de novo não muda nada; o chamador comenta
 *     lembrando o estado e segue sem pergunta.
 *   - `precisa-pergunta`   — nem decisão nem bloqueio recentes cobrem o
 *     estado atual da issue. Candidata real à bateria de `AskUserQuestion`.
 *   - `bloqueio-obsoleto`  — o bloqueio declarava `condicao.tipo:
 *     "depends_on"` e a issue apontada JÁ FECHOU (#7707). A condição foi
 *     satisfeita; o bloqueio não vale mais. O chamador roteia pra fora de
 *     `bloqueada`, nunca comenta "segue valendo".
 *   - `acao-imediata-candidata` — SÓ pra candidata `fora-de-rodada`
 *     (#7708): a issue saiu da fila por um mecanismo paralelo (alarme de
 *     estado, decisão em prosa, sem-direção) e ninguém avaliou se existe uma
 *     ação do editor que a destrava agora. Alimenta o pedido de ação
 *     imediata do playbook.
 *   - `acao-adiada`         — já pedimos a ação e o editor adiou; o cooldown
 *     (`ACAO_ADIADA_COOLDOWN_DAYS`) ainda vale (#7708). **Nunca** vira
 *     pergunta — é o que impede a skill de repetir a mesma bateria a cada
 *     rodada e queimar a paciência do editor em duas execuções.
 *   - `sem-sinal-nao-triada` — SÓ pra candidata `sem sinal` (#7694): a thread
 *     não tem marcador nenhum e nenhuma label classificou a issue. Não é
 *     "precisa perguntar" — é "ninguém olhou ainda". Vira TRIAGEM (o
 *     playbook lê título+corpo e decide o track), nunca pergunta automática:
 *     despejar 26 issues não-triadas na bateria de `AskUserQuestion` é
 *     exatamente o que "Perguntar é exceção" (#5321) proíbe.
 *   - `erro-leitura`       — o caller não conseguiu ler a thread completa
 *     (`commentsFetchError` preenchido, ex: `gh issue view` falhou, JSON
 *     malformado). **Nunca** vira `precisa-pergunta` mesmo que `comments`
 *     esteja vazio — um `[]` por falha de leitura é indistinguível de um
 *     `[]` genuíno pra quem só olha o array, e tratar os dois igual
 *     perguntaria de novo algo que a thread pode já ter respondido (achado
 *     do fleet review do PR #6632: a garantia central desta skill —
 *     "nunca pergunta o que a thread já resolve" — dependia de `comments`
 *     estar completo, e nada distinguia "0 porque vazio" de "0 porque a
 *     leitura falhou"). O chamador NUNCA pergunta pra esta issue — reporta
 *     o erro e sugere retry.
 *
 * ## #7694 — o bucket `overnight ·sem sinal` entra no escopo
 *
 * Até a #7694 o filtro era `track !== "bloqueada" && track !== "develop"` →
 * `null`, e TODA issue `overnight` saía sem uma única leitura de comentário.
 * Isso deixava de fora justamente o bucket mais provável de esconder um
 * bloqueio: o `matched: "default"` (badge `·sem sinal` do painel Triagem) —
 * nenhuma label/marcador classificou a issue, ou seja **ninguém olhou**. Uma
 * issue genuinamente bloqueada a que ninguém aplicou a label ficava invisível
 * pra esta skill, o `helios` tentava executá-la e falhava (medição de
 * 08/09/2026: 26 das 68 abertas estavam nesse bucket, contra 9 candidatas no
 * escopo antigo).
 *
 * O escopo passa a incluir `overnight` **quando, e só quando**, `matched`
 * for `"default"`. `overnight` com sinal positivo (`trade-off-real`,
 * `alarm-evento`, `triada-overnight`, ...) continua fora: alguém já triou, e
 * o veredito dessa triagem é justamente "não há o que desbloquear aqui".
 * É por isso que a classificação usa `classifyExecTrackWithRule` e não
 * `classifyExecTrack` — o `track` sozinho não distingue os dois casos.
 *
 * Pra uma candidata `sem sinal`, a leitura da thread responde algo diferente
 * das demais — não "ainda falta perguntar?", mas "a thread contradiz a
 * ausência de label?":
 *
 *   - `bloqueio-execucao` recente na thread → `bloqueio-confirmado` com
 *     `escopo: "sem-sinal"`. **É o achado de maior valor desta extensão**: o
 *     bloqueio está documentado e a LABEL está faltando. Ação do playbook
 *     não é comentar "segue valendo" (como na candidata `bloqueada`), é
 *     `route-issue.ts --track bloqueada` pra corrigir a classificação.
 *   - `decisao-editor` recente → `ja-destravada`, igual às demais.
 *   - nenhum marcador → `sem-sinal-nao-triada` (triagem, nunca pergunta).
 *
 * ## Por que a comparação NÃO usa `updatedAt` (#6961)
 *
 * A versão original comparava `decided_at`/`recorded_at` contra o
 * `updatedAt` da issue ("a decisão cobre o estado ATUAL?"). Isso quebrava
 * por construção: o PRÓPRIO comentário que grava um marcador bumpa o
 * `updatedAt` da issue para o instante do POST — sempre um pouco DEPOIS do
 * `decided_at`/`recorded_at` embutido no payload (gerado antes de o
 * comentário ser de fato enviado). Toda decisão nascia comparando
 * `decided_at < updatedAt-do-seu-próprio-post` e caía em
 * `precisa-pergunta` — não uma corrida rara, o caso normal (medição: 6/6
 * marcadores gravados em 01/09/2026 voltaram como `precisa-pergunta` na
 * varredura seguinte). E nenhuma outra causa de `updatedAt` avançar (label,
 * comentário de rodada do overnight, `route-issue.ts`) invalida de fato uma
 * decisão do editor — comparar contra ela não protegia nada.
 *
 * A comparação correta é entre os DOIS marcadores em si: uma `decisao-editor`
 * vale enquanto não houver um `bloqueio-execucao` MAIS RECENTE que ela na
 * mesma thread (e vice-versa) — "o marcador não expira por tempo, só por
 * evento" (opção 3 da issue). Como `comments` já é a thread INTEIRA (nunca
 * uma amostra — ver `commentsFetchError` abaixo), um evento que reabrisse a
 * questão apareceria como um marcador mais novo, que `latestDecisionFor`/
 * `latestExecutionBlockFor` já capturam.
 *
 * Determinístico: recebe dados já buscados (`gh issue list`/`gh issue view`
 * com `--json`), sem rede, sem `gh`. O CLI wrapper (`scripts/desbloqueia-scan.ts`)
 * é a única camada de I/O.
 *
 * ## #7343 — o comentário de revisão do Passo 2 não renova o bloqueio
 *
 * A skill `/diaria-desbloqueia` Passo 2 comenta, pra cada `bloqueioConfirmado`:
 * "Revisado por /diaria-desbloqueia — bloqueio de execução de {recorded_at}
 * ("{motivo}") segue valendo, nenhuma mudança." Comentar move o `updatedAt`
 * da issue. A versão ORIGINAL (#6628) comparava `recorded_at` contra
 * `updatedAt` ("o bloqueio cobre o estado ATUAL?"), então na execução seguinte
 * o marcador era mais antigo que o `updatedAt` e a issue caía em
 * `precisa-pergunta` — o único grupo que vira pergunta, exatamente o que a
 * skill existe pra evitar. Nada tinha de fato mudado na issue.
 *
 * #6961 corrigiu a comparação pra ser entre os DOIS marcadores, nunca
 * contra `updatedAt` — e isso corrige o sintoma: um comentário de revisão
 * sem marcador não é um evento pra essa comparação, então o bloqueio segue
 * confirmado. Premissa registrada (decisão do editor, #7343): **o único
 * sinal que renova um `bloqueio-execucao` é um NOVO marcador
 * `bloqueio-execucao` mais recente na thread** — um comentário de revisão
 * em prosa, mesmo citando o `recorded_at` no texto, nunca renova. Se um
 * estado de fato mudou, o mecanismo correto é `route-issue.ts --track
 * bloqueada` (que embute um novo marcador), não um comentário em prosa.
 */
import {
  classifyExecTrackWithRule,
  ENGAVETADAS_LABELS,
  type ExecTrack,
  type ExecTrackInput,
} from "./issue-exec-track.ts";
import {
  isAcaoAdiadaAtiva,
  latestAcaoAdiadaFor,
  latestDecisionFor,
  latestExecutionBlockFor,
  type AcaoAdiada,
  type ExecutionBlock,
  type IssueDecision,
} from "./issue-decisions.ts";

export type DesbloqueioStatus =
  | "ja-destravada"
  | "bloqueio-confirmado"
  | "bloqueio-obsoleto"
  | "precisa-pergunta"
  | "sem-sinal-nao-triada"
  | "acao-imediata-candidata"
  | "acao-adiada"
  | "erro-leitura";

/**
 * De qual bucket do backlog a candidata veio. Determina o que "a thread não
 * tem marcador nenhum" SIGNIFICA — e portanto o que o playbook faz com ela:
 *
 *   - `bloqueada`/`develop` — alguém já determinou que há um bloqueio, e a
 *     thread não diz qual → `precisa-pergunta`.
 *   - `sem-sinal` (#7694) — ninguém classificou nada → `sem-sinal-nao-triada`,
 *     que é TRIAGEM, não pergunta.
 *   - `fora-de-rodada` (#7708) — a issue foi tirada da fila por um mecanismo
 *     paralelo (alarme de estado, decisão em prosa, sem-direção) e ninguém
 *     avaliou se existe uma ação do editor que a destrava agora →
 *     `acao-imediata-candidata`.
 *
 * Sem este campo os três colapsariam em `precisa-pergunta`, e a bateria de
 * `AskUserQuestion` receberia o backlog inteiro.
 */
export type DesbloqueioEscopo = "bloqueada" | "develop" | "sem-sinal" | "fora-de-rodada";

export interface DesbloqueioIssueInput {
  number: number;
  title: string;
  labels: string[];
  body: string | null;
  state: string;
  /** ISO 8601 — `updatedAt` de `gh issue view --json updatedAt`. Mantido na
   * entrada por ser um campo padrão de toda leitura de issue (auditoria,
   * logging do chamador), mas `classifyDesbloqueioCandidate` NÃO o usa mais
   * na decisão (#6961 — ver docstring do módulo acima). */
  updatedAt: string;
  /** Bodies de TODOS os comentários da issue, na ordem — não um subconjunto.
   * Se a leitura falhou, o caller passa `[]` aqui E preenche
   * `commentsFetchError` — nunca finge que a thread está vazia. */
  comments: string[];
  /** Motivo pelo qual `comments` pode não representar a thread real (ex:
   * `gh issue view` retornou status != 0, JSON malformado). `null`/ausente
   * = leitura OK. Presente = `classifyDesbloqueioCandidate` força
   * `erro-leitura`, nunca deixa cair em `precisa-pergunta` por engano. */
  commentsFetchError?: string | null;
  /**
   * #7707 — estado da issue apontada por um `bloqueio-execucao` cuja
   * `condicao.tipo` é `"depends_on"`. Resolvido pelo CALLER (é I/O; este
   * módulo é puro), `undefined` quando não há dependência a resolver.
   *
   * `"missing"` (a issue apontada não existe) NUNCA vira `bloqueio-obsoleto`:
   * um marcador apontando pra issue inexistente é dado corrompido, e
   * tratá-lo como "dependência satisfeita" desbloquearia por engano — o
   * oposto exato do defeito que a #7707 corrige.
   */
  dependencyState: "open" | "closed" | "missing" | null;
  /** #7708 — `true` quando `on-hold`/`wontfix` também devem ser varridas
   * (`--incluir-engavetadas`). Default `false`: engavetada pelo editor não
   * se repergunta a cada rodada. */
  incluirEngavetadas?: boolean;
  /** Injetável pra teste; default `new Date()`. */
  now?: Date;
}

export interface DesbloqueioCandidate {
  number: number;
  title: string;
  track: ExecTrack;
  /** Regra que decidiu o `track` (`ExecTrackResult.matched`) — o playbook
   * relata o valor MECÂNICO, nunca prosa (guard do Passo 5 da SKILL, #573). */
  matched: string;
  /**
   * De qual bucket a candidata veio — ver `DesbloqueioEscopo`. Muda a AÇÃO
   * do playbook mesmo para o MESMO status: um `bloqueio-confirmado` com
   * escopo `sem-sinal` não é "bloqueio já conhecido, só revisar", é
   * "bloqueio documentado na thread e label FALTANDO, rotear pra
   * `bloqueada`" (#7694).
   */
  escopo: DesbloqueioEscopo;
  /** #7708 — o adiamento mais recente na thread, se houver. Preenchido
   * mesmo quando o cooldown já expirou (`status` deixa de ser
   * `acao-adiada`): a repergunta cita o que já foi pedido antes em vez de
   * recomeçar do zero. */
  acaoAdiada: AcaoAdiada | null;
  status: DesbloqueioStatus;
  decision: IssueDecision | null;
  executionBlock: ExecutionBlock | null;
  /** Quantos comentários o classificador recebeu como input — prova que
   * ele não amostrou um subconjunto do que foi passado. NÃO prova, por si
   * só, que a busca capturou 100% dos comentários reais da issue (essa
   * garantia depende do caller nunca mascarar falha de leitura como lista
   * vazia — ver `commentsFetchError`). */
  commentsRead: number;
  /** Espelha `DesbloqueioIssueInput.commentsFetchError` — `null` quando a
   * leitura foi OK. */
  commentsFetchError: string | null;
}

/**
 * Resolve de qual bucket a issue veio, ou `null` se ela está fora do escopo
 * desta skill. Puro — separado de `classifyDesbloqueioCandidate` pra o CLI
 * poder filtrar na passada 1 (antes de gastar um `gh issue view` por
 * candidata) usando exatamente a mesma regra que o miolo aplica depois.
 */
export function resolveDesbloqueioEscopo(
  input: Pick<DesbloqueioIssueInput, "labels" | "body" | "state" | "incluirEngavetadas" | "now">,
): { escopo: DesbloqueioEscopo; track: ExecTrack; matched: string } | null {
  const trackInput: ExecTrackInput = {
    labels: input.labels,
    body: input.body,
    state: input.state,
    now: input.now,
  };
  const { track, matched } = classifyExecTrackWithRule(trackInput);
  // Vetada pela whitelist AAARRR: destrava editando `aarrr-whitelist.json`,
  // não respondendo pergunta — nunca vira candidata a AskUserQuestion.
  if (matched === "label:aarrr-fora-da-whitelist") return null;
  if (track === "bloqueada" || track === "develop") return { escopo: track, track, matched };
  // #7694 — `overnight` só entra pelo bucket `·sem sinal`. Com sinal
  // positivo (trade-off-real, alarm-evento, triada-overnight) já foi triado.
  if (track === "overnight" && matched === "default") return { escopo: "sem-sinal", track, matched };
  if (track === "fora-de-rodada") {
    // #7708 — `on-hold`/`wontfix` são engavetamento deliberado do editor;
    // só entram sob pedido explícito. As demais causas de `fora-de-rodada`
    // (alarme de estado, decisão em prosa, sem-direção) entram sempre.
    const engavetada = input.labels.some((l) => ENGAVETADAS_LABELS.has(l));
    if (engavetada && !input.incluirEngavetadas) return null;
    // Issue FECHADA também classifica `fora-de-rodada` (`state:closed`) e
    // nunca é candidata a nada — o filtro de escopo é sobre backlog ABERTO.
    if (matched === "state:closed") return null;
    return { escopo: "fora-de-rodada", track, matched };
  }
  return null;
}

/**
 * Classifica uma issue candidata. Devolve `null` quando ela está fora do
 * escopo desta skill — ver `resolveDesbloqueioEscopo` para a regra exata.
 */
export function classifyDesbloqueioCandidate(input: DesbloqueioIssueInput): DesbloqueioCandidate | null {
  const escopoInfo = resolveDesbloqueioEscopo(input);
  if (!escopoInfo) return null;
  const { escopo, track, matched } = escopoInfo;

  if (input.commentsFetchError) {
    return {
      number: input.number,
      title: input.title,
      track,
      matched,
      escopo,
      acaoAdiada: null,
      status: "erro-leitura",
      decision: null,
      executionBlock: null,
      commentsRead: input.comments.length,
      commentsFetchError: input.commentsFetchError,
    };
  }

  const decision = latestDecisionFor(input.comments);
  const executionBlock = latestExecutionBlockFor(input.comments);
  const acaoAdiada = latestAcaoAdiadaFor(input.comments);
  const adiamentoSuprime = isAcaoAdiadaAtiva(acaoAdiada, {
    now: input.now,
    blocoMaisRecente: executionBlock,
  });

  // #6961: comparação é entre os dois marcadores, nunca contra
  // `input.updatedAt` (ver docstring do módulo — o próprio POST do
  // marcador bumpa `updatedAt` para depois do timestamp embutido nele,
  // tornando `decided_at >= updatedAt` insatisfazível por construção).
  // Marcador MAIS RECENTE (por `decided_at`/`recorded_at`) vence; empate
  // favorece a decisão (sinal mais forte — resolução explícita do editor).
  const status = decideStatus({ decision, executionBlock, adiamentoSuprime, escopo, input });

  return {
    number: input.number,
    title: input.title,
    track,
    matched,
    escopo,
    acaoAdiada,
    status,
    decision,
    executionBlock,
    commentsRead: input.comments.length,
    commentsFetchError: null,
  };
}

function decideStatus(args: {
  decision: IssueDecision | null;
  executionBlock: ExecutionBlock | null;
  adiamentoSuprime: boolean;
  escopo: DesbloqueioEscopo;
  input: DesbloqueioIssueInput;
}): DesbloqueioStatus {
  const { decision, executionBlock, adiamentoSuprime, escopo, input } = args;

  // Decisão do editor mais recente que o bloqueio resolve a issue INTEIRA —
  // vence inclusive um adiamento ativo (o adiamento é sobre uma ação
  // pendente; a decisão diz que não há mais o que pender).
  if (decision && (!executionBlock || decision.decided_at >= executionBlock.recorded_at)) {
    return "ja-destravada";
  }

  if (executionBlock && (!decision || executionBlock.recorded_at > decision.decided_at)) {
    // #7707 — a condição declarada já foi satisfeita: a issue de que este
    // bloqueio dependia FECHOU. O bloqueio é obsoleto, não válido. Só
    // `"closed"` conta: `"missing"` é marcador podre (ver `dependencyState`)
    // e `"open"`/ausente mantêm o bloqueio de pé.
    if (executionBlock.condicao.tipo === "depends_on" && input.dependencyState === "closed") {
      return "bloqueio-obsoleto";
    }
    // Um adiamento ativo não apaga o bloqueio — só suprime a REPERGUNTA.
    // O `executionBlock` continua no candidate pra o relatório mostrar por
    // que a issue está parada.
    return adiamentoSuprime ? "acao-adiada" : "bloqueio-confirmado";
  }

  if (adiamentoSuprime) return "acao-adiada";

  // Sem marcador nenhum, o destino depende do BUCKET de origem — ver
  // `DesbloqueioEscopo`. Colapsar os três em `precisa-pergunta` jogaria o
  // backlog inteiro na bateria de `AskUserQuestion`, contra #5321.
  if (escopo === "sem-sinal") return "sem-sinal-nao-triada";
  if (escopo === "fora-de-rodada") return "acao-imediata-candidata";
  return "precisa-pergunta";
}

export interface DesbloqueioScanReport {
  jaDestravadas: DesbloqueioCandidate[];
  bloqueioConfirmado: DesbloqueioCandidate[];
  precisaPergunta: DesbloqueioCandidate[];
  /** #7707 — o bloqueio declarava depender de outra issue, e essa issue já
   * FECHOU. A condição foi satisfeita; o bloqueio é obsoleto. O playbook
   * roteia pra fora de `bloqueada`, nunca comenta "segue valendo". */
  bloqueioObsoleto: DesbloqueioCandidate[];
  /** #7694 — candidatas do bucket `overnight ·sem sinal` cuja thread não tem
   * marcador nenhum: ninguém triou. NÃO viram pergunta — o playbook lê
   * título+corpo e roteia (`triada-overnight` quando confirma o overnight,
   * `bloqueada`/`develop` quando descobre um bloqueio que faltava rotular). */
  semSinalNaoTriadas: DesbloqueioCandidate[];
  /** #7708 — candidatas do bucket `fora-de-rodada` (alarme de estado,
   * decisão em prosa, sem-direção) que ninguém avaliou pra ação imediata do
   * editor. O playbook lê e decide quais viram um pedido "faça isto agora";
   * as que não forem acionáveis ficam como estão, sem comentário. */
  acaoImediataCandidatas: DesbloqueioCandidate[];
  /** #7708 — já pedimos a ação e o editor adiou; o cooldown
   * (`ACAO_ADIADA_COOLDOWN_DAYS`) ainda vale. **Nunca** vira pergunta — é o
   * grupo que impede a skill de repetir as mesmas ~22 perguntas por rodada
   * e queimar a paciência do editor em duas execuções. */
  acaoAdiada: DesbloqueioCandidate[];
  /** Leitura da thread falhou — NUNCA entra na bateria de perguntas (ver
   * docstring de `erro-leitura` acima). O chamador reporta e sugere retry. */
  erroLeitura: DesbloqueioCandidate[];
  /** Issues varridas fora do escopo desta skill (`agendada`, `epica`,
   * `overnight` já triado, e `fora-de-rodada` engavetada) — só o número, pra
   * auditoria de cobertura. */
  foraDoEscopo: number[];
  /**
   * #7711 review — dependências (`condicao.tipo === "depends_on"`) cujo
   * estado NÃO deu pra resolver: issue inexistente, `gh` sem rede, token
   * expirado, JSON malformado. Todas resolvem pra `"missing"`, que nunca
   * desbloqueia — direção segura —, mas sem este campo a diferença entre
   * "dependência genuinamente aberta" e "não deu pra checar" não chegava a
   * quem consome o JSON, e uma falha sistêmica de rede virava um relatório
   * "nada mudou" indistinguível de uma rodada limpa.
   *
   * Preenchido pelo CLI (`runDesbloqueioScan`), não por
   * `scanDesbloqueioCandidates` — o miolo puro não faz I/O e não tem como
   * saber. Vazio quando não houve dependência a resolver OU todas
   * resolveram.
   */
  dependenciasNaoResolvidas?: number[];
}

/**
 * Agrupa um lote de issues já buscadas (corpo + labels + TODOS os
 * comentários, ou o erro de por que não deu pra buscar) nos 8 destinos +
 * fora-de-escopo. Ordem de entrada preservada dentro de cada grupo.
 */
/**
 * As chaves de `DesbloqueioScanReport` que são LISTA DE CANDIDATAS.
 *
 * Filtra por TIPO do valor, não por nome de campo (achado do
 * type-design-analyzer no review da PR #7711): a versão anterior era
 * `Exclude<keyof DesbloqueioScanReport, "foraDoEscopo">`, que depende de um
 * literal de string. Renomear `foraDoEscopo` tornaria o `Exclude` um no-op
 * SILENCIOSO — o TS não reclama de excluir uma chave que não existe —, e
 * `number[]` passaria a ser um destino "válido" pro `push` de um
 * `DesbloqueioCandidate`, quebrando só em runtime. O mapped type sobrevive
 * a rename e a campos novos não-candidata sem tocar nada.
 */
type DesbloqueioGroupKey = {
  [K in keyof DesbloqueioScanReport]-?: DesbloqueioScanReport[K] extends DesbloqueioCandidate[] ? K : never;
}[keyof DesbloqueioScanReport];

const STATUS_TO_GROUP = {
  "ja-destravada": "jaDestravadas",
  "bloqueio-confirmado": "bloqueioConfirmado",
  "bloqueio-obsoleto": "bloqueioObsoleto",
  "precisa-pergunta": "precisaPergunta",
  "sem-sinal-nao-triada": "semSinalNaoTriadas",
  "acao-imediata-candidata": "acaoImediataCandidatas",
  "acao-adiada": "acaoAdiada",
  "erro-leitura": "erroLeitura",
} as const satisfies Record<DesbloqueioStatus, DesbloqueioGroupKey>;

export function scanDesbloqueioCandidates(inputs: readonly DesbloqueioIssueInput[]): DesbloqueioScanReport {
  const report: DesbloqueioScanReport = {
    jaDestravadas: [],
    bloqueioConfirmado: [],
    precisaPergunta: [],
    bloqueioObsoleto: [],
    semSinalNaoTriadas: [],
    acaoImediataCandidatas: [],
    acaoAdiada: [],
    erroLeitura: [],
    foraDoEscopo: [],
  };
  for (const input of inputs) {
    const candidate = classifyDesbloqueioCandidate(input);
    if (!candidate) {
      report.foraDoEscopo.push(input.number);
      continue;
    }
    // Mapa exaustivo status→grupo: `satisfies Record<DesbloqueioStatus, …>`
    // faz o compilador exigir uma entrada nova sempre que a união crescer.
    // A versão anterior era uma cadeia de if/else com `precisaPergunta` como
    // fallback silencioso — um status novo caía lá sem ninguém notar, que é
    // o pior destino possível (vira pergunta ao editor por omissão).
    const grupo = STATUS_TO_GROUP[candidate.status];
    report[grupo].push(candidate);
  }
  return report;
}
