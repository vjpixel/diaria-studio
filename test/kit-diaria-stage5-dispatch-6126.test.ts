/**
 * test/kit-diaria-stage5-dispatch-6126.test.ts (#6126)
 *
 * Testa o ORQUESTRADOR (`runStage5KitDispatch`), não a lógica de decisão —
 * essa vive em `test/kit-diaria-channel-6126.test.ts`.
 *
 * **Por que este arquivo existe** (achado P0 do review da PR #6138): os testes
 * da lógica pura provam que `decideKitChannelDispatch`/`resolveAudienceTagId`
 * devolvem o veredito certo *em isolamento*. Nenhum deles prova que o
 * orquestrador **respeita** esse veredito antes de chamar `createBroadcast`.
 *
 * Um bug de wiring — `if` invertido, `return` esquecido num branch de skip,
 * refactor que reordene passos — passaria por todos os 13 testes de lógica sem
 * quebrar nenhum, e chegaria em produção fazendo exatamente o pior cenário do
 * módulo: criar broadcast com filtro que casa com a base inteira, entregando a
 * edição EM DOBRO aos 585 assinantes importados da Beehiiv.
 *
 * Daí a asserção que se repete em quase todo caso abaixo:
 * **`createBroadcast` não foi chamado**. É o invariante central do canal.
 *
 * Espelha `test/brevo-diaria-stage5-dispatch-5772.test.ts`, o precedente do
 * canal irmão.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runStage5KitDispatch,
  KitDiariaStateCorruptError,
  type Stage5KitDeps,
} from "../scripts/kit-diaria-stage5-dispatch.ts";
import type { KitDiariaChannelConfig, KitDiariaPublished } from "../scripts/lib/kit-diaria-channel.ts";
import { buildTagFilter, buildAllSubscribersFilter } from "../scripts/lib/kit-broadcasts.ts";

const EDITION = "/tmp/edicao-fake-6126";
const TAG_ID = 4242;

interface Spy {
  createCalls: Parameters<Stage5KitDeps["createBroadcast"]>[0][];
  writeCalls: KitDiariaPublished[];
  logs: string[];
  tagSubscriberCalls: { tagId: number; subscriberId: number }[];
}

function makeDeps(over: {
  config?: KitDiariaChannelConfig | undefined;
  existing?: KitDiariaPublished | null;
  readState?: Stage5KitDeps["readState"];
  writeState?: Stage5KitDeps["writeState"];
  findTagId?: Stage5KitDeps["findTagId"];
  countTagMembers?: Stage5KitDeps["countTagMembers"];
  listCreatedAfterCandidates?: Stage5KitDeps["listCreatedAfterCandidates"];
  tagSubscriber?: Stage5KitDeps["tagSubscriber"];
  getBroadcast?: Stage5KitDeps["getBroadcast"];
  buildPayload?: Stage5KitDeps["buildPayload"];
  createBroadcast?: Stage5KitDeps["createBroadcast"];
} = {}): { deps: Stage5KitDeps; spy: Spy } {
  const spy: Spy = { createCalls: [], writeCalls: [], logs: [], tagSubscriberCalls: [] };
  const deps: Stage5KitDeps = {
    readPlatformConfig: () => ({
      kit_diaria: over.config === undefined ? { enabled: true } : over.config,
    }),
    readState: over.readState ?? (() => over.existing ?? null),
    writeState:
      over.writeState ??
      ((_dir, state) => void spy.writeCalls.push(state)),
    findTagId: over.findTagId ?? (async () => TAG_ID),
    // #6582 — default não-vazio: só os testes que exercitam o guard novo
    // (tag vazia) sobrescrevem isto pra 0.
    countTagMembers: over.countTagMembers ?? (async () => 1),
    // #7357 — default sem candidatos: só os testes do resgate por data
    // configuram `subscriber_filter_created_after` e sobrescrevem isto.
    listCreatedAfterCandidates: over.listCreatedAfterCandidates ?? (async () => []),
    tagSubscriber:
      over.tagSubscriber ??
      (async (tagId, subscriberId) => {
        spy.tagSubscriberCalls.push({ tagId, subscriberId });
      }),
    // #6582 — default sem `subscriber_filter`: verificação pós-dispatch cai
    // no ramo "não confirmável" (warning, não failure) pros testes que não
    // exercitam a verificação especificamente.
    getBroadcast: over.getBroadcast ?? (async () => ({})),
    buildPayload:
      over.buildPayload ??
      (() => ({ html: "<p>oi</p>", subject: "Assunto", previewText: "Preview", unresolvedImages: [], renderWarnings: [] })),
    createBroadcast:
      over.createBroadcast ??
      (async (input) => {
        spy.createCalls.push(input);
        return { id: 555 };
      }),
    log: (l) => void spy.logs.push(l),
    now: () => 1_700_000_000_000,
  };
  // Envolve o tagSubscriber customizado pra também espionar, se fornecido.
  if (over.tagSubscriber) {
    const inner = over.tagSubscriber;
    deps.tagSubscriber = async (tagId, subscriberId) => {
      spy.tagSubscriberCalls.push({ tagId, subscriberId });
      return inner(tagId, subscriberId);
    };
  }
  // Envolve o createBroadcast customizado pra também espionar.
  if (over.createBroadcast) {
    const inner = over.createBroadcast;
    deps.createBroadcast = async (input) => {
      spy.createCalls.push(input);
      return inner(input);
    };
  }
  return { deps, spy };
}

describe("#11225 runStage5KitDispatch — recusa inclusive config legada", () => {
  for (const backend of [undefined, "kit", "beehiiv", "typo"]) {
    for (const sendTest of [false, true]) {
      it(`backend=${backend}, sendTest=${sendTest}: nenhuma escrita ou lookup de audiência`, async () => {
        const { deps, spy } = makeDeps();
        deps.readPlatformConfig = () => ({ kit_diaria: { enabled: true }, publishing: { newsletter: { backend } } });
        deps.findTagId = async () => { throw new Error("não deve buscar tag"); };
        deps.buildPayload = () => { throw new Error("não deve renderizar"); };
        const r = await runStage5KitDispatch(EDITION, deps, { sendTest });
        assert.equal(r.status, "skipped");
        assert.deepEqual(spy.createCalls, []);
        assert.deepEqual(spy.writeCalls, []);
        assert.deepEqual(spy.tagSubscriberCalls, []);
      });
    }
  }
  it("preserva broadcast histórico sem recriar", async () => {
    const { deps, spy } = makeDeps({ existing: { broadcast_id: 999 } as KitDiariaPublished });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "already_done");
    assert.deepEqual(spy.createCalls, []);
    assert.deepEqual(spy.writeCalls, []);
  });
  it("estado corrompido continua sendo falha visível sem rede", async () => {
    const { deps, spy } = makeDeps({ readState: () => { throw new Error("corrompido"); } });
    assert.equal((await runStage5KitDispatch(EDITION, deps)).status, "failed");
    assert.deepEqual(spy.createCalls, []);
  });
});
