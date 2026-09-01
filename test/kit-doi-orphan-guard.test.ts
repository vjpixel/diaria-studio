/**
 * test/kit-doi-orphan-guard.test.ts (#6810)
 *
 * Cobre o miolo puro (`scripts/lib/kit-doi-orphan-guard.ts`) — nenhuma
 * chamada de rede. Cenários da regra do órfão exigidos pela issue:
 *   1. inactive > 48h sem vínculo ao form → detectado como órfão
 *   2. inactive < 48h (ainda dentro da janela normal) → NÃO órfão
 *   3. inactive vinculado ao form → NÃO órfão, mesmo velho
 *   4. active → NÃO órfão, mesmo sem vínculo/velho
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isKitDoiOrphan,
  findKitDoiOrphans,
  computeKitDoiOrphanFingerprint,
  shouldAlarmKitDoiOrphans,
  advanceKitDoiOrphanState,
  emptyKitDoiOrphanAlarmState,
  buildKitDoiOrphanAlarmEmail,
  ORPHAN_THRESHOLD_HOURS,
  type KitDoiOrphan,
} from "../scripts/lib/kit-doi-orphan-guard.ts";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();
}

describe("isKitDoiOrphan — regra do órfão (#6810)", () => {
  it("inactive há mais de 48h, ausente do form → órfão", () => {
    const s = { id: 1, state: "inactive", created_at: hoursAgo(72) };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW), true);
  });

  it("inactive há menos de 48h (ainda dentro da janela normal) → NÃO órfão", () => {
    const s = { id: 2, state: "inactive", created_at: hoursAgo(10) };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW), false);
  });

  it("exatamente no limiar (48h) conta como órfão — inclusivo", () => {
    const s = { id: 3, state: "inactive", created_at: hoursAgo(ORPHAN_THRESHOLD_HOURS) };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW), true);
  });

  it("inactive há mais de 48h MAS vinculado ao form → NÃO órfão", () => {
    const s = { id: 4, state: "inactive", created_at: hoursAgo(100) };
    assert.equal(isKitDoiOrphan(s, new Set([4]), NOW), false);
  });

  it("active, mesmo sem vínculo e velho → NÃO órfão (regra só se aplica a inactive)", () => {
    const s = { id: 5, state: "active", created_at: hoursAgo(1000) };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW), false);
  });

  it("cancelled/bounced (qualquer state != inactive) → NÃO órfão", () => {
    const s = { id: 6, state: "cancelled", created_at: hoursAgo(1000) };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW), false);
  });

  it("created_at ilegível → NÃO lança, trata como não-órfão (fail-soft)", () => {
    const s = { id: 7, state: "inactive", created_at: "not-a-date" };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW), false);
  });

  it("threshold custom é respeitado (override do default de 48h)", () => {
    const s = { id: 8, state: "inactive", created_at: hoursAgo(5) };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW, 4), true);
    assert.equal(isKitDoiOrphan(s, new Set(), NOW, 6), false);
  });
});

describe("findKitDoiOrphans", () => {
  it("filtra e ordena por created_at crescente (mais antigo primeiro)", () => {
    const subs = [
      { id: 1, email_address: "recente@x.com", state: "inactive", created_at: hoursAgo(49) },
      { id: 2, email_address: "antigo@x.com", state: "inactive", created_at: hoursAgo(200) },
      { id: 3, email_address: "vinculado@x.com", state: "inactive", created_at: hoursAgo(300) },
      { id: 4, email_address: "muito-novo@x.com", state: "inactive", created_at: hoursAgo(1) },
      { id: 5, email_address: "confirmado@x.com", state: "active", created_at: hoursAgo(500) },
    ];
    const orphans = findKitDoiOrphans(subs, new Set([3]), NOW);
    assert.deepEqual(
      orphans.map((o) => o.email_address),
      ["antigo@x.com", "recente@x.com"],
    );
    assert.ok(orphans[0].ageHours > orphans[1].ageHours);
  });

  it("lista vazia → nenhum órfão", () => {
    assert.deepEqual(findKitDoiOrphans([], new Set(), NOW), []);
  });
});

describe("computeKitDoiOrphanFingerprint / shouldAlarmKitDoiOrphans", () => {
  const orphan1: KitDoiOrphan = { id: 1, email_address: "a@x.com", created_at: hoursAgo(72), ageHours: 72 };
  const orphan2: KitDoiOrphan = { id: 2, email_address: "b@x.com", created_at: hoursAgo(60), ageHours: 60 };

  it("fingerprint é determinístico independente da ordem de chegada", () => {
    assert.equal(computeKitDoiOrphanFingerprint([orphan1, orphan2]), computeKitDoiOrphanFingerprint([orphan2, orphan1]));
  });

  it("fingerprint muda quando o conjunto muda", () => {
    assert.notEqual(computeKitDoiOrphanFingerprint([orphan1]), computeKitDoiOrphanFingerprint([orphan1, orphan2]));
  });

  it("sem órfão pendente → nunca alarma", () => {
    assert.equal(shouldAlarmKitDoiOrphans(emptyKitDoiOrphanAlarmState(), []), false);
  });

  it("órfão novo, estado vazio → alarma", () => {
    assert.equal(shouldAlarmKitDoiOrphans(emptyKitDoiOrphanAlarmState(), [orphan1]), true);
  });

  it("mesmo conjunto já alarmado → NÃO alarma de novo (idempotência)", () => {
    const fp = computeKitDoiOrphanFingerprint([orphan1]);
    const state = advanceKitDoiOrphanState(fp, NOW);
    assert.equal(shouldAlarmKitDoiOrphans(state, [orphan1]), false);
  });

  it("conjunto mudou (novo órfão apareceu) → alarma de novo", () => {
    const fp = computeKitDoiOrphanFingerprint([orphan1]);
    const state = advanceKitDoiOrphanState(fp, NOW);
    assert.equal(shouldAlarmKitDoiOrphans(state, [orphan1, orphan2]), true);
  });

  it("conjunto esvaziou e depois reapareceu (mesmo fingerprint) → re-arma e alarma de novo", () => {
    const fp = computeKitDoiOrphanFingerprint([orphan1]);
    const alarmed = advanceKitDoiOrphanState(fp, NOW);
    const rearmed = advanceKitDoiOrphanState(null, NOW); // conjunto esvaziou
    assert.equal(shouldAlarmKitDoiOrphans(alarmed, []), false);
    assert.equal(shouldAlarmKitDoiOrphans(rearmed, [orphan1]), true);
  });
});

describe("buildKitDoiOrphanAlarmEmail", () => {
  const orphan: KitDoiOrphan = { id: 42, email_address: "preso@x.com", created_at: hoursAgo(72), ageHours: 72 };

  it("assunto cita a contagem, corpo lista o e-mail e o id", () => {
    const { subject, body } = buildKitDoiOrphanAlarmEmail([orphan], NOW);
    assert.match(subject, /1 cadastro/);
    assert.match(body, /preso@x\.com/);
    assert.match(body, /id 42/);
    assert.match(body, /#6810/);
  });

  it("issueRef presente → corpo cita o número da issue", () => {
    const { body } = buildKitDoiOrphanAlarmEmail([orphan], NOW, {
      issueNumber: 9001,
      url: "https://github.com/x/y/issues/9001",
      action: "created",
    });
    assert.match(body, /#9001/);
  });

  it("issueRef com action failed → corpo cita a falha, não um número inventado", () => {
    const { body } = buildKitDoiOrphanAlarmEmail([orphan], NOW, {
      issueNumber: null,
      url: null,
      action: "failed",
      error: "gh não autenticado",
    });
    assert.match(body, /falha ao criar\/reusar/);
    assert.match(body, /gh não autenticado/);
  });
});
