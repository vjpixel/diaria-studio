import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideInstagramConfirm } from "../scripts/publish-shorts.ts";

const nowIso = "2026-10-23T10:30:00.000Z";

function confirm(timestamp: unknown, explicit: boolean) {
  return decideInstagramConfirm({
    published: { aammdd: "261023", entries: [] },
    media: { data: [{ id: "reel", media_product_type: "REELS", caption: "Título do D1", timestamp }] },
    sinceIso: "2026-10-23T00:00:00.000Z",
    markers: ["Título do D1"],
    ...(explicit ? { mediaId: "reel" } : {}),
    nowIso,
  });
}

describe("#11047 confirmação preserva o horário da postagem", () => {
  for (const explicit of [false, true]) {
    for (const timestamp of ["2026-10-23T08:00:00+0000", "2026-10-23T05:00:00-0300"]) {
      it(`confirmação às 10:30 registra mídia às 08:00 (${timestamp}, mediaId=${explicit})`, () => {
        const decision = confirm(timestamp, explicit);
        assert.equal(decision.kind, "register");
        if (decision.kind !== "register") throw new Error("registro esperado");
        assert.equal(decision.entry.at, "2026-10-23T08:00:00.000Z");
      });
    }
  }
  for (const timestamp of [undefined, "", "inválido"]) {
    it(`mediaId usa nowIso quando timestamp é ${String(timestamp)}`, () => {
      const decision = confirm(timestamp, true);
      assert.equal(decision.kind, "register");
      if (decision.kind !== "register") throw new Error("registro esperado");
      assert.equal(decision.entry.at, nowIso);
    });
  }
});
