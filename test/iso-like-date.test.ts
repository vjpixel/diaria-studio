import { test } from "node:test";
import assert from "node:assert/strict";
import { ISO_LIKE_DATE_RE } from "../scripts/lib/iso-like-date.ts";

// #8033 (fonte única) / #8043 review (ancorado nas duas pontas)

test("ISO_LIKE_DATE_RE: aceita AAAA-MM-DD e AAAA-MM-DD HH:MM:SS/AAAA-MM-DDTHH:MM:SS", () => {
  assert.ok(ISO_LIKE_DATE_RE.test("2026-09-03"));
  assert.ok(ISO_LIKE_DATE_RE.test("2026-09-03 06:11:16"), "formato do export Brevo (Delivered_Date)");
  assert.ok(ISO_LIKE_DATE_RE.test("2026-09-03T06:11:16"));
});

// #8043 — a maioria do store usa este formato completo (toISOString() real),
// gerado por latestEventTime/brevo-stats.ts. Sem o sufixo de milissegundos+Z
// no regex, o `$` sozinho rejeitaria (incorretamente) quase todo `last_sent_at`
// já correto — regressão pega antes de commitar o fix do #8043 review.
test("ISO_LIKE_DATE_RE: aceita o formato completo do store (toISOString(), com milissegundos e Z)", () => {
  assert.ok(ISO_LIKE_DATE_RE.test("2026-08-21T12:02:26.200Z"), "formato real predominante no store — NUNCA pode regredir");
  assert.ok(ISO_LIKE_DATE_RE.test("2026-09-03T06:11:16.000Z"));
});

test("ISO_LIKE_DATE_RE: aceita offset de fuso explícito (+/-HH:MM)", () => {
  assert.ok(ISO_LIKE_DATE_RE.test("2026-09-03T06:11:16-03:00"));
  assert.ok(ISO_LIKE_DATE_RE.test("2026-09-03T06:11:16.500+00:00"));
});

test("ISO_LIKE_DATE_RE: rejeita o formato ambíguo DD-MM-AAAA", () => {
  assert.equal(ISO_LIKE_DATE_RE.test("03-09-2026 06:11:16"), false);
});

test("ISO_LIKE_DATE_RE: rejeita prefixo válido seguido de lixo (#8043 — sem $ isso passava)", () => {
  assert.equal(ISO_LIKE_DATE_RE.test("2026-09-03 lixo"), false);
  assert.equal(ISO_LIKE_DATE_RE.test("2026-09-03-extra"), false);
});
