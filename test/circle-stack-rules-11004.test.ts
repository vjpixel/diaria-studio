/**
 * test/circle-stack-rules-11004.test.ts
 *
 * Regras do post semanal da Stack e resíduos do fleet review do #10904:
 *   - #11004: Lançamentos e Use melhor só com link do site do fabricante
 *     (seleção filtra/rebaixa; seleção editada à mão é recusada no publish).
 *   - #11005: títulos em português (heurística + recusa nomeando o item).
 *   - #10977: lock O_EXCL do --publish, marcador do --hello, guard de data/ na
 *     task, escape de `<` solto no payload.
 *
 * Arquivo separado de `circle-stack.test.ts` para não colidir com a PR #10999,
 * que reescreve o bloco de render daquele arquivo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isManufacturerUrl, MANUFACTURER_DOCS_PATTERNS } from "../scripts/lib/official-domains.ts";
import { isOfficialLancamentoUrl } from "../scripts/lib/launch-heuristics.ts";
import {
  circleStackSelectionViolations,
  looksEnglishTitle,
  selectCircleStack,
} from "../scripts/lib/circle-stack-select.ts";
import type { WeeklyRawCandidate } from "../scripts/lib/weekly-linkedin-parse.ts";
import type { CircleStackItem } from "../scripts/lib/circle-stack-render.ts";
import {
  acquireCircleStackPublishLock,
  circleStackHelloMarkerPath,
  circleStackPublishLockPath,
  parseStoredCircleStackSelection,
  publishCircleStackCycle,
  publishCircleStackHello,
} from "../scripts/publish-circle-stack.ts";
import { buildStackPostPayload, escapeLooseAngleBrackets } from "../scripts/lib/stack-webhook.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";

const cand = (over: Partial<WeeklyRawCandidate>): WeeklyRawCandidate => ({
  editionDate: "261020",
  url: `https://ex.com/${Math.random()}`,
  title: "Título neutro",
  body: "Corpo neutro.",
  why: "",
  kind: "section",
  category: "RADAR",
  section: "radar",
  ...over,
});

const item = (over: Partial<CircleStackItem> = {}): CircleStackItem => ({
  editionDate: "261020",
  url: "https://blog.replit.com/agent-4",
  title: "Replit lança o Agent 4",
  body: "Descrição.",
  why: "",
  ...over,
});

describe("isManufacturerUrl (#11004)", () => {
  it("central de ajuda da Anthropic passa (item do Cowork, ciclo 26w43) — allowlist, não o conteúdo (#7401)", () => {
    assert.equal(isManufacturerUrl("https://support.claude.com/en/articles/123-cowork"), true);
  });
  it("help.openai.com, support.google.com e docs das ferramentas da Stack passam", () => {
    for (const u of [
      "https://help.openai.com/en/articles/1",
      "https://support.google.com/gemini/answer/1",
      "https://docs.n8n.io/workflows/",
      "https://docs.lovable.dev/features/agent",
      "https://www.cursor.com/docs/agent",
    ]) {
      assert.equal(isManufacturerUrl(u), true, u);
    }
  });
  it("registro de lançamento (#160) continua valendo: blog oficial passa", () => {
    assert.equal(isManufacturerUrl("https://www.anthropic.com/news/claude-x"), true);
    assert.equal(isManufacturerUrl("https://mistral.ai/news/x"), true);
  });
  it("imprensa, blog pessoal e URL inválida não passam", () => {
    assert.equal(isManufacturerUrl("https://canaltech.com.br/ia/gemini-ganha-menu-para-conectar-apps/"), false);
    assert.equal(isManufacturerUrl("https://fulano.substack.com/p/claude"), false);
    assert.equal(isManufacturerUrl("not a url"), false);
  });
  it("docs/ajuda NÃO entram no registro de lançamento da diária (categorize não muda)", () => {
    assert.equal(isOfficialLancamentoUrl("https://support.claude.com/en/articles/123-cowork"), false);
    assert.ok(MANUFACTURER_DOCS_PATTERNS.length > 0);
  });
});

describe("selectCircleStack — só link do fabricante em Lançamentos/Use melhor (#11004)", () => {
  it("item de imprensa sai de Lançamentos e de Use melhor; oficial fica", () => {
    const picks = selectCircleStack([
      cand({ kind: "destaque", section: "destaque", title: "Cursor ganha agentes" }),
      cand({ url: "https://canaltech.com.br/ia/gemini-apps", section: "lancamentos", title: "Gemini ganha apps para agentes" }),
      cand({ url: "https://blog.replit.com/agent-4", section: "lancamentos", title: "Replit Agent 4" }),
      cand({ url: "https://tecnoblog.net/n8n-dicas", section: "use_melhor", title: "Dicas de n8n" }),
      cand({ url: "https://support.claude.com/en/articles/1", section: "use_melhor", title: "Claude Code no Cowork" }),
    ]);
    assert.deepEqual(picks.lancamentos.map((c) => c.title), ["Replit Agent 4"]);
    assert.deepEqual(picks.useMelhor.map((c) => c.title), ["Claude Code no Cowork"]);
  });
  it("o item rebaixado pode ir para o Radar, sem o bônus da seção de origem e respeitando o teto", () => {
    const picks = selectCircleStack(
      [
        cand({ kind: "destaque", section: "destaque", title: "Eleição" }),
        cand({ url: "https://canaltech.com.br/ia/gemini-apps", section: "lancamentos", title: "Gemini ganha apps para agentes" }),
        cand({ url: "https://tecnoblog.net/x", section: "lancamentos", title: "Modelo de imagem" }),
      ],
      { caps: { destaques: 1, lancamentos: 4, useMelhor: 3, radar: 4 } },
    );
    const radar = picks.radar.map((c) => c.title);
    assert.ok(radar.includes("Gemini ganha apps para agentes"), radar.join(" | "));
    // "Modelo de imagem" só tinha o bônus de seção (2) — sem ele, score 0, fica fora.
    assert.ok(!radar.includes("Modelo de imagem"), radar.join(" | "));
    const g = picks.radar.find((c) => c.title === "Gemini ganha apps para agentes");
    assert.equal(g?.score, 3 * 2 + 2 * 2, "agentes (3) + app (2), título em dobro, sem o +2 de lançamento");

    const capped = selectCircleStack(
      [
        cand({ url: "https://canaltech.com.br/a", section: "lancamentos", title: "Agentes A" }),
        cand({ url: "https://canaltech.com.br/b", section: "lancamentos", title: "Agentes B" }),
      ],
      { caps: { destaques: 0, lancamentos: 4, useMelhor: 3, radar: 1 } },
    );
    assert.equal(capped.radar.length, 1);
  });
});

describe("looksEnglishTitle (#11005)", () => {
  it("frase em inglês é detectada", () => {
    for (const t of ["Diffusion at Scale: Introducing Mercury 3", "How to build agents with the SDK", "Claude for your team"]) {
      assert.equal(looksEnglishTitle(t), true, t);
    }
  });
  it("título em português com nome de produto em inglês passa", () => {
    for (const t of [
      "Inception lança o Mercury 3, LLM de difusão",
      "Claude for Chrome chega ao Brasil",
      "Nemotron e Claude Cowork viram padrão",
      "Mercury 3",
    ]) {
      assert.equal(looksEnglishTitle(t), false, t);
    }
  });
});

describe("circleStackSelectionViolations (#11004, #11005)", () => {
  const empty = { destaques: [], lancamentos: [], useMelhor: [], radar: [] };
  it("seleção limpa não tem violação", () => {
    assert.deepEqual(circleStackSelectionViolations({ ...empty, lancamentos: [item()], radar: [item({ url: "https://canaltech.com.br/x" })] }), []);
  });
  it("link não oficial em Lançamentos/Use melhor nomeia seção e item; no Radar é permitido", () => {
    const v = circleStackSelectionViolations({
      ...empty,
      lancamentos: [item({ title: "Gemini ganha menu", url: "https://canaltech.com.br/ia/x" })],
      useMelhor: [item({ title: "Dicas", url: "https://tecnoblog.net/y" })],
    });
    assert.equal(v.length, 2);
    assert.match(v[0], /^Lançamentos: "Gemini ganha menu".*canaltech/);
    assert.match(v[1], /^Use melhor: "Dicas"/);
  });
  it("título em inglês em qualquer seção nomeia o item", () => {
    const v = circleStackSelectionViolations({ ...empty, radar: [item({ title: "Introducing Mercury 3" })] });
    assert.equal(v.length, 1);
    assert.match(v[0], /^Radar: título em inglês "Introducing Mercury 3"/);
  });
});

describe("parseStoredCircleStackSelection — titleOriginal (#11005)", () => {
  const base = {
    cycle: "26w44",
    contentWindow: ["261019"],
    weeklyEditions: [],
    destaques: [item()],
    lancamentos: [],
    useMelhor: [],
    radar: [],
  };
  it("aceita titleOriginal texto e recusa não-texto", () => {
    const ok = JSON.stringify({ ...base, destaques: [{ ...item(), titleOriginal: "Introducing Agent 4" }] });
    assert.doesNotThrow(() => parseStoredCircleStackSelection(ok, "/x.json", "26w44"));
    const bad = JSON.stringify({ ...base, destaques: [{ ...item(), titleOriginal: 3 }] });
    assert.throws(() => parseStoredCircleStackSelection(bad, "/x.json", "26w44"), /titleOriginal não é texto/);
  });
});

describe("publishCircleStackCycle — lock O_EXCL contra --publish concorrente (#10977)", () => {
  const payload = buildStackPostPayload("Radar Stack", "corpo");
  const fresh = () => join(mkdtempSync(join(tmpdir(), "circle-stack-lock-")), "circle-stack-published.json");

  it("dois --publish simultâneos: só um chama send", async () => {
    const statePath = fresh();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = publishCircleStackCycle({
      statePath, cycle: "26w44", title: "T", payload, force: false,
      send: async () => { calls++; await gate; },
    });
    const second = publishCircleStackCycle({
      statePath, cycle: "26w44", title: "T", payload, force: false,
      send: async () => { calls++; },
    });
    await assert.rejects(second, /Outro --publish da Stack está em andamento/);
    release();
    await first;
    assert.equal(calls, 1);
    assert.equal(existsSync(circleStackPublishLockPath(statePath)), false, "lock liberado ao terminar");
  });

  it("lock é liberado mesmo quando o envio falha", async () => {
    const statePath = fresh();
    await assert.rejects(
      publishCircleStackCycle({ statePath, cycle: "26w44", title: "T", payload, force: false, send: async () => { throw new Error("timeout"); } }),
      /timeout/,
    );
    assert.equal(existsSync(circleStackPublishLockPath(statePath)), false);
  });

  it("lock que sobrou recusa sem tomar posse (nada é enviado)", async () => {
    const statePath = fresh();
    writeFileSync(circleStackPublishLockPath(statePath), "{}");
    let calls = 0;
    await assert.rejects(
      publishCircleStackCycle({ statePath, cycle: "26w44", title: "T", payload, force: true, send: async () => { calls++; } }),
      /apague o arquivo/,
    );
    assert.equal(calls, 0);
    assert.equal(existsSync(statePath), false, "nenhuma tentativa gravada");
  });

  it("acquire/release diretos", () => {
    const lock = `${fresh()}.lock`;
    const rel = acquireCircleStackPublishLock(lock);
    assert.throws(() => acquireCircleStackPublishLock(lock), /em andamento/);
    rel();
    acquireCircleStackPublishLock(lock)();
  });
});

describe("publishCircleStackHello — marcador contra 2º 'Olá, mundo' (#10977)", () => {
  const fixedNow = () => new Date("2026-10-26T10:00:00.000Z");
  it("1º envio grava marcador; 2º recusa sem --force; --force envia de novo", async () => {
    const root = mkdtempSync(join(tmpdir(), "circle-stack-hello-"));
    const markerPath = circleStackHelloMarkerPath(root);
    assert.equal(markerPath, join(root, "data", "weekly", "_internal", "circle-stack-hello.json"));
    let calls = 0;
    const send = async () => { calls++; };
    const r1 = await publishCircleStackHello({ markerPath, force: false, send, now: fixedNow });
    assert.equal(r1.forced, false);
    assert.deepEqual(JSON.parse(readFileSync(markerPath, "utf8")), {
      attempted_at: "2026-10-26T10:00:00.000Z",
      sent_at: "2026-10-26T10:00:00.000Z",
    });
    await assert.rejects(publishCircleStackHello({ markerPath, force: false, send }), /já foi enviado.*--force/);
    assert.equal(calls, 1);
    const r3 = await publishCircleStackHello({ markerPath, force: true, send });
    assert.equal(r3.forced, true);
    assert.equal(calls, 2);
  });
  it("envio que falha deixa o marcador da tentativa — o próximo recusa (o post pode ter saído)", async () => {
    const markerPath = circleStackHelloMarkerPath(mkdtempSync(join(tmpdir(), "circle-stack-hello-")));
    await assert.rejects(publishCircleStackHello({ markerPath, force: false, send: async () => { throw new Error("502"); } }), /502/);
    let calls = 0;
    await assert.rejects(publishCircleStackHello({ markerPath, force: false, send: async () => { calls++; } }), /já foi enviado/);
    assert.equal(calls, 0);
  });
});

describe("escape de `<` solto no payload (#10977)", () => {
  it("autolink vira URL nua; tag e `<` solto viram \\<; já escapado fica", () => {
    assert.equal(escapeLooseAngleBrackets("veja <https://ex.com/a> agora"), "veja https://ex.com/a agora");
    assert.equal(escapeLooseAngleBrackets("use <tag> e a<<b"), "use \\<tag> e a\\<\\<b");
    assert.equal(escapeLooseAngleBrackets("já \\<ok"), "já \\<ok");
  });
  it("texto da edição com `<tag>` não derruba mais a prévia", () => {
    assert.doesNotThrow(() => buildStackPostPayload("T", "O modelo <Mercury> chegou"));
  });
});

describe("task Diaria-Circle-Stack-Weekly-Preview — guard de data/ montado (#10977)", () => {
  it("aborta sem data/editions", () => {
    const task = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Circle-Stack-Weekly-Preview");
    assert.ok(task, "task registrada");
    assert.equal(task.guard?.requiredFile, "editions");
    assert.ok(!task.steps.some((s) => (s.args ?? []).includes("--publish")), "a task nunca publica");
  });
});
