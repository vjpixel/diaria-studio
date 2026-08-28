/**
 * test/kit-diaria-channel-6126.test.ts (#6126)
 *
 * O que estes testes protegem, acima de tudo: no Kit, um `subscriber_filter`
 * ausente ou vazio significa **audiência INTEIRA**, não audiência nenhuma.
 * Toda falha deste canal precisa degradar para "não envia" — nunca para
 * "envia pra base toda", que entregaria a edição EM DOBRO aos 585 assinantes
 * importados da Beehiiv.
 *
 * Por isso a maioria dos casos abaixo é sobre RECUSA, não sobre sucesso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideKitChannelDispatch,
  resolveAudienceTagId,
  checkAudienceTagHasMembers,
  type KitDiariaPublished,
} from "../scripts/lib/kit-diaria-channel.ts";
import { buildTagFilter, buildTestSendFilter, buildAllSubscribersFilter } from "../scripts/lib/kit-broadcasts.ts";

const DEFAULT_TAG = "kit-nativo";

const published: KitDiariaPublished = {
  broadcast_id: 999,
  subject: "s",
  preview_text: "p",
  audience_tag: DEFAULT_TAG,
  audience_tag_id: 42,
  status: "draft",
};

describe("#6126 decideKitChannelDispatch", () => {
  it("idempotência vence config: estado existente vira no-op mesmo com canal desligado", () => {
    // Ordem deliberada — um resume da Etapa 5 nunca reprocessa edição já
    // despachada, nem para reavaliar config (mesmo princípio do #5772).
    const d = decideKitChannelDispatch({
      config: { enabled: false },
      existing: published,
      defaultAudienceTag: DEFAULT_TAG,
    });
    assert.deepEqual(d, { action: "already_done", broadcastId: 999 });
  });

  it("REGRESSÃO #6162: backend === \"kit\" ⇒ skip, mesmo com o canal ligado", () => {
    // Guard de exclusão mútua. Com o switchover ativo, o Passo 5c-1-kit já
    // dispara pra audiência INTEIRA; rodar o canal paralelo junto entregaria
    // a edição EM DOBRO a quem está nos dois filtros.
    const d = decideKitChannelDispatch({
      config: { enabled: true },
      newsletterBackend: "kit",
      existing: null,
      defaultAudienceTag: DEFAULT_TAG,
    });
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.match(d.reason, /EM DOBRO/);
  });

  it("backend \"beehiiv\" (o normal) não bloqueia o canal paralelo", () => {
    const d = decideKitChannelDispatch({
      config: { enabled: true },
      newsletterBackend: "beehiiv",
      existing: null,
      defaultAudienceTag: DEFAULT_TAG,
    });
    assert.deepEqual(d, { action: "dispatch", audienceTag: DEFAULT_TAG });
  });

  it("config ausente ⇒ skip (não dispatch)", () => {
    const d = decideKitChannelDispatch({ config: undefined, existing: null, defaultAudienceTag: DEFAULT_TAG });
    assert.equal(d.action, "skip");
  });

  it("default é DESLIGADO: enabled ausente ⇒ skip", () => {
    const d = decideKitChannelDispatch({ config: {}, existing: null, defaultAudienceTag: DEFAULT_TAG });
    assert.equal(d.action, "skip");
  });

  it("enabled precisa ser exatamente true — valores truthy não bastam", () => {
    for (const v of [1, "true", "yes", {}] as unknown[]) {
      const d = decideKitChannelDispatch({
        config: { enabled: v as boolean },
        existing: null,
        defaultAudienceTag: DEFAULT_TAG,
      });
      assert.equal(d.action, "skip", `enabled=${JSON.stringify(v)} deveria pular`);
    }
  });

  it("audience_tag vazio ⇒ skip, NUNCA dispatch com filtro default", () => {
    // Este é o caso que causaria envio à base inteira se degradasse errado.
    for (const tag of ["", "   "]) {
      const d = decideKitChannelDispatch({
        config: { enabled: true, audience_tag: tag },
        existing: null,
        defaultAudienceTag: DEFAULT_TAG,
      });
      assert.equal(d.action, "skip", `audience_tag=${JSON.stringify(tag)} deveria pular`);
      if (d.action === "skip") assert.match(d.reason, /audiência INTEIRA/);
    }
  });

  it("habilitado sem audience_tag usa o default kit-nativo", () => {
    const d = decideKitChannelDispatch({ config: { enabled: true }, existing: null, defaultAudienceTag: DEFAULT_TAG });
    assert.deepEqual(d, { action: "dispatch", audienceTag: DEFAULT_TAG });
  });

  it("audience_tag customizado permite o rollout escalonado da #6126", () => {
    const d = decideKitChannelDispatch({
      config: { enabled: true, audience_tag: "diaria-test-email" },
      existing: null,
      defaultAudienceTag: DEFAULT_TAG,
    });
    assert.deepEqual(d, { action: "dispatch", audienceTag: "diaria-test-email" });
  });
});

describe("#6126 resolveAudienceTagId — o guard contra audiência inteira", () => {
  it("tag inexistente (null) ⇒ recusa, citando o motivo real", () => {
    // null = o marcador de cadastro nativo (#6048/PR #6127) ainda não rodou.
    const r = resolveAudienceTagId("kit-nativo", null);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /audiência INTEIRA/);
      assert.match(r.reason, /kit-nativo/);
    }
  });

  it("ids inválidos são recusados — inclusive 0, que é falsy e passaria num if solto", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const r = resolveAudienceTagId("t", bad);
      assert.equal(r.ok, false, `id ${bad} deveria ser recusado`);
    }
  });

  it("id válido passa", () => {
    assert.deepEqual(resolveAudienceTagId("t", 7), { ok: true, tagId: 7 });
  });
});

describe("#6582 checkAudienceTagHasMembers — tag resolvida mas VAZIA deixou de ser normal", () => {
  it("0 membros ⇒ recusa (o cenário do incidente: tag resolve, ninguém recebe)", () => {
    const r = checkAudienceTagHasMembers("rampa-kit", 0);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /VAZIA/);
      assert.match(r.reason, /rampa-kit/);
      assert.match(r.reason, /6582/);
    }
  });

  it("contagem negativa ou não-inteira ⇒ recusa (dado inválido, não confiar)", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      const r = checkAudienceTagHasMembers("t", bad);
      assert.equal(r.ok, false, `contagem ${bad} deveria ser recusada`);
    }
  });

  it("≥1 membro passa", () => {
    assert.deepEqual(checkAudienceTagHasMembers("t", 1), { ok: true });
    assert.deepEqual(checkAudienceTagHasMembers("t", 92), { ok: true });
  });
});

describe("#6126 buildTagFilter", () => {
  it("produz filtro escopado à tag, nunca vazio", () => {
    const f = buildTagFilter(7);
    assert.deepEqual(f, [{ all: [{ type: "tag", ids: [7] }] }]);
    assert.notDeepEqual(f, []);
  });

  it("é distinto de buildAllSubscribersFilter — o filtro da base inteira", () => {
    assert.notDeepEqual(buildTagFilter(7), buildAllSubscribersFilter());
  });

  it("buildTestSendFilter continua equivalente após o refactor (#6126)", () => {
    // buildTestSendFilter passou a delegar em buildTagFilter; o contrato
    // público dele não pode ter mudado.
    assert.deepEqual(buildTestSendFilter(123), buildTagFilter(123));
    assert.deepEqual(buildTestSendFilter(123), [{ all: [{ type: "tag", ids: [123] }] }]);
  });
});
