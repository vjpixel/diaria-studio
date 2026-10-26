/**
 * test/circle-stack-stored-title-11161.test.ts
 *
 * #11161: seleção da Stack GRAVADA com título em inglês sem palavra funcional do
 * inglês ("Codex Launch Notes") — tradução falhou na prévia ou `--no-translate` —
 * passava no `--publish` seguinte, porque o guard `looksEnglishTitle` só pega
 * frase com "the/for/with...". Agora o `--publish` recusa título sem sinal de
 * português até o editor reescrever, rodar `--translate-titles` ou marcar
 * `"titleReviewed": true`. LLM e webhook sempre mockados.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { circleStackUnreviewedTitles } from "../scripts/lib/circle-stack-select.ts";
import { stackTitleTranslationCandidates } from "../scripts/lib/circle-stack-translate.ts";
import type { CircleStackItem } from "../scripts/lib/circle-stack-render.ts";
import {
  parseStoredCircleStackSelection,
  runCircleStack,
  type RunCircleStackDeps,
} from "../scripts/publish-circle-stack.ts";

const ROOT = resolve(import.meta.dirname, "..");

const item = (over: Partial<CircleStackItem>): CircleStackItem => ({
  editionDate: "261020",
  url: "https://example.com/x",
  title: "Título",
  body: "Descrição.",
  why: "",
  ...over,
});
const empty = { destaques: [], lancamentos: [], useMelhor: [], radar: [] };

describe("circleStackUnreviewedTitles (#11161)", () => {
  it("acusa título sem sinal de português e sem palavra funcional do inglês", () => {
    const v = circleStackUnreviewedTitles({ ...empty, radar: [item({ title: "Codex Launch Notes" })] });
    assert.equal(v.length, 1);
    assert.match(v[0], /^Radar: título sem sinal de português "Codex Launch Notes"/);
    assert.match(v[0], /titleReviewed/);
  });

  it("título em português, já acusado como inglês, ou confirmado pelo editor não entra", () => {
    assert.deepEqual(
      circleStackUnreviewedTitles({
        ...empty,
        destaques: [item({ url: "https://a.example/1", title: "Replit lança o Agent 4" })],
        lancamentos: [item({ url: "https://b.example/1", title: "Introducing the new Codex" })],
        radar: [item({ url: "https://c.example/1", title: "GPT-5.5", titleReviewed: true })],
      }),
      [],
    );
  });

  it("mesma URL em duas seções gera uma linha só", () => {
    const dup = item({ url: "https://d.example/1", title: "Codex Launch Notes" });
    assert.equal(circleStackUnreviewedTitles({ ...empty, destaques: [dup], radar: [dup] }).length, 1);
  });

  it("título confirmado não vai de novo ao tradutor", () => {
    const sel = {
      ...empty,
      radar: [
        item({ url: "https://e.example/1", title: "GPT-5.5", titleReviewed: true }),
        item({ url: "https://f.example/1", title: "Codex Launch Notes" }),
      ],
    };
    assert.deepEqual(stackTitleTranslationCandidates(sel).map((c) => c.url), ["https://f.example/1"]);
  });
});

describe("parseStoredCircleStackSelection — titleReviewed (#11161)", () => {
  const base = { cycle: "26w44", contentWindow: [], weeklyEditions: [], destaques: [], lancamentos: [], useMelhor: [], radar: [] };
  it("aceita booleano e recusa outro tipo", () => {
    const ok = JSON.stringify({ ...base, radar: [{ ...item({}), titleReviewed: true }] });
    assert.equal(parseStoredCircleStackSelection(ok, "/x.json", "26w44").selection.radar[0].titleReviewed, true);
    const bad = JSON.stringify({ ...base, radar: [{ ...item({}), titleReviewed: "sim" }] });
    assert.throws(() => parseStoredCircleStackSelection(bad, "/x.json", "26w44"), /titleReviewed precisa ser true ou false/);
  });
});

describe("#11161 — runCircleStack com seleção gravada (LLM e webhook mockados)", () => {
  const CODEX_URL = "https://openai.com/index/codex-launch-notes";
  const EDITION_MD = [
    "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
    "",
    "**[Cursor lança agentes em segundo plano para programação](https://cursor.com/blog/background-agents)**",
    "",
    "O Cursor passou a rodar agentes de programação em segundo plano.",
    "",
    "Por que isso importa:",
    "",
    "Quem constrói produto ganha um agente que trabalha sozinho.",
    "",
    "---",
    "",
    "**🚀 LANÇAMENTOS**",
    "",
    `**[Codex Launch Notes](${CODEX_URL})**`,
    "A OpenAI publicou as notas do Codex com agentes de programação na nuvem.",
    "",
  ].join("\n");

  function setup() {
    const dataRoot = mkdtempSync(join(tmpdir(), "circle-stack-11161-"));
    const dir = join(dataRoot, "data", "editions", "261020");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), EDITION_MD, "utf8");
    const selectionPath = join(dataRoot, "data", "weekly", "26w43", "_internal", "circle-stack-selection.json");
    const sent: string[] = [];
    const deps = (translateCall: RunCircleStackDeps["translateCall"]): RunCircleStackDeps => ({
      rootDir: ROOT,
      platformConfig: { circle_stack: { enabled: true } },
      env: { STACK_WEBHOOK_URL: "https://webhook.example.test/stack", STACK_WEBHOOK_KEY: "chave-de-teste" },
      translateCall,
      send: async (_u, _k, payload) => {
        sent.push(JSON.stringify(payload));
      },
      ghRun: () => ({ status: 0, stdout: "[]", stderr: "" }),
    });
    const base = ["--publish-monday", "261026", "--data-root", dataRoot];
    return { selectionPath, sent, deps, base };
  }

  const fail: RunCircleStackDeps["translateCall"] = () => {
    throw new Error("claude CLI excedeu o timeout de 180000ms");
  };

  it("prévia com tradução falha grava o título em inglês; o --publish seguinte recusa e não envia", async () => {
    const t = setup();
    await runCircleStack(t.base, t.deps(fail));
    const stored = JSON.parse(readFileSync(t.selectionPath, "utf8"));
    assert.equal(stored.lancamentos[0].title, "Codex Launch Notes");
    await assert.rejects(runCircleStack([...t.base, "--publish"], t.deps(fail)), /sem sinal de português "Codex Launch Notes"/);
    assert.deepEqual(t.sent, []);
  });

  it("prévia com --no-translate: o --publish seguinte também recusa", async () => {
    const t = setup();
    await runCircleStack([...t.base, "--no-translate"], t.deps(fail));
    await assert.rejects(runCircleStack([...t.base, "--publish"], t.deps(fail)), /titleReviewed/);
    assert.deepEqual(t.sent, []);
  });

  it("dry-run sobre a seleção gravada mostra o aviso", async () => {
    const t = setup();
    await runCircleStack([...t.base, "--no-translate"], t.deps(fail));
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.join(" "));
    };
    try {
      await runCircleStack(t.base, t.deps(fail));
    } finally {
      console.warn = origWarn;
    }
    assert.ok(warns.some((w) => /sem sinal de português "Codex Launch Notes"/.test(w)));
  });

  it("editor marca titleReviewed: o --publish envia", async () => {
    const t = setup();
    await runCircleStack([...t.base, "--no-translate"], t.deps(fail));
    const stored = JSON.parse(readFileSync(t.selectionPath, "utf8"));
    stored.lancamentos[0].titleReviewed = true;
    writeFileSync(t.selectionPath, JSON.stringify(stored));
    await runCircleStack([...t.base, "--publish"], t.deps(fail));
    assert.equal(t.sent.length, 1);
  });

  it("--translate-titles sobre a seleção gravada destrava o --publish seguinte", async () => {
    const t = setup();
    await runCircleStack([...t.base, "--no-translate"], t.deps(fail));
    const translate: RunCircleStackDeps["translateCall"] = () =>
      JSON.stringify({ items: [{ url: CODEX_URL, titlePt: "OpenAI publica as notas de lançamento do Codex" }] });
    await runCircleStack([...t.base, "--translate-titles"], t.deps(translate));
    await runCircleStack([...t.base, "--publish"], t.deps(fail));
    assert.equal(t.sent.length, 1);
    assert.match(t.sent[0], /OpenAI publica as notas de lançamento do Codex/);
  });
});
