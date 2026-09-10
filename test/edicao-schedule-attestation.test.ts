/**
 * test/edicao-schedule-attestation.test.ts (#7036)
 *
 * Lógica pura de `scripts/lib/edicao-schedule-attestation.ts` — o marcador
 * cross-machine que ataca a lacuna do `TIMER_DISABLED_CROSS_MACHINE_CAVEAT`
 * (#6898): `queryTaskArmed` só enxerga o agendador da máquina LOCAL, e se a
 * via Windows for reativada sem o par Linux, o alarme rodando no `helios`
 * silenciaria por engano lendo `disabled` sobre um agendador que não é o
 * que de fato importa.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEdicaoScheduleAttestation,
  parseEdicaoScheduleAttestation,
  isAttestationStale,
  resolveEdicaoTimerStateCrossMachine,
  ATTESTATION_STALE_MS,
} from "../scripts/lib/edicao-schedule-attestation.ts";

describe("buildEdicaoScheduleAttestation / parseEdicaoScheduleAttestation — round-trip", () => {
  it("serializa e reparseia sem perda", () => {
    const now = new Date("2026-09-01T19:00:00Z");
    const attestation = buildEdicaoScheduleAttestation("NEO", "windows-task-scheduler", true, now);
    const roundTripped = parseEdicaoScheduleAttestation(JSON.stringify(attestation));
    assert.deepEqual(roundTripped, attestation);
  });

  it("armed=false round-trip (desarmado explicitamente, não ausência)", () => {
    const now = new Date("2026-09-01T19:00:00Z");
    const attestation = buildEdicaoScheduleAttestation("helios", "systemd", false, now);
    const roundTripped = parseEdicaoScheduleAttestation(JSON.stringify(attestation));
    assert.equal(roundTripped?.armed, false);
  });
});

describe("parseEdicaoScheduleAttestation — fail-soft", () => {
  it("raw null (arquivo ausente) → null", () => {
    assert.equal(parseEdicaoScheduleAttestation(null), null);
  });

  it("JSON inválido → null, nunca lança", () => {
    assert.equal(parseEdicaoScheduleAttestation("{ isso não é json"), null);
  });

  it("JSON válido mas schema errado (campo faltando) → null", () => {
    assert.equal(parseEdicaoScheduleAttestation(JSON.stringify({ machine: "NEO", armed: true })), null);
  });

  it("scheduler fora do enum → null", () => {
    const bad = { machine: "NEO", scheduler: "cron", armed: true, updatedAt: "2026-09-01T00:00:00Z" };
    assert.equal(parseEdicaoScheduleAttestation(JSON.stringify(bad)), null);
  });

  it("armed como string em vez de boolean → null", () => {
    const bad = { machine: "NEO", scheduler: "windows-task-scheduler", armed: "true", updatedAt: "2026-09-01T00:00:00Z" };
    assert.equal(parseEdicaoScheduleAttestation(JSON.stringify(bad)), null);
  });

  it("array em vez de objeto → null", () => {
    assert.equal(parseEdicaoScheduleAttestation("[]"), null);
  });
});

describe("parseEdicaoScheduleAttestation — tolerância a BOM UTF-8 (#7036, achado do review da PR #7860)", () => {
  it("string com BOM (\\uFEFF) na frente do JSON ainda parseia corretamente", () => {
    const now = new Date("2026-09-01T19:00:00Z");
    const attestation = buildEdicaoScheduleAttestation("NEO", "windows-task-scheduler", true, now);
    const withBom = "﻿" + JSON.stringify(attestation);
    assert.deepEqual(parseEdicaoScheduleAttestation(withBom), attestation);
  });

  it("arquivo real gravado com BOM UTF-8 (repro exato do que Set-Content -Encoding utf8 produz no PowerShell 5.1) é lido corretamente via readFileSync + parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "edicao-schedule-attestation-bom-"));
    const filePath = join(dir, "attestation.json");
    try {
      const now = new Date("2026-09-01T19:00:00Z");
      const attestation = buildEdicaoScheduleAttestation("NEO", "windows-task-scheduler", true, now);
      // Grava com BOM UTF-8 explícito, replicando o bug: Set-Content -Encoding
      // utf8 no Windows PowerShell 5.1 escreve UTF-8 COM BOM (só corrigido em
      // PS7+ com utf8NoBOM) — sem a tolerância em parseEdicaoScheduleAttestation,
      // JSON.parse lançaria sobre o BOM e a atestação seria silenciosamente
      // tratada como "arquivo ausente".
      writeFileSync(filePath, "﻿" + JSON.stringify(attestation), "utf8");
      const raw = readFileSync(filePath, "utf8");
      assert.deepEqual(parseEdicaoScheduleAttestation(raw), attestation);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isAttestationStale", () => {
  const writtenAt = new Date("2026-01-01T00:00:00Z");

  it("dentro da janela de 90 dias → não stale", () => {
    const attestation = buildEdicaoScheduleAttestation("NEO", "windows-task-scheduler", true, writtenAt);
    const now = new Date(writtenAt.getTime() + ATTESTATION_STALE_MS - 1000);
    assert.equal(isAttestationStale(attestation, now), false);
  });

  it("além de 90 dias → stale", () => {
    const attestation = buildEdicaoScheduleAttestation("NEO", "windows-task-scheduler", true, writtenAt);
    const now = new Date(writtenAt.getTime() + ATTESTATION_STALE_MS + 1000);
    assert.equal(isAttestationStale(attestation, now), true);
  });

  it("updatedAt ilegível → stale (sem confiança)", () => {
    const attestation = { machine: "NEO", scheduler: "windows-task-scheduler" as const, armed: true, updatedAt: "not-a-date" };
    assert.equal(isAttestationStale(attestation, new Date()), true);
  });
});

describe("resolveEdicaoTimerStateCrossMachine — o cenário real do #7036", () => {
  const now = new Date("2026-09-09T18:00:00Z");

  it("atestação AUSENTE → preserva o comportamento LOCAL de hoje (pré-#7036)", () => {
    assert.equal(resolveEdicaoTimerStateCrossMachine("disabled", null, now), "disabled");
    assert.equal(resolveEdicaoTimerStateCrossMachine("armed", null, now), "armed");
    assert.equal(resolveEdicaoTimerStateCrossMachine("unknown", null, now), "unknown");
  });

  it("cenário do #7036: local='disabled' (helios/Linux) + atestação de OUTRA máquina armada (Windows) → 'armed', NÃO silencia", () => {
    const attestation = buildEdicaoScheduleAttestation("NEO", "windows-task-scheduler", true, now);
    assert.equal(resolveEdicaoTimerStateCrossMachine("disabled", attestation, now), "armed");
  });

  it("local='unknown' + atestação armada → 'armed' (atestação fortalece o sinal mesmo sem consulta local confiável)", () => {
    const attestation = buildEdicaoScheduleAttestation("NEO", "windows-task-scheduler", true, now);
    assert.equal(resolveEdicaoTimerStateCrossMachine("unknown", attestation, now), "armed");
  });

  it("atestação com armed=false (a mesma ou outra máquina confirmando desarmado) → preserva o LOCAL, nunca piora", () => {
    const attestation = buildEdicaoScheduleAttestation("helios", "systemd", false, now);
    assert.equal(resolveEdicaoTimerStateCrossMachine("disabled", attestation, now), "disabled");
    assert.equal(resolveEdicaoTimerStateCrossMachine("unknown", attestation, now), "unknown");
  });

  it("atestação STALE (>90 dias) é tratada como ausente — não silencia nem arma por engano com dado velho", () => {
    const staleWrittenAt = new Date(now.getTime() - ATTESTATION_STALE_MS - 1000);
    const attestation = buildEdicaoScheduleAttestation("NEO", "windows-task-scheduler", true, staleWrittenAt);
    assert.equal(resolveEdicaoTimerStateCrossMachine("disabled", attestation, now), "disabled");
  });

  it("atestação armada NUNCA rebaixa 'armed' local — idempotente", () => {
    const attestation = buildEdicaoScheduleAttestation("NEO", "windows-task-scheduler", true, now);
    assert.equal(resolveEdicaoTimerStateCrossMachine("armed", attestation, now), "armed");
  });
});
