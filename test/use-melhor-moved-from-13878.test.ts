/**
 * test/use-melhor-moved-from-13878.test.ts (#13878)
 *
 * O teto de score do item movido para o USE MELHOR (#13849,
 * `comparableUseMelhorScore`) só valia quando o item ainda aparecia num bucket
 * que não era o `use_melhor`. O caminho oficial do gate, `move-pool-item.ts
 * --to use_melhor`, tira o objeto do `radar` e o põe no `use_melhor` de
 * `01-approved.json` e `01-approved-capped.json` com o score do RADAR: depois
 * disso o item contava como nativo e vencia qualquer item do `use_melhor` só
 * pela escala (RADAR 105 contra ≤80).
 *
 * Fix: o move grava `moved_from` (bucket de origem) no objeto, e
 * `poolCandidatesForReviewed` lê como `pool_bucket`. Os fixtures aqui estão no
 * estado PÓS-`move-pool-item.ts` (o do #13849 montava o item ainda no `radar`).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { markMovedFrom, moveInApprovedJson, movePoolItem } from "../scripts/move-pool-item.ts";
import {
  poolCandidatesForReviewed,
  selectUseMelhorItem,
  USE_MELHOR_MOVED_FROM_KEY,
  type UseMelhorPostConfigState,
} from "../scripts/lib/use-melhor-post.ts";
import { runSelection } from "../scripts/select-use-melhor-post.ts";

const ON: UseMelhorPostConfigState = { enabled: true, time: "07:45" };

const NATIVE = { url: "https://exemplo.com/guia-nativo", title: "Guia nativo", summary: "Passo a passo.", score: 80 };
const NATIVE_LOW = { url: "https://exemplo.com/guia-fraco", title: "Guia fraco", summary: "Outro.", score: 50 };
const RADAR = { url: "https://exemplo.com/radar-105", title: "Radar 105", summary: "Notícia do radar.", score: 105 };

const MD = `Olá!

---

**🛠️ USE MELHOR**

**[${NATIVE.title}](${NATIVE.url})**
${NATIVE.summary} (5 min)

**[${NATIVE_LOW.title}](${NATIVE_LOW.url})**
${NATIVE_LOW.summary} (4 min)

---

**📡 RADAR**

**[${RADAR.title}](${RADAR.url})**
${RADAR.summary}

**[Outro radar](https://exemplo.com/radar-outro)**
Mais um.

---
`;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function edition(opts: { cappedHasRadar?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-13878-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  const outro = { url: "https://exemplo.com/radar-outro", title: "Outro radar", summary: "", score: 60 };
  writeFileSync(
    join(dir, "_internal", "01-approved.json"),
    JSON.stringify({ highlights: [], use_melhor: [NATIVE, NATIVE_LOW], radar: [RADAR, outro] }),
  );
  writeFileSync(
    join(dir, "_internal", "01-approved-capped.json"),
    JSON.stringify({ use_melhor: [NATIVE, NATIVE_LOW], radar: opts.cappedHasRadar === false ? [outro] : [RADAR, outro] }),
  );
  writeFileSync(join(dir, "02-reviewed.md"), MD);
  return dir;
}

const readJson = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, "_internal", f), "utf8"));
const inUseMelhor = (j: { use_melhor: Array<Record<string, unknown>> }) => j.use_melhor.find((x) => x.url === RADAR.url);

describe("#13878 — teto de score vale para o item movido por move-pool-item.ts", () => {
  it("REGRESSÃO: RADAR 105 movido para use_melhor não vence o nativo 80 (--reviewed --force)", () => {
    const dir = edition();
    movePoolItem(dir, RADAR.url, "use_melhor", { tempo: 3 });
    // Estado pós-move: o item está no bucket use_melhor dos dois JSONs, com o score do RADAR.
    for (const f of ["01-approved.json", "01-approved-capped.json"]) {
      const j = readJson(dir, f);
      assert.equal(j.radar.some((x: { url: string }) => x.url === RADAR.url), false, f);
      assert.equal(inUseMelhor(j)?.score, 105, f);
      assert.equal(inUseMelhor(j)?.[USE_MELHOR_MOVED_FROM_KEY], "radar", f);
    }
    const r = runSelection(dir, ON, { useReviewed: true, forceReselect: true, discontinuationTopics: [] });
    assert.equal(r.state.item?.url, NATIVE.url, JSON.stringify(r.state));
  });

  it("nativo de maior score cortado: o teto passa ao maior nativo em disputa e o empate fica com o nativo", () => {
    const dir = edition();
    movePoolItem(dir, RADAR.url, "use_melhor", { tempo: 3 });
    // Editor cortou o nativo 80 do USE MELHOR final: o teto passa a ser o 50 do que sobrou;
    // 105 limitado a 50 empata e perde para o nativo.
    const md = readFileSync(join(dir, "02-reviewed.md"), "utf8").replace(
      `**[${NATIVE.title}](${NATIVE.url})**\n${NATIVE.summary} (5 min)\n\n`,
      "",
    );
    writeFileSync(join(dir, "02-reviewed.md"), md);
    const r = runSelection(dir, ON, { useReviewed: true, forceReselect: true, discontinuationTopics: [] });
    assert.equal(r.state.item?.url, NATIVE_LOW.url, JSON.stringify(r.state));
  });

  it("teto calculado só sobre os itens em disputa: o nativo 80 cortado não define o teto (pure)", () => {
    const cs = poolCandidatesForReviewed([
      { use_melhor: [NATIVE, NATIVE_LOW, { ...RADAR, score: 90, [USE_MELHOR_MOVED_FROM_KEY]: "radar" }] },
    ]);
    // Renderizados: o fraco (50) e o movido (90). Antes, o teto saía de TODOS os
    // candidatos (80, do nativo cortado) e o movido vencia com 80; agora é 50 e o empate fica com o nativo.
    const sel = selectUseMelhorItem(cs, [NATIVE_LOW.url, RADAR.url]);
    assert.equal(sel.item?.url, NATIVE_LOW.url);
  });

  it("arquivo que não tinha o item (capped sem o RADAR) recebe a cópia com moved_from", () => {
    const dir = edition({ cappedHasRadar: false });
    movePoolItem(dir, RADAR.url, "use_melhor", { tempo: 3 });
    assert.equal(inUseMelhor(readJson(dir, "01-approved-capped.json"))?.[USE_MELHOR_MOVED_FROM_KEY], "radar");
    const r = runSelection(dir, ON, { useReviewed: true, forceReselect: true, discontinuationTopics: [] });
    assert.equal(r.state.item?.url, NATIVE.url);
  });

  it("voltar ao bucket de origem apaga moved_from; ida e volta preserva a origem PRIMEIRA", () => {
    const json: Record<string, unknown> = { use_melhor: [], radar: [{ ...RADAR }], video: [] };
    moveInApprovedJson(json, RADAR.url, "use_melhor");
    assert.equal((json.use_melhor as Array<Record<string, unknown>>)[0][USE_MELHOR_MOVED_FROM_KEY], "radar");
    moveInApprovedJson(json, RADAR.url, "video");
    assert.equal((json.video as Array<Record<string, unknown>>)[0][USE_MELHOR_MOVED_FROM_KEY], "radar");
    moveInApprovedJson(json, RADAR.url, "radar");
    assert.equal(USE_MELHOR_MOVED_FROM_KEY in (json.radar as Array<Record<string, unknown>>)[0], false);
  });

  it("item nativo do use_melhor que sai e volta não fica marcado (não ganha teto)", () => {
    const item: Record<string, unknown> = { ...NATIVE };
    assert.equal(markMovedFrom(item, "use_melhor", "radar"), true);
    assert.equal(item[USE_MELHOR_MOVED_FROM_KEY], "use_melhor");
    assert.equal(markMovedFrom(item, "radar", "use_melhor"), true);
    assert.equal(USE_MELHOR_MOVED_FROM_KEY in item, false);
    assert.equal(poolCandidatesForReviewed([{ use_melhor: [item] }])[0].pool_bucket, undefined);
  });
});
