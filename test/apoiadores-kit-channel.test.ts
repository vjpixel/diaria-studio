/**
 * test/apoiadores-kit-channel.test.ts (#7633)
 *
 * Guards puros do canal Kit do envio extra pros apoiadores
 * (`scripts/lib/mensal/apoiadores-kit-channel.ts`). Todos existem porque o
 * modo de falha deste canal é ASSIMÉTRICO: `subscriber_filter` ausente/não
 * resolvido no Kit significa **base INTEIRA** (#6126), então um erro de
 * audiência aqui manda o conteúdo exclusivo de apoiador pra todo mundo — não
 * deixa de enviar. Cada teste trava um ponto dessa cadeia.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APOIADORES_MENSAL_NIVEIS,
  APOIADORES_TAG_BLAST_RADIUS_THRESHOLD,
  checkApoiadoresAudienceNotEmpty,
  diffApoiadoresTagMembership,
  evaluateApoiadoresBlastRadius,
  resolveApoiadoresTagId,
  resolveApoiadoresTagName,
} from "../scripts/lib/mensal/apoiadores-kit-channel.ts";

describe("#7633 — níveis-alvo", () => {
  it("só Mantenedor e Patrono (decisão 2 do #4482, preservada em todas as trocas de canal)", () => {
    assert.deepEqual([...APOIADORES_MENSAL_NIVEIS], ["mantenedor", "patrono"]);
  });
});

describe("#7633 — resolveApoiadoresTagName", () => {
  it("config ausente -> erro (nunca default silencioso)", () => {
    const r = resolveApoiadoresTagName(undefined);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /audience_tag/);
  });

  it("string vazia/só espaços -> erro", () => {
    assert.equal(resolveApoiadoresTagName({ audience_tag: "   " }).ok, false);
  });

  it("nome válido -> ok, com trim", () => {
    const r = resolveApoiadoresTagName({ audience_tag: "  apoio-mensal  " });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.tagName, "apoio-mensal");
  });

  it("a razão do erro explica o modo de falha (filtro ausente = base inteira)", () => {
    const r = resolveApoiadoresTagName({});
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /BASE INTEIRA/i);
  });
});

describe("#7633 — resolveApoiadoresTagId", () => {
  it("tag inexistente (null) -> recusa, apontando pro sync que cria a audiência", () => {
    const r = resolveApoiadoresTagId("apoio-mensal", null);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /sync-apoio-mensal-tag-kit/);
  });

  it("id inválido (0, negativo, não-inteiro) -> recusa", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.equal(resolveApoiadoresTagId("apoio-mensal", bad).ok, false, `aceitou id inválido: ${bad}`);
    }
  });

  it("id válido -> ok", () => {
    const r = resolveApoiadoresTagId("apoio-mensal", 123);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.tagId, 123);
  });
});

describe("#7633 — checkApoiadoresAudienceNotEmpty", () => {
  it("tag vazia -> recusa (broadcast que reporta sucesso e não entrega a ninguém)", () => {
    const r = checkApoiadoresAudienceNotEmpty("apoio-mensal", 0);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /VAZIA/);
  });

  it("contagem inválida -> recusa", () => {
    assert.equal(checkApoiadoresAudienceNotEmpty("apoio-mensal", -3).ok, false);
    assert.equal(checkApoiadoresAudienceNotEmpty("apoio-mensal", 1.5).ok, false);
  });

  it("pelo menos 1 membro -> ok", () => {
    assert.deepEqual(checkApoiadoresAudienceNotEmpty("apoio-mensal", 1), { ok: true });
  });
});

describe("#7633 — diffApoiadoresTagMembership", () => {
  it("1ª sincronização (tag vazia) -> tudo entra, nada sai", () => {
    const d = diffApoiadoresTagMembership(["a@x.com", "b@x.com"], []);
    assert.deepEqual(d.toAdd, ["a@x.com", "b@x.com"]);
    assert.deepEqual(d.toRemove, []);
    assert.deepEqual(d.unchanged, []);
  });

  it("quem deixou de ser Mantenedor/Patrono sai; quem continua fica", () => {
    const d = diffApoiadoresTagMembership(["a@x.com"], ["a@x.com", "ex@x.com"]);
    assert.deepEqual(d.toAdd, []);
    assert.deepEqual(d.toRemove, ["ex@x.com"]);
    assert.deepEqual(d.unchanged, ["a@x.com"]);
  });

  it("casa por e-mail normalizado (case/espaço não geram add+remove do mesmo contato)", () => {
    const d = diffApoiadoresTagMembership(["  A@X.com "], ["a@x.com"]);
    assert.deepEqual(d.toAdd, []);
    assert.deepEqual(d.toRemove, []);
    assert.deepEqual(d.unchanged, ["a@x.com"]);
  });

  it("duplicatas na entrada não viram mutação repetida", () => {
    const d = diffApoiadoresTagMembership(["a@x.com", "A@x.com"], []);
    assert.deepEqual(d.toAdd, ["a@x.com"]);
  });

  it("strings vazias são descartadas (não viram um 'contato' fantasma)", () => {
    const d = diffApoiadoresTagMembership(["", "  "], ["a@x.com"]);
    assert.deepEqual(d.toAdd, []);
    assert.deepEqual(d.toRemove, ["a@x.com"]);
  });
});

describe("#7633 — evaluateApoiadoresBlastRadius", () => {
  it("audiência vazia (1ª sincronização) nunca bloqueia", () => {
    const r = evaluateApoiadoresBlastRadius(0, 0, false);
    assert.equal(r.blocked, false);
    assert.equal(r.ratio, 0);
  });

  it("remoção dentro do limiar passa", () => {
    // 2 de 10 = 20%, abaixo dos 30%.
    assert.equal(evaluateApoiadoresBlastRadius(2, 10, false).blocked, false);
  });

  it("remoção acima do limiar bloqueia (leitura parcial não vira remoção em massa)", () => {
    // 4 de 10 = 40%.
    const r = evaluateApoiadoresBlastRadius(4, 10, false);
    assert.equal(r.blocked, true);
    assert.ok(r.ratio > APOIADORES_TAG_BLAST_RADIUS_THRESHOLD);
  });

  it("exatamente no limiar NÃO bloqueia (só acima)", () => {
    assert.equal(evaluateApoiadoresBlastRadius(3, 10, false).blocked, false);
  });

  it("--force-blast-radius destrava (decisão consciente, sempre logada pelo caller)", () => {
    assert.equal(evaluateApoiadoresBlastRadius(10, 10, true).blocked, false);
  });
});
