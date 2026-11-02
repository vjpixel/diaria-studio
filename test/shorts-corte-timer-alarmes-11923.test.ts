/**
 * #11923: alarmes do timer do corte não podem ser enganosos nem se perder em
 * falha transitória (OneDrive) — resíduo do review da #11917.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpretCorteTimerOutput } from "../scripts/shorts-corte-timer.ts";
import { restoreCorteAuthorizationAfterUpdate } from "../scripts/publish-shorts.ts";

const keys = (refused: string) =>
  interpretCorteTimerOutput(2, JSON.stringify({ authorization_refused: refused, reason: "m" }), ["instagram"]).map((o) => (o.kind === "alarm" ? o.key : o.kind));

describe("#11923", () => {
  it("1: spec-unreadable vira chave de retry (crash), nunca revoked", () => {
    assert.deepEqual(keys("spec-unreadable"), ["crash"]);
  });

  it("3: motivo desconhecido cai em crash, não em revoked enganoso", () => {
    assert.deepEqual(keys("motivo-do-futuro"), ["crash"]);
    assert.deepEqual(keys("revoked"), ["revoked"]);
  });

  it("1: o filho recusa com spec-unreadable (e não revoked) quando reler o corte.json lança", () => {
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    assert.match(src, /refusal = \{ refused: "spec-unreadable"/);
    assert.match(src, /"content-changed" \| "missing-content" \| "spec-unreadable"/);
  });

  it("5: restoreCorteAuthorizationAfterUpdate nunca lança (corte.json ilegível)", () => {
    const dir = mkdtempSync(join(tmpdir(), "corte-11923-"));
    writeFileSync(join(dir, "corte.json"), "{ json pela metade");
    const r = restoreCorteAuthorizationAfterUpdate(dir, new Date().toISOString(), new Set(["instagram"]), null, () => {});
    assert.equal(r.restored, false);
  });

  it("5: sem corte.json também não lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "corte-11923-"));
    const r = restoreCorteAuthorizationAfterUpdate(dir, new Date().toISOString(), new Set(), null, () => {});
    assert.equal(r.restored, false);
  });

  it("2: a variante do alarme é calculada em try/catch (fonte)", () => {
    const src = readFileSync(new URL("../scripts/shorts-corte-timer.ts", import.meta.url), "utf8");
    assert.match(src, /let variant: string \| undefined;[\s\S]*try \{[\s\S]*corteAlarmVariant\(o\.key[\s\S]*\} catch/);
  });
});
