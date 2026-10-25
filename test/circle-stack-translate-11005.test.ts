/**
 * test/circle-stack-translate-11005.test.ts
 *
 * #11005: títulos do post semanal da Stack sempre em português. A tradução é
 * feita pelo agente `stack-title-translator` (decisão do editor, briefing
 * 261025b) — aqui a chamada à LLM é SEMPRE mockada (`call` injetado).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  applyStackTitleTranslations,
  buildStackTitlePrompt,
  parseStackTitleResponse,
  stackTitleTranslationCandidates,
  translateCircleStackTitles,
  STACK_TITLE_TRANSLATOR_AGENT,
} from "../scripts/lib/circle-stack-translate.ts";
import { circleStackSelectionViolations, hasPortugueseSignal } from "../scripts/lib/circle-stack-select.ts";
import { parseAgentModelSpec } from "../scripts/lib/prompt-regression-eval.ts";
import type { CircleStackItem, CircleStackSelection } from "../scripts/lib/circle-stack-render.ts";
import { circleStackFreshTranslationBlockReason } from "../scripts/publish-circle-stack.ts";

const ROOT = resolve(import.meta.dirname, "..");

const item = (over: Partial<CircleStackItem>): CircleStackItem => ({
  editionDate: "261020",
  url: "https://example.com/x",
  title: "Título",
  body: "Descrição em português.",
  why: "",
  ...over,
});

const MERCURY = item({
  url: "https://www.inceptionlabs.ai/blog/mercury-3",
  title: "Diffusion at Scale: Introducing Mercury 3",
  titleOriginal: "Diffusion at Scale: Introducing Mercury 3",
  body: "A Inception lançou o Mercury 3, LLM de difusão.",
});
const NOTES = item({ url: "https://openai.com/codex-notes", title: "Codex Launch Notes" });
const PT_DESTAQUE = item({ url: "https://g1.globo.com/a", title: "Claude for Chrome chega ao Brasil" });

function sel(over: Partial<CircleStackSelection> = {}): CircleStackSelection {
  return {
    cycle: "26w43",
    contentWindow: ["261020", "261024"],
    destaques: [PT_DESTAQUE],
    lancamentos: [MERCURY],
    useMelhor: [],
    radar: [NOTES],
    weeklyEditions: [],
    ...over,
  };
}

const okResponse = JSON.stringify({
  items: [
    { url: MERCURY.url, titlePt: "Inception lança o Mercury 3, LLM de difusão" },
    { url: NOTES.url, titlePt: "Notas de lançamento do Codex" },
  ],
});

describe("#11005 — candidatos à tradução", () => {
  it("envia só título sem sinal de português, inclusive sem palavra funcional do inglês", () => {
    const urls = stackTitleTranslationCandidates(sel()).map((c) => c.url);
    assert.deepEqual(urls, [MERCURY.url, NOTES.url]);
  });

  it("título já em português (ou reescrito à mão) não vai ao agente", () => {
    assert.equal(hasPortugueseSignal("Inception lança o Mercury 3"), true);
    assert.equal(hasPortugueseSignal("Codex Launch Notes"), false);
    const s = sel({ lancamentos: [{ ...MERCURY, title: "Inception lança o Mercury 3" }], radar: [] });
    assert.deepEqual(stackTitleTranslationCandidates(s), []);
  });

  it("mesma URL em duas seções vai uma vez só", () => {
    const s = sel({ radar: [NOTES, { ...NOTES }], useMelhor: [NOTES] });
    assert.equal(stackTitleTranslationCandidates(s).filter((c) => c.url === NOTES.url).length, 1);
  });
});

describe("#11005 — validação da resposta do agente", () => {
  const items = stackTitleTranslationCandidates(sel());

  it("aceita JSON completo (inclusive cercado por bloco de código)", () => {
    const m = parseStackTitleResponse("```json\n" + okResponse + "\n```", items);
    assert.equal(m.get(MERCURY.url), "Inception lança o Mercury 3, LLM de difusão");
  });

  it("recusa título que ainda parece inglês", () => {
    const bad = JSON.stringify({ items: [{ url: MERCURY.url, titlePt: "Introducing Mercury 3 for the world" }, { url: NOTES.url, titlePt: "Notas do Codex" }] });
    assert.throws(() => parseStackTitleResponse(bad, items), /ainda em inglês/);
  });

  it("recusa item faltando, URL estranha, repetida, vazio, markdown ou seta", () => {
    const one = JSON.stringify({ items: [{ url: MERCURY.url, titlePt: "Inception lança o Mercury 3" }] });
    assert.throws(() => parseStackTitleResponse(one, items), /faltou tradução/);
    const extra = JSON.stringify({ items: [{ url: "https://outra.com", titlePt: "Algo novo" }] });
    assert.throws(() => parseStackTitleResponse(extra, items), /fora da entrada/);
    const dup = JSON.stringify({ items: [{ url: NOTES.url, titlePt: "Notas do Codex" }, { url: NOTES.url, titlePt: "Notas do Codex" }] });
    assert.throws(() => parseStackTitleResponse(dup, items), /repetida/);
    const empty = JSON.stringify({ items: [{ url: MERCURY.url, titlePt: "  " }] });
    assert.throws(() => parseStackTitleResponse(empty, items), /vazio/);
    const md = JSON.stringify({ items: [{ url: MERCURY.url, titlePt: "**Mercury 3** chega" }] });
    assert.throws(() => parseStackTitleResponse(md, items), /markdown/);
    const arrow = JSON.stringify({ items: [{ url: MERCURY.url, titlePt: "Mercury 3 → difusão" }] });
    assert.throws(() => parseStackTitleResponse(arrow, items), /seta/);
    assert.throws(() => parseStackTitleResponse("não sei", items), /sem JSON/);
  });
});

describe("#11005 — gravação na seleção", () => {
  it("troca title, guarda o original em titleOriginal e não mexe no resto", () => {
    const m = new Map([[NOTES.url, "Notas de lançamento do Codex"]]);
    const { selection, changed } = applyStackTitleTranslations(sel(), m);
    assert.equal(selection.radar[0].title, "Notas de lançamento do Codex");
    assert.equal(selection.radar[0].titleOriginal, "Codex Launch Notes");
    assert.equal(selection.lancamentos[0].title, MERCURY.title);
    assert.deepEqual(changed, [{ from: "Codex Launch Notes", to: "Notas de lançamento do Codex" }]);
  });
});

describe("#11005 — translateCircleStackTitles (LLM mockada)", () => {
  it("cenário 26w43: Mercury 3 sai em português, guard passa, editor recebe aviso de revisão", () => {
    const calls: { prompt: string; model?: string; effort?: string }[] = [];
    const r = translateCircleStackTitles(sel(), {
      rootDir: ROOT,
      call: (prompt, opts) => {
        calls.push({ prompt, model: opts.model, effort: opts.effort });
        return okResponse;
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "claude-opus-5-5");
    assert.equal(calls[0].effort, "low");
    assert.match(calls[0].prompt, /Diffusion at Scale: Introducing Mercury 3/);
    assert.doesNotMatch(calls[0].prompt, /Claude for Chrome chega ao Brasil/);
    assert.equal(r.failed, false);
    assert.equal(r.translated, 2);
    assert.equal(r.selection.lancamentos[0].title, "Inception lança o Mercury 3, LLM de difusão");
    assert.equal(r.selection.lancamentos[0].titleOriginal, MERCURY.title);
    assert.equal(r.warnings.length, 2);
    assert.match(r.warnings[0], /revisar/);
    // antes da tradução o guard do --publish recusava; depois, passa
    assert.ok(circleStackSelectionViolations(sel()).some((v) => v.includes("Mercury 3")));
    assert.deepEqual(circleStackSelectionViolations(r.selection), []);
  });

  it("sem candidato, não chama a LLM", () => {
    let called = false;
    const r = translateCircleStackTitles(sel({ lancamentos: [], radar: [] }), {
      rootDir: ROOT,
      call: () => {
        called = true;
        return "";
      },
    });
    assert.equal(called, false);
    assert.equal(r.translated, 0);
  });

  it("falha da LLM mantém os títulos originais e vira aviso (o guard segue barrando)", () => {
    const r = translateCircleStackTitles(sel(), {
      rootDir: ROOT,
      call: () => {
        throw new Error("claude CLI falhou (status 1)");
      },
    });
    assert.equal(r.failed, true);
    assert.equal(r.selection.lancamentos[0].title, MERCURY.title);
    assert.match(r.warnings[0], /falhou/);
    assert.ok(circleStackSelectionViolations(r.selection).length > 0);
  });

  it("resposta inválida não aproveita metade", () => {
    const r = translateCircleStackTitles(sel(), {
      rootDir: ROOT,
      call: () => JSON.stringify({ items: [{ url: NOTES.url, titlePt: "Notas do Codex" }] }),
    });
    assert.equal(r.failed, true);
    assert.equal(r.selection.radar[0].title, NOTES.title);
  });
});

describe("#11005 — gate de revisão e agente", () => {
  it("--publish que traduziu na mesma execução recusa; seleção já revisada passa", () => {
    assert.match(circleStackFreshTranslationBlockReason(2, "sel.json") ?? "", /ainda não foram revisados/);
    assert.equal(circleStackFreshTranslationBlockReason(0, "sel.json"), null);
  });

  it("agente com model pinado claude-opus-5-5 e effort low, prompt com os itens", () => {
    const md = readFileSync(join(ROOT, ".claude", "agents", `${STACK_TITLE_TRANSLATOR_AGENT}.md`), "utf8");
    assert.deepEqual(parseAgentModelSpec(md), { model: "claude-opus-5-5", effort: "low" });
    const p = buildStackTitlePrompt("Instrução.", [{ url: "u", title: "t", body: "b" }]);
    assert.match(p, /^Instrução\./);
    assert.match(p, /"url": "u"/);
  });
});
