/**
 * test/voto-tema-8371.test.ts (#8371)
 *
 * Teste de regressão da votação do tema do Artigo Especial. Cobre exatamente
 * os 3 pontos exigidos pelo dispatch:
 *
 *   1. rejeição de token que resolve pra e-mail FORA do eleitorado da cédula
 *      (`autorizarEleitor`) — o guard que impede a base inteira da diária de
 *      votar na recompensa exclusiva dos apoiadores.
 *   2. troca de voto — último clique vence, sem inflar a contagem
 *      (`upsertVoto` + `apurar`).
 *   3. apuração determinística via `list` do prefixo — `apurar` não pode
 *      depender da ORDEM em que os votos chegam.
 *
 * Mais os testes de forma que o resto da lógica pura depende (`parseCicloVotacao`,
 * `validarCedula`, empate) e um teste ponta-a-ponta dos handlers do worker
 * contra um KVNamespace fake (guard "voto registrado só por POST").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  apurar,
  autorizarEleitor,
  ballotKey,
  eleitorHash,
  isUnsubstitutedMergeTagToken,
  isValidTemaVoteToken,
  normalizeEmail,
  parseCicloVotacao,
  pollTokenKvKeyMirror,
  resultKey,
  upsertVoto,
  validarCedula,
  voteKey,
  voteKeyPrefix,
  type BallotTema,
  type VotoRegistrado,
  type VotosPorEmail,
} from "../workers/artigos/src/voto-tema-core.ts";
import {
  handleVotacaoOpcaoGet,
  handleVotacaoPlacar,
  handleVotoPost,
  type VotoTemaEnv,
} from "../workers/artigos/src/voto-tema.ts";
import { selectPendentesElegiveis } from "../scripts/voto-tema-lembrete.ts";
import { ballotWriteFailureMessage } from "../scripts/voto-tema-open.ts";

// ── fixtures ────────────────────────────────────────────────────────────

const OPCOES = [
  { n: 1, titulo: "Tema A", descricao: "Descrição A" },
  { n: 2, titulo: "Tema B", descricao: "Descrição B" },
  { n: 3, titulo: "Tema C", descricao: "Descrição C" },
];

async function buildBallot(eleitoresEmails: string[]): Promise<BallotTema> {
  const eleitores = await Promise.all(eleitoresEmails.map((e) => eleitorHash(e)));
  return {
    titulo: "Tema do próximo Artigo Especial",
    opcoes: OPCOES,
    eleitores,
    aberta_em: new Date().toISOString(),
  };
}

// ── 1. rejeição de token fora do eleitorado ─────────────────────────────

describe("autorizarEleitor — rejeita fora do eleitorado (#8371)", () => {
  it("aceita e-mail que está na cédula", async () => {
    const ballot = await buildBallot(["mantenedor@example.com", "patrono@example.com"]);
    assert.equal(await autorizarEleitor("mantenedor@example.com", ballot.eleitores), true);
  });

  it("rejeita e-mail que NÃO está na cédula (assinante comum da diária)", async () => {
    const ballot = await buildBallot(["mantenedor@example.com", "patrono@example.com"]);
    assert.equal(await autorizarEleitor("qualquer-assinante@example.com", ballot.eleitores), false);
  });

  it("normaliza (case/trim) antes de comparar — não deixa passar por diferença cosmética nem barra por ela", async () => {
    const ballot = await buildBallot(["Mantenedor@Example.com "]);
    assert.equal(await autorizarEleitor(" mantenedor@example.com", ballot.eleitores), true);
  });
});

// ── 2. troca de voto — último clique vence ──────────────────────────────

describe("upsertVoto + apurar — troca de voto (#8371)", () => {
  it("segundo voto da MESMA pessoa sobrescreve o primeiro, sem inflar a contagem", async () => {
    const ballot = await buildBallot(["a@example.com"]);
    let votes: VotosPorEmail = new Map<string, VotoRegistrado>();
    votes = upsertVoto(votes, "a@example.com", { opcao: 1, ts: "2026-09-18T10:00:00Z" });
    votes = upsertVoto(votes, "a@example.com", { opcao: 2, ts: "2026-09-18T10:05:00Z" });

    const apuracao = apurar(ballot, [...votes.values()]);
    assert.equal(apuracao.total, 1, "1 pessoa votou — o total nunca conta o voto trocado 2x");
    assert.equal(apuracao.opcoes.find((o) => o.n === 1)?.votos, 0);
    assert.equal(apuracao.opcoes.find((o) => o.n === 2)?.votos, 1);
  });

  it("votos de pessoas DIFERENTES não se sobrescrevem", () => {
    let votes: VotosPorEmail = new Map<string, VotoRegistrado>();
    votes = upsertVoto(votes, "a@example.com", { opcao: 1, ts: "t1" });
    votes = upsertVoto(votes, "b@example.com", { opcao: 1, ts: "t2" });
    assert.equal(votes.size, 2);
  });
});

// ── 3. apuração determinística, independente de ordem ───────────────────

describe("apurar — determinístico, independente da ordem do `list` (#8371)", () => {
  const votos: VotoRegistrado[] = [
    { opcao: 1, ts: "t1" },
    { opcao: 2, ts: "t2" },
    { opcao: 1, ts: "t3" },
    { opcao: 3, ts: "t4" },
    { opcao: 1, ts: "t5" },
  ];

  it("mesma contagem em qualquer permutação da lista de votos", async () => {
    const ballot = await buildBallot([]);
    const a = apurar(ballot, votos);
    const b = apurar(ballot, [...votos].reverse());
    const c = apurar(ballot, [votos[2], votos[0], votos[4], votos[1], votos[3]]);
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
    assert.equal(a.vencedor, 1);
    assert.equal(a.total, 5);
    assert.equal(a.empate, false);
  });

  it("zero votos não é empate nem tem vencedor", async () => {
    const ballot = await buildBallot([]);
    const apuracao = apurar(ballot, []);
    assert.equal(apuracao.empate, false);
    assert.equal(apuracao.vencedor, null);
    assert.equal(apuracao.total, 0);
  });

  it("empate — 2+ opções no topo não elege vencedor", async () => {
    const ballot = await buildBallot([]);
    const apuracao = apurar(ballot, [
      { opcao: 1, ts: "t1" },
      { opcao: 2, ts: "t2" },
    ]);
    assert.equal(apuracao.empate, true);
    assert.equal(apuracao.vencedor, null);
  });
});

// ── formato / validação ──────────────────────────────────────────────────

describe("parseCicloVotacao — AAMM, nunca AAMMDD nem YYMM-MM (#8371)", () => {
  it("aceita 4 dígitos", () => {
    assert.equal(parseCicloVotacao("2610"), "2610");
  });
  it("rejeita AAMMDD (6 dígitos, formato da diária)", () => {
    assert.equal(parseCicloVotacao("260418"), null);
  });
  it("rejeita YYMM-MM (formato do mensal)", () => {
    assert.equal(parseCicloVotacao("2605-06"), null);
  });
  it("rejeita não-numérico e vazio", () => {
    assert.equal(parseCicloVotacao("abcd"), null);
    assert.equal(parseCicloVotacao(""), null);
  });
});

describe("validarCedula (#8371)", () => {
  it("aceita cédula bem formada", () => {
    assert.deepEqual(validarCedula({ titulo: "Tema", opcoes: OPCOES }), { ok: true });
  });
  it("recusa menos de 2 opções", () => {
    const r = validarCedula({ titulo: "Tema", opcoes: [OPCOES[0]] });
    assert.equal(r.ok, false);
  });
  it("recusa `n` duplicado", () => {
    const r = validarCedula({
      titulo: "Tema",
      opcoes: [
        { n: 1, titulo: "A", descricao: "d" },
        { n: 1, titulo: "B", descricao: "d" },
      ],
    });
    assert.equal(r.ok, false);
  });
  it("recusa opção sem descrição", () => {
    const r = validarCedula({
      titulo: "Tema",
      opcoes: [
        { n: 1, titulo: "A", descricao: "" },
        { n: 2, titulo: "B", descricao: "d" },
      ],
    });
    assert.equal(r.ok, false);
  });
  it("recusa título de votação ausente", () => {
    const r = validarCedula({ titulo: "", opcoes: OPCOES });
    assert.equal(r.ok, false);
  });
});

describe("token de voto — formato e merge tag não-substituída (#8371)", () => {
  it("token válido: 24 hex chars minúsculos", () => {
    assert.equal(isValidTemaVoteToken("a".repeat(24)), true);
    assert.equal(isValidTemaVoteToken("A".repeat(24)), false, "maiúsculo não é válido — mesma forma de poll-token.ts");
    assert.equal(isValidTemaVoteToken("a".repeat(23)), false);
  });
  it("detecta merge tag Liquid/Handlebars não-substituída", () => {
    assert.equal(isUnsubstitutedMergeTagToken("{{ subscriber.voto_token }}"), true);
    assert.equal(isUnsubstitutedMergeTagToken("a".repeat(24)), false);
  });
  it("chave KV do token casa o mesmo formato usado pelo 'É IA?'", () => {
    assert.equal(pollTokenKvKeyMirror("abc123"), "polltoken:abc123");
  });
});

describe("chaves KV — prefixo tema:, sem colisão entre ciclos (#8371)", () => {
  it("ballotKey/resultKey/voteKey namespaced por ciclo", () => {
    assert.equal(ballotKey("2610"), "tema:ballot:2610");
    assert.equal(resultKey("2610"), "tema:result:2610");
    assert.equal(voteKey("2610", "A@Example.com"), "tema:vote:2610:a@example.com");
    assert.ok(voteKey("2610", "x@example.com").startsWith(voteKeyPrefix("2610")));
    assert.notEqual(voteKeyPrefix("2610"), voteKeyPrefix("2611"));
  });
  it("normalizeEmail — trim + lowercase", () => {
    assert.equal(normalizeEmail(" Foo@Bar.COM "), "foo@bar.com");
  });
});

// ── handlers do worker contra um KVNamespace fake ────────────────────────

/** KV fake mínimo — só o subset de `KVNamespace` que os handlers usam
 *  (`get`, `put`, `list` com prefix/cursor). Suficiente pra exercitar o
 *  fluxo GET (não escreve) × POST (escreve) ponta-a-ponta sem infra real. */
function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async list({ prefix }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  } as unknown as VotoTemaEnv["POLL"] & { store: Map<string, string> };
}

async function envWithBallot(eleitoresEmails: string[]) {
  const ballot = await buildBallot(eleitoresEmails);
  const POLL = fakeKv({ [ballotKey("2610")]: JSON.stringify(ballot) });
  return { env: { POLL } as VotoTemaEnv, POLL, ballot };
}

describe("handlers — voto só é gravado por POST, nunca por GET (#8371)", () => {
  it("GET /votacao/{ciclo}/{n}?t=token NÃO grava voto (defesa contra scanner de link)", async () => {
    const { env, POLL } = await envWithBallot(["mantenedor@example.com"]);
    await POLL.put(pollTokenKvKeyMirror("a".repeat(24)), "mantenedor@example.com");

    const req = new Request(`https://especial.diar.ia.br/votacao/2610/1?t=${"a".repeat(24)}`);
    const res = await handleVotacaoOpcaoGet(req, env, "2610", 1);
    assert.equal(res.status, 200);
    assert.equal(POLL.store.has(voteKey("2610", "mantenedor@example.com")), false);
  });

  it("POST /votacao/{ciclo}/{n}?t=token grava o voto", async () => {
    const { env, POLL } = await envWithBallot(["mantenedor@example.com"]);
    await POLL.put(pollTokenKvKeyMirror("a".repeat(24)), "mantenedor@example.com");

    const req = new Request(`https://especial.diar.ia.br/votacao/2610/1?t=${"a".repeat(24)}`, { method: "POST" });
    const res = await handleVotoPost(req, env, "2610", 1);
    assert.equal(res.status, 200);
    assert.equal(POLL.store.get(voteKey("2610", "mantenedor@example.com")) !== undefined, true);
    const saved = JSON.parse(POLL.store.get(voteKey("2610", "mantenedor@example.com"))!);
    assert.equal(saved.opcao, 1);
  });

  it("POST com token que resolve pra e-mail fora do eleitorado é rejeitado (403) e não grava nada", async () => {
    const { env, POLL } = await envWithBallot(["mantenedor@example.com"]);
    await POLL.put(pollTokenKvKeyMirror("b".repeat(24)), "assinante-qualquer@example.com");

    const req = new Request(`https://especial.diar.ia.br/votacao/2610/1?t=${"b".repeat(24)}`, { method: "POST" });
    const res = await handleVotoPost(req, env, "2610", 1);
    assert.equal(res.status, 403);
    assert.equal(POLL.store.has(voteKey("2610", "assinante-qualquer@example.com")), false);
  });

  it("POST sem token conhecido no KV é rejeitado (403)", async () => {
    const { env } = await envWithBallot(["mantenedor@example.com"]);
    const req = new Request(`https://especial.diar.ia.br/votacao/2610/1?t=${"c".repeat(24)}`, { method: "POST" });
    const res = await handleVotoPost(req, env, "2610", 1);
    assert.equal(res.status, 403);
  });

  it("POST com merge tag não-substituída no token é rejeitado (400)", async () => {
    const { env } = await envWithBallot(["mantenedor@example.com"]);
    const req = new Request(
      `https://especial.diar.ia.br/votacao/2610/1?t=${encodeURIComponent("{{ subscriber.voto_token }}")}`,
      { method: "POST" },
    );
    const res = await handleVotoPost(req, env, "2610", 1);
    assert.equal(res.status, 400);
  });

  it("segundo POST da mesma pessoa troca o voto (último vence) — contagem não infla", async () => {
    const { env, POLL } = await envWithBallot(["mantenedor@example.com"]);
    await POLL.put(pollTokenKvKeyMirror("a".repeat(24)), "mantenedor@example.com");

    await handleVotoPost(
      new Request(`https://x/votacao/2610/1?t=${"a".repeat(24)}`, { method: "POST" }),
      env,
      "2610",
      1,
    );
    await handleVotoPost(
      new Request(`https://x/votacao/2610/2?t=${"a".repeat(24)}`, { method: "POST" }),
      env,
      "2610",
      2,
    );

    const placarRes = await handleVotacaoPlacar(new Request("https://x/votacao/2610"), env, "2610");
    const bodyText = await placarRes.text();
    assert.match(bodyText, /1 voto\(s\)|1 de 1/); // total continua 1 pessoa
  });

  it("placar público não existe (ciclo desconhecido) devolve 404", async () => {
    const { env } = await envWithBallot([]);
    const res = await handleVotacaoPlacar(new Request("https://x/votacao/9999"), env, "9999");
    assert.equal(res.status, 404);
  });
});

// ── findings do self-review da PR #8394 ─────────────────────────────────

describe("apurar — voto órfão de --force com cédula de outro shape (#8394)", () => {
  it("voto sob `n` ausente da cédula não entra em total nem em opção", async () => {
    const ballot = await buildBallot([]);
    // Cenário concreto: ciclo reaberto com `voto-tema-open.ts --push --force`
    // sob uma cédula nova (opções 1..3) com votos antigos do ciclo anterior
    // ainda no KV sob n=7/n=9 — numeração que não existe mais.
    const apuracao = apurar(ballot, [
      { opcao: 1, ts: "t1" },
      { opcao: 7, ts: "t2" },
      { opcao: 9, ts: "t3" },
      { opcao: 2, ts: "t4" },
    ]);
    assert.equal(apuracao.total, 2, "total conta só os votos que casam uma opção da cédula");
    const soma = apuracao.opcoes.reduce((acc, o) => acc + o.votos, 0);
    assert.equal(soma, apuracao.total, "barras de porcentagem somam 100% do total");
    assert.equal(apuracao.vencedor, null);
    assert.equal(apuracao.empate, true);
  });

  it("todos os votos órfãos = placar vazio, não 'total > 0 sem vencedor'", async () => {
    const ballot = await buildBallot([]);
    const apuracao = apurar(ballot, [
      { opcao: 42, ts: "t1" },
      { opcao: 43, ts: "t2" },
    ]);
    assert.equal(apuracao.total, 0);
    assert.equal(apuracao.empate, false);
    assert.equal(apuracao.vencedor, null);
    assert.deepEqual(
      apuracao.opcoes.map((o) => o.votos),
      [0, 0, 0],
    );
  });
});

describe("selectPendentesElegiveis — lembrete nunca vai pra quem tomaria 403 (#8394)", () => {
  it("membro que entrou na tag depois da abertura fica fora dos pendentes", async () => {
    // `ballot.eleitores` congela a@ e b@ na abertura; c@ virou Mantenedor
    // depois e já aparece em `fetchTagMembers`, mas um clique dele no link
    // de voto bateria 403 em `autorizarEleitor`.
    const eleitoresHashes = await Promise.all(["a@example.com", "b@example.com"].map((e) => eleitorHash(e)));
    const { pendentes, foraDoEleitorado } = await selectPendentesElegiveis(
      ["a@example.com", "b@example.com", "c@example.com"],
      ["b@example.com"],
      eleitoresHashes,
    );
    assert.deepEqual(pendentes, ["a@example.com"]);
    assert.deepEqual(foraDoEleitorado, ["c@example.com"], "operador precisa saber quem ficou de fora");
  });

  it("normaliza e-mail antes de casar com o hash congelado", async () => {
    const eleitoresHashes = [await eleitorHash("a@example.com")];
    const { pendentes, foraDoEleitorado } = await selectPendentesElegiveis(["  A@Example.COM "], [], eleitoresHashes);
    assert.deepEqual(pendentes, ["a@example.com"]);
    assert.deepEqual(foraDoEleitorado, []);
  });

  it("quem já votou nunca entra em pendentes nem em foraDoEleitorado", async () => {
    const eleitoresHashes = await Promise.all(["a@example.com", "b@example.com"].map((e) => eleitorHash(e)));
    const { pendentes, foraDoEleitorado } = await selectPendentesElegiveis(
      ["a@example.com", "b@example.com"],
      ["a@example.com", "b@example.com"],
      eleitoresHashes,
    );
    assert.deepEqual(pendentes, []);
    assert.deepEqual(foraDoEleitorado, []);
  });
});

describe("ballotWriteFailureMessage — erro pós-patch diz o que já aconteceu (#8394)", () => {
  it("nomeia os patches já aplicados, a key que falta e desaconselha ação manual", () => {
    const msg = ballotWriteFailureMessage("2610", 7, 9, "KV PUT 500");
    assert.match(msg, /KV PUT 500/);
    assert.match(msg, /JÁ ACONTECERAM/);
    assert.match(msg, /7\/9/, "diz quantos custom fields já foram patchados");
    assert.match(msg, /voto_token/);
    assert.match(msg, /polltoken:\*/);
    assert.ok(msg.includes(ballotKey("2610")), "nomeia a key da cédula que falta");
    assert.match(msg, /NÃO repatche o Kit manualmente/);
    assert.match(msg, /--push --force/, "aponta a reexecução segura");
  });
});
