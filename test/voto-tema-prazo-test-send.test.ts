/**
 * test/voto-tema-prazo-test-send.test.ts (#9260, #9261)
 *
 * #9260: no ciclo 2609 o prazo ficou fora do e-mail e a votação seguiu
 * aceitando voto dias depois. Agora `prazo` é validado em `validarCedula`,
 * aparece no e-mail e no placar, e o worker recusa voto depois dele.
 *
 * #9261: `--test-send` prova a merge tag `voto_token` — token garantido para
 * os membros de `diaria-test-email`, broadcast filtrado relido ANTES de
 * agendar. Tudo com mocks: nenhum Kit/KV real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ballotKey,
  eleitorHash,
  formatPrazo,
  pollTokenKvKeyMirror,
  prazoEncerrado,
  validarCedula,
  voteKey,
  type BallotTema,
} from "../workers/artigos/src/voto-tema-core.ts";
import {
  handleVotacaoOpcaoGet,
  handleVotacaoPlacar,
  handleVotoPost,
  type VotoTemaEnv,
} from "../workers/artigos/src/voto-tema.ts";
import {
  TEST_SEND_DELAY_MS,
  renderVotoTemaEmailHtml,
  runTestSend,
  type TestSendDeps,
} from "../scripts/publish-voto-tema-kit.ts";
import { KIT_TEST_SEND_TAG_NAME, buildTestSendFilter } from "../scripts/lib/kit-broadcasts.ts";

const OPCOES = [
  { n: 1, titulo: "Tema A", descricao: "Descrição A" },
  { n: 2, titulo: "Tema B", descricao: "Descrição B" },
];
const PASSADO = "2020-01-01T09:00:00-03:00";
const FUTURO = "2099-01-01T09:00:00-03:00";

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
    async list({ prefix }: { prefix?: string } = {}) {
      return {
        keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  } as unknown as VotoTemaEnv["POLL"] & { store: Map<string, string> };
}

async function envCom(prazo: string | undefined) {
  const ballot: BallotTema = {
    titulo: "Tema",
    opcoes: OPCOES,
    eleitores: [await eleitorHash("m@example.com")],
    aberta_em: "2026-09-20T12:00:00Z",
    ...(prazo ? { prazo } : {}),
  };
  const POLL = fakeKv({ [ballotKey("2610")]: JSON.stringify(ballot), [pollTokenKvKeyMirror("a".repeat(24))]: "m@example.com" });
  return { env: { POLL } as VotoTemaEnv, POLL, ballot };
}

describe("validarCedula — prazo (#9260)", () => {
  it("aceita prazo ISO com fuso", () => {
    assert.deepEqual(validarCedula({ titulo: "T", opcoes: OPCOES, prazo: FUTURO }, { exigirPrazo: true }), { ok: true });
  });
  it("exigirPrazo recusa cédula sem prazo", () => {
    const r = validarCedula({ titulo: "T", opcoes: OPCOES }, { exigirPrazo: true });
    assert.equal(r.ok, false);
  });
  it("sem exigirPrazo, ausência é aceita (cédulas antigas no KV)", () => {
    assert.deepEqual(validarCedula({ titulo: "T", opcoes: OPCOES }), { ok: true });
  });
  for (const ruim of ["27/09 9h", "2026-09-27T09:00:00", "2026-09-27", "2026-13-40T09:00:00Z"]) {
    it(`recusa prazo malformado/sem fuso: ${ruim}`, () => {
      assert.equal(validarCedula({ titulo: "T", opcoes: OPCOES, prazo: ruim }).ok, false);
    });
  }
});

describe("prazoEncerrado / formatPrazo (#9260)", () => {
  it("encerra no instante do prazo, não antes", () => {
    const b = { prazo: "2026-09-27T09:00:00-03:00" };
    assert.equal(prazoEncerrado(b, new Date("2026-09-27T11:59:59Z")), false);
    assert.equal(prazoEncerrado(b, new Date("2026-09-27T12:00:00Z")), true);
    assert.equal(prazoEncerrado({}, new Date("2099-01-01T00:00:00Z")), false);
  });
  it("formata em horário de Brasília", () => {
    assert.equal(formatPrazo("2026-09-27T12:00:00Z"), "27/09/2026 às 09:00 (horário de Brasília)");
  });
});

describe("worker recusa voto depois do prazo (#9260)", () => {
  it("POST após o prazo → 409 e nada gravado", async () => {
    const { env, POLL } = await envCom(PASSADO);
    const res = await handleVotoPost(new Request(`https://x/votacao/2610/1?t=${"a".repeat(24)}`, { method: "POST" }), env, "2610", 1);
    assert.equal(res.status, 409);
    assert.equal(POLL.store.has(voteKey("2610", "m@example.com")), false);
  });
  it("GET da opção após o prazo → 409", async () => {
    const { env } = await envCom(PASSADO);
    const res = await handleVotacaoOpcaoGet(new Request(`https://x/votacao/2610/1?t=${"a".repeat(24)}`), env, "2610", 1);
    assert.equal(res.status, 409);
  });
  it("POST antes do prazo grava normalmente", async () => {
    const { env, POLL } = await envCom(FUTURO);
    const res = await handleVotoPost(new Request(`https://x/votacao/2610/1?t=${"a".repeat(24)}`, { method: "POST" }), env, "2610", 1);
    assert.equal(res.status, 200);
    assert.equal(POLL.store.has(voteKey("2610", "m@example.com")), true);
  });
  it("placar mostra o prazo e se apresenta encerrado depois dele", async () => {
    const aberto = await (await handleVotacaoPlacar(new Request("https://x/votacao/2610"), (await envCom(FUTURO)).env, "2610")).text();
    assert.match(aberto, /Vote até: 01\/01\/2099 às 09:00/);
    const fechado = await (await handleVotacaoPlacar(new Request("https://x/votacao/2610"), (await envCom(PASSADO)).env, "2610")).text();
    assert.match(fechado, /Votação encerrada/);
    assert.match(fechado, /Prazo: 01\/01\/2020 às 09:00/);
  });
});

describe("e-mail da votação exibe o prazo (#9260)", () => {
  it("com prazo", async () => {
    const { ballot } = await envCom(FUTURO);
    assert.match(renderVotoTemaEmailHtml("2610", ballot), /Prazo para votar: 01\/01\/2099 às 09:00/);
  });
  it("sem prazo, sem linha", async () => {
    const { ballot } = await envCom(undefined);
    assert.doesNotMatch(renderVotoTemaEmailHtml("2610", ballot), /Prazo para votar/);
  });
});

describe("runTestSend — test-send da merge tag voto_token (#9261)", () => {
  const TAG_ID = 77;
  function mkDeps(over: Partial<TestSendDeps> = {}) {
    const calls: string[] = [];
    const kv = new Map<string, string>();
    const fields = new Map<number, Record<string, string>>();
    let created: Parameters<TestSendDeps["createBroadcast"]>[0] | null = null;
    let scheduled: string | null = null;
    const deps: TestSendDeps = {
      findTagIdByName: async (name) => (name === KIT_TEST_SEND_TAG_NAME ? TAG_ID : null),
      fetchTagMembers: async () => [{ id: 5, email: "teste@example.com" }],
      computeToken: async () => "b".repeat(24),
      putKv: async (k, v) => {
        calls.push("kv");
        kv.set(k, v);
      },
      updateSubscriberFields: async (id, f) => {
        calls.push("kit-field");
        fields.set(id, f);
      },
      createBroadcast: async (input) => {
        calls.push("create");
        created = input;
        return { id: 999 };
      },
      getBroadcast: async () => ({ subscriber_filter: buildTestSendFilter(TAG_ID) }),
      updateBroadcast: async (_id, input) => {
        calls.push("schedule");
        scheduled = input.send_at;
      },
      now: () => new Date("2026-10-01T12:00:00Z"),
      ...over,
    };
    return { deps, calls, kv, fields, get created() { return created; }, get scheduled() { return scheduled; } };
  }
  const ballot: BallotTema = { titulo: "T", opcoes: OPCOES, eleitores: [], aberta_em: "x", prazo: FUTURO };

  it("garante token (KV antes do Kit), cria rascunho filtrado na tag de teste, relê e só então agenda", async () => {
    const m = mkDeps();
    const r = await runTestSend("2610", ballot, m.deps, () => {});
    assert.deepEqual(m.calls, ["kv", "kit-field", "create", "schedule"]);
    assert.equal(m.kv.get(pollTokenKvKeyMirror("b".repeat(24))), "teste@example.com");
    assert.deepEqual(m.fields.get(5), { voto_token: "b".repeat(24) });
    assert.equal(m.created!.send_at, null);
    assert.deepEqual(m.created!.subscriber_filter, buildTestSendFilter(TAG_ID));
    assert.match(m.created!.content, /\?t=\{\{ subscriber\.voto_token \}\}/);
    assert.equal(m.scheduled, new Date(Date.parse("2026-10-01T12:00:00Z") + TEST_SEND_DELAY_MS).toISOString());
    assert.equal(r.broadcastId, 999);
  });

  it("filtro divergente na releitura → lança e NÃO agenda", async () => {
    const m = mkDeps({ getBroadcast: async () => ({ subscriber_filter: [] }) });
    await assert.rejects(runTestSend("2610", ballot, m.deps, () => {}), /NÃO foi agendado/);
    assert.ok(!m.calls.includes("schedule"));
  });

  it("releitura falha → lança e NÃO agenda", async () => {
    const m = mkDeps({ getBroadcast: async () => { throw new Error("500"); } });
    await assert.rejects(runTestSend("2610", ballot, m.deps, () => {}), /NÃO foi agendado/);
    assert.ok(!m.calls.includes("schedule"));
  });

  it("tag de teste inexistente ou vazia → nada é criado", async () => {
    const semTag = mkDeps({ findTagIdByName: async () => null });
    await assert.rejects(runTestSend("2610", ballot, semTag.deps, () => {}), /não existe/);
    const vazia = mkDeps({ fetchTagMembers: async () => [] });
    await assert.rejects(runTestSend("2610", ballot, vazia.deps, () => {}), /vazia/);
    assert.deepEqual([...semTag.calls, ...vazia.calls], []);
  });
});
