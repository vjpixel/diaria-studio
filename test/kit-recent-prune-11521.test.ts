/**
 * #11521 — `kit-recent/` ganhava ~24 observações horárias por dia sem poda, e
 * o relatório lia todas a cada execução. A rodada `--recent` agora apaga as
 * observações com mais de `RECENT_RETENTION_DAYS` dias.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  expiredHourlyObservationFiles,
  hourlyObservationFileName,
  RECENT_RETENTION_DAYS,
} from "../scripts/lib/subscriber-hourly-confirmation.ts";
import { pruneHourlyObservations } from "../scripts/subscriber-state-snapshot.ts";
import { loadHourlyObservations } from "../scripts/subscriber-confirmation-report.ts";

const NOW = new Date("2026-10-29T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe("poda de kit-recent/ (#11521)", () => {
  it("retenção default é 35 dias", () => {
    assert.equal(RECENT_RETENTION_DAYS, 35);
  });

  it("expiredHourlyObservationFiles: só nomes de observação mais velhos que a janela", () => {
    const old = hourlyObservationFileName(daysAgo(36));
    const edge = hourlyObservationFileName(daysAgo(35)); // exatamente no limite: fica
    const fresh = hourlyObservationFileName(daysAgo(1));
    const out = expiredHourlyObservationFiles([old, edge, fresh, "README.md", "2020-01-01.jsonl"], NOW);
    assert.deepEqual(out, [old]);
  });

  it("expiredHourlyObservationFiles rejeita retenção inválida", () => {
    assert.throws(() => expiredHourlyObservationFiles([], NOW, 0));
    assert.throws(() => expiredHourlyObservationFiles([], NOW, Number.NaN));
  });

  it("pruneHourlyObservations apaga só as expiradas e o relatório deixa de lê-las", () => {
    const root = resolve(mkdtempSync(resolve(tmpdir(), "kit-recent-prune-")), "kit-recent");
    mkdirSync(root, { recursive: true });
    const names: string[] = [];
    // 40 dias de observações, uma a cada 6h.
    for (let h = 0; h < 40 * 24; h += 6) {
      const name = hourlyObservationFileName(new Date(NOW.getTime() - h * 3_600_000));
      names.push(name);
      writeFileSync(resolve(root, name), "");
    }
    writeFileSync(resolve(root, "notas.txt"), "não é observação");
    const before = loadHourlyObservations(root).length;
    assert.equal(before, names.length);

    const r = pruneHourlyObservations(root, NOW);
    assert.ok(r.removed.length > 0);
    assert.deepEqual(r.failed, []);
    const minMs = NOW.getTime() - 35 * 86_400_000;
    for (const obs of loadHourlyObservations(root)) assert.ok(obs.at.getTime() >= minMs);
    assert.equal(loadHourlyObservations(root).length, names.length - r.removed.length);
    assert.ok(existsSync(resolve(root, "notas.txt")), "arquivo que não é observação nunca é apagado");
  });

  it("dryRun lista sem apagar; diretório ausente não lança", () => {
    const root = mkdtempSync(resolve(tmpdir(), "kit-recent-dry-"));
    const old = hourlyObservationFileName(daysAgo(50));
    writeFileSync(resolve(root, old), "");
    const r = pruneHourlyObservations(root, NOW, { dryRun: true });
    assert.deepEqual(r.expired, [old]);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(readdirSync(root), [old]);
    assert.deepEqual(pruneHourlyObservations(resolve(root, "nao-existe"), NOW), { expired: [], removed: [], failed: [] });
  });
});
