/**
 * test/sync-apoio-mensal-tag-kit.test.ts (#7633)
 *
 * Cobre a seleção de audiência de `scripts/sync-apoio-mensal-tag-kit.ts` — o
 * sync que projeta o custom field `apoio_nivel` em membresia da tag usada
 * como `subscriber_filter` do envio extra dos apoiadores.
 *
 * O diff/guards puros ficam em `test/apoiadores-kit-channel.test.ts`; aqui é
 * só `selectDesiredMembers`, cuja falha tem duas direções ruins e assimétricas:
 * incluir quem não apoia (vaza conteúdo pago) ou excluir quem apoia (a pessoa
 * paga e não recebe a recompensa).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectDesiredMembers, type SelectableKitSubscriber } from "../scripts/sync-apoio-mensal-tag-kit.ts";

const sub = (over: Partial<SelectableKitSubscriber> & { id: number; email_address: string }): SelectableKitSubscriber => ({
  state: "active",
  fields: {},
  ...over,
});

describe("#7633 — selectDesiredMembers", () => {
  it("inclui mantenedor e patrono", () => {
    const out = selectDesiredMembers([
      sub({ id: 1, email_address: "m@x.com", fields: { apoio_nivel: "mantenedor" } }),
      sub({ id: 2, email_address: "p@x.com", fields: { apoio_nivel: "patrono" } }),
    ]);
    assert.deepEqual(out.map((m) => m.email), ["m@x.com", "p@x.com"]);
  });

  it("exclui amigo e apoiador (níveis abaixo do alvo, decisão 2 do #4482)", () => {
    const out = selectDesiredMembers([
      sub({ id: 1, email_address: "a@x.com", fields: { apoio_nivel: "amigo" } }),
      sub({ id: 2, email_address: "b@x.com", fields: { apoio_nivel: "apoiador" } }),
    ]);
    assert.deepEqual(out, []);
  });

  it("exclui quem não tem apoio_nivel (campo ausente ou vazio)", () => {
    const out = selectDesiredMembers([
      sub({ id: 1, email_address: "s@x.com" }),
      sub({ id: 2, email_address: "v@x.com", fields: { apoio_nivel: "" } }),
    ]);
    assert.deepEqual(out, []);
  });

  it("exclui assinante não-ativo, mesmo com nível alvo", () => {
    const out = selectDesiredMembers([
      sub({ id: 1, email_address: "i@x.com", state: "inactive", fields: { apoio_nivel: "patrono" } }),
      sub({ id: 2, email_address: "c@x.com", state: "cancelled", fields: { apoio_nivel: "mantenedor" } }),
    ]);
    assert.deepEqual(out, []);
  });

  it("normaliza o valor do campo — texto livre com espaço/caixa alta não exclui quem apoia", () => {
    const out = selectDesiredMembers([
      sub({ id: 1, email_address: "p@x.com", fields: { apoio_nivel: "  Patrono " } }),
    ]);
    assert.deepEqual(out.map((m) => m.email), ["p@x.com"]);
  });

  it("normaliza o e-mail (o diff casa por e-mail — caixa alta viraria add+remove do mesmo contato)", () => {
    const out = selectDesiredMembers([
      sub({ id: 1, email_address: "  P@X.COM ", fields: { apoio_nivel: "patrono" } }),
    ]);
    assert.deepEqual(out, [{ id: 1, email: "p@x.com" }]);
  });

  it("preserva o id do assinante (é ele que a mutação de tag usa, não o e-mail)", () => {
    const out = selectDesiredMembers([
      sub({ id: 4242, email_address: "p@x.com", fields: { apoio_nivel: "patrono" } }),
    ]);
    assert.equal(out[0].id, 4242);
  });
});
