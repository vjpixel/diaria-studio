/**
 * #13112 — o guard escopado do erro intencional (#13105) conta só o texto que
 * o render PUBLICA. Campo da seleção que não sai no post (`why` de
 * Lançamentos/Use melhor/Radar, item excluído) não pode recusar o `--publish`
 * da Stack de segunda 06:00, que roda sem ninguém olhando.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findScopedIntentionalErrorLeaks,
  segmentTextByEdition,
  type IntentionalErrorPair,
} from "../scripts/lib/intentional-error-scrub.ts";
import { runCircleStack, type RunCircleStackDeps } from "../scripts/publish-circle-stack.ts";
import type { CircleStackSelection } from "../scripts/lib/circle-stack-render.ts";

const ROOT = resolve(import.meta.dirname, "..");
const tmpRoots: string[] = [];
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const APPEL: IntentionalErrorPair = { edition: "261111", wrong: "Appel", correct: "Apple", location: "RADAR, item 2" };

describe("#13112 segmentTextByEdition: só o texto renderizado vira trecho", () => {
  it("texto de item ausente do texto final não conta (why não publicado)", () => {
    const segs = segmentTextByEdition("Título publicado do item\nCorpo publicado do item.", [
      { edition: "261111", texts: ["Título publicado do item", "Corpo publicado do item.", "A Appel explica por que importa."] },
    ]);
    assert.deepEqual(findScopedIntentionalErrorLeaks(segs, [APPEL]), { blocking: [], advisory: [] });
  });

  it("o mesmo erro no texto publicado do item recusa (controle)", () => {
    const segs = segmentTextByEdition("A Appel lança chip novo\nCorpo.", [
      { edition: "261111", texts: ["A Appel lança chip novo", "A Appel explica por que importa."] },
    ]);
    const r = findScopedIntentionalErrorLeaks(segs, [APPEL]);
    assert.equal(r.blocking.length, 1);
    assert.equal(r.blocking[0].count, 1, "só a ocorrência publicada conta, não a do why");
  });

  it("corpo com linhas partidas pelo render: só as linhas publicadas contam", () => {
    const body = "Linha publicada sem erro algum.\nLinha cortada que cita a Appel.";
    const segs = segmentTextByEdition("<p>Linha publicada sem erro algum.</p>", [{ edition: "261111", texts: [body] }]);
    assert.deepEqual(findScopedIntentionalErrorLeaks(segs, [APPEL]), { blocking: [], advisory: [] });
  });
});

// ── Integração: Stack ──────────────────────────────────────────────────────

const ERR_APPEL = {
  description: "Grafia trocada no RADAR",
  location: "RADAR, item 2",
  category: "ortografia",
  wrong_value: "Appel",
  correct_value: "Apple",
  reveal: "Na última edição, escrevi Appel onde o correto é Apple.",
};

const MD_261111 = [
  "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
  "",
  "**[Apple lança agente de programação no Xcode](https://www.apple.com/newsroom/xcode-agent)**",
  "",
  "A Apple colocou um agente de programação dentro do Xcode.",
  "",
  "Por que isso importa:",
  "",
  "Quem constrói app para iPhone ganha um agente no próprio editor.",
  "",
  "---",
  "",
  "**📡 RADAR**",
  "",
  "**[Relatório anual da IA sai agora](https://exemplo.com/relatorio-ia)**",
  "O documento reúne os números do setor.",
  "",
].join("\n");

describe("#13112 integração: erro só em why/item excluído não recusa o --publish da Stack", () => {
  it("--publish sai; o texto não publicado não entra no guard", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "ie-13112-stack-"));
    tmpRoots.push(dataRoot);
    const dir = join(dataRoot, "data", "editions", "2611", "261111");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), MD_261111, "utf8");
    writeFileSync(join(dir, "_internal", "intentional-error.json"), JSON.stringify(ERR_APPEL));
    const selectionPath = join(dataRoot, "data", "weekly", "26w46", "_internal", "circle-stack-selection.json");
    const sent: unknown[] = [];
    const deps: RunCircleStackDeps = {
      rootDir: ROOT,
      platformConfig: { circle_stack: { enabled: true } },
      env: { STACK_WEBHOOK_URL: "https://hook.test", STACK_WEBHOOK_KEY: "k" },
      translateCall: () => JSON.stringify({ items: [] }),
      send: async (_url, _key, p) => {
        sent.push(p);
        return { postUrl: null, postId: null, postSlug: null };
      },
      ghRun: () => ({ status: 0, stdout: "[]", stderr: "" }),
      topVideo: async () => null,
    };
    const base = ["--publish-monday", "261116", "--data-root", dataRoot, "--no-translate"];
    const warns: string[] = [];
    const ow = console.warn;
    const ol = console.log;
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    console.log = () => {};
    try {
      await runCircleStack(base, deps);
      const sel = JSON.parse(readFileSync(selectionPath, "utf8")) as CircleStackSelection;
      const template = sel.destaques[0];
      // Radar da MESMA edição do erro: `why` não é renderizado no Radar.
      const radarItem = {
        ...template,
        destaqueN: undefined,
        url: "https://exemplo.com/radar-why",
        title: "Item do Radar com motivo não publicado",
        body: "Corpo publicado do item do Radar.",
        why: "A Appel explica por que isso importa.",
      };
      // Item excluído pelo editor, também da mesma edição, com o erro no título.
      const excludedItem = { ...radarItem, url: "https://exemplo.com/excluido", title: "Appel lança outro chip", why: "" };
      sel.radar = [...sel.radar, radarItem, excludedItem];
      sel.excluded = [{ url: excludedItem.url, note: "fora" }];
      writeFileSync(selectionPath, JSON.stringify(sel, null, 2));
      warns.length = 0;
      let error: unknown;
      try {
        await runCircleStack([...base, "--publish"], deps);
      } catch (e) {
        error = e;
      }
      assert.equal(error, undefined, `o --publish não pode ser recusado: ${String(error)}`);
      assert.equal(sent.length, 1, "o post sai");
      const out = JSON.stringify(sent[0]);
      assert.ok(!out.includes("Appel"), "o texto não publicado não chega ao post");
      assert.ok(!warns.some((w) => w.includes("erro intencional")), warns.join("\n"));
    } finally {
      console.warn = ow;
      console.log = ol;
    }
  });
});
