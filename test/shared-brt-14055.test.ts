/**
 * test/shared-brt-14055.test.ts (#14055)
 *
 * Prova que os helpers canônicos de `scripts/lib/shared/brt.ts` devolvem
 * exatamente o que as cópias privadas removidas devolviam, e fixa o valor e
 * o sentido das duas constantes de offset que substituem o homônimo
 * `BRT_UTC_OFFSET_HOURS` (-3 num arquivo, +3 no outro).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRT_TIMEZONE,
  BRT_MINUS_UTC_HOURS,
  UTC_MINUS_BRT_HOURS,
  brtDayKey,
  hhmmBrt,
} from "../scripts/lib/shared/brt.ts";
import { BRT_TIMEZONE as NEXT_EDITION_BRT_TIMEZONE } from "../scripts/lib/next-edition-date.ts";
import { brtDateString } from "../scripts/lib/site-home-page.ts";
import { brtDateOf } from "../scripts/lib/ads-rolling-window.ts";
import { resolveEditionScheduledAt } from "../scripts/lib/edition-scheduled-at.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Corpo literal da cópia removida de shorts-{instagram,linkedin-profile,threads-profile}-timer.ts. */
function oldHhmmBrt(ms: number): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

/** Corpo literal da cópia removida de meta-capi-confirmations-send / subscriber-state-snapshot / upload-google-ads-confirmations (com `now` injetável). */
function oldTodayBrtDayKey(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Instantes de fronteira: meia-noite BRT, 23:59 BRT, viradas de mês e de ano, bissexto. */
const BOUNDARY_ISO = [
  "2026-11-26T03:00:00.000Z", // 00:00 BRT
  "2026-11-26T02:59:00.000Z", // 23:59 BRT do dia anterior
  "2026-11-26T02:59:59.999Z", // último ms do dia BRT anterior
  "2026-12-01T02:59:00.000Z", // 30/11 23:59 BRT (virada de mês)
  "2026-12-01T03:00:00.000Z", // 01/12 00:00 BRT
  "2027-01-01T02:59:00.000Z", // 31/12 23:59 BRT (virada de ano)
  "2027-01-01T03:00:00.000Z", // 01/01 00:00 BRT
  "2028-02-29T12:00:00.000Z", // bissexto
  "2028-03-01T02:30:00.000Z", // 29/02 23:30 BRT
  "2026-11-26T09:00:00.000Z", // 06:00 BRT, horário do envio
  "2026-11-26T15:00:00.000Z", // 12:00 BRT (meio-dia, h23 não vira 00)
];

describe("#14055 hhmmBrt canônico = cópia removida", () => {
  for (const iso of BOUNDARY_ISO) {
    it(iso, () => {
      const ms = Date.parse(iso);
      assert.equal(hhmmBrt(ms), oldHhmmBrt(ms));
    });
  }
  it("valores esperados nas fronteiras", () => {
    assert.equal(hhmmBrt(Date.parse("2026-11-26T03:00:00.000Z")), "00:00");
    assert.equal(hhmmBrt(Date.parse("2026-11-26T02:59:00.000Z")), "23:59");
    assert.equal(hhmmBrt(Date.parse("2026-11-26T15:00:00.000Z")), "12:00");
  });
});

describe("#14055 brtDayKey canônico = cópia removida e = brtDateString", () => {
  for (const iso of BOUNDARY_ISO) {
    it(iso, () => {
      const d = new Date(iso);
      assert.equal(brtDayKey(d), oldTodayBrtDayKey(d));
      assert.equal(brtDateString(d), oldTodayBrtDayKey(d));
    });
  }
  it("valores esperados nas viradas", () => {
    assert.equal(brtDayKey(new Date("2026-11-26T02:59:00.000Z")), "2026-11-25");
    assert.equal(brtDayKey(new Date("2026-11-26T03:00:00.000Z")), "2026-11-26");
    assert.equal(brtDayKey(new Date("2026-12-01T02:59:00.000Z")), "2026-11-30");
    assert.equal(brtDayKey(new Date("2027-01-01T02:59:00.000Z")), "2026-12-31");
    assert.equal(brtDayKey(new Date("2027-01-01T03:00:00.000Z")), "2027-01-01");
  });
  it("default é agora", () => {
    assert.equal(brtDayKey(), oldTodayBrtDayKey(new Date()));
  });
});

describe("#14055 constantes de offset: valor e sentido fixos", () => {
  it("UTC_MINUS_BRT_HOURS = 3 e BRT_MINUS_UTC_HOURS = -3", () => {
    assert.equal(UTC_MINUS_BRT_HOURS, 3);
    assert.equal(BRT_MINUS_UTC_HOURS, -3);
  });
  it("BRT_TIMEZONE único, re-exportado por next-edition-date", () => {
    assert.equal(BRT_TIMEZONE, "America/Sao_Paulo");
    assert.equal(NEXT_EDITION_BRT_TIMEZONE, BRT_TIMEZONE);
  });
  it("brtDateOf (ads-rolling-window) segue BRT − UTC nas fronteiras", () => {
    assert.equal(brtDateOf("2026-11-26T02:59:00.000Z"), "2026-11-25");
    assert.equal(brtDateOf("2026-11-26T03:00:00.000Z"), "2026-11-26");
    assert.equal(brtDateOf("2027-01-01T02:59:00.000Z"), "2026-12-31");
    for (const iso of BOUNDARY_ISO) assert.equal(brtDateOf(iso), oldTodayBrtDayKey(new Date(iso)));
  });
  it("resolveEditionScheduledAt (edition-scheduled-at) segue UTC − BRT", () => {
    assert.equal(resolveEditionScheduledAt("261126", "06:00"), "2026-11-26T09:00:00.000Z");
    assert.equal(resolveEditionScheduledAt("261231", "23:59"), "2027-01-01T02:59:00.000Z");
    assert.equal(resolveEditionScheduledAt("261130", "00:00"), "2026-11-30T03:00:00.000Z");
  });
  it("o homônimo BRT_UTC_OFFSET_HOURS não volta como código (só em comentário histórico)", () => {
    for (const rel of [
      "scripts/lib/ads-rolling-window.ts",
      "scripts/lib/edition-scheduled-at.ts",
      "scripts/aquisicao-reconcile.ts",
    ]) {
      const code = readFileSync(join(ROOT, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(code, /BRT_UTC_OFFSET_HOURS/, rel);
    }
  });
});
