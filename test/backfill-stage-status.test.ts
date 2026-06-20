/**
 * test/backfill-stage-status.test.ts (#1661, #2416-sibling)
 *
 * Regressão: backfill-stage-status enumerava data/editions sem validar o nome
 * AAMMDD, então dirs de backup (260527-backup-…, 260422-local-backup) entravam
 * no scan e — sem --dry-run — tinham seu stage-status.json sobrescrito por
 * applyFixes. listEditionDirs agora aplica isValidEditionDir (mesmo guard do
 * dedup.ts, #1567) pra excluí-los.
 *
 * #2416-sibling: sentinel.completed_at malformado em scanEdition produz
 * rawEndMs=NaN, que fluía para Fix.endMs=NaN → autoUpdateStageStatusOnSentinel
 * recebia nowMs=NaN → new Date(NaN).toISOString() lançava RangeError engolido
 * → no-op silencioso. Guard detecta NaN e cai para Date.now() com warn.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listEditionDirs, scanEdition } from "../scripts/backfill-stage-status.ts";
import {
  applyUpdate,
  makeInitialDoc,
  saveDoc,
} from "../scripts/update-stage-status.ts";

function setup(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "bss-"));
  for (const n of names) mkdirSync(join(root, n), { recursive: true });
  return root;
}

describe("listEditionDirs — exclui dirs de backup (#1661)", () => {
  it("regression #1661: backup dirs com sufixo são excluídos do scan", () => {
    const dir = setup([
      "260528",
      "260527-backup-20260526203126",
      "260422-local-backup",
    ]);
    // Sem o guard isValidEditionDir, os 2 backups entrariam (são diretórios) e
    // seriam alvos de escrita destrutiva.
    assert.deepEqual(listEditionDirs(dir).sort(), ["260528"]);
  });

  it("aceita múltiplas edições válidas e barra AAMMDD inválido (dia 99)", () => {
    const dir = setup(["260528", "260601", "not-an-edition", "260999"]);
    assert.deepEqual(listEditionDirs(dir).sort(), ["260528", "260601"]);
  });

  it("--edition filter restringe a uma edição, e ainda valida o nome", () => {
    const dir = setup(["260528", "260601", "260527-backup-x"]);
    assert.deepEqual(listEditionDirs(dir, "260601"), ["260601"]);
    // filtro apontando pra um backup → vazio (o guard rejeita mesmo com filtro)
    assert.deepEqual(listEditionDirs(dir, "260527-backup-x"), []);
  });
});

describe("#2416 sibling: scanEdition — NaN guard em completed_at malformado", () => {
  // Regressão: sentinel.completed_at malformado produzia rawEndMs=NaN →
  // Fix.endMs=NaN → autoUpdateStageStatusOnSentinel(nowMs=NaN) →
  // new Date(NaN).toISOString() lança RangeError engolido pelo try/catch →
  // no-op silencioso: stage-status nunca flipado para done, sem warning.
  // Fix: guard NaN antes de emitir Fix; fallback para Date.now() + warn.

  it("#2416-sibling: completed_at malformado → endMs é número válido (não NaN), warn emitido", () => {
    const dir = mkdtempSync(join(tmpdir(), "bss-nan-guard-"));
    try {
      // Montar um dir de edição com stage-status.json (stage 2 em running)
      let doc = makeInitialDoc("260620");
      doc = applyUpdate(doc, {
        stage: 2,
        status: "running",
        start: "2026-06-20T10:00:00Z",
      });
      saveDoc(dir, doc);

      // Escrever sentinel com completed_at malformado (string não-ISO inválida)
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", ".step-2-done.json"),
        JSON.stringify({ step: 2, completed_at: "not-a-date", outputs: [] }),
      );

      // Capturar warns emitidos por scanEdition
      const warnMessages: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnMessages.push(args.map(String).join(" "));
      };

      let fixes: ReturnType<typeof scanEdition>;
      try {
        fixes = scanEdition(dir, "260620");
      } finally {
        console.warn = originalWarn;
      }

      // scanEdition deve retornar 1 fix (sentinel encontrado para stage 2)
      assert.equal(fixes.length, 1, "deve detectar 1 fix mesmo com completed_at malformado");

      // O bug: Fix.endMs era NaN, propagado para autoUpdateStageStatusOnSentinel
      // como nowMs=NaN, causando no-op silencioso. Com o guard, endMs é Date.now().
      assert.ok(!Number.isNaN(fixes[0].endMs), "#2416-sibling: Fix.endMs não deve ser NaN (guard deve ter aplicado fallback)");
      assert.equal(typeof fixes[0].endMs, "number", "endMs deve ser number");
      // Sanity: fallback é Date.now(), que é > 0
      assert.ok(fixes[0].endMs > 0, "endMs deve ser um timestamp positivo");

      // O warn de fallback deve ter sido emitido
      const warnEmitted = warnMessages.some(
        (m) => m.includes("malformed completed_at") && m.includes("not-a-date"),
      );
      assert.ok(warnEmitted, "#2416-sibling: warn de fallback deve ser emitido quando completed_at é malformado");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#2416-sibling: completed_at válido → endMs igual ao timestamp do sentinel (sem fallback)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bss-valid-ts-"));
    try {
      let doc = makeInitialDoc("260620");
      doc = applyUpdate(doc, {
        stage: 1,
        status: "running",
        start: "2026-06-20T08:00:00Z",
      });
      saveDoc(dir, doc);

      const completedAt = "2026-06-20T09:30:00Z";
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", ".step-1-done.json"),
        JSON.stringify({ step: 1, completed_at: completedAt, outputs: [] }),
      );

      const fixes = scanEdition(dir, "260620");
      assert.equal(fixes.length, 1);
      // Com completed_at válido, endMs deve ser exatamente o timestamp do sentinel
      assert.equal(
        fixes[0].endMs,
        new Date(completedAt).getTime(),
        "completed_at válido → endMs deve refletir o timestamp exato do sentinel",
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
