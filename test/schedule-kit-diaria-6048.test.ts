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
    readPlatformConfig: () => ({ kit_diaria: { enabled: over.enabled ?? true } }),
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

describe("#6048 scheduleKitDiaria — caminho feliz", () => {
  it("agenda, confirma por releitura e grava o estado", async () => {
    const { deps, written, patched } = makeDeps();
    const r = await scheduleKitDiaria(EDITION, WHEN, deps);
    assert.equal(r.code, 0);
    if (r.code === 0) assert.equal(r.scheduledAt, WHEN);
    assert.deepEqual(patched, [4242]);
    assert.equal(written.length, 1);
    assert.equal(written[0].status, "scheduled");
    assert.equal(written[0].scheduled_at, WHEN);
  });

  it("usa o send_at CONFIRMADO, não o pedido — a plataforma pode normalizar", async () => {
    const outro = "2026-08-26T09:05:00Z";
    const { deps, written } = makeDeps({ verifyReturns: { send_at: outro } });
    const r = await scheduleKitDiaria(EDITION, WHEN, deps);
    assert.equal(r.code, 0);
    if (r.code === 0) assert.equal(r.scheduledAt, outro);
    assert.equal(written[0].scheduled_at, outro);
  });
});

describe("#6048 scheduleKitDiaria — o guard do #573: verificação manda", () => {
  it("GET pós-PATCH sem send_at ⇒ code 4 e estado NÃO vira scheduled", async () => {
    // O modo de falha que isto impede: reportar agendado, o broadcast ficar
    // como rascunho, e a edição não sair — descoberto pela ausência.
    const { deps, written } = makeDeps({ verifyReturns: { send_at: null } });
    const r = await scheduleKitDiaria(EDITION, WHEN, deps);
    assert.equal(r.code, 4);
    assert.equal(written.length, 0, "nunca gravar scheduled sem confirmação");
  });

  it("GET de verificação lança ⇒ code 4, não 0", async () => {
    const { deps, written } = makeDeps({ verifyThrows: true });
    const r = await scheduleKitDiaria(EDITION, WHEN, deps);
    assert.equal(r.code, 4);
    if (r.code === 4) assert.match(r.reason, /ECONNRESET/);
    assert.equal(written.length, 0);
  });
});

describe("#6048 scheduleKitDiaria — não-participação NÃO é erro", () => {
  it("canal desligado ⇒ code 2, sem PATCH", async () => {
    const { deps, patched } = makeDeps({ enabled: false });
    const r = await scheduleKitDiaria(EDITION, WHEN, deps);
    assert.equal(r.code, 2);
    assert.equal(patched.length, 0);
  });

  it("estado ausente (canal pulou a Etapa 5) ⇒ code 2, sem PATCH", async () => {
    const { deps, patched } = makeDeps({ state: null });
    const r = await scheduleKitDiaria(EDITION, WHEN, deps);
    assert.equal(r.code, 2);
    assert.equal(patched.length, 0);
  });

  it("estado CORROMPIDO ⇒ code 3, não 2 — ilegível é diferente de ausente", async () => {
    // Mesma disciplina do #6153: tratar corrompido como ausente esconderia
    // que alguém precisa olhar.
    const { deps, patched } = makeDeps({ readStateThrows: true });
    const r = await scheduleKitDiaria(EDITION, WHEN, deps);
    assert.equal(r.code, 3);
    assert.equal(patched.length, 0);
  });
});

describe("#6048 scheduleKitDiaria — idempotência e falha de PATCH", () => {
  it("já agendado ⇒ code 0 sem re-PATCH (resume)", async () => {
    const { deps, patched, written } = makeDeps({
      state: { ...draft, status: "scheduled", scheduled_at: WHEN },
    });
    const r = await scheduleKitDiaria(EDITION, WHEN, deps);
    assert.equal(r.code, 0);
    assert.equal(patched.length, 0, "não re-agenda o que já está agendado");
    assert.equal(written.length, 0);
  });

  it("PATCH falha ⇒ code 3, estado intocado", async () => {
    const { deps, written } = makeDeps({ patchThrows: true });
    const r = await scheduleKitDiaria(EDITION, WHEN, deps);
    assert.equal(r.code, 3);
    if (r.code === 3) assert.match(r.reason, /429/);
    assert.equal(written.length, 0);
  });
});
