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

describe("#6126 runStage5KitDispatch — o guard: nenhum caminho de recusa toca a rede", () => {
  it("canal desligado ⇒ skipped e createBroadcast NÃO chamado", async () => {
    const { deps, spy } = makeDeps({ config: { enabled: false } });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "skipped");
    assert.equal(spy.createCalls.length, 0);
    assert.equal(spy.writeCalls.length, 0);
  });

  it("config ausente ⇒ skipped e createBroadcast NÃO chamado", async () => {
    const { deps, spy } = makeDeps({ config: undefined as unknown as KitDiariaChannelConfig });
    // readPlatformConfig devolve { kit_diaria: { enabled: true } } quando
    // `config === undefined`; forçamos o caso real de bloco ausente:
    deps.readPlatformConfig = () => ({});
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "skipped");
    assert.equal(spy.createCalls.length, 0);
  });

  it("tag inexistente (findTagId → null) ⇒ skipped, createBroadcast NÃO chamado", async () => {
    // Cenário real: o marcador de cadastro nativo ainda não produziu ninguém.
    const { deps, spy } = makeDeps({ findTagId: async () => null });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "skipped");
    if (r.status === "skipped") assert.match(r.reason, /audiência INTEIRA/);
    assert.equal(spy.createCalls.length, 0, "NUNCA criar broadcast com tag não resolvida");
  });

  it("tag id inválido (0) ⇒ skipped, createBroadcast NÃO chamado", async () => {
    // `0` é falsy: um `if (tagId)` ingênuo pularia o guard e seguiria.
    const { deps, spy } = makeDeps({ findTagId: async () => 0 });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "skipped");
    assert.equal(spy.createCalls.length, 0);
  });

  it("findTagId rejeita (erro de rede) ⇒ failed, createBroadcast NÃO chamado", async () => {
    const { deps, spy } = makeDeps({
      findTagId: async () => {
        throw new Error("ECONNRESET");
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "failed");
    if (r.status === "failed") {
      assert.equal(r.step, "findTagIdByName");
      assert.match(r.reason, /ECONNRESET/, "a causa original precisa sobreviver");
    }
    assert.equal(spy.createCalls.length, 0);
  });

  it("subject vazio ⇒ failed, createBroadcast NÃO chamado", async () => {
    const { deps, spy } = makeDeps({
      buildPayload: () => ({ html: "<p>x</p>", subject: "   ", previewText: "p", unresolvedImages: [], renderWarnings: [] }),
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "failed");
    assert.equal(spy.createCalls.length, 0);
  });

  it("buildPayload lança ⇒ failed com a causa, createBroadcast NÃO chamado", async () => {
    const { deps, spy } = makeDeps({
      buildPayload: () => {
        throw new Error("02-reviewed.md ausente");
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "failed");
    if (r.status === "failed") assert.match(r.reason, /02-reviewed/);
    assert.equal(spy.createCalls.length, 0);
  });

  it("dry-run ⇒ skipped, sem createBroadcast e sem writeState", async () => {
    const { deps, spy } = makeDeps();
    const r = await runStage5KitDispatch(EDITION, deps, { dryRun: true });
    assert.equal(r.status, "skipped");
    assert.equal(spy.createCalls.length, 0, "dry-run não pode vazar pra chamada real");
    assert.equal(spy.writeCalls.length, 0);
  });
});

describe("#6582 runStage5KitDispatch — tag resolvida mas VAZIA (0 membros)", () => {
  it("0 membros ⇒ failed (não skipped — deixou de ser 'estado normal'), createBroadcast NÃO chamado", async () => {
    const { deps, spy } = makeDeps({ countTagMembers: async () => 0 });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "failed");
    if (r.status === "failed") {
      assert.equal(r.step, "audienceTagEmpty");
      assert.match(r.reason, /VAZIA/);
      assert.match(r.reason, /6582/);
    }
    assert.equal(spy.createCalls.length, 0, "NUNCA criar broadcast com tag vazia");
  });

  it("countTagMembers rejeita (erro de rede) ⇒ failed, createBroadcast NÃO chamado", async () => {
    const { deps, spy } = makeDeps({
      countTagMembers: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "failed");
    if (r.status === "failed") {
      assert.equal(r.step, "countTagMembers");
      assert.match(r.reason, /ETIMEDOUT/);
    }
    assert.equal(spy.createCalls.length, 0);
  });

  it("membros > 0 segue normalmente (não regride o caminho feliz)", async () => {
    const { deps, spy } = makeDeps({ countTagMembers: async () => 92 });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "ok");
    assert.equal(spy.createCalls.length, 1);
  });
});

describe("#6582 runStage5KitDispatch — verificação pós-dispatch da audiência", () => {
  it("releitura confirma o subscriber_filter esperado ⇒ audienceFilterVerified: true", async () => {
    const { deps } = makeDeps({
      getBroadcast: async () => ({ subscriber_filter: buildTagFilter(TAG_ID) }),
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "ok");
    if (r.status === "ok") assert.equal(r.audienceFilterVerified, true);
  });

  it("releitura DIVERGE do filtro esperado ⇒ failed, broadcast já existe mas dispatch reporta falha", async () => {
    const { deps, spy } = makeDeps({
      // Simula a API aceitando 2xx mas aplicando um filtro diferente
      // (ex: base inteira) — o cenário que #573/#6195 já documentam pra
      // outras chamadas do módulo.
      getBroadcast: async () => ({ subscriber_filter: buildAllSubscribersFilter() }),
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "failed");
    if (r.status === "failed") {
      assert.equal(r.step, "verifyBroadcastAudience");
      assert.match(r.reason, /divergente/);
      assert.match(r.reason, /555/, "precisa do broadcast_id — ele JÁ existe no Kit");
    }
    // O broadcast já foi criado (createBroadcast chamado) — a falha é da
    // CAMADA de verificação, não do dispatch em si.
    assert.equal(spy.createCalls.length, 1);
  });

  describe("#6693 REGRESSÃO — persistir broadcast_id ANTES de retornar failed em verifyBroadcastAudience", () => {
    it("estado é gravado com broadcast_id e audience_verified:false — sem isso o resume duplicaria o broadcast", async () => {
      const { deps, spy } = makeDeps({
        getBroadcast: async () => ({ subscriber_filter: buildAllSubscribersFilter() }),
      });
      const r = await runStage5KitDispatch(EDITION, deps);
      assert.equal(r.status, "failed");
      assert.equal(spy.writeCalls.length, 1, "o bug original NÃO gravava estado neste retorno failed");
      assert.deepEqual(spy.writeCalls[0], {
        broadcast_id: 555,
        subject: "Assunto",
        preview_text: "Preview",
        audience_tag: "kit-nativo",
        audience_tag_id: TAG_ID,
        status: "draft",
        audience_verified: false,
      });
    });

    it("2ª chamada de decideKitChannelDispatch (resume) vê o estado gravado e decide already_done, NUNCA dispatch de novo", async () => {
      const { deps: firstDeps } = makeDeps({
        getBroadcast: async () => ({ subscriber_filter: buildAllSubscribersFilter() }),
      });
      let persisted: KitDiariaPublished | null = null;
      firstDeps.writeState = (_dir, state) => {
        persisted = state;
      };
      const first = await runStage5KitDispatch(EDITION, firstDeps);
      assert.equal(first.status, "failed");
      assert.ok(persisted, "o 1º dispatch precisa ter persistido o estado");

      // Resume: uma 2ª invocação do dispatch, lendo o estado que a 1ª gravou.
      const { deps: secondDeps, spy: secondSpy } = makeDeps({ existing: persisted! });
      const second = await runStage5KitDispatch(EDITION, secondDeps);
      assert.deepEqual(second, { status: "already_done", broadcastId: 555 });
      assert.equal(secondSpy.createCalls.length, 0, "resume NUNCA cria um 2º broadcast duplicado");
    });

    it("writeState também falha (disco cheio) ⇒ a mensagem avisa que o resume PODE duplicar", async () => {
      const { deps, spy } = makeDeps({
        getBroadcast: async () => ({ subscriber_filter: buildAllSubscribersFilter() }),
        writeState: () => {
          throw new Error("ENOSPC");
        },
      });
      const r = await runStage5KitDispatch(EDITION, deps);
      assert.equal(r.status, "failed");
      if (r.status === "failed") {
        assert.match(r.reason, /ENOSPC/);
        assert.match(r.reason, /2º duplicado|duplicado/i);
      }
      assert.equal(spy.createCalls.length, 1);
    });
  });

  it("subscriber_filter ausente na releitura ⇒ ok mas audienceFilterVerified: false (não confirmável, não é falha)", async () => {
    const { deps } = makeDeps({ getBroadcast: async () => ({}) });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "ok");
    if (r.status === "ok") assert.equal(r.audienceFilterVerified, false);
  });

  it("getBroadcast rejeita (erro de rede) ⇒ fail-soft: ok com audienceFilterVerified: false", async () => {
    const { deps } = makeDeps({
      getBroadcast: async () => {
        throw new Error("503");
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "ok", "a releitura é verificação adicional — falha dela não derruba o dispatch");
    if (r.status === "ok") assert.equal(r.audienceFilterVerified, false);
  });
});

describe("#6126 runStage5KitDispatch — idempotência", () => {
  it("estado existente ⇒ already_done sem tocar rede nem regravar", async () => {
    const existing: KitDiariaPublished = {
      broadcast_id: 777,
      subject: "s",
      preview_text: "p",
      audience_tag: "kit-nativo",
      audience_tag_id: TAG_ID,
      status: "draft",
    };
    const { deps, spy } = makeDeps({ existing });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.deepEqual(r, { status: "already_done", broadcastId: 777 });
    assert.equal(spy.createCalls.length, 0, "resume nunca cria um 2º broadcast");
    assert.equal(spy.writeCalls.length, 0);
  });
});

describe("#6126 runStage5KitDispatch — caminho feliz", () => {
  it("envia com filtro DA TAG, nunca o da base inteira", async () => {
    const { deps, spy } = makeDeps();
    const r = await runStage5KitDispatch(EDITION, deps);

    assert.equal(r.status, "ok");
    assert.equal(spy.createCalls.length, 1);

    const call = spy.createCalls[0];
    // A asserção que justifica este arquivo existir:
    assert.deepEqual(call.subscriber_filter, buildTagFilter(TAG_ID));
    assert.notDeepEqual(
      call.subscriber_filter,
      buildAllSubscribersFilter(),
      "jamais o filtro da base inteira",
    );
    assert.notDeepEqual(call.subscriber_filter, [], "jamais filtro vazio (= base inteira no Kit)");
    // Rascunho: a Etapa 6 é quem agenda, sob o gate do editor.
    assert.equal(call.send_at, null);
    assert.equal(call.subject, "Assunto");
    assert.equal(call.content, "<p>oi</p>");
  });

  it("grava o estado com o id RESOLVIDO e a tag usada (auditoria de 'para quem foi')", async () => {
    const { deps, spy } = makeDeps();
    await runStage5KitDispatch(EDITION, deps);
    assert.equal(spy.writeCalls.length, 1);
    assert.deepEqual(spy.writeCalls[0], {
      broadcast_id: 555,
      subject: "Assunto",
      preview_text: "Preview",
      audience_tag: "kit-nativo",
      audience_tag_id: TAG_ID,
      status: "draft",
    });
  });

  it("audience_tag customizado é respeitado — habilita o rollout escalonado", async () => {
    const seen: string[] = [];
    const { deps, spy } = makeDeps({
      config: { enabled: true, audience_tag: "diaria-test-email" },
      findTagId: async (name) => {
        seen.push(name);
        return 99;
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "ok");
    assert.deepEqual(seen, ["diaria-test-email"]);
    assert.deepEqual(spy.createCalls[0].subscriber_filter, buildTagFilter(99));
  });
});

describe("#6126 runStage5KitDispatch — falha de rede na criação", () => {
  it("createBroadcast rejeita ⇒ failed e estado NÃO é gravado", async () => {
    // Gravar estado de um broadcast que não existe faria a próxima invocação
    // reportar `already_done` para um id inexistente — pior que duplicar.
    const { deps, spy } = makeDeps({
      createBroadcast: async () => {
        throw new Error("429 rate limited");
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "failed");
    if (r.status === "failed") {
      assert.equal(r.step, "createBroadcast");
      assert.match(r.reason, /429/);
    }
    assert.equal(spy.writeCalls.length, 0, "não gravar estado de broadcast que não foi criado");
  });
});

describe("#6126 runStage5KitDispatch — findings do review da PR #6138", () => {
  it("finding 1: estado CORROMPIDO ⇒ failed, nunca 'dispatch de novo'", async () => {
    // O bug original: JSON ilegível virava `null`, que `decideKitChannelDispatch`
    // lê como "nunca despachado" — e o dispatch criava um SEGUNDO broadcast
    // para a mesma edição. Newsletter em dobro, e envio não se desfaz.
    const { deps, spy } = makeDeps({
      readState: () => {
        throw new KitDiariaStateCorruptError("kit-diaria-published.json não é JSON válido");
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "failed");
    if (r.status === "failed") assert.match(r.reason, /JSON válido/);
    assert.equal(spy.createCalls.length, 0, "estado ilegível NUNCA pode virar 2º broadcast");
  });

  it("finding 2: writeState falhando ⇒ failed que AVISA que o broadcast já existe", async () => {
    // Sem isso a exceção subia crua: broadcast órfão no Kit, estado local
    // ausente, e o resume seguinte duplicava o envio.
    const { deps, spy } = makeDeps({
      writeState: () => {
        throw new Error("ENOSPC");
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "failed");
    if (r.status === "failed") {
      assert.equal(r.step, "writeState");
      assert.match(r.reason, /JÁ FOI CRIADO/, "quem lê o resumo precisa saber antes de re-rodar");
      assert.match(r.reason, /555/, "e precisa do broadcast_id pra conferir no Kit");
    }
    assert.equal(spy.createCalls.length, 1);
  });

  it("finding 3: readPlatformConfig lançando ⇒ failed estruturado, não crash", async () => {
    const { deps, spy } = makeDeps();
    deps.readPlatformConfig = () => {
      throw new Error("platform.config.json malformado");
    };
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "failed");
    if (r.status === "failed") assert.match(r.reason, /malformado/);
    assert.equal(spy.createCalls.length, 0);
  });

  it("finding 4: warnings de render chegam ao RESULTADO, não só ao log", async () => {
    // Warning só em stderr é warning que o editor nunca vê num `status: "ok"`,
    // porque o orchestrator lê o JSON de stdout.
    const { deps } = makeDeps({
      buildPayload: () => ({
        html: "<p>x</p>",
        subject: "S",
        previewText: "P",
        unresolvedImages: ["04-d1-2x1.jpg"],
        renderWarnings: ["bloco_perdido"],
      }),
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "ok");
    if (r.status === "ok") {
      assert.deepEqual(r.unresolvedImages, ["04-d1-2x1.jpg"]);
      assert.deepEqual(r.renderWarnings, ["bloco_perdido"]);
    }
  });
});

describe("#6181 --send-test — testar o HTML antes de agendar", () => {
  it("troca a audiência pra tag de teste, NÃO a de produção", async () => {
    // Sem isto não havia forma suportada de testar este canal:
    // `publish-newsletter-kit.ts --send-test` é gated por
    // `checkKitBackendEnabled` (exige backend "kit"), o oposto daqui.
    const vistos: string[] = [];
    const { deps, spy } = makeDeps({
      config: { enabled: true, audience_tag: "audiencia-de-producao" },
      findTagId: async (nome) => {
        vistos.push(nome);
        return 999;
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps, { sendTest: true });
    assert.equal(r.status, "ok");
    assert.deepEqual(vistos, ["diaria-test-email"], "jamais resolver a audiência de produção num test-send");
    assert.equal(spy.createCalls.length, 1);
  });

  it("NÃO grava estado — senão o dispatch real veria already_done e nunca criaria o broadcast da edição", async () => {
    const { deps, spy } = makeDeps();
    await runStage5KitDispatch(EDITION, deps, { sendTest: true });
    assert.equal(spy.writeCalls.length, 0);
  });

  it("test-send dispara sozinho (send_at futuro); produção nasce rascunho (null)", async () => {
    const t0 = 1_700_000_000_000;
    const a = makeDeps();
    await runStage5KitDispatch(EDITION, a.deps, { sendTest: true });
    assert.equal(a.spy.createCalls[0].send_at, new Date(t0 + 60_000).toISOString());

    const b = makeDeps();
    await runStage5KitDispatch(EDITION, b.deps);
    assert.equal(b.spy.createCalls[0].send_at, null, "produção nunca auto-dispara — Etapa 6 agenda");
  });

  it("dry-run + send-test não cria nada", async () => {
    const { deps, spy } = makeDeps();
    const r = await runStage5KitDispatch(EDITION, deps, { sendTest: true, dryRun: true });
    assert.equal(r.status, "skipped");
    assert.equal(spy.createCalls.length, 0);
  });

  describe("#6701 REGRESSÃO — mensagem de tag vazia aponta pro lugar certo em cada caminho", () => {
    it("--send-test com tag de teste VAZIA ⇒ mensagem fala da tag de TESTE, não de produção", async () => {
      const { deps, spy } = makeDeps({ countTagMembers: async () => 0 });
      const r = await runStage5KitDispatch(EDITION, deps, { sendTest: true });
      assert.equal(r.status, "failed");
      if (r.status === "failed") {
        assert.equal(r.step, "audienceTagEmpty");
        assert.match(r.reason, /diaria-test-email|KIT_TEST_SEND_TAG_NAME|teste/i);
        // A mensagem de produção não deve vazar pro caminho de teste.
        assert.doesNotMatch(r.reason, /ondas 0\/1/);
        assert.doesNotMatch(r.reason, /único canal alcançável/);
      }
      assert.equal(spy.createCalls.length, 0);
    });

    it("produção (sem --send-test) com tag VAZIA ⇒ mensagem original de produção intacta", async () => {
      const { deps } = makeDeps({ countTagMembers: async () => 0 });
      const r = await runStage5KitDispatch(EDITION, deps);
      assert.equal(r.status, "failed");
      if (r.status === "failed") {
        assert.match(r.reason, /ondas 0\/1/);
        assert.match(r.reason, /6582/);
      }
    });
  });
});

describe("#7357 runStage5KitDispatch — resgate por data (subscriber_filter_created_after)", () => {
  it("corte AUSENTE ⇒ nunca lista candidatos nem tagueia ninguém (comportamento pré-#7357)", async () => {
    const { deps, spy } = makeDeps({
      listCreatedAfterCandidates: async () => {
        throw new Error("não deveria ser chamado sem corte configurado");
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "ok");
    if (r.status === "ok") assert.equal(r.backfillTaggedCount, undefined);
    assert.equal(spy.tagSubscriberCalls.length, 0);
  });

  it("corte configurado: tagueia só quem ainda não tem a tag, com o id de tag da audiência de produção", async () => {
    const { deps, spy } = makeDeps({
      config: { enabled: true, subscriber_filter_created_after: "2026-08-25" },
      listCreatedAfterCandidates: async (cutoff) => {
        assert.equal(cutoff, "2026-08-25");
        return [
          { id: 101, tagIds: [] }, // precisa
          { id: 102, tagIds: [TAG_ID] }, // já tem — pula
          { id: 103, tagIds: [999] }, // precisa
        ];
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "ok");
    if (r.status === "ok") assert.equal(r.backfillTaggedCount, 2);
    assert.deepEqual(
      spy.tagSubscriberCalls.map((c) => c.subscriberId).sort(),
      [101, 103],
    );
    for (const call of spy.tagSubscriberCalls) assert.equal(call.tagId, TAG_ID);
  });

  it("nenhum candidato precisa de tag ⇒ backfillTaggedCount: 0 (dia normal, ninguém preso)", async () => {
    const { deps, spy } = makeDeps({
      config: { enabled: true, subscriber_filter_created_after: "2026-08-25" },
      listCreatedAfterCandidates: async () => [{ id: 1, tagIds: [TAG_ID] }],
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "ok");
    if (r.status === "ok") assert.equal(r.backfillTaggedCount, 0);
    assert.equal(spy.tagSubscriberCalls.length, 0);
  });

  it("--send-test NUNCA aciona o resgate — a tag ali é de teste, sem relação com o corte de produção", async () => {
    const { deps, spy } = makeDeps({
      config: { enabled: true, subscriber_filter_created_after: "2026-08-25" },
      listCreatedAfterCandidates: async () => {
        throw new Error("resgate não deve rodar em --send-test");
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps, { sendTest: true });
    assert.equal(r.status, "ok");
    if (r.status === "ok") assert.equal(r.backfillTaggedCount, undefined);
    assert.equal(spy.tagSubscriberCalls.length, 0);
  });

  it("listCreatedAfterCandidates falha ⇒ fail-soft: dispatch segue OK, erro registrado no resultado", async () => {
    const { deps, spy } = makeDeps({
      config: { enabled: true, subscriber_filter_created_after: "2026-08-25" },
      listCreatedAfterCandidates: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "ok", "falha do resgate não pode derrubar o envio pra quem já está na tag");
    if (r.status === "ok") {
      assert.equal(r.backfillTaggedCount, 0);
      assert.ok(r.backfillErrors?.some((e) => e.includes("ETIMEDOUT")));
    }
    assert.equal(spy.createCalls.length, 1, "o dispatch principal precisa continuar mesmo com o resgate falho");
  });

  it("tagSubscriber falha pra 1 candidato ⇒ fail-soft: os demais são tagueados, erro isolado registrado", async () => {
    const { deps, spy } = makeDeps({
      config: { enabled: true, subscriber_filter_created_after: "2026-08-25" },
      listCreatedAfterCandidates: async () => [
        { id: 1, tagIds: [] },
        { id: 2, tagIds: [] },
      ],
      tagSubscriber: async (_tagId, subscriberId) => {
        if (subscriberId === 1) throw new Error("429 rate limited");
      },
    });
    const r = await runStage5KitDispatch(EDITION, deps);
    assert.equal(r.status, "ok");
    if (r.status === "ok") {
      assert.equal(r.backfillTaggedCount, 1, "só o candidato 2 foi tagueado com sucesso");
      assert.ok(r.backfillErrors?.some((e) => e.includes("429 rate limited")));
    }
    assert.equal(spy.tagSubscriberCalls.length, 2, "tentou os dois — 1 falhou, não abortou o resto");
  });
});
