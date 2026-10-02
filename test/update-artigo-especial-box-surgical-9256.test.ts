import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyBoxPin,
  runUpdateArtigoEspecialBox,
  serializeConfigSurgically,
  type BoxesDivulgacaoConfig,
} from "../scripts/update-artigo-especial-box.ts";

// #9256 — o pin/unpin do box reescrevia platform.config.json inteiro via
// JSON.stringify (arrays inline expandidos, dezenas de linhas no diff).

// slot2 normalizado pro Artigo Especial: na config real ele alterna com a Retrospectiva
// (#9474, last-writer-wins) e estes testes não podem depender de quem ocupa o slot hoje.
const realText = readFileSync(join(import.meta.dirname, "..", "platform.config.json"), "utf8").replace(
  /("slot2": )"[^"]*"/,
  '$1"artigo-especial-apoiadores.md"',
);
const INPUT = { titulo: "T", gancho: "G", mesLabel: "Setembro" };

function changedLines(a: string, b: string): string[] {
  const la = a.split("\n");
  const lb = b.split("\n");
  assert.equal(la.length, lb.length, "número de linhas mudou — o arquivo foi reformatado");
  return lb.filter((line, i) => line !== la[i]).map((l) => l.trim());
}

function withAuto(config: BoxesDivulgacaoConfig, pinned: number[], slot1?: string): BoxesDivulgacaoConfig {
  return {
    ...config,
    boxes_divulgacao: slot1 ? { ...config.boxes_divulgacao, slot1 } : config.boxes_divulgacao,
    boxes_divulgacao_auto: { ...config.boxes_divulgacao_auto, pinned_slots: pinned },
  };
}

describe("serializeConfigSurgically (#9256)", () => {
  it("pin muda só as linhas slotN e pinned_slots (config real)", () => {
    const config = JSON.parse(realText) as BoxesDivulgacaoConfig;
    const baseCfg = withAuto(config, [], "outro.md");
    const base = serializeConfigSurgically(realText, baseCfg, 1);
    const next = applyBoxPin(baseCfg, { slot: 1, filename: "artigo-especial-apoiadores.md", pin: true });
    const out = serializeConfigSurgically(base, next, 1);
    assert.deepEqual(changedLines(base, out).sort(), ['"pinned_slots": [1],', '"slot1": "artigo-especial-apoiadores.md",'].sort());
    assert.deepEqual(JSON.parse(out), next);
  });

  it("unpin muda só pinned_slots", () => {
    const config = JSON.parse(realText) as BoxesDivulgacaoConfig;
    const next = applyBoxPin(config, { slot: 2, filename: "artigo-especial-apoiadores.md", pin: false });
    const out = serializeConfigSurgically(realText, next, 2);
    const changed = changedLines(realText, out);
    assert.equal(changed.length, 1);
    assert.match(changed[0], /^"pinned_slots": \[/);
    assert.deepEqual(JSON.parse(out), next);
  });

  it("chave ausente no texto cai no JSON.stringify completo (ainda correto)", () => {
    const text = JSON.stringify({ boxes_divulgacao_auto: { pinned_slots: [] } });
    const next = applyBoxPin(JSON.parse(text), { slot: 2, filename: "a.md", pin: true });
    assert.deepEqual(JSON.parse(serializeConfigSurgically(text, next, 2)), next);
  });

  it("runUpdateArtigoEspecialBox grava platform.config.json sem reformatar", () => {
    const dir = mkdtempSync(join(tmpdir(), "ae-box-9256-"));
    try {
      const configPath = join(dir, "platform.config.json");
      const config = JSON.parse(realText) as BoxesDivulgacaoConfig;
      const before = serializeConfigSurgically(realText, withAuto(config, [1]), 2);
      writeFileSync(configPath, before, "utf8");
      runUpdateArtigoEspecialBox({ ...INPUT, snippetsFile: join(dir, "box.md"), configPath, dataDir: dir, slot: 2, pin: true, dryRun: false, force: false });
      assert.deepEqual(changedLines(before, readFileSync(configPath, "utf8")), ['"pinned_slots": [1, 2],']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
