/**
 * test/circle-stack-video-description-12549.test.ts (#12549 itens 4, 5 e 6)
 *
 * - Item 6 (decisão do editor, 10/11/2026): a descrição do vídeo da semana é
 *   escrita pelo `stack-writer` no mesmo `circle-stack-copy.json`
 *   (`videoDescription`), só com fatos do destaque que o vídeo comenta (D1 da
 *   edição do vídeo). Manifest traz o destaque; validação exige o campo quando
 *   há vídeo, recusa quando não há, recusa número fora do destaque; `--apply`
 *   grava em `video.description`; o render mostra.
 * - Item 5: conselho ao leitor ("Quem constrói X deveria ver", "precisa
 *   migrar", "Vale testar") é recusado mecanicamente.
 * - Itens 4 e 5 nos prompts dos agentes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  applyStackCopy,
  buildStackWriterInput,
  hasReaderAdvice,
  parseStackCopy,
  stackCopyTextProblems,
  unsourcedNumbers,
  videoDestaqueFromSelection,
  STACK_COPY_VIDEO_DESCRIPTION_MAX_CHARS,
} from "../scripts/lib/circle-stack-copy.ts";
import { renderCircleStackPost, type CircleStackItem, type CircleStackSelection } from "../scripts/lib/circle-stack-render.ts";
import { circleStackCopyPaths, runCircleStackCopy } from "../scripts/circle-stack-copy.ts";

const item = (over: Partial<CircleStackItem>): CircleStackItem => ({
  editionDate: "261103", url: "https://ex.com/x", title: "Título", body: "Corpo.", why: "", ...over,
});

const D1 = item({
  editionDate: "261104",
  url: "https://www.anthropic.com/news/claude-x",
  title: "Anthropic lança o Claude X com janela de 2 milhões de tokens",
  body: "O Claude X lê 2 milhões de tokens e custa 40% menos que o anterior.",
  why: "Projetos inteiros cabem numa conversa.",
  destaqueN: 1,
});

const VIDEO = { title: "Claude X comentado", url: "https://www.youtube.com/watch?v=abc", editionDate: "261104", views: 120 };

const sel = (over: Partial<CircleStackSelection> = {}): CircleStackSelection => ({
  cycle: "26w45",
  contentWindow: ["261102", "261103", "261104", "261105", "261106"],
  destaques: [D1],
  lancamentos: [item({ url: "https://blog.n8n.io/n8n-3", title: "n8n 3.0 em beta", body: "O n8n abriu o beta da versão 3." })],
  useMelhor: [],
  radar: [item({ url: "https://news.example.com/estudo", title: "Estudo mede uso de IA", body: "Um estudo." })],
  weeklyEditions: [],
  video: { ...VIDEO },
  ...over,
});

const copyFor = (s: CircleStackSelection, videoDescription?: string) => ({
  cycle: s.cycle,
  opening: "O Claude X chegou com janela maior. O n8n abriu o beta da versão 3.",
  notes: [
    { url: "https://blog.n8n.io/n8n-3", stackNote: "O beta já roda fluxos existentes." },
    { url: "https://news.example.com/estudo", stackNote: "O estudo mede o uso de IA no trabalho." },
  ],
  ...(videoDescription !== undefined ? { videoDescription } : {}),
});

const GOOD_DESC = "O Claude X lê 2 milhões de tokens e custa 40% menos que o modelo anterior da Anthropic.";

describe("#12549 item 6 — manifest do stack-writer leva o vídeo e o destaque comentado", () => {
  it("D1 da edição do vídeo vem da seleção (destaques ou lista)", () => {
    assert.equal(videoDestaqueFromSelection(sel())?.url, D1.url);
    const noRadar = sel({ destaques: [], radar: [D1] });
    assert.equal(videoDestaqueFromSelection(noRadar)?.url, D1.url);
  });
  it("manifest: video com destaque, teto e descrição anterior", () => {
    const s = sel();
    s.video = { ...VIDEO, description: "  Anterior.  " };
    const input = buildStackWriterInput(s, "/tmp/c.json");
    assert.equal(input.video?.destaque.body, D1.body);
    assert.equal(input.video?.currentDescription, "Anterior.");
    assert.equal(input.limits.videoDescriptionMaxChars, STACK_COPY_VIDEO_DESCRIPTION_MAX_CHARS);
  });
  it("sem vídeo, ou sem o destaque comentado, video = null", () => {
    assert.equal(buildStackWriterInput(sel({ video: undefined }), "x").video, null);
    assert.equal(buildStackWriterInput(sel({ destaques: [] }), "x").video, null);
    assert.equal(buildStackWriterInput(sel({ video: { ...VIDEO, url: " " } }), "x").video, null);
  });
});

describe("#12549 item 6 — validação de videoDescription", () => {
  it("descrição com os fatos do destaque passa e é aplicada em video.description", () => {
    const s = sel();
    const { copy, problems } = parseStackCopy(JSON.stringify(copyFor(s, `  ${GOOD_DESC}  `)), s);
    assert.deepEqual(problems, []);
    assert.equal(copy?.videoDescription, GOOD_DESC);
    const applied = applyStackCopy(s, copy!);
    assert.equal(applied.video?.description, GOOD_DESC);
    assert.equal(applied.video?.views, 120);
    assert.equal(s.video?.description, undefined, "não muta a entrada");
  });
  it("com vídeo, falta da descrição recusa tudo", () => {
    const s = sel();
    const r = parseStackCopy(JSON.stringify(copyFor(s)), s);
    assert.equal(r.copy, null);
    assert.match(r.problems.join("\n"), /videoDescription ausente/);
  });
  it("sem vídeo, o campo a mais recusa tudo", () => {
    const s = sel({ video: undefined });
    const r = parseStackCopy(JSON.stringify(copyFor(s, GOOD_DESC)), s);
    assert.equal(r.copy, null);
    assert.match(r.problems.join("\n"), /videoDescription sem vídeo/);
  });
  it("sem vídeo e sem o campo passa (sem descrição de vídeo)", () => {
    const s = sel({ video: undefined });
    const r = parseStackCopy(JSON.stringify(copyFor(s)), s);
    assert.deepEqual(r.problems, []);
    assert.equal(r.copy?.videoDescription, undefined);
  });
  it("número fora do destaque comentado é recusado", () => {
    const s = sel();
    const r = parseStackCopy(JSON.stringify(copyFor(s, "O Claude X lê 3 milhões de tokens.")), s);
    assert.equal(r.copy, null);
    assert.match(r.problems.join("\n"), /número\(s\) fora do destaque comentado \(3\)/);
  });
  it("teto, markdown e chamada para assistir são recusados", () => {
    const s = sel();
    for (const bad of ["a".repeat(STACK_COPY_VIDEO_DESCRIPTION_MAX_CHARS + 1), "O **Claude X** chegou.", "Vale assistir: o Claude X chegou."]) {
      assert.equal(parseStackCopy(JSON.stringify(copyFor(s, bad)), s).copy, null, bad);
    }
  });
  it("destaque passado pelo CLI vence o da seleção (lido do disco)", () => {
    const s = sel({ destaques: [] });
    const vd = { editionDate: "261104", url: D1.url, title: D1.title, body: D1.body, why: D1.why };
    assert.equal(parseStackCopy(JSON.stringify(copyFor(s, GOOD_DESC)), s).copy, null, "sem destaque, o campo sobra");
    assert.deepEqual(parseStackCopy(JSON.stringify(copyFor(s, GOOD_DESC)), s, { videoDestaque: vd }).problems, []);
  });
  it("render: a descrição aplicada sai logo abaixo do título do vídeo", () => {
    const s = sel();
    const applied = applyStackCopy(s, parseStackCopy(JSON.stringify(copyFor(s, GOOD_DESC)), s).copy!);
    const md = renderCircleStackPost(applied).markdown;
    const i = md.indexOf("Claude X comentado");
    assert.ok(i > 0);
    assert.ok(md.indexOf(GOOD_DESC) > i, md.slice(0, 600));
    assert.ok(md.indexOf(GOOD_DESC) < md.indexOf("## Destaques da semana"));
  });
  it("applyStackCopy recusa descrição de vídeo numa seleção sem vídeo", () => {
    const s = sel({ video: undefined });
    assert.throws(() => applyStackCopy(s, { ...copyFor(s), videoDescription: GOOD_DESC }), /não tem vídeo/);
  });
});

describe("unsourcedNumbers", () => {
  it("aceita número do texto-fonte, também com separador decimal trocado", () => {
    assert.deepEqual(unsourcedNumbers("Custa 1,5 dólar e 40% menos.", ["custa US$ 1.5", "40% menos"]), []);
    assert.deepEqual(unsourcedNumbers("Chegou em 2027.", ["Chegou."]), ["2027"]);
  });
  it("compara número inteiro por conjunto, nunca por substring (review #12854)", () => {
    assert.deepEqual(unsourcedNumbers("Lê 2 milhões.", ["lê 20 milhões"]), ["2"]);
    assert.deepEqual(unsourcedNumbers("Saiu a versão 3.", ["Anunciado em 2023."]), ["3"], "ano na fonte não libera número inventado");
    assert.deepEqual(unsourcedNumbers("Custa 1,5.", ["custa 11,55"]), ["1,5"]);
    assert.deepEqual(unsourcedNumbers("Lê 20 milhões em 2023.", ["2023: lê 20 milhões"]), []);
  });
});

describe("#12549 review — applyStackCopy sem videoDescription", () => {
  it("preserva a descrição do vídeo escrita à mão", () => {
    const s = sel({ video: { ...VIDEO, description: "Escrita à mão pelo editor." } });
    const applied = applyStackCopy(s, copyFor(s));
    assert.equal(applied.video?.description, "Escrita à mão pelo editor.");
  });
  it("campo a mais com vídeo mas sem o D1: a recusa aponta o destaque, e o motivo, não só manda apagar", () => {
    const s = sel({ destaques: [] });
    const r = parseStackCopy(JSON.stringify(copyFor(s, GOOD_DESC)), s, { videoDestaque: null, videoUnavailableReason: "motivo X" });
    assert.equal(r.copy, null);
    assert.match(r.problems.join("\n"), /sem o destaque que o vídeo comenta \(motivo X\).*restaure o D1/);
  });
});

describe("#12549 item 5 — conselho ao leitor é recusado", () => {
  for (const t of [
    "Quem constrói agentes deveria ver.",
    "Quem tem fluxo apoiado nele precisa migrar.",
    "Vale testar antes de atualizar.",
    "Vale a pena conferir o changelog.",
    "Você precisa revisar os prompts.",
    "Quem usa o plano gratuito precisa migrar até março.",
    "Quem monta fluxos no n8n deveria revisar os gatilhos.",
  ]) {
    it(`recusa: ${t}`, () => {
      assert.ok(hasReaderAdvice(t));
      assert.ok(stackCopyTextProblems(t, 240).some((p) => /aconselha o leitor/.test(p)));
    });
  }
  for (const t of [
    "O modelo precisa de menos memória para rodar.",
    "A versão nova vale para todos os planos.",
    "O agente deve terminar a tarefa sem pedir confirmação.",
    // review #12854: frases factuais com "quem" que o padrão largo recusava.
    "Para quem usa o Cursor, o novo limite vale para todos os planos.",
    "Segundo quem acompanha o setor, a empresa deve lançar em março.",
    "Pesquisa mostra que quem usa IA precisa de 30% menos tempo.",
  ]) {
    it(`fato sem conselho passa: ${t}`, () => {
      assert.equal(hasReaderAdvice(t), false);
    });
  }
});

describe("#12549 — CLI circle-stack-copy.ts com vídeo", () => {
  const EDITION_MD = [
    "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
    "",
    `**[${D1.title}](${D1.url})**`,
    "",
    D1.body,
    "",
    "Por que isso importa:",
    "",
    D1.why as string,
    "",
    "---",
    "",
  ].join("\n");

  function setup(withDestaqueInSelection: boolean) {
    const root = mkdtempSync(join(tmpdir(), "stack-video-12549-"));
    const p = circleStackCopyPaths(root, "261109");
    mkdirSync(dirname(p.selectionPath), { recursive: true });
    const s = { ...sel(withDestaqueInSelection ? {} : { destaques: [] }), cycle: p.cycle, warnings: ["aviso"] };
    writeFileSync(p.selectionPath, JSON.stringify(s, null, 2));
    const edDir = join(root, "data", "editions", "261104");
    mkdirSync(edDir, { recursive: true });
    writeFileSync(join(edDir, "02-reviewed.md"), EDITION_MD, "utf8");
    return { root, ...p };
  }

  async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const orig = console.log;
    let out = "";
    console.log = (...a: unknown[]) => {
      out += a.join(" ") + "\n";
    };
    try {
      return { code: await fn(), out };
    } finally {
      console.log = orig;
    }
  }

  it("--manifest lê o D1 do 02-reviewed.md quando ele não está na seleção", async () => {
    const { root } = setup(false);
    try {
      const { code, out } = await captureStdout(() => runCircleStackCopy(["--publish-monday", "261109", "--manifest", "--data-root", root], root));
      assert.equal(code, 0);
      const m = JSON.parse(out);
      assert.equal(m.video.destaque.url, D1.url);
      assert.match(m.video.destaque.body, /2 milhões de tokens/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--apply grava video.description e preserva os outros campos do vídeo", async () => {
    const { root, selectionPath, copyPath } = setup(false);
    try {
      const stored = JSON.parse(readFileSync(selectionPath, "utf8"));
      writeFileSync(copyPath, JSON.stringify(copyFor(stored, GOOD_DESC)));
      const { code } = await captureStdout(() => runCircleStackCopy(["--publish-monday", "261109", "--apply", "--data-root", root], root));
      assert.equal(code, 0);
      const after = JSON.parse(readFileSync(selectionPath, "utf8"));
      assert.equal(after.video.description, GOOD_DESC);
      assert.equal(after.video.views, 120);
      assert.deepEqual(after.warnings, ["aviso"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--apply sem videoDescription numa semana com vídeo sai 1 e não toca a seleção", async () => {
    const { root, selectionPath, copyPath } = setup(true);
    try {
      const before = readFileSync(selectionPath, "utf8");
      writeFileSync(copyPath, JSON.stringify(copyFor(JSON.parse(before))));
      const orig = console.error;
      console.error = () => {};
      try {
        assert.equal(await runCircleStackCopy(["--publish-monday", "261109", "--apply", "--data-root", root], root), 1);
      } finally {
        console.error = orig;
      }
      assert.equal(readFileSync(selectionPath, "utf8"), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; err: string; out: string }> {
    const [ol, oe] = [console.log, console.error];
    let out = "";
    let err = "";
    console.log = (...a: unknown[]) => void (out += a.join(" ") + "\n");
    console.error = (...a: unknown[]) => void (err += a.join(" ") + "\n");
    try {
      return { result: await fn(), err, out };
    } finally {
      console.log = ol;
      console.error = oe;
    }
  }

  it("exceção de leitura da edição do vídeo propaga (não vira 'sem vídeo') e a seleção fica intacta", async () => {
    const { root, selectionPath, copyPath } = setup(false);
    try {
      const edMd = join(root, "data", "editions", "261104", "02-reviewed.md");
      rmSync(edMd);
      mkdirSync(edMd); // existe, mas a leitura lança (EISDIR)
      const before = readFileSync(selectionPath, "utf8");
      writeFileSync(copyPath, JSON.stringify(copyFor(JSON.parse(before))));
      await assert.rejects(
        quiet(() => runCircleStackCopy(["--publish-monday", "261109", "--apply", "--data-root", root], root)),
      );
      assert.equal(readFileSync(selectionPath, "utf8"), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edição do vídeo ausente: avisa o motivo, a linha OK diz 'sem descrição do vídeo: <motivo>' e avisa da descrição antiga sem validação", async () => {
    const { root, selectionPath, copyPath } = setup(false);
    try {
      rmSync(join(root, "data", "editions", "261104"), { recursive: true, force: true });
      const stored = JSON.parse(readFileSync(selectionPath, "utf8"));
      stored.video.description = "Antiga.";
      writeFileSync(selectionPath, JSON.stringify(stored, null, 2));
      writeFileSync(copyPath, JSON.stringify(copyFor(stored)));
      const { result, err, out } = await quiet(() => runCircleStackCopy(["--publish-monday", "261109", "--apply", "--data-root", root], root));
      assert.equal(result, 0);
      assert.match(err, /edição 261104 do vídeo não existe/);
      assert.match(err, /SEM validação/);
      assert.match(out, /sem descrição do vídeo: a edição 261104 do vídeo não existe/);
      assert.equal(JSON.parse(readFileSync(selectionPath, "utf8")).video.description, "Antiga.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#12549 itens 4 e 5 — prompts dos agentes", () => {
  const writer = readFileSync(".claude/agents/stack-writer.md", "utf8");
  const translator = readFileSync(".claude/agents/stack-title-translator.md", "utf8");
  it("stack-writer não pede mais 'por que um builder deveria se importar' e veta conselho ao leitor", () => {
    assert.doesNotMatch(writer, /deveria se importar/);
    assert.match(writer, /Quem constrói X deveria ver/);
    assert.match(writer, /Sem conselho ao leitor/);
  });
  it("stack-writer descreve videoDescription só com o destaque comentado", () => {
    assert.match(writer, /videoDescription/);
    assert.match(writer, /A única fonte é `video\.destaque`/);
  });
  it("stack-title-translator mantém produto/fabricante no título", () => {
    assert.match(translator, /Produto ou fabricante sempre no título/);
    assert.match(translator, /mais rápidos no Claude/);
  });
});
