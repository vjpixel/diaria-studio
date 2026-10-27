/**
 * test/schedule-kit-diaria-6048.test.ts (#6048 — wiring do canal Kit paralelo)
 *
 * O invariante central aqui é o do #573: **nunca reportar "agendado" a partir
 * da resposta do PATCH**. Um agendamento que não aconteceu, reportado como
 * sucesso, faz o editor achar que a edição sai e ela não sai — o mesmo modo
 * de falha silenciosa do canal Brevo em 260825 (#6146).
 *
 * Daí a asserção que se repete: quando a verificação não confirma, o
 * resultado é `code: 4` e o estado NÃO é gravado como `scheduled`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scheduleKitDiaria, type ScheduleKitDiariaDeps } from "../scripts/schedule-kit-diaria.ts";
import type { KitDiariaPublished } from "../scripts/lib/kit-diaria-channel.ts";

const EDITION = "/tmp/edicao-fake-6048";
const WHEN = "2026-08-26T09:00:00Z";

const draft: KitDiariaPublished = {
  broadcast_id: 4242,
  subject: "S",
  preview_text: "P",
  audience_tag: "kit-nativo",
  audience_tag_id: 7,
  status: "draft",
};

function makeDeps(
  over: Partial<{
    enabled: boolean;
    newsletterBackend: string;
    state: KitDiariaPublished | null;
    readStateThrows: boolean;
    patchThrows: boolean;
    verifyReturns: { send_at?: string | null };
    verifyThrows: boolean;
  }> = {},
): { deps: ScheduleKitDiariaDeps; written: KitDiariaPublished[]; patched: number[] } {
  const written: KitDiariaPublished[] = [];
  const patched: number[] = [];
  const deps: ScheduleKitDiariaDeps = {
    readPlatformConfig: () => ({
      kit_diaria: { enabled: over.enabled ?? true },
      ...(over.newsletterBackend !== undefined
        ? { publishing: { newsletter: { backend: over.newsletterBackend } } }
        : {}),
    }),
    readState: (() => {
      if (over.readStateThrows) throw new Error("kit-diaria-published.json não é JSON válido");
      return over.state === undefined ? draft : over.state;
    }) as ScheduleKitDiariaDeps["readState"],
    writeState: ((_d: string, s: KitDiariaPublished) => void written.push(s)) as ScheduleKitDiariaDeps["writeState"],
    patch: async (id) => {
      if (over.patchThrows) throw new Error("429 rate limited");
      patched.push(id);
      return { id };
    },
    verify: async () => {
      if (over.verifyThrows) throw new Error("ECONNRESET");
      return over.verifyReturns ?? { send_at: WHEN };
    },
    log: () => {},
  };
  return { deps, written, patched };
}

describe("#11225 scheduleKitDiaria — canal paralelo aposentado", () => {
  for (const newsletterBackend of [undefined, "kit", "beehiiv", "typo"]) {
    it(`não agenda com backend ${newsletterBackend ?? "ausente"}, mesmo enabled=true`, async () => {
      const { deps, written, patched } = makeDeps({ newsletterBackend });
      deps.readState = () => { throw new Error("não deve ler estado histórico"); };
      const r = await scheduleKitDiaria(EDITION, WHEN, deps);
      assert.equal(r.code, 2);
      assert.deepEqual(written, []);
      assert.deepEqual(patched, []);
    });
  }
  it("mantém o guard de data antes de qualquer acesso", async () => {
    const { deps } = makeDeps();
    deps.readPlatformConfig = () => { throw new Error("não deve ler config"); };
    const r = await scheduleKitDiaria("/tmp/260826", "2026-08-27T09:00:00Z", deps);
    assert.equal(r.code, 5);
  });
});
