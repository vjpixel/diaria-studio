/**
 * scripts/lib/desbloqueia-scan.ts (#6628)
 *
 * Miolo puro (sem I/O) de `/diaria-desbloqueia`. Responde, por issue
 * candidata (`classifyExecTrackWithRule` deu `bloqueada`, `develop`, ou
 * `overnight` com `matched: "default"` — ver "#7694" abaixo), uma pergunta:
 * **a thread já resolve isso, ou ainda precisa perguntar ao editor?**
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
 * ## As 4 saídas
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
 *     `semSinal: true`. **É o achado de maior valor desta extensão**: o
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
import { classifyExecTrackWithRule, type ExecTrack, type ExecTrackInput } from "./issue-exec-track.ts";
import {
  latestDecisionFor,
  latestExecutionBlockFor,
  type ExecutionBlock,
  type IssueDecision,
} from "./issue-decisions.ts";

export type DesbloqueioStatus =
  | "ja-destravada"
  | "bloqueio-confirmado"
  | "precisa-pergunta"
  | "sem-sinal-nao-triada"
  | "erro-leitura";

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
  /** #7694 — `true` quando a candidata veio do bucket `overnight ·sem sinal`
   * (`track === "overnight" && matched === "default"`): nenhuma label ou
   * marcador classificou a issue. Muda a AÇÃO do playbook para os mesmos
   * status — um `bloqueio-confirmado` com `semSinal: true` não é "bloqueio já
   * conhecido, só revisar", é "bloqueio documentado na thread e label
   * FALTANDO, rotear pra `bloqueada`". Ver docstring do módulo. */
  semSinal: boolean;
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
 * Classifica uma issue candidata. Devolve `null` quando ela está fora do
 * escopo desta skill: `agendada`, `epica`, `fora-de-rodada`, e `overnight`
 * **com sinal positivo** (alguém já triou — ver #7694 na docstring do
 * módulo). Ficam dentro: `bloqueada`, `develop`, e `overnight` com
 * `matched: "default"` (o bucket `·sem sinal`).
 */
export function classifyDesbloqueioCandidate(input: DesbloqueioIssueInput): DesbloqueioCandidate | null {
  const trackInput: ExecTrackInput = {
    labels: input.labels,
    body: input.body,
    state: input.state,
    now: input.now,
  };
  const { track, matched } = classifyExecTrackWithRule(trackInput);
  const semSinal = track === "overnight" && matched === "default";
  if (track !== "bloqueada" && track !== "develop" && !semSinal) return null;

  if (input.commentsFetchError) {
    return {
      number: input.number,
      title: input.title,
      track,
      matched,
      semSinal,
      status: "erro-leitura",
      decision: null,
      executionBlock: null,
      commentsRead: input.comments.length,
      commentsFetchError: input.commentsFetchError,
    };
  }

  const decision = latestDecisionFor(input.comments);
  const executionBlock = latestExecutionBlockFor(input.comments);

  // #6961: comparação é entre os dois marcadores, nunca contra
  // `input.updatedAt` (ver docstring do módulo — o próprio POST do
  // marcador bumpa `updatedAt` para depois do timestamp embutido nele,
  // tornando `decided_at >= updatedAt` insatisfazível por construção).
  // Marcador MAIS RECENTE (por `decided_at`/`recorded_at`) vence; empate
  // favorece a decisão (sinal mais forte — resolução explícita do editor).
  let status: DesbloqueioStatus;
  if (decision && (!executionBlock || decision.decided_at >= executionBlock.recorded_at)) {
    status = "ja-destravada";
  } else if (executionBlock && (!decision || executionBlock.recorded_at > decision.decided_at)) {
    status = "bloqueio-confirmado";
  } else {
    // #7694 — sem marcador nenhum, o destino depende de a issue TER ou não um
    // sinal de classificação. Com label (`bloqueada`/`develop`): alguém já
    // determinou que há um bloqueio, e a thread não diz qual → é pergunta.
    // Sem sinal nenhum: ninguém determinou nada ainda → é TRIAGEM, e mandar
    // isso pra `AskUserQuestion` transformaria "ninguém olhou" em pergunta
    // ao editor, contra "Perguntar é exceção" (#5321).
    status = semSinal ? "sem-sinal-nao-triada" : "precisa-pergunta";
  }

  return {
    number: input.number,
    title: input.title,
    track,
    matched,
    semSinal,
    status,
    decision,
    executionBlock,
    commentsRead: input.comments.length,
    commentsFetchError: null,
  };
}

export interface DesbloqueioScanReport {
  jaDestravadas: DesbloqueioCandidate[];
  bloqueioConfirmado: DesbloqueioCandidate[];
  precisaPergunta: DesbloqueioCandidate[];
  /** #7694 — candidatas do bucket `overnight ·sem sinal` cuja thread não tem
   * marcador nenhum: ninguém triou. NÃO viram pergunta — o playbook lê
   * título+corpo e roteia (`triada-overnight` quando confirma o overnight,
   * `bloqueada`/`develop` quando descobre um bloqueio que faltava rotular). */
  semSinalNaoTriadas: DesbloqueioCandidate[];
  /** Leitura da thread falhou — NUNCA entra na bateria de perguntas (ver
   * docstring de `erro-leitura` acima). O chamador reporta e sugere retry. */
  erroLeitura: DesbloqueioCandidate[];
  /** Issues varridas fora do escopo desta skill (`agendada`, `epica`,
   * `fora-de-rodada`, e `overnight` já triado) — só o número, pra auditoria
   * de cobertura. */
  foraDoEscopo: number[];
}

/**
 * Agrupa um lote de issues já buscadas (corpo + labels + TODOS os
 * comentários, ou o erro de por que não deu pra buscar) nos 5 destinos +
 * fora-de-escopo. Ordem de entrada preservada dentro de cada grupo.
 */
export function scanDesbloqueioCandidates(inputs: readonly DesbloqueioIssueInput[]): DesbloqueioScanReport {
  const report: DesbloqueioScanReport = {
    jaDestravadas: [],
    bloqueioConfirmado: [],
    precisaPergunta: [],
    semSinalNaoTriadas: [],
    erroLeitura: [],
    foraDoEscopo: [],
  };
  for (const input of inputs) {
    const candidate = classifyDesbloqueioCandidate(input);
    if (!candidate) {
      report.foraDoEscopo.push(input.number);
      continue;
    }
    if (candidate.status === "ja-destravada") report.jaDestravadas.push(candidate);
    else if (candidate.status === "bloqueio-confirmado") report.bloqueioConfirmado.push(candidate);
    else if (candidate.status === "erro-leitura") report.erroLeitura.push(candidate);
    else if (candidate.status === "sem-sinal-nao-triada") report.semSinalNaoTriadas.push(candidate);
    else report.precisaPergunta.push(candidate);
  }
  return report;
}
