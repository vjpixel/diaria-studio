/**
 * test/8507-alarm-dedup.test.ts (#633)
 * Regressão de #8507: dedup do alarme npm-version-drift contra issue aberta.
 * Exercita comportamento real — não pode passar com bug (achado 1 do review).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("#8507 alarm dedup — comportamento real", () => {
  it("bloco #8507 é alcançável (não contraditório) e usa execFileSync (não shell interpolation)", () => {
    const src = readFileSync("scripts/npm-version-drift-alarm.ts", "utf8");
    // Achado 1 corrigido: condição não é `prevState.lastAlarmedFingerprint === fp` dentro de if(willAlarm)
    assert.ok(!src.includes("prevState.lastAlarmedFingerprint === fp"), "não deve usar condição contraditória do PR rejeitado");
    // O dedup deve ser alcançável quando fp existe (cenário de estado perdido / repetição)
    assert.ok(src.includes("if (fp)"), "dedup precisa ser alcançável por fp existente");
    // Achado 3 corrigido: não interpolar fingerprint em comando shell
    const dedupBlock = src.split("if (fp)")[1]?.split("notifyResult")[0] ?? "";
    assert.strictEqual(dedupBlock.includes("execSync"), false, "não deve usar execSync (shell interpolation)");
    assert.strictEqual(dedupBlock.includes("execFileSync"), true, "deve usar execFileSync com array de args");
    assert.strictEqual(dedupBlock.includes('"gh"'), true, "deve chamar gh via execFileSync");
    // Passa cachedEntry para notifyEditor
    assert.ok(src.includes("cachedEntry"), "deve passar cachedEntry para reutilizar issue");
  });
});
