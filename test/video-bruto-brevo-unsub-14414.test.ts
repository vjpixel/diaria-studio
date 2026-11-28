import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBrutosLocal, type BrutoLocalDeps } from "../scripts/lib/diaria/video-bruto-local.ts";
import { parseBrevoContact, extractContactEvents } from "../scripts/lib/brevo-stats.ts";

// #14414 item 1: metadado legível na 1ª leitura e ilegível na 2ª. Sem o
// flagged.add no catch, a leitura cronometrada conferia o mesmo arquivo de
// novo e ele saía duas vezes em `problems`.
describe("#14414 checkBrutosLocal: arquivo ilegível na 2ª leitura sai uma vez só", () => {
  it("não repassa à leitura cronometrada o que já falhou no metadado", () => {
    let calls = 0;
    const asked: string[][] = [];
    const deps: BrutoLocalDeps = {
      platform: "linux",
      sleep: () => {},
      size: () => {
        calls++;
        if (calls > 1) throw new Error("EBUSY");
        return 10;
      },
      timedRead: (paths) => {
        asked.push([...paths]);
        return new Map(paths.map((p) => [p, "erro" as const]));
      },
    };
    const c = checkBrutosLocal(["/r/a.mp4"], deps, { settleMs: 1 });
    assert.equal(c.problems.length, 1);
    assert.equal(c.problems[0].reason, "ilegivel");
    assert.match(c.problems[0].detail, /EBUSY/);
    assert.deepEqual(asked, []);
  });
});

// #14414 item 2: a Brevo devolve `unsubscriptions` como objeto com duas
// listas. O `asArray` cru contava as listas (2) em vez dos eventos.
describe("#14414 brevo-stats: unsubscriptions aninhado", () => {
  const contact = (unsubscriptions: unknown) => ({ email: "a@b.c", statistics: { unsubscriptions } });

  it("objeto com as duas listas vazias não marca descadastro", () => {
    const c = contact({ userUnsubscription: [], adminUnsubscription: [] });
    assert.equal(parseBrevoContact(c).unsubscribed, 0);
    assert.deepEqual(extractContactEvents(c), []);
  });

  it("evento real marca descadastro e preserva campanha e horário", () => {
    const c = contact({ userUnsubscription: [{ campaignId: 5, eventTime: "2026-10-01T00:00:00Z" }], adminUnsubscription: [] });
    assert.equal(parseBrevoContact(c).unsubscribed, 1);
    assert.deepEqual(extractContactEvents(c), [
      { category: "unsubscriptions", campaignId: 5, ts: "2026-10-01T00:00:00.000Z" },
    ]);
  });

  it("descadastro administrativo também conta", () => {
    const c = contact({ adminUnsubscription: [{ eventTime: "2026-10-02T00:00:00Z" }] });
    assert.equal(parseBrevoContact(c).unsubscribed, 1);
    assert.equal(extractContactEvents(c).length, 1);
  });

  it("forma em array (legado) segue funcionando", () => {
    const c = contact([{ campaignId: 7, eventTime: "2026-10-03T00:00:00Z" }]);
    assert.equal(parseBrevoContact(c).unsubscribed, 1);
    assert.equal(extractContactEvents(c)[0].campaignId, 7);
    assert.equal(parseBrevoContact(contact({})).unsubscribed, 0);
  });
});
