/**
 * test/box-scheduled-pin-14334.test.ts (#14334)
 *
 * Box da Black Friday da Clarice (NEWS65) só na edição 261130, sem ficar preso
 * (#10303/#11202) e sem a caixa concorrente `clarice-divulgacao.md`
 * (NEWS25/NEWS50) em outro slot da mesma edição. Mecanismo:
 * `boxes_divulgacao_auto.scheduled_pins` (pin com janela de datas da EDIÇÃO).
 *
 * Trava:
 *   1. o parse/janela (`parseScheduledPins`, `activeScheduledPins`);
 *   2. o resolver em fixture: na 261130 o slot 2 sai com a caixa do pin e a
 *      `clarice-divulgacao.md` não sai em nenhum slot, mesmo sendo a mais
 *      clicada; na 261129 e na 261201 nada disso vale (controle);
 *   3. o mesmo com a auto-seleção desligada;
 *   4. o registro `scheduled-pin` não é lido como drift de config (#9253);
 *   5. o `platform.config.json` REAL: a entrada existe, vale só em
 *      2026-11-30 e não pina o slot 2 em `pinned_slots`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeScheduledPins,
  loadBoxesDivulgacaoAutoConfig,
  parseScheduledPins,
  resolveBoxesForEdition,
  type ScheduledBoxPin,
} from "../scripts/select-boxes-by-clicks.ts";
import { detectBoxSelectionConfigDrift } from "../scripts/lib/box-selection-drift.ts";

const REPO_CONFIG = join(import.meta.dirname, "..", "platform.config.json");
const BF = "clarice-black-friday-news65.md";
const CLARICE = "clarice-divulgacao.md";

const PIN: ScheduledBoxPin = { slot: 2, file: BF, from: "2026-11-30", until: "2026-11-30", excludeFiles: [CLARICE] };

function writeSnippet(dir: string, file: string, nome: string, url: string, extraHeader = ""): void {
  writeFileSync(join(dir, file), `<!--\nnome: ${nome}\n${extraHeader}-->\n\n**${nome}**\n\nTexto.\n\n[Link](${url})\n`);
}

/** Edição com box nos dois gaps (slot 1 e slot 2). */
function writeEdition(editionsDir: string, aammdd: string, b1: [string, string], b2: [string, string]): void {
  const d = join(editionsDir, aammdd);
  mkdirSync(d, { recursive: true });
  const box = ([nome, url]: [string, string]) => `**${nome}**\n\nTexto.\n\n[Link](${url})`;
  writeFileSync(
    join(d, "02-reviewed.md"),
    `**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody\n\n---\n\n${box(b1)}\n\n---\n\n` +
      `**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody\n\n---\n\n${box(b2)}\n\n---\n\n` +
      `**DESTAQUE 3 | 🚀**\n\n[T](https://d3.com)\n\nbody`,
  );
}

function writePost(postsDir: string, id: string, iso: string, clicks: Record<string, number>): void {
  writeFileSync(
    join(postsDir, `${id}.json`),
    JSON.stringify({
      id,
      publish_date: Math.floor(new Date(`${iso}T09:00:00Z`).getTime() / 1000),
      stats: {
        clicks: Object.entries(clicks).map(([url, n]) => ({ url, email: { verified_clicks: n, unique_verified_clicks: n } })),
      },
    }),
  );
}

const URL_CLARICE = "https://clarice.ai/precos-planos?via=diaria";
const URL_BF = "https://clarice.ai/precos-planos?via=diaria&bf=1";
const URL_LIVROS = "https://livros.diar.ia.br";
const URL_LOJA = "https://x.com/loja";
const URL_PODCAST = "https://x.com/podcast";

function scenario(aammdd: string, opts: { enabled?: boolean; pins?: readonly ScheduledBoxPin[]; bfExpires?: string; slot1?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "box-sched-14334-"));
  const editionsDir = join(dir, "editions");
  const postsDir = join(dir, "posts");
  const snippetsDir = join(dir, "snippets");
  for (const d of [editionsDir, postsDir, snippetsDir]) mkdirSync(d, { recursive: true });
  try {
    writeSnippet(snippetsDir, CLARICE, "Clarice", URL_CLARICE);
    writeSnippet(snippetsDir, BF, "Black Friday", URL_BF, `expires: ${opts.bfExpires ?? "2026-11-30"}\n`);
    writeSnippet(snippetsDir, "livros-divulgacao.md", "Livros", URL_LIVROS);
    writeSnippet(snippetsDir, "amazon-loja-divulgacao.md", "Loja", URL_LOJA);
    writeSnippet(snippetsDir, "podcast.md", "Podcast", URL_PODCAST);
    // 261124-261126: Clarice (muito clicada) + Livros.
    for (const [i, a] of ["261124", "261125", "261126"].entries()) {
      writeEdition(editionsDir, a, ["Clarice", URL_CLARICE], ["Livros", URL_LIVROS]);
      writePost(postsDir, `p${a}`, `2026-11-${24 + i}`, { [URL_CLARICE]: 90, [URL_LIVROS]: 40 });
    }
    // 261127: Loja + Podcast (edição imediatamente anterior a todas as datas testadas).
    writeEdition(editionsDir, "261127", ["Loja", URL_LOJA], ["Podcast", URL_PODCAST]);
    writePost(postsDir, "p261127", "2026-11-27", { [URL_LOJA]: 5, [URL_PODCAST]: 5 });
    return resolveBoxesForEdition({
      aammdd,
      boxesCfg: { slot0: "", slot1: opts.slot1 ?? "amazon-loja-divulgacao.md", slot2: "livros-divulgacao.md", slot3: null },
      autoCfg: {
        enabled: opts.enabled ?? true,
        pinnedSlots: new Set(),
        recentWindow: 3,
        priorWindow: 3,
        lastN: 20,
        scheduledPins: opts.pins ?? [PIN],
      },
      editionsDir,
      postsDir,
      snippetsDir,
      destaqueCount: 3,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#14334 — parseScheduledPins / activeScheduledPins", () => {
  it("aceita a entrada válida e descarta as malformadas", () => {
    const pins = parseScheduledPins([
      { slot: 2, file: BF, from: "2026-11-30", until: "2026-11-30", exclude_files: [CLARICE, BF, 3] },
      { slot: 3, file: BF, from: "2026-11-30", until: "2026-11-30" },
      { slot: 1, file: "", from: "2026-11-30", until: "2026-11-30" },
      { slot: 1, file: BF, from: "30/11/2026", until: "2026-11-30" },
      { slot: 1, file: BF, from: "2026-12-01", until: "2026-11-30" },
      "lixo",
    ]);
    assert.deepEqual(pins, [PIN]);
    assert.deepEqual(parseScheduledPins(undefined), []);
  });

  it("janela inclusiva, pela data da edição", () => {
    assert.equal(activeScheduledPins([PIN], "2026-11-30").get(2)?.file, BF);
    assert.equal(activeScheduledPins([PIN], "2026-11-29").size, 0);
    assert.equal(activeScheduledPins([PIN], "2026-12-01").size, 0);
    assert.equal(activeScheduledPins([PIN], null).size, 0);
  });
});

describe("#14334 — resolver com pin de janela", () => {
  it("controle: sem o pin, a 261130 pegaria a clarice-divulgacao.md (a mais clicada)", () => {
    const { effective } = scenario("261130", { pins: [] });
    assert.ok(effective.slot1 === CLARICE || effective.slot2 === CLARICE, JSON.stringify(effective));
  });

  it("261130: slot 2 = Black Friday (scheduled-pin) e a clarice-divulgacao.md fora de todos os slots", () => {
    const { effective, selection } = scenario("261130");
    assert.equal(effective.slot2, BF);
    assert.equal(selection.find((s) => s.slot === 2)!.mode, "scheduled-pin");
    assert.notEqual(effective.slot1, CLARICE);
    assert.notEqual(effective.slot0, CLARICE);
    assert.ok(effective.slot1, "slot 1 segue preenchido pela seleção automática");
  });

  it("261130 com slot 1 configurado = clarice-divulgacao.md (auto desligada): o slot 1 sai vazio", () => {
    // Sem candidato fora da exclusão e do anti-repetição, cairia no fallback.
    const { effective } = scenario("261130", { slot1: CLARICE, enabled: false });
    assert.equal(effective.slot1, null);
    assert.equal(effective.slot2, BF);
  });

  for (const aammdd of ["261129", "261201"]) {
    it(`${aammdd}: o pin não vale — slot 2 sem a Black Friday e sem exclusão`, () => {
      const { effective, selection } = scenario(aammdd);
      assert.notEqual(effective.slot2, BF);
      assert.notEqual(effective.slot1, BF);
      assert.ok(!selection.some((s) => s.mode === "scheduled-pin"));
      assert.ok(effective.slot1 === CLARICE || effective.slot2 === CLARICE, JSON.stringify(effective));
    });
  }

  it("auto-seleção desligada: na 261130 o pin ainda vale; fora dela, o config de sempre", () => {
    const on = scenario("261130", { enabled: false });
    assert.equal(on.effective.slot2, BF);
    assert.equal(on.selection.find((s) => s.slot === 2)!.mode, "scheduled-pin");
    const off = scenario("261201", { enabled: false });
    assert.equal(off.effective.slot2, "livros-divulgacao.md");
  });

  it("caixa já vencida pelo próprio expires: dentro da janela não sai", () => {
    const { effective, selection } = scenario("261130", { bfExpires: "2026-11-29" });
    assert.notEqual(effective.slot2, BF);
    assert.ok(!selection.some((s) => s.mode === "scheduled-pin"));
  });

  it("registro scheduled-pin não é drift do config (#9253)", () => {
    const { selection } = scenario("261130");
    assert.deepEqual(
      detectBoxSelectionConfigDrift(selection, { slot1: "amazon-loja-divulgacao.md", slot2: "livros-divulgacao.md" }).filter((d) => d.slot === 2),
      [],
    );
  });
});

describe("#14334 — platform.config.json real", () => {
  it("o pin da Black Friday existe, vale só em 2026-11-30 e não entra em pinned_slots", () => {
    const cfg = loadBoxesDivulgacaoAutoConfig(REPO_CONFIG);
    const pin = cfg.scheduledPins?.find((p) => p.file === BF);
    assert.ok(pin, "entrada clarice-black-friday-news65.md em scheduled_pins");
    assert.equal(pin.slot, 2);
    assert.ok(pin.excludeFiles.includes(CLARICE));
    assert.equal(activeScheduledPins([pin], "2026-11-30").size, 1);
    assert.equal(activeScheduledPins([pin], "2026-11-29").size, 0);
    assert.equal(activeScheduledPins([pin], "2026-12-01").size, 0);
    assert.ok(!cfg.pinnedSlots.has(2), "pin com janela não usa pinned_slots (#10303)");
  });
});
