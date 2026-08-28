/**
 * scripts/lib/desbloqueia-scan.ts (#6628)
 *
 * Miolo puro (sem I/O) de `/diaria-desbloqueia`. Responde, por issue
 * candidata (`classifyExecTrack` já devolveu `bloqueada` ou `develop`), uma
 * pergunta: **a thread já resolve isso, ou ainda precisa perguntar ao
 * editor?**
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
 *   - `ja-destravada`      — existe `decisao-editor` cujo `decided_at` é
 *     posterior (ou igual) ao `updatedAt` da issue. A decisão que resolve o
 *     trade-off já está na thread; nenhuma pergunta nova é necessária — o
 *     chamador re-rotea direto (`route-issue.ts`).
 *   - `bloqueio-confirmado` — sem decisão nova, mas existe um
 *     `bloqueio-execucao` cujo `recorded_at` é posterior (ou igual) ao
 *     `updatedAt`. O que falta já está documentado (token que não chegou,
 *     conta que não existe) — perguntar de novo não muda nada; o chamador
 *     comenta lembrando o estado e segue sem pergunta.
 *   - `precisa-pergunta`   — nem decisão nem bloqueio recentes cobrem o
 *     estado atual da issue. Candidata real à bateria de `AskUserQuestion`.
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
 * Mesmo critério de comparação `decided_at`/`recorded_at` vs `updatedAt` já
 * usado em prosa por `.claude/skills/diaria-develop/SKILL.md` ("Antes de
 * classificar como cat. C") — este módulo só o torna reusável e testável
 * fora daquela skill.
 *
 * Determinístico: recebe dados já buscados (`gh issue list`/`gh issue view`
 * com `--json`), sem rede, sem `gh`. O CLI wrapper (`scripts/desbloqueia-scan.ts`)
 * é a única camada de I/O.
 */
import { classifyExecTrack, type ExecTrack, type ExecTrackInput } from "./issue-exec-track.ts";
import {
  latestDecisionFor,
  latestExecutionBlockFor,
  type ExecutionBlock,
  type IssueDecision,
} from "./issue-decisions.ts";

export type DesbloqueioStatus = "ja-destravada" | "bloqueio-confirmado" | "precisa-pergunta" | "erro-leitura";

export interface DesbloqueioIssueInput {
  number: number;
  title: string;
  labels: string[];
  body: string | null;
  state: string;
  /** ISO 8601 — `updatedAt` de `gh issue view --json updatedAt`. */
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
 * Classifica uma issue candidata. Devolve `null` quando `classifyExecTrack`
 * não dá `bloqueada` nem `develop` — fora do escopo desta skill (issue já
 * elegível, agendada, épica, fora de rodada não precisam de desbloqueio).
 */
export function classifyDesbloqueioCandidate(input: DesbloqueioIssueInput): DesbloqueioCandidate | null {
  const trackInput: ExecTrackInput = {
    labels: input.labels,
    body: input.body,
    state: input.state,
    now: input.now,
  };
  const track = classifyExecTrack(trackInput);
  if (track !== "bloqueada" && track !== "develop") return null;

  if (input.commentsFetchError) {
    return {
      number: input.number,
      title: input.title,
      track,
      status: "erro-leitura",
      decision: null,
      executionBlock: null,
      commentsRead: input.comments.length,
      commentsFetchError: input.commentsFetchError,
    };
  }

  const decision = latestDecisionFor(input.comments);
  const executionBlock = latestExecutionBlockFor(input.comments);

  let status: DesbloqueioStatus;
  if (decision && decision.decided_at >= input.updatedAt) {
    status = "ja-destravada";
  } else if (executionBlock && executionBlock.recorded_at >= input.updatedAt) {
    status = "bloqueio-confirmado";
  } else {
    status = "precisa-pergunta";
  }

  return {
    number: input.number,
    title: input.title,
    track,
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
  /** Leitura da thread falhou — NUNCA entra na bateria de perguntas (ver
   * docstring de `erro-leitura` acima). O chamador reporta e sugere retry. */
  erroLeitura: DesbloqueioCandidate[];
  /** Issues varridas que `classifyExecTrack` não considerou candidatas
   * (fora do escopo desta skill) — só o número, pra auditoria de cobertura. */
  foraDoEscopo: number[];
}

/**
 * Agrupa um lote de issues já buscadas (corpo + labels + TODOS os
 * comentários, ou o erro de por que não deu pra buscar) nos 4 destinos +
 * fora-de-escopo. Ordem de entrada preservada dentro de cada grupo.
 */
export function scanDesbloqueioCandidates(inputs: readonly DesbloqueioIssueInput[]): DesbloqueioScanReport {
  const report: DesbloqueioScanReport = {
    jaDestravadas: [],
    bloqueioConfirmado: [],
    precisaPergunta: [],
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
    else report.precisaPergunta.push(candidate);
  }
  return report;
}
