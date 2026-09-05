/**
 * develop-label-gate.ts (#6271)
 *
 * Lógica PURA do gate mecânico de **saída** do track Develop: a sessão
 * terminou o trabalho que exigia o editor, e a issue continua classificando
 * como `develop` na Triagem.
 *
 * ─── O problema, medido ────────────────────────────────────────────────────
 *
 * Pergunta do editor ao fim da `/diaria-develop` 260826b: *"ainda há 5 issues
 * abertas marcadas como develop"* — depois de uma sessão develop inteira ter
 * rodado. Adjudicando uma a uma, **3 das 5 eram resíduo, não fila**: a razão
 * que as trouxe pro Develop tinha sido consumida pela própria sessão, e
 * ninguém tirou a label. As 2 legítimas eram justamente as que a sessão nunca
 * tentou.
 *
 * (Contagem congelada em 260826: `trade-off-real` era, à época, uma das 3
 * labels simples de develop. Hoje são 2 — o #7493 tirou `trade-off-real` do
 * conjunto; ver `developTriggeringLabels` abaixo. O incidente e a medição
 * seguem válidos, a aritmética "1 de 3" é histórica.)
 *
 * A causa é estrutural: **todos os call sites de roteamento do develop são de
 * ENTRADA.** Medido em `origin/master`, ANTES deste gate existir (a própria
 * correção acrescenta call sites de saída àquele arquivo, então re-rodar o
 * `grep` hoje dá outro número — é evidência congelada, não invariante): das
 * 6 ocorrências de `route-issue` em
 * `.claude/skills/diaria-develop/SKILL.md`, uma única era de SAÍDA (remover
 * `trade-off-real` ao fechar uma cat. C) — e ela cobre exatamente 1 das 3
 * labels que disparam `develop`. Para `windows` e `develop-track` não há
 * instrução nenhuma:
 *
 *     $ grep -c "remove-label windows" .claude/skills/diaria-develop/SKILL.md
 *     0
 *
 * Consequência: **Develop é um sink.** Issue entra e não sai, exceto por ação
 * humana ou por sorte. A fila do painel cresce monotonicamente com trabalho já
 * feito, e o editor perde justamente a distinção que a Triagem (#5462 / épica
 * #5969) existe pra dar — o que precisa dele AGORA versus o que já foi
 * resolvido.
 *
 * ─── Por que um GUARD, e não mais uma linha de prosa ───────────────────────
 *
 * O projeto já diagnosticou este modo de falha — **para uma das três labels.**
 * A instrução de cat. C traz o raciocínio escrito (*"sem isso a issue fica
 * presa em Develop na Triagem para sempre depois de já decidida"*) e ganhou
 * guard mecânico próprio na #5821 (`check-trade-off-label-cleared.ts`),
 * **porque o esquecimento aconteceu de verdade** (#5415).
 *
 * Ou seja: o modo de falha foi nomeado, corrigido e blindado — para 1 de 3
 * labels. `windows` e `develop-track` não receberam nem a instrução nem o
 * guard, e falham do mesmo jeito, pelo mesmo motivo.
 *
 * A evidência de que a prosa sozinha não basta veio da MESMA sessão, com o
 * mesmo coordenador, a ~1h de distância: na #6098 ele notou que o código já
 * estava mergeado e rodou `route-issue --track agendada` (saiu de develop);
 * na #6181 **não** rodou, mesmo tendo acabado de consumir integralmente a
 * razão do `windows`. Resultados opostos, mesma disciplina — o que significa
 * que não havia disciplina, havia sorte.
 *
 * Não é falta de ferramenta: `windows`, `develop-track` e `trade-off-real`
 * estão **os três** em `ROUTABLE_LABELS` (`scripts/lib/issue-route.ts`), e
 * `route-issue --track overnight` removeria qualquer um deles hoje. O verbo
 * está pronto; ninguém o chama na saída.
 *
 * ─── O que este gate checa, e o que ele deliberadamente NÃO checa ──────────
 *
 * Só entra na checagem a issue que ESTA sessão **terminou de trabalhar** —
 * ver `WORK_FINISHED_STATUSES`. Isso é o que separa resíduo de fila:
 *
 *   - issue nunca tentada (`nao-tentada`) ou deixada pro `helios`
 *     (`deixado-para-o-helios`) **não** entra: ela continua sendo fila
 *     legítima do Develop, e é exatamente o caso das 2 issues corretas da
 *     medição (#6048, #467);
 *   - issue `pulada` por bloqueio (`nao-destravavel-na-sessao`,
 *     `decisao-adiada`) **não** entra: o bloqueio é a razão de ela estar em
 *     Develop, e ele não foi resolvido;
 *   - issue mergeada, entregue fora de código, ou verificada como já resolvida
 *     antes da sessão **entra**: o trabalho acabou, então a razão que a trouxe
 *     pro Develop precisa ainda existir por si — ou a label sai.
 *
 * O gate **não decide o track de destino**. Ele detecta o resíduo e para; qual
 * track é o verdadeiro (`overnight` quando o resto é trabalho comum,
 * `bloqueada` quando passou a depender de outra issue) é julgamento que a
 * sessão registra rodando `route-issue`. Mesmo princípio de `issue-decisions.ts`
 * (#5373): julgamento feito uma vez por quem tem contexto, gravado de forma
 * durável, nunca re-derivado por heurística.
 *
 * ─── Escape hatch, e por que ele existe ────────────────────────────────────
 *
 * `develop_track_justificado` no `plan.json` da issue: string não-vazia
 * explicando por que ela SEGUE em Develop mesmo com o trabalho desta sessão
 * encerrado (ex.: mergeou a parte 1 e a parte 2 continua exigindo Chrome
 * logado). Mesma disciplina de `unblock_evidence`/`ja_resolvida_evidencia`:
 * o motivo é aceito, mas precisa estar escrito — o que o gate recusa é o
 * silêncio, não a permanência.
 *
 * Puro, sem rede: recebe o plano e as labels/corpo já buscados. O I/O fica no
 * entrypoint (`scripts/check-develop-label-cleared.ts`), mesmo padrão de
 * `trade-off-label-gate.ts`/`overnight-comment-coverage.ts`.
 *
 * @see scripts/lib/trade-off-label-gate.ts (guard irmão, cobre só `trade-off-real`)
 * @see scripts/lib/issue-exec-track.ts (`classifyExecTrack` — a fonte do veredito)
 * @see scripts/lib/issue-route.ts (`ROUTABLE_LABELS` — o verbo de saída que já existia)
 */

import { classifyExecTrack, type ExecTrack } from "./issue-exec-track.ts";

/**
 * Status de `plan.json` que significam **"esta sessão terminou de trabalhar
 * esta issue"**. Só eles entram na checagem — ver a seção "o que este gate
 * deliberadamente NÃO checa" no topo.
 *
 * Deliberadamente CONSERVADOR: cada status aqui é um em que o trabalho
 * acabou de forma inequívoca. Um status ambíguo de fora desta lista produz,
 * no pior caso, um resíduo que o gate não pega — o que é o comportamento de
 * hoje, e portanto nunca uma regressão. Incluir demais teria o efeito oposto:
 * um gate que acusa fila legítima vira ruído, e gate ruidoso é desligado.
 */
export const WORK_FINISHED_STATUSES: readonly string[] = [
  "mergeada",
  "entregue-fora-de-codigo",
  // `draft-ci-vermelho` entrou no fleet review #6320, com evidência do próprio
  // repo: `scripts/lib/pr-terminal-state.ts` descreve este status como
  // "handoff intencional — PR fica aberto de propósito PRO OVERNIGHT SEGUINTE
  // pegar", e a SKILL.md o lista lado a lado com `mergeada` entre os terminais.
  //
  // Isso é decisivo pro critério deste gate: se o projeto já roteia o resto do
  // trabalho (consertar CI) pro overnight, então a razão DEVELOP-específica —
  // Chrome logado, ComfyUI, decisão do editor — foi consumida. Deixá-lo de
  // fora reintroduzia o sink exatamente pra este status: uma issue `windows`
  // cujo PR terminou em draft ficaria com a label presa sem ninguém checar.
  //
  // Se algum dia um caso concreto mostrar que CI vermelho às vezes exige a
  // máquina do editor de volta, o lugar de registrar isso é aqui, com o caso —
  // não removendo o status em silêncio.
  "draft-ci-vermelho",
];

/**
 * Motivos de `pulada` que também contam como "trabalho terminado" — só o caso
 * em que a sessão VERIFICOU ao vivo que a issue já estava resolvida (#5723).
 * `nao-destravavel-na-sessao`/`decisao-adiada` ficam de fora de propósito: o
 * bloqueio é a razão de a issue estar em Develop.
 */
export const WORK_FINISHED_SKIP_MOTIVES: readonly string[] = ["ja-resolvida-antes-da-sessao"];

/** Uma issue do `plan.json`, no mínimo que este gate precisa. */
export interface DevelopGatePlanIssue {
  number: number;
  status?: string;
  motivo?: string;
  /** Escape hatch — ver "Escape hatch" no docblock do módulo. */
  develop_track_justificado?: string;
}

/** Estado atual da issue no GitHub, já buscado pelo entrypoint. */
export interface DevelopGateIssueState {
  number: number;
  labels: string[];
  body?: string;
}

export interface DevelopGateFinding {
  number: number;
  status: string;
  /** Labels ATUAIS que fazem `classifyExecTrack` devolver `develop`. */
  developLabels: string[];
}

export interface DevelopGateResult {
  ok: boolean;
  findings: DevelopGateFinding[];
  /** Issues que entraram na checagem e saíram limpas — útil pro relatório. */
  cleared: number[];
  /** Issues com `develop_track_justificado` preenchido — passam, mas ficam visíveis. */
  justified: number[];
}

/**
 * `true` quando o status/motivo indicam que ESTA sessão terminou o trabalho —
 * ver `WORK_FINISHED_STATUSES`. Pura.
 */
export function isWorkFinished(issue: Readonly<DevelopGatePlanIssue>): boolean {
  const status = issue.status ?? "";
  if (WORK_FINISHED_STATUSES.includes(status)) return true;
  if (status === "pulada" && issue.motivo !== undefined) {
    return WORK_FINISHED_SKIP_MOTIVES.includes(issue.motivo);
  }
  return false;
}

/**
 * As labels SIMPLES que fazem `classifyExecTrack` rotear pra `develop` —
 * `windows` e `develop-track` desde o #7493, que tirou `trade-off-real` do
 * conjunto (ambiguidade de trade-off real voltou a ser pergunta do briefing
 * do overnight, então deixou de produzir `develop`). Como o conjunto é
 * derivado por PROBE contra o classificador, essa mudança não exigiu editar
 * nada aqui — só esta frase.
 *
 * **Não é a enumeração completa dos caminhos pro track**: existe um 4º,
 * COMPOSTO — `external-blocker` + `credencial-escopo` (cat. A, #5694) —, e
 * um probe label a label estruturalmente não o alcança (nenhuma das duas
 * isolada dá `develop`). Isso NÃO afeta o veredito: `checkDevelopLabelCleared`
 * chama `classifyExecTrack` com o conjunto INTEIRO e acusa a issue
 * corretamente. O que degrada é só a MENSAGEM, que cai no fallback
 * "(nenhuma; ver corpo)" em vez de nomear a label. Travado em teste pra que
 * a limitação seja intencional, não surpresa de quem lê o output. Derivadas
 * por PROBE contra o próprio classificador, não redigitadas: se ele mudar o
 * conjunto, isto acompanha sozinho — mesma disciplina de `ROUTABLE_LABELS`,
 * que também se ancora no classificador em vez de duplicar literais.
 */
export function developTriggeringLabels(labels: readonly string[], body = ""): string[] {
  return labels.filter((label) => classifyExecTrack({ labels: [label], body }) === "develop");
}

/**
 * Decide o gate a partir do plano + estado atual das issues. Puro, sem rede.
 *
 * Uma issue só vira finding quando TODAS estas forem verdade:
 *   1. o trabalho desta sessão terminou (`isWorkFinished`);
 *   2. ela AINDA classifica como `develop` hoje (`classifyExecTrack`);
 *   3. não há `develop_track_justificado` preenchido.
 *
 * Issue ausente de `issueStates` (não deu pra buscar) é ignorada — fail-soft:
 * o entrypoint já degrada quando o `gh` falha, e um gate que acusa por
 * ausência de dado seria ruído (#738).
 */
export function checkDevelopLabelCleared(
  planIssues: readonly DevelopGatePlanIssue[],
  issueStates: readonly DevelopGateIssueState[],
): DevelopGateResult {
  const byNumber = new Map(issueStates.map((s) => [s.number, s]));
  const findings: DevelopGateFinding[] = [];
  const cleared: number[] = [];
  const justified: number[] = [];

  for (const issue of planIssues) {
    if (!isWorkFinished(issue)) continue;
    const state = byNumber.get(issue.number);
    if (!state) continue; // sem dado — nunca acusa por ausência

    const track: ExecTrack = classifyExecTrack({ labels: state.labels, body: state.body ?? "" });
    if (track !== "develop") {
      cleared.push(issue.number);
      continue;
    }
    // `typeof` e não só `?? ""` (achado do fleet review #6320): o campo é
    // preenchido À MÃO pelo coordenador seguindo a SKILL.md, então um typo
    // plausível (`develop_track_justificado: true`, ou um objeto) faria o
    // `?? ""` passar o valor adiante e o `.trim()` LANÇAR — exceção crua num
    // módulo cujo contrato inteiro é ser puro e não lançar. Não-string é
    // tratado como ausente: justificativa que não é texto não justifica nada.
    const justificativa = issue.develop_track_justificado;
    if (typeof justificativa === "string" && justificativa.trim() !== "") {
      justified.push(issue.number);
      continue;
    }
    findings.push({
      number: issue.number,
      status: issue.status ?? "",
      developLabels: developTriggeringLabels(state.labels, state.body ?? ""),
    });
  }

  return { ok: findings.length === 0, findings, cleared, justified };
}
