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
import { formatDecisionMarker, formatExecutionBlockMarker } from "../scripts/lib/issue-decisions.ts";

function baseInput(overrides: Partial<DesbloqueioIssueInput> = {}): DesbloqueioIssueInput {
  return {
    number: 1234,
    title: "issue de teste",
    labels: ["external-blocker"],
    body: "corpo qualquer",
    state: "OPEN",
    updatedAt: "2026-08-01T00:00:00Z",
    comments: [],
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

  it("issue elegível (sem label de bloqueio) → fora do escopo, devolve null", () => {
    const input = baseInput({ labels: [] });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result, null);
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

  it("commentsFetchError força erro-leitura, NUNCA precisa-pergunta, mesmo com comments vazio (#6632)", () => {
    const input = baseInput({ comments: [], commentsFetchError: "gh issue view #1234 falhou (status 1)" });
    const result = classifyDesbloqueioCandidate(input);
    assert.equal(result?.status, "erro-leitura");
    assert.equal(result?.commentsFetchError, "gh issue view #1234 falhou (status 1)");
    assert.equal(result?.decision, null);
    assert.equal(result?.executionBlock, null);
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
  it("agrupa múltiplas issues nos 4 destinos + fora do escopo", () => {
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
    assert.deepEqual(report.foraDoEscopo, [4]);
  });

  it("lista vazia devolve os 5 grupos vazios", () => {
    const report = scanDesbloqueioCandidates([]);
    assert.deepEqual(report, {
      jaDestravadas: [],
      bloqueioConfirmado: [],
      precisaPergunta: [],
      erroLeitura: [],
      foraDoEscopo: [],
    });
  });
});
