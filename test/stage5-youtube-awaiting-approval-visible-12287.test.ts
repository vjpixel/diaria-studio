/**
 * #12287: o desfecho `awaiting-approval` do Stage 5 saía como `info` e o
 * marcador `_internal/05-youtube-pending-approval.json` não tinha validade.
 * Um dry-run abandonado fazia toda Etapa 5 seguinte segurar o horizontal em
 * silêncio, e o D1 saía sem o link do vídeo.
 *
 * Fix: `warn` no run-log, `[aviso]` no stderr, e o texto cita a idade do
 * marcador e o D0 já passado. Desde o #12588 a Etapa 5 não sobe vídeo: o
 * marcador é só informativo e quem barra a falta do link é o Passo 0b.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describePendingApproval,
  pendingApprovalStaleNote,
  PENDING_APPROVAL_STALE_MS,
  type PendingApprovalRead,
} from "../scripts/lib/diaria/youtube-pending-approval.ts";
import { youtubeStepLevel } from "../scripts/stage5-youtube.ts";

const AAMMDD = "261106";
const pending = (at: string): Exclude<PendingApprovalRead, { kind: "none" }> => ({
  kind: "pending",
  marker: { aammdd: AAMMDD, at, source: "publish-youtube --dry-run" },
});

describe("#12287 — hold do YouTube no Stage 5 fica visível", () => {
  it("#12588: sem o link (o caso em que o marcador aparece) é warn", () => {
    assert.equal(youtubeStepLevel({ outcome: "missing-link" }), "warn");
    assert.equal(youtubeStepLevel({ outcome: "already-published" }), "info");
  });

  it("marcador recente, edição por vir: sem nota; o texto aponta a skill e o set-d1-no-video (#12588)", () => {
    const now = new Date("2026-11-05T22:00:00Z"); // 19:00 BRT de 05/11, véspera do D0
    const read = pending("2026-11-05T21:00:00Z");
    assert.equal(pendingApprovalStaleNote(read, AAMMDD, now), null);
    const text = describePendingApproval(read, AAMMDD, now);
    assert.match(text, /\/diaria-publica 261106/);
    assert.match(text, /set-d1-no-video\.ts 261106/);
    assert.doesNotMatch(text, /--ignore-pending-approval/, "flag removida no #12588");
    assert.doesNotMatch(text, /ATENÇÃO/);
  });

  it("cenário da issue: dry-run abandonado, Etapa 5 de outra edição dias depois → nota de marcador antigo e D0 passado", () => {
    const now = new Date("2026-11-08T22:00:00Z"); // 08/11 BRT
    const read = pending("2026-11-05T21:00:00Z");
    const note = pendingApprovalStaleNote(read, AAMMDD, now);
    assert.ok(note);
    assert.match(note!, /há 73h/);
    assert.match(note!, /já passou do D0/);
    assert.match(describePendingApproval(read, AAMMDD, now), /ATENÇÃO \(#12287\)/);
  });

  it("limiar de idade: exatamente no limite não é antigo; um minuto depois é", () => {
    const at = "2026-11-05T10:00:00Z";
    const base = Date.parse(at) + PENDING_APPROVAL_STALE_MS;
    assert.equal(pendingApprovalStaleNote(pending(at), AAMMDD, new Date(base)), null);
    assert.match(pendingApprovalStaleNote(pending(at), AAMMDD, new Date(base + 60_000)) ?? "", /provável abandono/);
  });

  it("D0 em BRT, não em UTC: 01:00 UTC de 07/11 ainda é 06/11 em BRT", () => {
    const read: Exclude<PendingApprovalRead, { kind: "none" }> = { kind: "unreadable", reason: "x" };
    assert.equal(pendingApprovalStaleNote(read, AAMMDD, new Date("2026-11-07T01:00:00Z")), null);
    assert.match(pendingApprovalStaleNote(read, AAMMDD, new Date("2026-11-07T04:00:00Z")) ?? "", /já passou do D0/);
  });

  it("sem now (chamadas antigas): texto igual ao de antes, sem nota", () => {
    assert.doesNotMatch(describePendingApproval(pending("2020-01-01T00:00:00Z"), AAMMDD), /ATENÇÃO/);
  });
});
