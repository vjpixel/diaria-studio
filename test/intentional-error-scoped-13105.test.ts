/**
 * #13105 (follow-up do #13051) — o erro intencional não pode corromper nem
 * travar o que é legítimo:
 *   1. scrub: valor ambíguo ("2025") que também aparece de forma legítima em
 *      outro item só é trocado onde dá para atribuir ao erro (ocorrência única,
 *      ou única na seção de `location`);
 *   2. guard: o `wrong_value` de cada edição só conta no texto dos itens da
 *      MESMA edição (e no texto sem origem); número/palavra curta só avisa.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findScopedIntentionalErrorLeaks,
  formatIntentionalErrorAdvisory,
  isAmbiguousWrongValue,
  pairFromRecord,
  scrubIntentionalError,
  segmentTextByEdition,
  type IntentionalErrorPair,
} from "../scripts/lib/intentional-error-scrub.ts";
import { sectionKeyFromLocation } from "../scripts/lib/intentional-error-sections.ts";
import { sectionKeyFromLocation as replantSectionKey } from "../scripts/replant-intentional-error.ts";
import { annualScrubScope } from "../scripts/collect-annual.ts";
import { runCircleStack, type RunCircleStackDeps } from "../scripts/publish-circle-stack.ts";
import { circleStackSelectionAttributedTexts, type CircleStackSelection } from "../scripts/lib/circle-stack-render.ts";
import { linkedinSelectionAttributedTexts } from "../scripts/render-linkedin-weekly.ts";

const ROOT = resolve(import.meta.dirname, "..");

const tmpRoots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const NUM: IntentionalErrorPair = { edition: "261111", wrong: "2025", correct: "2026", location: "RADAR, item Relatório anual" };
const APPEL: IntentionalErrorPair = { edition: "261111", wrong: "Appel", correct: "Apple", location: "RADAR, item 2" };

const MD_2025 = [
  "**DESTAQUE 1 | NOTÍCIAS**",
  "",
  "**[Modelo aberto supera rival lançado em 2025](https://exemplo.com/modelo)**",
  "",
  "O rival foi lançado em março.",
  "",
  "**📡 RADAR**",
  "",
  "**[Relatório anual sai em 2025](https://exemplo.com/2025/relatorio)**",
  "Saiu agora.",
  "",
].join("\n");

describe("#13105 item 1 — scrub de valor ambíguo", () => {
  it("isAmbiguousWrongValue: número e palavra curta são ambíguos; grafia de nome não", () => {
    assert.equal(isAmbiguousWrongValue("2025"), true);
    assert.equal(isAmbiguousWrongValue("R$ 3,5 bi"), true);
    assert.equal(isAmbiguousWrongValue("GPT-5"), true);
    assert.equal(isAmbiguousWrongValue("dos"), true);
    assert.equal(isAmbiguousWrongValue("Appel"), false);
    assert.equal(isAmbiguousWrongValue("MTER"), false);
  });

  it('"2025" legítimo no D1 fica; o do RADAR (seção de location) vira 2026', () => {
    const out = scrubIntentionalError(MD_2025, NUM);
    assert.match(out, /rival lançado em 2025\]/, "o 2025 legítimo do D1 não pode ser corrompido");
    assert.match(out, /Relatório anual sai em 2026\]/);
    assert.match(out, /https:\/\/exemplo\.com\/2025\/relatorio/, "URL intacta");
  });

  it("valor ambíguo com várias ocorrências e sem seção resolvível: texto intacto", () => {
    assert.equal(scrubIntentionalError(MD_2025, { ...NUM, location: undefined }), MD_2025);
    assert.equal(scrubIntentionalError(MD_2025, { ...NUM, location: "item sobre o relatório" }), MD_2025);
  });

  it("valor ambíguo com 2 ocorrências na própria seção: texto intacto", () => {
    const md = MD_2025.replace("Saiu agora.", "Dados de 2025.");
    assert.equal(scrubIntentionalError(md, NUM), md);
  });

  it("ocorrência única troca mesmo sem location; grafia de nome troca todas", () => {
    assert.equal(scrubIntentionalError("Relatório de 2025.", { ...NUM, location: undefined }), "Relatório de 2026.");
    assert.equal(scrubIntentionalError("Appel aqui, Appel ali", APPEL), "Apple aqui, Apple ali");
  });

  it("pairFromRecord leva a location (JSON), o destaque numérico ou o detail (JSONL)", () => {
    assert.equal(pairFromRecord("261111", { wrong_value: "2025", correct_value: "2026", location: "RADAR, item X" })?.location, "RADAR, item X");
    assert.equal(pairFromRecord("261111", { wrong_value: "2025", correct_value: "2026", destaque: 2 })?.location, "DESTAQUE 2");
    assert.equal(pairFromRecord("261111", { wrong_value: "2025", correct_value: "2026", detail: "no título, no RADAR" })?.location, "no título, no RADAR");
    assert.equal("location" in (pairFromRecord("261111", { wrong_value: "2025", correct_value: "2026" }) ?? {}), false);
  });

  it("sectionKeyFromLocation saiu do script de replantio sem mudar (re-export)", () => {
    assert.equal(replantSectionKey, sectionKeyFromLocation);
    assert.equal(sectionKeyFromLocation("RADAR, item Apple cobra por uso extra de IA"), "RADAR");
    assert.equal(sectionKeyFromLocation("DESTAQUE 2, parágrafo 3"), "DESTAQUE 2");
  });

  it("anual: valor ambíguo só toca o destaque de location; fora dos destaques, nenhum", () => {
    assert.equal(annualScrubScope(APPEL), "all");
    assert.equal(annualScrubScope({ ...NUM, location: "DESTAQUE 2" }), 2);
    assert.equal(annualScrubScope(NUM), "none");
    assert.equal(annualScrubScope({ ...NUM, location: undefined }), "all");
  });
});

describe("#13105 item 2 — guard escopado à edição do item", () => {
  it('"2025" legítimo em item de OUTRA edição não conta', () => {
    const text = "Abertura.\nRelatório de 2025 mostra alta\nOutro item";
    const segs = segmentTextByEdition(text, [{ edition: "261112", texts: ["Relatório de 2025 mostra alta"] }]);
    assert.deepEqual(findScopedIntentionalErrorLeaks(segs, [NUM]), { blocking: [], advisory: [] });
  });

  it('"2025" no item da MESMA edição só avisa (valor ambíguo)', () => {
    const segs = segmentTextByEdition("Relatório anual sai em 2025", [{ edition: "261111", texts: ["Relatório anual sai em 2025"] }]);
    const r = findScopedIntentionalErrorLeaks(segs, [NUM]);
    assert.equal(r.blocking.length, 0);
    assert.equal(r.advisory.length, 1);
    assert.match(formatIntentionalErrorAdvisory(r.advisory, "Post"), /"2025".*261111.*não recusa/);
  });

  it("grafia errada no item da mesma edição ou no texto sem origem recusa; em item de outra edição, não", () => {
    const same = segmentTextByEdition("Appel lança chip", [{ edition: "261111", texts: ["Appel lança chip"] }]);
    assert.equal(findScopedIntentionalErrorLeaks(same, [APPEL]).blocking.length, 1);
    const opening = segmentTextByEdition("Na semana, a Appel lançou.\nTítulo X", [{ edition: "261112", texts: ["Título X"] }]);
    assert.equal(findScopedIntentionalErrorLeaks(opening, [APPEL]).blocking.length, 1);
    const other = segmentTextByEdition("Appel lança chip", [{ edition: "261112", texts: ["Appel lança chip"] }]);
    assert.deepEqual(findScopedIntentionalErrorLeaks(other, [APPEL]), { blocking: [], advisory: [] });
  });

  it("texto do item reescrito pelo render (parágrafos juntados, escape HTML) ainda é atribuído", () => {
    const body = "Dados de 2025 mostram alta.\n\nO mercado segue & cresce.";
    const html = "<p>Dados de 2025 mostram alta.</p><p>O mercado segue &amp; cresce.</p>";
    const segs = segmentTextByEdition(html, [{ edition: "261112", texts: [body] }]);
    assert.deepEqual(findScopedIntentionalErrorLeaks(segs, [NUM]), { blocking: [], advisory: [] });
  });

  it("textos atribuídos da seleção da Stack e do LinkedIn levam a edição de cada item", () => {
    const item = { editionDate: "261112", url: "https://x.test", title: "T 2025", body: "B", why: "W" };
    const sel = {
      cycle: "26w46",
      contentWindow: [],
      destaques: [item],
      lancamentos: [],
      useMelhor: [],
      radar: [],
      weeklyEditions: [{ editionDate: "261113", url: "https://x.test/e", destaques: ["D1 da 13"] }],
      video: { title: "Vídeo", url: "https://y.test", editionDate: "261111" },
    } as CircleStackSelection;
    assert.deepEqual(
      circleStackSelectionAttributedTexts(sel).map((a) => a.edition),
      ["261112", "261113", "261111"],
    );
    assert.deepEqual(
      linkedinSelectionAttributedTexts({
        headlines: [{ title: "H", body: "B", why: "W", editionDate: "261110" }],
        weeklyEditions: [],
        video: null,
      }),
      [{ edition: "261110", texts: ["H", "B", "W"] }],
    );
  });
});

// ── Integração: Stack ──────────────────────────────────────────────────────

const ERR_2025 = {
  description: "Ano trocado no título do relatório, no RADAR",
  location: "RADAR, item Relatório anual da IA",
  category: "factual",
  wrong_value: "2025",
  correct_value: "2026",
  reveal: "Na última edição, escrevi 2025 onde o correto é 2026.",
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
  "**[Relatório anual da IA sai em 2025](https://exemplo.com/relatorio-ia)**",
  "O documento reúne os números do setor.",
  "",
].join("\n");

describe("#13105 integração: Stack com '2025' legítimo em item de outra edição", () => {
  it("--publish não é recusado pelo guard; o 2025 de outra edição fica", async () => {
    const dataRoot = tmp("ie-13105-stack-");
    const dir = join(dataRoot, "data", "editions", "2611", "261111");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), MD_261111, "utf8");
    writeFileSync(join(dir, "_internal", "intentional-error.json"), JSON.stringify(ERR_2025));
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
      const raw = readFileSync(selectionPath, "utf8");
      // Um item de OUTRA edição (261112) cita 2025 de forma legítima.
      const sel = JSON.parse(raw) as CircleStackSelection & Record<string, unknown>;
      const legit = { ...sel.destaques[0], editionDate: "261112", url: "https://exemplo.com/outro", title: "Balanço de 2025 mostra recorde de investimento", destaqueN: undefined };
      sel.radar = [...sel.radar, legit];
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
      assert.match(JSON.stringify(sent[0]), /Balanço de 2025/, "o 2025 legítimo fica no post");
      assert.ok(!warns.some((w) => w.includes("erro intencional")), warns.join("\n"));
    } finally {
      console.warn = ow;
      console.log = ol;
    }
  });
});
