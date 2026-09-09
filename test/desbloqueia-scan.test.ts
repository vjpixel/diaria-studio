/**
 * test/desbloqueia-scan.test.ts (#6628)
 *
 * Regressão pura pra `scripts/lib/desbloqueia-scan.ts` — nenhuma chamada
 * `gh` real (as funções recebem body/labels/comentários já buscados).
 * Cobre a lista pedida pelo critério de aceite da issue + os gaps
 * apontados pelo fleet review do PR #6632:
 *
 *   - issue com decisão registrada em comentário posterior ao `updatedAt`
 *     → `ja-destravada`, ZERO pergunta necessária (o teste central do
 *     requisito "ler a thread antes de perguntar")
 *   - issue com bloqueio de execução registrado e recente → `bloqueio-confirmado`
 *   - issue sem nenhum marcador recente → `precisa-pergunta`
 *   - #6961: decisão MAIS ANTIGA que `updatedAt`, mas SEM nenhum
 *     `bloqueio-execucao` mais novo → ainda `ja-destravada` (o próprio POST
 *     do marcador bumpa `updatedAt`; isso nunca invalida a decisão —
 *     regressão do bug original, que comparava contra `updatedAt`)
 *   - issue fora do escopo (`elegível`, `agendada`, `epica`, `fora-de-rodada`,
 *     `CLOSED`) → `null` / entra em `foraDoEscopo`, nunca nos grupos de ação
 *   - `commentsRead` reflete o número real de comentários passados (prova
 *     de leitura completa, não amostra)
 *   - track `develop` (não só `bloqueada`) passa pelo mesmo pipeline (#6632)
 *   - limite inclusivo `>=` — timestamp IGUAL a `updatedAt` conta como
 *     fresco (#6632)
 *   - decisão E bloqueio presentes ao mesmo tempo — decisão sempre vence,
 *     na ordem certa (#6632)
 *   - `commentsFetchError` força `erro-leitura`, NUNCA `precisa-pergunta`
 *     mesmo com `comments: []` (#6632 — falha de leitura não pode virar
 *     "sem comentário" silenciosamente)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDesbloqueioCandidate,
  scanDesbloqueioCandidates,
  type DesbloqueioIssueInput,
} from "../scripts/lib/desbloqueia-scan.ts";
import {
  resolveDependencyStates,
  runDesbloqueioScan,
  type GhRunFn,
} from "../scripts/desbloqueia-scan.ts";
import {
  ACAO_ADIADA_COOLDOWN_DAYS,
  formatAcaoAdiadaMarker,
  formatDecisionMarker,
  formatExecutionBlockMarker,
} from "../scripts/lib/issue-decisions.ts";

function baseInput(overrides: Partial<DesbloqueioIssueInput> = {}): DesbloqueioIssueInput {
  return {
    number: 1234,
    title: "issue de teste",
    labels: ["external-blocker"],
    body: "corpo qualquer",
    state: "OPEN",
    updatedAt: "2026-08-01T00:00:00Z",
    comments: [],
    dependencyState: null,
    ...overrides,
  };
}

describe("classifyDesbloqueioCandidate", () => {
  it("decisão registrada DEPOIS de updatedAt → ja-destravada, sem pergunta", () => {
    const marker = formatDecisionMarker({
      decided_at: "2026-08-15T00:00:00Z",
      pergunta: "Trocar X por Y?",
      resposta: "Trocar por Y",
      sessao: "develop",
    });
    const input = baseInput({
      updatedAt: "2026-08-01T00:00:00Z",
      comments: [`Decisão do editor: trocar por Y.\n\n${marker}`],
    });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "ja-destravada");
    assert.equal(result?.decision?.resposta, "Trocar por Y");
    assert.equal(result?.commentsRead, 1);
    assert.equal(result?.commentsFetchError, null);
  });

  it("#6961: decisão registrada ANTES de updatedAt, sem bloqueio mais novo → AINDA ja-destravada (updatedAt não invalida decisão)", () => {
    const marker = formatDecisionMarker({
      decided_at: "2026-07-01T00:00:00Z",
      pergunta: "Trocar X por Y?",
      resposta: "Trocar por Y",
      sessao: "develop",
    });
    const input = baseInput({
      updatedAt: "2026-08-01T00:00:00Z",
      comments: [marker],
    });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "ja-destravada");
  });

  it("#6961 — regressão do bug original: marcador grava decided_at, e o PRÓPRIO comentário que o carrega bumpa updatedAt pra DEPOIS — não deve virar precisa-pergunta", () => {
    // Reproduz a medição da issue: decided_at gerado no payload ANTES do
    // POST completar; updatedAt reflete o instante do POST, sempre um
    // pouco depois. O bug original comparava decided_at >= updatedAt,
    // condição insatisfazível por construção nesse cenário.
    const decidedAt = "2026-09-01T20:16:42.541Z";
    const updatedAtAposPost = "2026-09-01T20:17:47.000Z"; // depois do decided_at
    const marker = formatDecisionMarker({
      decided_at: decidedAt,
      pergunta: "Qual segmento usar?",
      resposta: "Usar o segmento B",
      sessao: "overnight",
    });
    const input = baseInput({ updatedAt: updatedAtAposPost, comments: [marker] });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "ja-destravada");
    assert.equal(result?.decision?.resposta, "Usar o segmento B");
  });

  it("bloqueio de execução recente sem decisão nova → bloqueio-confirmado", () => {
    const marker = formatExecutionBlockMarker({
      recorded_at: "2026-08-20T00:00:00Z",
      motivo: "falta acesso à conta X",
      sessao: "overnight",
      condicao: { tipo: "externo", descricao: "falta acesso à conta X" },
    });
    const input = baseInput({
      updatedAt: "2026-08-01T00:00:00Z",
      comments: [marker],
    });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "bloqueio-confirmado");
    assert.equal(result?.executionBlock?.motivo, "falta acesso à conta X");
  });

  it("sem marcador nenhum → precisa-pergunta", () => {
    const input = baseInput({ comments: ["comentário qualquer sem marcador"] });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "precisa-pergunta");
  });

  it("#7694: issue sem label nenhuma (overnight ·sem sinal) ENTRA no escopo como sem-sinal-nao-triada", () => {
    // Antes da #7694 esta issue era `null` (fora do escopo) — era exatamente o
    // bug: o bucket mais provável de esconder um bloqueio sem label era o
    // único que a skill nunca lia.
    const input = baseInput({ labels: [], comments: ["comentário sem marcador"] });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.track, "overnight");
    assert.equal(result?.matched, "default");
    assert.equal(result?.escopo, "sem-sinal");
    assert.equal(result?.status, "sem-sinal-nao-triada");
  });

  it("#7694: overnight com sinal POSITIVO (trade-off-real) fica fora do escopo — já foi triado", () => {
    const input = baseInput({ labels: ["trade-off-real"] });
    assert.equal(classifyDesbloqueioCandidate(input), null);
  });

  it("#7694: overnight confirmado por triada-overnight fica fora do escopo", () => {
    const input = baseInput({ labels: ["triada-overnight"] });
    assert.equal(classifyDesbloqueioCandidate(input), null);
  });

  it("#7694: sem-sinal com bloqueio-execucao na thread → bloqueio-confirmado + semSinal (label FALTANDO)", () => {
    // O achado de maior valor da extensão: a thread documenta o bloqueio e
    // ninguém aplicou a label. O playbook roteia pra `bloqueada` em vez de só
    // comentar "segue valendo".
    const blocked = formatExecutionBlockMarker({
      recorded_at: "2026-08-20T00:00:00Z",
      motivo: "conta da Brevo ainda não existe",
      sessao: "overnight",
      condicao: { tipo: "externo", descricao: "conta da Brevo ainda não existe" },
    });
    const result = classifyDesbloqueioCandidate(baseInput({ labels: [], comments: [blocked] }));
    assert.equal(result?.status, "bloqueio-confirmado");
    assert.equal(result?.escopo, "sem-sinal");
    assert.equal(result?.track, "overnight");
  });

  it("#7694: sem-sinal com decisao-editor na thread → ja-destravada, como qualquer outra", () => {
    const decided = formatDecisionMarker({
      decided_at: "2026-08-20T00:00:00Z",
      pergunta: "?",
      resposta: "opção B",
      sessao: "develop",
    });
    const result = classifyDesbloqueioCandidate(baseInput({ labels: [], comments: [decided] }));
    assert.equal(result?.status, "ja-destravada");
    assert.equal(result?.escopo, "sem-sinal");
  });

  it("#7694: sem-sinal com erro de leitura → erro-leitura, NUNCA sem-sinal-nao-triada", () => {
    const result = classifyDesbloqueioCandidate(
      baseInput({ labels: [], comments: [], commentsFetchError: "gh falhou" }),
    );
    assert.equal(result?.status, "erro-leitura");
    assert.equal(result?.escopo, "sem-sinal");
  });

  it("#7694: candidata COM label (bloqueada) e sem marcador continua precisa-pergunta, não sem-sinal", () => {
    const result = classifyDesbloqueioCandidate(baseInput({ labels: ["external-blocker"], comments: [] }));
    assert.equal(result?.status, "precisa-pergunta");
    assert.notEqual(result?.escopo, "sem-sinal");
    assert.equal(result?.matched, "label:external-blocker");
  });

  it("issue on-hold (fora-de-rodada) → fora do escopo, devolve null", () => {
    const input = baseInput({ labels: ["on-hold"] });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result, null);
  });

  it("issue CLOSED → fora do escopo mesmo com label de bloqueio (#6632)", () => {
    const input = baseInput({ state: "CLOSED" });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result, null);
  });

  it("commentsRead reflete o total de comentários passados, não uma amostra", () => {
    const input = baseInput({ comments: ["a", "b", "c", "d", "e"] });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.commentsRead, 5);
  });

  it("track develop (label windows) passa pelo mesmo pipeline de classificação (#6632)", () => {
    const marker = formatDecisionMarker({
      decided_at: "2026-08-15T00:00:00Z",
      pergunta: "?",
      resposta: "sim",
      sessao: "develop",
    });
    const input = baseInput({
      labels: ["windows"],
      updatedAt: "2026-08-01T00:00:00Z",
      comments: [marker],
    });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.track, "develop");
    assert.equal(result?.status, "ja-destravada");
  });

  it("decided_at === updatedAt (limite inclusivo >=) → ja-destravada (#6632)", () => {
    const marker = formatDecisionMarker({
      decided_at: "2026-08-01T00:00:00Z",
      pergunta: "?",
      resposta: "sim",
      sessao: "develop",
    });
    const input = baseInput({ updatedAt: "2026-08-01T00:00:00Z", comments: [marker] });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "ja-destravada");
  });

  it("recorded_at === updatedAt (limite inclusivo >=) → bloqueio-confirmado (#6632)", () => {
    const marker = formatExecutionBlockMarker({
      recorded_at: "2026-08-01T00:00:00Z",
      motivo: "falta token",
      sessao: "overnight",
      condicao: { tipo: "externo", descricao: "falta token" },
    });
    const input = baseInput({ updatedAt: "2026-08-01T00:00:00Z", comments: [marker] });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "bloqueio-confirmado");
  });

  it("decisão E bloqueio presentes, decisão mais recente → ja-destravada vence (#6632)", () => {
    const oldBlock = formatExecutionBlockMarker({
      recorded_at: "2026-08-10T00:00:00Z",
      motivo: "faltava token",
      sessao: "overnight",
      condicao: { tipo: "externo", descricao: "faltava token" },
    });
    const newDecision = formatDecisionMarker({
      decided_at: "2026-08-20T00:00:00Z",
      pergunta: "?",
      resposta: "resolvido",
      sessao: "develop",
    });
    const input = baseInput({
      updatedAt: "2026-08-01T00:00:00Z",
      comments: [oldBlock, newDecision],
    });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "ja-destravada");
  });

  it("decisão E bloqueio presentes, bloqueio mais recente (decisão velha) → bloqueio-confirmado (#6632)", () => {
    const oldDecision = formatDecisionMarker({
      decided_at: "2026-07-01T00:00:00Z",
      pergunta: "?",
      resposta: "resolvido antes",
      sessao: "develop",
    });
    const newBlock = formatExecutionBlockMarker({
      recorded_at: "2026-08-20T00:00:00Z",
      motivo: "voltou a faltar token depois da decisão",
      sessao: "overnight",
      condicao: { tipo: "externo", descricao: "voltou a faltar token depois da decisão" },
    });
    const input = baseInput({
      updatedAt: "2026-08-01T00:00:00Z",
      comments: [oldDecision, newBlock],
    });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "bloqueio-confirmado");
  });

  it("decided_at === recorded_at (empate exato) → decisão vence, ja-destravada (#7013 self-review)", () => {
    const tie = "2026-08-20T00:00:00Z";
    const decision = formatDecisionMarker({
      decided_at: tie,
      pergunta: "?",
      resposta: "resolvido no empate",
      sessao: "develop",
    });
    const block = formatExecutionBlockMarker({
      recorded_at: tie,
      motivo: "bloqueio registrado no mesmo instante",
      sessao: "overnight",
      condicao: { tipo: "externo", descricao: "bloqueio registrado no mesmo instante" },
    });
    const input = baseInput({
      updatedAt: "2026-08-01T00:00:00Z",
      comments: [block, decision],
    });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "ja-destravada");
  });

  it("#7343: decisão registrada ANTES do bloqueio NÃO desbloqueia um bloqueio-confirmado (bloqueio mais recente vence)", () => {
    // A garantia central de #7343: a comparação é entre os DOIS marcadores
    // ("o marcador não expira por tempo, só por evento"). Uma decisão
    // antiga não desbloqueia um bloqueio gravado depois — o bloqueio é o
    // sinal mais recente e vence, mesmo sem um `updatedAt` envolvido.
    const oldDecision = formatDecisionMarker({
      decided_at: "2026-08-01T00:00:00Z",
      pergunta: "Resolvido?",
      resposta: "sim, resolvido",
      sessao: "develop",
    });
    const newBlock = formatExecutionBlockMarker({
      recorded_at: "2026-09-01T20:16:42.541Z",
      motivo: "mesmo assim, Postmaster Tools ainda recusa o dominio",
      sessao: "develop",
      condicao: { tipo: "externo",descricao: "aguardar mais semanas de envio" },
    });
    const result = classifyDesbloqueioCandidate(
      baseInput({ updatedAt: "2026-09-01T20:20:00Z", comments: [oldDecision, newBlock] }),
    );
    assert.equal(result?.status, "bloqueio-confirmado");
    assert.equal(result?.executionBlock?.motivo, "mesmo assim, Postmaster Tools ainda recusa o dominio");
  });

  it("commentsFetchError força erro-leitura, NUNCA precisa-pergunta, mesmo com comments vazio (#6632)", () => {
    const input = baseInput({ comments: [], commentsFetchError: "gh issue view #1234 falhou (status 1)" });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "erro-leitura");
    assert.equal(result?.commentsFetchError, "gh issue view #1234 falhou (status 1)");
    assert.equal(result?.decision, null);
    assert.equal(result?.executionBlock, null);
  });

  it("#7343: comentário de revisão do Passo 2 (sem marcador, só bumpa o updatedAt) NUNCA desbloqueia um bloqueio-confirmado", () => {
    // Cenário exato da issue #7343: a skill /diaria-desbloqueia Passo 2
    // comenta "Revisado por ... — bloqueio segue valendo, nenhuma mudança".
    // Comentar move o `updatedAt` da issue, mas o comentário NÃO carrega
    // nenhum marcador — então não há novo `bloqueio-execucao` nem nova
    // `decisao-editor` na thread. O bloqueio segue confirmado.
    //
    // Antes de #6961 isto caía em `precisa-perunta` porque a comparação
    // era `recorded_at >= updatedAt` — insatisfazível por construção (o
    // próprio POST do marcador bumpa `updatedAt` pra depois do
    // `recorded_at`). Hoje a comparação é entre os dois marcadores, e um
    // comentário de revisão sem marcador não é um evento pra ela.
    const block = formatExecutionBlockMarker({
      recorded_at: "2026-09-01T20:16:42.541Z",
      motivo: "Postmaster Tools recusou news.diar.ia.br por volume acumulado insuficiente",
      sessao: "develop",
      condicao: { tipo: "externo", descricao: "aguardar mais semanas de envio" },
    });
    const reviewComment =
      "Revisado por /diaria-desbloqueia (01/09/2026) — bloqueio de execução de 2026-09-01T20:16:42Z " +
      '("Postmaster Tools recusou news.diar.ia.br por volume acumulado insuficiente") segue valendo, nenhuma mudança.';

    const antes = classifyDesbloqueioCandidate(
      baseInput({ updatedAt: "2026-09-01T20:20:00Z", comments: [block] }),
    );
    assert.equal(antes?.status, "bloqueio-confirmado");

    const depois = classifyDesbloqueioCandidate(
      baseInput({ updatedAt: "2026-09-03T16:00:00Z", comments: [block, reviewComment] }),
    );
    assert.equal(depois?.status, "bloqueio-confirmado");
    assert.equal(depois?.executionBlock?.motivo, "Postmaster Tools recusou news.diar.ia.br por volume acumulado insuficiente");
    // Prova de que o classificador NAO caiu no "nenhum marcador" — a thread
    // tem 2 comentários e o bloqueio original ainda é o mais recente válido.
    assert.equal(depois?.commentsRead, 2);
  });

  it("#7343: um bloqueio de execução REALMENTE renovado (novo marcador posterior) ainda vence o comentário de revisão", () => {
    // Mesma família do #7343, no sentido certo: um comentário de revisão
    // NÃO renova o bloqueio, mas um NOVO marcador `bloqueio-execucao`
    // gravado depois de fato muda o estado — e o classificador deve
    // reconhecê-lo (o mecanismo que corrige o bug não deve quebrar o
    // caso legítimo de renovação).
    const oldBlock = formatExecutionBlockMarker({
      recorded_at: "2026-09-01T20:16:42.541Z",
      motivo: "volume acumulado insuficiente",
      sessao: "develop",
      condicao: { tipo: "externo",descricao: "aguardar mais semanas de envio" },
    });
    const reviewComment =
      "Revisado por /diaria-desbloqueia — bloqueio de 2026-09-01 segue valendo, nenhuma mudança.";
    const newBlock = formatExecutionBlockMarker({
      recorded_at: "2026-09-04T00:00:00Z",
      motivo: "editor confirmou que o dominio foi aceito no Postmaster Tools",
      sessao: "develop",
      condicao: { tipo: "externo",descricao: "dominio aceito" },
    });
    const result = classifyDesbloqueioCandidate(
      baseInput({
        updatedAt: "2026-09-04T00:01:00Z",
        comments: [oldBlock, reviewComment, newBlock],
      }),
    );
    assert.equal(result?.status, "bloqueio-confirmado");
    assert.equal(result?.executionBlock?.motivo, "editor confirmou que o dominio foi aceito no Postmaster Tools");
  });

  it("commentsFetchError vence mesmo se, por algum motivo, comments tiver conteúdo parcial (#6632)", () => {
    const marker = formatDecisionMarker({
      decided_at: "2026-08-15T00:00:00Z",
      pergunta: "?",
      resposta: "sim",
      sessao: "develop",
    });
    const input = baseInput({
      updatedAt: "2026-08-01T00:00:00Z",
      comments: [marker],
      commentsFetchError: "timeout no meio da paginação",
    });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "erro-leitura");
  });
});

describe("scanDesbloqueioCandidates", () => {
  it("agrupa múltiplas issues nos 5 destinos + fora do escopo", () => {
    const decided = formatDecisionMarker({
      decided_at: "2026-08-15T00:00:00Z",
      pergunta: "?",
      resposta: "sim",
      sessao: "develop",
    });
    const blocked = formatExecutionBlockMarker({
      recorded_at: "2026-08-20T00:00:00Z",
      motivo: "falta token",
      sessao: "overnight",
      condicao: { tipo: "externo", descricao: "falta token" },
    });
    const report = scanDesbloqueioCandidates([
      baseInput({ number: 1, updatedAt: "2026-08-01T00:00:00Z", comments: [decided] }),
      baseInput({ number: 2, updatedAt: "2026-08-01T00:00:00Z", comments: [blocked] }),
      baseInput({ number: 3, comments: [] }),
      baseInput({ number: 4, labels: [] }),
      baseInput({ number: 5, comments: [], commentsFetchError: "gh falhou" }),
      baseInput({ number: 6, labels: ["on-hold"] }),
    ]);
    assert.deepEqual(
      report.jaDestravadas.map((c) => c.number),
      [1],
    );
    assert.deepEqual(
      report.bloqueioConfirmado.map((c) => c.number),
      [2],
    );
    assert.deepEqual(
      report.precisaPergunta.map((c) => c.number),
      [3],
    );
    assert.deepEqual(
      report.erroLeitura.map((c) => c.number),
      [5],
    );
    // #7694 — #4 (sem label nenhuma) MIGROU de foraDoEscopo pra
    // semSinalNaoTriadas; quem sai do escopo agora é #6 (`on-hold`).
    assert.deepEqual(
      report.semSinalNaoTriadas.map((c) => c.number),
      [4],
    );
    assert.deepEqual(report.foraDoEscopo, [6]);
  });

  it("lista vazia devolve os 9 grupos vazios", () => {
    const report = scanDesbloqueioCandidates([]);
    assert.deepEqual(report, {
      jaDestravadas: [],
      bloqueioConfirmado: [],
      bloqueioObsoleto: [],
      precisaPergunta: [],
      semSinalNaoTriadas: [],
      acaoImediataCandidatas: [],
      acaoAdiada: [],
      erroLeitura: [],
      foraDoEscopo: [],
    });
  });
});

describe("#7707 — dependência declarada que já fechou vira bloqueio-obsoleto", () => {
  const blocoDepende = (issue: number, recordedAt = "2026-09-06T00:00:00Z") =>
    formatExecutionBlockMarker({
      recorded_at: recordedAt,
      motivo: `depende do veredito de #${issue}`,
      sessao: "overnight",
      condicao: { tipo: "depends_on", issue },
    });

  it("dependência CLOSED → bloqueio-obsoleto (o caso #5734)", () => {
    const r = classifyDesbloqueioCandidate(
      baseInput({ comments: [blocoDepende(7523)], dependencyState: "closed" }),
    );
    assert.equal(r?.status, "bloqueio-obsoleto");
  });

  it("dependência OPEN → segue bloqueio-confirmado", () => {
    const r = classifyDesbloqueioCandidate(
      baseInput({ comments: [blocoDepende(7523)], dependencyState: "open" }),
    );
    assert.equal(r?.status, "bloqueio-confirmado");
  });

  it("dependência MISSING nunca desbloqueia — marcador podre não é condição satisfeita", () => {
    const r = classifyDesbloqueioCandidate(
      baseInput({ comments: [blocoDepende(999999)], dependencyState: "missing" }),
    );
    assert.equal(r?.status, "bloqueio-confirmado");
  });

  it("dependencyState ausente (caller não resolveu) → bloqueio-confirmado, nunca obsoleto", () => {
    const r = classifyDesbloqueioCandidate(baseInput({ comments: [blocoDepende(7523)] }));
    assert.equal(r?.status, "bloqueio-confirmado");
  });

  it("condicao externo com dependencyState closed pendurado NÃO vira obsoleto", () => {
    // Defesa contra caller confuso: só `depends_on` consulta o estado.
    const externo = formatExecutionBlockMarker({
      recorded_at: "2026-09-06T00:00:00Z",
      motivo: "conta de terceiro não existe",
      sessao: "overnight",
      condicao: { tipo: "externo", descricao: "conta de terceiro não existe" },
    });
    const r = classifyDesbloqueioCandidate(
      baseInput({ comments: [externo], dependencyState: "closed" }),
    );
    assert.equal(r?.status, "bloqueio-confirmado");
  });
});

describe("#7708 — fora-de-rodada no escopo + anti-fadiga do acao-adiada", () => {
  const adiada = (pedidoEm: string) =>
    formatAcaoAdiadaMarker({
      pedido_em: pedidoEm,
      acao: "reiniciar a unit diaria-reconcile-send-audiences no helios",
      motivo: "",
      sessao: "develop",
    });
  const agora = new Date("2026-09-09T12:00:00Z");
  const diasAtras = (n: number) =>
    new Date(agora.getTime() - n * 86_400_000).toISOString();

  it("alarme de estado entra no escopo como acao-imediata-candidata", () => {
    const r = classifyDesbloqueioCandidate(baseInput({ labels: ["alarm"], now: agora }));
    assert.equal(r?.track, "fora-de-rodada");
    assert.equal(r?.escopo, "fora-de-rodada");
    assert.equal(r?.status, "acao-imediata-candidata");
  });

  it("decisao-registrada e sem-direcao-acionavel também entram", () => {
    for (const label of ["decisao-registrada", "sem-direcao-acionavel"]) {
      const r = classifyDesbloqueioCandidate(baseInput({ labels: [label], now: agora }));
      assert.equal(r?.status, "acao-imediata-candidata", label);
    }
  });

  it("on-hold/wontfix ficam FORA por default — engavetamento deliberado não se repergunta", () => {
    for (const label of ["on-hold", "wontfix"]) {
      assert.equal(classifyDesbloqueioCandidate(baseInput({ labels: [label], now: agora })), null, label);
    }
  });

  it("--incluir-engavetadas traz on-hold/wontfix pro escopo", () => {
    for (const label of ["on-hold", "wontfix"]) {
      const r = classifyDesbloqueioCandidate(
        baseInput({ labels: [label], incluirEngavetadas: true, now: agora }),
      );
      assert.equal(r?.escopo, "fora-de-rodada", label);
    }
  });

  it("issue CLOSED continua fora do escopo mesmo com --incluir-engavetadas", () => {
    const r = classifyDesbloqueioCandidate(
      baseInput({ state: "CLOSED", labels: [], incluirEngavetadas: true, now: agora }),
    );
    assert.equal(r, null);
  });

  it("adiamento DENTRO do cooldown suprime a pergunta", () => {
    const r = classifyDesbloqueioCandidate(
      baseInput({ labels: ["alarm"], comments: [adiada(diasAtras(2))], now: agora }),
    );
    assert.equal(r?.status, "acao-adiada");
    assert.equal(r?.acaoAdiada?.acao, "reiniciar a unit diaria-reconcile-send-audiences no helios");
  });

  it("adiamento EXPIRADO volta a ser perguntável, mas o candidate ainda carrega o pedido anterior", () => {
    const r = classifyDesbloqueioCandidate(
      baseInput({
        labels: ["alarm"],
        comments: [adiada(diasAtras(ACAO_ADIADA_COOLDOWN_DAYS + 1))],
        now: agora,
      }),
    );
    assert.equal(r?.status, "acao-imediata-candidata");
    assert.ok(r?.acaoAdiada, "o adiamento expirado continua visível pra a repergunta citar o que já foi pedido");
  });

  it("adiamento ativo suprime também numa issue bloqueada, sem apagar o bloqueio", () => {
    const bloco = formatExecutionBlockMarker({
      recorded_at: diasAtras(10),
      motivo: "falta recarregar a conta",
      sessao: "overnight",
      condicao: { tipo: "externo", descricao: "falta recarregar a conta" },
    });
    const r = classifyDesbloqueioCandidate(
      baseInput({ labels: ["external-blocker"], comments: [bloco, adiada(diasAtras(1))], now: agora }),
    );
    assert.equal(r?.status, "acao-adiada");
    assert.equal(r?.executionBlock?.motivo, "falta recarregar a conta");
  });

  it("sintoma NOVO (bloqueio posterior ao adiamento) reabre a pergunta antes do cooldown", () => {
    const blocoNovo = formatExecutionBlockMarker({
      recorded_at: diasAtras(1),
      motivo: "agora é outra coisa",
      sessao: "overnight",
      condicao: { tipo: "externo", descricao: "agora é outra coisa" },
    });
    const r = classifyDesbloqueioCandidate(
      baseInput({ labels: ["external-blocker"], comments: [adiada(diasAtras(3)), blocoNovo], now: agora }),
    );
    assert.equal(r?.status, "bloqueio-confirmado");
  });

  it("decisão do editor vence um adiamento ativo — não há mais o que pender", () => {
    const decisao = formatDecisionMarker({
      decided_at: diasAtras(1),
      pergunta: "?",
      resposta: "resolvido assim",
      sessao: "develop",
    });
    const r = classifyDesbloqueioCandidate(
      baseInput({ labels: ["alarm"], comments: [adiada(diasAtras(2)), decisao], now: agora }),
    );
    assert.equal(r?.status, "ja-destravada");
  });
});

describe("#7707 resolveDependencyStates — a camada de I/O", () => {
  const semRede: GhRunFn = () => {
    throw new Error("não deveria chamar gh — a issue estava na lista de abertas");
  };
  const respondendo = (payload: Record<number, { status?: number; state?: string; stdout?: string }>): GhRunFn =>
    (args) => {
      const n = Number(args[2]);
      const p = payload[n] ?? { status: 1 };
      return {
        status: p.status ?? 0,
        stdout: p.stdout ?? (p.state ? JSON.stringify({ state: p.state }) : ""),
        stderr: "",
      };
    };

  it("issue na lista de abertas resolve como open SEM nenhuma chamada gh", () => {
    const out = resolveDependencyStates([42], new Set([42]), ".", semRede);
    assert.equal(out.get(42), "open");
  });

  it("issue fora da lista e CLOSED → closed", () => {
    const out = resolveDependencyStates([7523], new Set([1]), ".", respondendo({ 7523: { state: "CLOSED" } }));
    assert.equal(out.get(7523), "closed");
  });

  it("gh falhando → missing (direção segura: o bloqueio continua de pé)", () => {
    const out = resolveDependencyStates([999], new Set(), ".", respondendo({ 999: { status: 1 } }));
    assert.equal(out.get(999), "missing");
  });

  it("JSON malformado → missing, nunca lança", () => {
    const out = resolveDependencyStates([5], new Set(), ".", respondendo({ 5: { stdout: "não é json" } }));
    assert.equal(out.get(5), "missing");
  });

  it("state desconhecido → missing", () => {
    const out = resolveDependencyStates([6], new Set(), ".", respondendo({ 6: { state: "ARQUIVADA" } }));
    assert.equal(out.get(6), "missing");
  });

  it("deduplica: a mesma dependência citada por 3 issues consulta gh 1 vez só", () => {
    let chamadas = 0;
    const contando: GhRunFn = () => {
      chamadas++;
      return { status: 0, stdout: JSON.stringify({ state: "CLOSED" }), stderr: "" };
    };
    const out = resolveDependencyStates([7523, 7523, 7523], new Set(), ".", contando);
    assert.equal(chamadas, 1);
    assert.equal(out.get(7523), "closed");
  });
});

describe("#7711 review — lacunas apontadas pelo fleet", () => {
  const agora = new Date("2026-09-09T12:00:00Z");
  const diasAtras = (n: number) => new Date(agora.getTime() - n * 86_400_000).toISOString();
  const blocoExterno = (recordedAt: string) =>
    formatExecutionBlockMarker({
      recorded_at: recordedAt,
      motivo: "falta recarregar a conta",
      sessao: "overnight",
      condicao: { tipo: "externo", descricao: "falta recarregar a conta" },
    });
  const blocoDepende = (issue: number, recordedAt: string) =>
    formatExecutionBlockMarker({
      recorded_at: recordedAt,
      motivo: "depende de outra issue",
      sessao: "overnight",
      condicao: { tipo: "depends_on", issue },
    });
  const adiada = (pedidoEm: string) =>
    formatAcaoAdiadaMarker({ pedido_em: pedidoEm, acao: "reiniciar a unit", motivo: "", sessao: "develop" });

  // ── O bug de comparação de data que o code-reviewer achou ────────────────
  // `route-issue.ts` grava `recorded_at` truncado em DIA (`slice(0, 10)`),
  // enquanto `pedido_em` é timestamp completo. A comparação lexicográfica
  // antiga dava `"2026-09-09" > "2026-09-09T09:00:00Z" === false` sempre, e o
  // gatilho de sintoma novo nunca disparava no mesmo dia. Estes 3 testes
  // usam o formato REAL de produção; os antigos usavam `toISOString()` cheio
  // nos dois lados e por isso não pegavam nada.
  it("recorded_at TRUNCADO EM DIA no dia SEGUINTE reabre a pergunta", () => {
    const r = classifyDesbloqueioCandidate(
      baseInput({
        labels: ["external-blocker"],
        comments: [adiada("2026-09-08T09:00:00Z"), blocoExterno("2026-09-09")],
        now: agora,
      }),
    );
    assert.equal(r?.status, "bloqueio-confirmado", "bloqueio de dia posterior e sintoma novo");
  });

  it("recorded_at truncado no MESMO dia do adiamento mantem a supressao — limitacao assumida", () => {
    // O dado nao diz qual veio primeiro (o bloqueio so carrega o dia). A
    // escolha e manter suprimido, limitada pelo cooldown de 7 dias — nunca
    // "para sempre". Este teste PINA a escolha pra ela nao mudar por acidente.
    const r = classifyDesbloqueioCandidate(
      baseInput({
        labels: ["external-blocker"],
        comments: [adiada("2026-09-09T09:00:00Z"), blocoExterno("2026-09-09")],
        now: agora,
      }),
    );
    assert.equal(r?.status, "acao-adiada");
  });

  it("recorded_at truncado num dia ANTERIOR nao reabre — o adiamento ja respondia a ele", () => {
    const r = classifyDesbloqueioCandidate(
      baseInput({
        labels: ["external-blocker"],
        comments: [adiada("2026-09-08T09:00:00Z"), blocoExterno("2026-09-05")],
        now: agora,
      }),
    );
    assert.equal(r?.status, "acao-adiada");
  });

  // ── Precedencia que o pr-test-analyzer apontou sem cobertura ─────────────
  it("bloqueio-obsoleto VENCE um adiamento ativo — dependencia fechada destrava na hora", () => {
    const r = classifyDesbloqueioCandidate(
      baseInput({
        comments: [adiada(diasAtras(1)), blocoDepende(7523, "2026-09-08")],
        dependencyState: "closed",
        now: agora,
      }),
    );
    assert.equal(r?.status, "bloqueio-obsoleto");
  });

  // ── Combos status x escopo descobertos ──────────────────────────────────
  it("bloqueio-confirmado x develop", () => {
    const r = classifyDesbloqueioCandidate(
      baseInput({ labels: ["windows"], comments: [blocoExterno("2026-09-01")], now: agora }),
    );
    assert.equal(r?.escopo, "develop");
    assert.equal(r?.status, "bloqueio-confirmado");
  });

  it("bloqueio-confirmado x fora-de-rodada", () => {
    const r = classifyDesbloqueioCandidate(
      baseInput({ labels: ["alarm"], comments: [blocoExterno("2026-09-01")], now: agora }),
    );
    assert.equal(r?.escopo, "fora-de-rodada");
    assert.equal(r?.status, "bloqueio-confirmado");
  });

  it("bloqueio-obsoleto nao e exclusivo de escopo bloqueada", () => {
    const casos: Array<[string[], string]> = [
      [["windows"], "develop"],
      [["alarm"], "fora-de-rodada"],
      [[], "sem-sinal"],
    ];
    for (const [labels, escopo] of casos) {
      const r = classifyDesbloqueioCandidate(
        baseInput({ labels, comments: [blocoDepende(1, "2026-09-01")], dependencyState: "closed", now: agora }),
      );
      assert.equal(r?.escopo, escopo, labels.join(","));
      assert.equal(r?.status, "bloqueio-obsoleto", labels.join(","));
    }
  });

  it("acao-adiada x develop e x sem-sinal", () => {
    const casos: Array<[string[], string]> = [
      [["windows"], "develop"],
      [[], "sem-sinal"],
    ];
    for (const [labels, escopo] of casos) {
      const r = classifyDesbloqueioCandidate(baseInput({ labels, comments: [adiada(diasAtras(1))], now: agora }));
      assert.equal(r?.escopo, escopo, labels.join(","));
      assert.equal(r?.status, "acao-adiada", labels.join(","));
    }
  });

  // ── STATUS_TO_GROUP semantico, nao so exaustivo ─────────────────────────
  // O `satisfies Record<...>` garante que todo status TEM entrada, nao que a
  // entrada aponta pro grupo CERTO: trocar "bloqueio-obsoleto" por
  // "acaoAdiada" no mapa compila igual. Este teste pega o mis-mapeamento.
  it("scanDesbloqueioCandidates poe os 3 status NOVOS no grupo certo", () => {
    const report = scanDesbloqueioCandidates([
      baseInput({ number: 10, comments: [blocoDepende(1, "2026-09-01")], dependencyState: "closed", now: agora }),
      baseInput({ number: 11, labels: ["alarm"], now: agora }),
      baseInput({ number: 12, labels: ["alarm"], comments: [adiada(diasAtras(1))], now: agora }),
    ]);
    assert.deepEqual(
      report.bloqueioObsoleto.map((c) => c.number),
      [10],
    );
    assert.deepEqual(
      report.acaoImediataCandidatas.map((c) => c.number),
      [11],
    );
    assert.deepEqual(
      report.acaoAdiada.map((c) => c.number),
      [12],
    );
    assert.deepEqual(report.precisaPergunta, [], "nenhum dos tres deve vazar pro grupo de pergunta");
  });
});

describe("#7711 review — runDesbloqueioScan fim-a-fim (regressao da #7707, regra #633)", () => {
  // O review de cobertura apontou que o bug da #5734 vivia na FIACAO
  // (comentario -> condicao.issue -> resolver estado -> dependencyState), nao
  // no miolo puro: um teste que so exercita `classifyDesbloqueioCandidate`
  // passando `dependencyState` a mao continuaria verde se alguem removesse a
  // chamada a `resolveDependencyStates`. Estes testes rodam o pipeline
  // inteiro com um `gh` fake.
  const issueList = (entries: Array<{ number: number; labels?: string[] }>) =>
    JSON.stringify(
      entries.map((e) => ({
        number: e.number,
        title: "issue " + e.number,
        labels: (e.labels ?? ["external-blocker"]).map((name) => ({ name })),
        body: null,
        state: "OPEN",
        updatedAt: "2026-09-01T00:00:00Z",
      })),
    );

  const fakeGh =
    (spec: {
      open: Array<{ number: number; labels?: string[] }>;
      comments: Record<number, string[]>;
      states?: Record<number, string>;
    }): GhRunFn =>
    (args) => {
      if (args[1] === "list") return { status: 0, stdout: issueList(spec.open), stderr: "" };
      const n = Number(args[2]);
      if (args.includes("comments")) {
        return {
          status: 0,
          stdout: JSON.stringify({ comments: (spec.comments[n] ?? []).map((body) => ({ body })) }),
          stderr: "",
        };
      }
      const state = spec.states?.[n];
      if (!state) return { status: 1, stdout: "", stderr: "not found" };
      return { status: 0, stdout: JSON.stringify({ state }), stderr: "" };
    };

  const blocoDepende = (issue: number) =>
    formatExecutionBlockMarker({
      recorded_at: "2026-09-06",
      motivo: "depende de outra issue",
      sessao: "overnight",
      condicao: { tipo: "depends_on", issue },
    });

  it("dependencia FECHADA vira bloqueio-obsoleto pelo pipeline real (o caso #5734)", () => {
    const report = runDesbloqueioScan(".", {
      runGh: fakeGh({
        open: [{ number: 5734 }],
        comments: { 5734: [blocoDepende(7523)] },
        states: { 7523: "CLOSED" },
      }),
    });
    assert.deepEqual(
      report.bloqueioObsoleto.map((c) => c.number),
      [5734],
    );
    assert.deepEqual(report.bloqueioConfirmado, []);
  });

  it("dependencia ABERTA descoberta via fetch (fora da lista) segue bloqueio-confirmado", () => {
    // Cobre o retorno "open" pelo caminho do gh, nao pelo fast-path da lista
    // — inverter a comparacao `state === "OPEN"` passava sem este teste.
    const report = runDesbloqueioScan(".", {
      runGh: fakeGh({
        open: [{ number: 5734 }],
        comments: { 5734: [blocoDepende(9999)] },
        states: { 9999: "OPEN" },
      }),
    });
    assert.deepEqual(
      report.bloqueioConfirmado.map((c) => c.number),
      [5734],
    );
    assert.deepEqual(report.bloqueioObsoleto, []);
    assert.deepEqual(report.dependenciasNaoResolvidas, []);
  });

  it("dependencia na LISTA de abertas resolve sem chamar gh de novo (fast-path)", () => {
    const report = runDesbloqueioScan(".", {
      runGh: fakeGh({
        open: [{ number: 5734 }, { number: 7523 }],
        comments: { 5734: [blocoDepende(7523)], 7523: [] },
        // Sem `states`: se o codigo tentar buscar, o fake devolve status 1, a
        // dependencia cai em `missing` e o assert de baixo pega.
      }),
    });
    assert.deepEqual(
      report.bloqueioConfirmado.map((c) => c.number),
      [5734],
    );
    assert.deepEqual(report.dependenciasNaoResolvidas, []);
  });

  it("gh sem rede pra dependencia devolve dependenciasNaoResolvidas, nao silencio", () => {
    const report = runDesbloqueioScan(".", {
      runGh: fakeGh({ open: [{ number: 5734 }], comments: { 5734: [blocoDepende(7523)] }, states: {} }),
    });
    assert.deepEqual(
      report.bloqueioConfirmado.map((c) => c.number),
      [5734],
    );
    assert.deepEqual(
      report.dependenciasNaoResolvidas,
      [7523],
      "quem consome o JSON precisa distinguir dependencia aberta de nao deu pra checar",
    );
  });

  it("--incluir-engavetadas muda o escopo pelo pipeline real", () => {
    const spec = { open: [{ number: 1, labels: ["on-hold"] }], comments: { 1: [] } };
    assert.deepEqual(runDesbloqueioScan(".", { runGh: fakeGh(spec) }).foraDoEscopo, [1]);
    const comFlag = runDesbloqueioScan(".", { runGh: fakeGh(spec), incluirEngavetadas: true });
    assert.deepEqual(
      comFlag.acaoImediataCandidatas.map((c) => c.number),
      [1],
    );
  });
});
