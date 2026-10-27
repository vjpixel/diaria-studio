/**
 * test/circle-stack-copy-11184.test.ts (#11184, #11237 item 2)
 *
 * Skill `/diaria-stack`: texto próprio do post semanal da Stack (abertura +
 * descrição dos itens de lista), escrito pelo agente `stack-writer` e gravado
 * na seleção por `scripts/circle-stack-copy.ts`.
 *   - insumo do agente: só itens de lista, ferramenta de curso pela fonte oficial;
 *   - validação recusa o arquivo inteiro (item faltando, URL a mais, ciclo
 *     errado, markdown, seta, URL, emoji, "agentivo", acima do teto);
 *   - aplicação grava opening/stackNote e o render passa a usar o texto novo;
 *   - CLI --apply não toca a seleção quando o texto é recusado;
 *   - a prévia do publicador mostra o `payload.titulo` real (#11237).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyStackCopy,
  buildStackWriterInput,
  parseStackCopy,
  stackCopyTextProblems,
  stackCourseTool,
  STACK_COPY_NOTE_MAX_CHARS,
} from "../scripts/lib/circle-stack-copy.ts";
import { renderCircleStackPost, type CircleStackItem, type CircleStackSelection } from "../scripts/lib/circle-stack-render.ts";
import { buildStackPostPayload } from "../scripts/lib/stack-webhook.ts";
import { circleStackPreviewTitle, runCircleStack } from "../scripts/publish-circle-stack.ts";
import { runCircleStackCopy, circleStackCopyPaths } from "../scripts/circle-stack-copy.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const item = (over: Partial<CircleStackItem>): CircleStackItem => ({
  editionDate: "261020", url: "https://ex.com/x", title: "Título", body: "Corpo da newsletter.", why: "", ...over,
});

const sel = (): CircleStackSelection => ({
  cycle: "26w44",
  contentWindow: ["261019", "261020", "261021", "261022", "261023"],
  destaques: [item({ url: "https://www.anthropic.com/news/x", title: "Anthropic lança X", body: "A Anthropic lançou o X.", why: "Importa." })],
  lancamentos: [item({ url: "https://blog.n8n.io/n8n-2", title: "n8n 2.0 sai com agentes", body: "O n8n lançou a versão 2." })],
  useMelhor: [item({ url: "https://code.claude.com/docs/en/changelog", title: "Novidades do Claude Code", body: "Changelog." })],
  radar: [item({ url: "https://news.example.com/estudo", title: "Estudo mede uso de IA", body: "Um estudo." })],
  weeklyEditions: [],
});

const goodCopy = (s: CircleStackSelection) => ({
  cycle: s.cycle,
  opening: "Semana boa para quem automatiza: o n8n ganhou agentes nativos e o Claude Code mudou o fluxo de revisão.",
  notes: [
    { url: "https://blog.n8n.io/n8n-2", stackNote: "Dá para montar o agente direto no fluxo, sem nó externo." },
    { url: "https://code.claude.com/docs/en/changelog", stackNote: "Vale reler o changelog antes de atualizar o projeto." },
    { url: "https://news.example.com/estudo", stackNote: "O número ajuda a calibrar o que prometer ao cliente." },
  ],
});

describe("stackCourseTool (#10952)", () => {
  it("reconhece as fontes oficiais das ferramentas dos cursos", () => {
    assert.equal(stackCourseTool("https://blog.n8n.io/n8n-2"), "n8n");
    assert.equal(stackCourseTool("https://docs.lovable.dev/changelog"), "Lovable");
    assert.equal(stackCourseTool("https://lovable.dev/blog/novidade"), "Lovable");
    assert.equal(stackCourseTool("https://www.cursor.com/changelog/1-9"), "Cursor");
    assert.equal(stackCourseTool("https://code.claude.com/docs/en/changelog"), "Claude Code");
    assert.equal(stackCourseTool("https://github.com/anthropics/claude-code/releases/tag/v2.1.0"), "Claude Code");
    assert.equal(stackCourseTool("https://replit.com/blog/agent-4"), "Replit");
  });
  it("página de app/preço/terceiro não conta", () => {
    assert.equal(stackCourseTool("https://n8n.io/pricing"), null);
    assert.equal(stackCourseTool("https://lovable.dev/projects/abc"), null);
    assert.equal(stackCourseTool("https://replit.com/@user/app"), null);
    assert.equal(stackCourseTool("https://techcrunch.com/n8n"), null);
    assert.equal(stackCourseTool("não é url"), null);
  });
});

describe("buildStackWriterInput", () => {
  it("só itens de lista viram itens a escrever; destaques entram como contexto", () => {
    const input = buildStackWriterInput(sel(), "/tmp/copy.json");
    assert.deepEqual(input.items.map((i) => i.section), ["lancamentos", "useMelhor", "radar"]);
    assert.equal(input.items[0].tool, "n8n");
    assert.equal(input.items[2].tool, null);
    assert.equal(input.destaques.length, 1);
    assert.equal(input.copyPath, "/tmp/copy.json");
    assert.equal(input.currentOpening, null);
  });
  it("URL repetida entre seções entra uma vez; texto anterior vem como current*", () => {
    const s = sel();
    s.radar.push(item({ url: "https://blog.n8n.io/n8n-2" }));
    s.lancamentos[0].stackNote = "Nota anterior.";
    s.opening = "Abertura anterior.";
    const input = buildStackWriterInput(s, "x");
    assert.equal(input.items.filter((i) => i.url === "https://blog.n8n.io/n8n-2").length, 1);
    assert.equal(input.items[0].currentNote, "Nota anterior.");
    assert.equal(input.currentOpening, "Abertura anterior.");
  });
});

describe("stackCopyTextProblems", () => {
  it("texto limpo passa", () => {
    assert.deepEqual(stackCopyTextProblems("Dá para montar o agente no fluxo.", 240), []);
  });
  for (const [label, text] of [
    ["seta", "Veja o novo recurso → agora"],
    ["markdown negrito", "Um **recurso** novo"],
    ["markdown lista", "- item"],
    ["link markdown", "Veja [aqui](https://x.com)"],
    ["URL", "Mais em https://x.com"],
    ["agentivo", "Um fluxo agentivo"],
    ["emoji", "Novidade 🚀"],
  ] as const) {
    it(`recusa ${label}`, () => {
      assert.ok(stackCopyTextProblems(text, 240).length > 0, text);
    });
  }
  it("recusa vazio e acima do teto", () => {
    assert.deepEqual(stackCopyTextProblems("  ", 240), ["vazio"]);
    assert.match(stackCopyTextProblems("a".repeat(STACK_COPY_NOTE_MAX_CHARS + 1), STACK_COPY_NOTE_MAX_CHARS)[0], /teto/);
  });
});

describe("parseStackCopy", () => {
  it("cópia completa passa e sai normalizada", () => {
    const c = goodCopy(sel());
    c.opening = `  ${c.opening}  `;
    const { copy, problems } = parseStackCopy(JSON.stringify(c), sel());
    assert.deepEqual(problems, []);
    assert.equal(copy?.opening, c.opening.trim());
    assert.equal(copy?.notes.length, 3);
  });
  it("recusa tudo: item faltando, URL a mais, URL repetida, ciclo errado", () => {
    const c = goodCopy(sel());
    c.cycle = "26w43";
    c.notes = [c.notes[0], c.notes[0], { url: "https://outra.com", stackNote: "Texto." }];
    const { copy, problems } = parseStackCopy(JSON.stringify(c), sel());
    assert.equal(copy, null);
    const all = problems.join("\n");
    assert.match(all, /ciclo/);
    assert.match(all, /repetida/);
    assert.match(all, /fora dos itens/);
    assert.match(all, /sem stackNote para https:\/\/code\.claude\.com/);
  });
  it("não aceita stackNote para destaque (o render o ignoraria)", () => {
    const c = goodCopy(sel());
    c.notes.push({ url: "https://www.anthropic.com/news/x", stackNote: "Texto." });
    assert.equal(parseStackCopy(JSON.stringify(c), sel()).copy, null);
  });
  it("JSON ilegível e shape errado viram problema, não exceção", () => {
    assert.match(parseStackCopy("{", sel()).problems[0], /ilegível/);
    assert.match(parseStackCopy("[]", sel()).problems[0], /objeto/);
  });
});

describe("applyStackCopy + render", () => {
  it("o post passa a usar a abertura e as descrições próprias; destaques ficam como na diária", () => {
    const s = sel();
    const applied = applyStackCopy(s, goodCopy(s));
    const md = renderCircleStackPost(applied).markdown;
    assert.ok(md.startsWith(goodCopy(s).opening), md.slice(0, 120));
    assert.match(md, /n8n 2\.0 sai com agentes\]\(https:\/\/blog\.n8n\.io\/n8n-2\): Dá para montar o agente/);
    assert.doesNotMatch(md, /O n8n lançou a versão 2\./);
    assert.match(md, /A Anthropic lançou o X\./);
    assert.doesNotMatch(md, /→/);
  });
  it("não muta a seleção de entrada e recusa ciclo diferente", () => {
    const s = sel();
    applyStackCopy(s, goodCopy(s));
    assert.equal(s.opening, undefined);
    assert.throws(() => applyStackCopy(s, { ...goodCopy(s), cycle: "26w01" }), /ciclo/);
  });
});

describe("CLI circle-stack-copy.ts", () => {
  function setup(): { root: string; selectionPath: string; copyPath: string } {
    const root = mkdtempSync(join(tmpdir(), "stack-copy-"));
    const p = circleStackCopyPaths(root, "261102");
    mkdirSync(dirname(p.selectionPath), { recursive: true });
    const s = { ...sel(), cycle: p.cycle, warnings: ["aviso preservado"], generatedAt: "2026-11-02T10:00:00Z" };
    writeFileSync(p.selectionPath, JSON.stringify(s, null, 2));
    return { root, selectionPath: p.selectionPath, copyPath: p.copyPath };
  }

  it("--apply grava opening/stackNote e preserva os outros campos", async () => {
    const { root, selectionPath, copyPath } = setup();
    try {
      const stored = JSON.parse(readFileSync(selectionPath, "utf8"));
      writeFileSync(copyPath, JSON.stringify({ ...goodCopy(stored), cycle: stored.cycle }));
      const code = await runCircleStackCopy(["--publish-monday", "261102", "--apply", "--data-root", root], root);
      assert.equal(code, 0);
      const after = JSON.parse(readFileSync(selectionPath, "utf8"));
      assert.equal(after.opening, goodCopy(stored).opening);
      assert.equal(after.lancamentos[0].stackNote, "Dá para montar o agente direto no fluxo, sem nó externo.");
      assert.deepEqual(after.warnings, ["aviso preservado"]);
      assert.equal(after.generatedAt, "2026-11-02T10:00:00Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--apply com texto recusado sai 1 e não toca a seleção", async () => {
    const { root, selectionPath, copyPath } = setup();
    try {
      const before = readFileSync(selectionPath, "utf8");
      const stored = JSON.parse(before);
      const bad = goodCopy(stored);
      bad.notes[0].stackNote = "Veja → agora";
      writeFileSync(copyPath, JSON.stringify(bad));
      const code = await runCircleStackCopy(["--publish-monday", "261102", "--apply", "--data-root", root], root);
      assert.equal(code, 1);
      assert.equal(readFileSync(selectionPath, "utf8"), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem seleção gravada, aponta o dry-run do publicador", async () => {
    const root = mkdtempSync(join(tmpdir(), "stack-copy-"));
    try {
      await assert.rejects(
        runCircleStackCopy(["--publish-monday", "261102", "--manifest", "--data-root", root], root),
        /publish-circle-stack\.ts --publish-monday 261102/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prévia mostra o payload.titulo real (#11237 item 2)", () => {
  it("título sem `<` sai igual; com `<` mostra o escapado e o original", () => {
    assert.equal(circleStackPreviewTitle("Modelo novo", buildStackPostPayload("Modelo novo", "c")), "Modelo novo");
    const t = circleStackPreviewTitle("Modelo < 1B supera GPT", buildStackPostPayload("Modelo < 1B supera GPT", "c"));
    assert.match(t, /^Modelo \\< 1B supera GPT \(/);
    assert.match(t, /sem escape: Modelo < 1B supera GPT\)$/);
  });

  it("dry-run grava o título escapado no cabeçalho da prévia", async () => {
    const root = mkdtempSync(join(tmpdir(), "stack-preview-"));
    try {
      const p = circleStackCopyPaths(root, "261102");
      mkdirSync(dirname(p.selectionPath), { recursive: true });
      const s = sel();
      s.cycle = p.cycle;
      s.destaques[0].title = "Modelo < 1B supera GPT";
      writeFileSync(p.selectionPath, JSON.stringify(s, null, 2));
      const logs: string[] = [];
      const origLog = console.log;
      const origWarn = console.warn;
      console.log = (...a: unknown[]) => logs.push(a.join(" "));
      console.warn = () => {};
      try {
        await runCircleStack(["--publish-monday", "261102", "--data-root", root], {
          rootDir: ROOT,
          platformConfig: {},
          env: {},
          translateCall: () => {
            throw new Error("tradução não deveria rodar com seleção gravada");
          },
          send: async () => {
            throw new Error("dry-run não envia");
          },
        });
      } finally {
        console.log = origLog;
        console.warn = origWarn;
      }
      const md = readFileSync(join(dirname(dirname(p.selectionPath)), `circle-stack-${p.cycle}.md`), "utf8");
      assert.match(md.split("\n")[0], /^# Modelo \\< 1B supera GPT \(título enviado ao webhook; sem escape: Modelo < 1B supera GPT\)$/);
      assert.ok(logs.some((l) => l.startsWith("[dry-run] Modelo \\< 1B")), logs.join("\n"));
      assert.ok(existsSync(join(dirname(p.selectionPath), "circle-stack-payload.json")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
