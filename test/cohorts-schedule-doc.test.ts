/**
 * Guard de regressão para docs/cohorts-schedule.md (#2555).
 *
 * Asserta que o snippet Register-ScheduledTask contém as flags de hardening
 * introduzidas após o incidente 260624 (crawl morto na bateria). Se alguém
 * reverter o doc sem preservar essas flags, este teste falha imediatamente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docPath = resolve(__dirname, "../docs/cohorts-schedule.md");
const doc = readFileSync(docPath, "utf8");

describe("cohorts-schedule.md hardening flags (#2555)", () => {
  it("Register snippet inclui -StartWhenAvailable", () => {
    assert.ok(
      doc.includes("-StartWhenAvailable"),
      "Flag -StartWhenAvailable ausente no snippet Register-ScheduledTask"
    );
  });

  it("Register snippet inclui -AllowStartIfOnBatteries", () => {
    assert.ok(
      doc.includes("-AllowStartIfOnBatteries"),
      "Flag -AllowStartIfOnBatteries ausente no snippet Register-ScheduledTask"
    );
  });

  it("Register snippet inclui -DontStopIfGoingOnBatteries", () => {
    assert.ok(
      doc.includes("-DontStopIfGoingOnBatteries"),
      "Flag -DontStopIfGoingOnBatteries ausente no snippet Register-ScheduledTask"
    );
  });

  it("Register snippet inclui -MultipleInstances Queue", () => {
    assert.ok(
      doc.includes("-MultipleInstances Queue"),
      "Flag -MultipleInstances Queue ausente no snippet Register-ScheduledTask"
    );
  });

  it("contém seção de re-aplicar task já registrada", () => {
    assert.ok(
      doc.includes("Re-aplicar numa task já registrada"),
      "Subseção 'Re-aplicar numa task já registrada' ausente"
    );
  });

  it("subseção de re-aplicar contém Set-ScheduledTask", () => {
    assert.ok(
      doc.includes("Set-ScheduledTask -TaskName 'DiariaCohortsCrawl' -Settings $t.Settings"),
      "Comando Set-ScheduledTask ausente na subseção de re-aplicar"
    );
  });

  it("referencia o incidente 260624 / #2555", () => {
    assert.ok(
      doc.includes("260624") && doc.includes("#2555"),
      "Referência ao incidente 260624 / #2555 ausente no racional das flags"
    );
  });
});
