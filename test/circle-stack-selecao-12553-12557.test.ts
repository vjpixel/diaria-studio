/**
 * Lote Stack (ciclo 26w45): avisos recalculados (#12553), erro de leitura com
 * caminho (#12554), prévia HTML por script (#12555), link do post (#12556) e
 * itens descartados na seleção (#12557).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseStoredCircleStackSelection,
  publishCircleStackCycle,
  readEdition,
  readStoredCircleStackExclusions,
  runCircleStack,
  type RunCircleStackDeps,
} from "../scripts/publish-circle-stack.ts";
import {
  applyCircleStackExclusions,
  renderCircleStackPost,
  type CircleStackItem,
  type CircleStackSelection,
} from "../scripts/lib/circle-stack-render.ts";
import { refreshCircleStackWarnings } from "../scripts/lib/circle-stack-warnings.ts";
import { stackTitleTranslatedWarning, applyStackTitleTranslations } from "../scripts/lib/circle-stack-translate.ts";
import { FileReadError, readUtf8WithContext } from "../scripts/lib/read-file-with-context.ts";
import { renderCircleStackPreviewHtml } from "../scripts/lib/circle-stack-preview-html.ts";
import { buildStackPostPayload, extractStackPostUrl, sendStackPost } from "../scripts/lib/stack-webhook.ts";
import {
  buildCircleStackOutcomeEmail,
  circleStackPostLinkLine,
  classifyCircleStackRun,
  CIRCLE_STACK_RADAR_URL,
} from "../scripts/lib/circle-stack-schedule.ts";

const ROOT = resolve(import.meta.dirname, "..");

function item(over: Partial<CircleStackItem> & Pick<CircleStackItem, "url" | "title">): CircleStackItem {
  return { editionDate: "261103", body: "Corpo do item.", why: "", ...over };
}

function sel(over: Partial<CircleStackSelection> = {}): CircleStackSelection {
  return {
    cycle: "26w45",
    contentWindow: ["261102", "261103", "261104", "261105", "261106"],
    destaques: [item({ url: "https://lovable.dev/blog/dreams", title: "Lovable \"sonha\" e reescreve a memória do seu app", why: "Importa." })],
    lancamentos: [
      item({
        url: "https://claude.com/blog/message-threads",
        title: "Message threads no Claude deixam agentes de longa duração mais rápidos",
        titleOriginal: "Make long-running agents faster with message threads",
      }),
      item({ url: "https://openai.com/index/images-2-6", title: "OpenAI lança o Images 2.6", titleOriginal: "Introducing Images 2.6" }),
    ],
    useMelhor: [],
    radar: [item({ url: "https://example.com/candidato", title: "O candidato com 278 entrevistas não era humano" })],
    weeklyEditions: [
      {
        editionDate: "261103",
        url: "https://diar.ia.br/p/so-o-claude",
        destaques: ["Só o Claude Opus 5.5 supera a IA aberta da Mistral no teste às cegas", "O candidato com 278 entrevistas não era humano"],
      },
    ],
    ...over,
  };
}

const LEGACY_WARNINGS = [
  "Edições sem 02-reviewed.md: 261102",
  stackTitleTranslatedWarning("Message threads deixam agentes de longa duração mais rápidos", "Make long-running agents faster with message threads"),
  stackTitleTranslatedWarning("OpenAI lança o Images 2.6", "Introducing Images 2.6"),
];

describe("#12553 — avisos recalculados sobre a seleção atual", () => {
  it("caso 26w45: título reescrito à mão deixa de ser aviso; o que segue igual ao traduzido continua", () => {
    const out = refreshCircleStackWarnings(sel(), LEGACY_WARNINGS);
    assert.ok(!out.some((w) => w.includes("Message threads")), out.join("\n"));
    assert.ok(out.includes(stackTitleTranslatedWarning("OpenAI lança o Images 2.6", "Introducing Images 2.6")));
  });

  it("titleReviewed tira o aviso de tradução", () => {
    const s = sel();
    s.lancamentos[1] = { ...s.lancamentos[1], titleReviewed: true };
    assert.ok(!refreshCircleStackWarnings(s, LEGACY_WARNINGS).some((w) => w.includes("Images 2.6")));
  });

  it("seleção nova grava titleTranslated e o aviso sai do item, não do texto gravado", () => {
    const base = sel({ lancamentos: [item({ url: "https://x.test/a", title: "Introducing Codex" })] });
    const { selection } = applyStackTitleTranslations(base, new Map([["https://x.test/a", "OpenAI apresenta o Codex"]]));
    assert.equal(selection.lancamentos[0].titleTranslated, "OpenAI apresenta o Codex");
    assert.deepEqual(refreshCircleStackWarnings(selection, []), [stackTitleTranslatedWarning("OpenAI apresenta o Codex", "Introducing Codex")]);
    const edited = { ...selection, lancamentos: [{ ...selection.lancamentos[0], title: "OpenAI abre o Codex para todos" }] };
    assert.deepEqual(refreshCircleStackWarnings(edited, []), []);
  });

  it("feriado (sem diretório de edição) não é edição faltando; diretório sem arquivo continua aviso", () => {
    const w = ["Edições sem 02-reviewed.md: 261102, 261104"];
    assert.deepEqual(refreshCircleStackWarnings(sel(), w, { editionDirExists: (d) => d === "261104" }), ["Edições sem 02-reviewed.md: 261104"]);
    assert.deepEqual(refreshCircleStackWarnings(sel(), w, { editionDirExists: () => false }), []);
    // sem como conferir (sem data/), o aviso gravado fica
    assert.deepEqual(refreshCircleStackWarnings(sel(), w), w);
  });

  it("recontagem de destaques sem termo de interesse e falha de tradução que não vale mais", () => {
    const s = sel();
    (s.destaques[0] as CircleStackItem & { score: number }).score = 12;
    const out = refreshCircleStackWarnings(s, [
      "1 destaque(s) sem nenhum termo de interesse da Stack — revisar a seleção",
      "Tradução automática dos títulos falhou (timeout) — 1 título(s) sem sinal de português ficaram como na fonte; reescreva",
      "Aviso qualquer",
    ]);
    assert.deepEqual(out, ["Aviso qualquer"]);
  });

  it("runCircleStack: feriado fora do aviso, edição sem arquivo dentro, título editado sem aviso velho", async () => {
    const t = setupRun();
    // 261021 tem diretório sem 02-reviewed.md; 261019/261022/261023 não têm diretório (sem edição).
    mkdirSync(join(t.dataRoot, "data", "editions", "261021"), { recursive: true });
    await runCircleStack(t.base, t.deps(translateTo("OpenAI publica as notas do Codex")));
    const stored = JSON.parse(readFileSync(t.selectionPath, "utf8"));
    assert.ok(stored.warnings.includes("Edições sem 02-reviewed.md: 261021"), stored.warnings.join("\n"));
    assert.deepEqual(stored.editionsWithoutEdition, ["261019", "261022", "261023"]);

    stored.lancamentos[0].title = "OpenAI publica as notas de lançamento do Codex";
    writeFileSync(t.selectionPath, JSON.stringify(stored));
    const warns = await captureWarn(() => runCircleStack(t.base, t.deps(translateTo("nunca chamado"))));
    assert.ok(!warns.some((w) => w.includes("Título traduzido")), warns.join("\n"));
    assert.ok(warns.some((w) => w.includes("261021")));
  });
});

describe("#12554 — erro de leitura com o caminho do arquivo", () => {
  const unknown = () => {
    const e = new Error("UNKNOWN: unknown error, read") as NodeJS.ErrnoException;
    e.code = "UNKNOWN";
    throw e;
  };

  it("UNKNOWN sai com caminho, código e a dica do OneDrive", () => {
    assert.throws(
      () => readUtf8WithContext("/x/data/editions/2611/261109/02-reviewed.md", unknown),
      (err: unknown) => {
        assert.ok(err instanceof FileReadError);
        assert.equal(err.code, "UNKNOWN");
        assert.match(err.message, /261109\/02-reviewed\.md/);
        assert.match(err.message, /OneDrive/);
        return true;
      },
    );
  });

  it("ENOENT sai com caminho, sem a dica do OneDrive", () => {
    assert.throws(
      () => readUtf8WithContext("/nao/existe.md"),
      (err: unknown) => err instanceof FileReadError && err.code === "ENOENT" && /\/nao\/existe\.md/.test(err.message) && !/OneDrive/.test(err.message),
    );
  });

  it("readEdition relança com o caminho do 02-reviewed.md", () => {
    const root = mkdtempSync(join(tmpdir(), "stack-12554-"));
    mkdirSync(join(root, "2611", "261109"), { recursive: true });
    writeFileSync(join(root, "2611", "261109", "02-reviewed.md"), "x");
    assert.throws(() => readEdition(root, "261109", unknown), /2611\/261109\/02-reviewed\.md \(UNKNOWN\)/);
    assert.equal(readEdition(root, "261102"), "sem-edicao");
  });
});

describe("#12557 — item descartado na seleção", () => {
  it("por título: sai do Radar e de Outros destaques", () => {
    const s = sel({ excluded: [{ title: "o candidato com 278 entrevistas  não era humano", note: "fraco para builder" }] });
    const md = renderCircleStackPost(s).markdown;
    assert.doesNotMatch(md, /278 entrevistas/);
    assert.match(md, /Só o Claude Opus 5\.5/);
  });

  it("por URL: sai da seção e, enquanto o item está na seleção, também de Outros destaques", () => {
    const applied = applyCircleStackExclusions(sel({ excluded: [{ url: "https://example.com/candidato" }] }));
    assert.equal(applied.radar.length, 0);
    assert.deepEqual(applied.weeklyEditions[0].destaques, ["Só o Claude Opus 5.5 supera a IA aberta da Mistral no teste às cegas"]);
  });

  it("sem excluded a seleção não muda", () => {
    const s = sel();
    assert.equal(applyCircleStackExclusions(s), s);
  });

  it("parseStored valida excluded e devolve a seleção sem os descartados", () => {
    const raw = (x: unknown) => JSON.stringify({ ...sel(), excluded: x });
    assert.throws(() => parseStoredCircleStackSelection(raw({}), "p.json", "26w45"), /excluded precisa ser uma lista/);
    assert.throws(() => parseStoredCircleStackSelection(raw([{ note: "só nota" }]), "p.json", "26w45"), /precisa de url ou title/);
    assert.throws(() => parseStoredCircleStackSelection(raw([{ url: 3 }]), "p.json", "26w45"), /excluded\[0\]\.url não é texto/);
    const { selection } = parseStoredCircleStackSelection(raw([{ url: "https://example.com/candidato" }]), "p.json", "26w45");
    assert.equal(selection.radar.length, 0);
  });

  it("readStoredCircleStackExclusions ignora entrada vazia e arquivo ilegível", () => {
    const dir = mkdtempSync(join(tmpdir(), "stack-12557-"));
    const p = join(dir, "s.json");
    writeFileSync(p, JSON.stringify({ excluded: [{ title: "A" }, {}, { url: "https://b.test", note: "n" }] }));
    assert.deepEqual(readStoredCircleStackExclusions(p), [{ title: "A" }, { url: "https://b.test", note: "n" }]);
    writeFileSync(p, "{");
    assert.deepEqual(readStoredCircleStackExclusions(p), []);
  });

  it("--reselect mantém os descartados", async () => {
    const t = setupRun();
    await runCircleStack(t.base, t.deps(translateTo("OpenAI publica as notas do Codex")));
    const stored = JSON.parse(readFileSync(t.selectionPath, "utf8"));
    stored.excluded = [{ url: CODEX_URL }];
    writeFileSync(t.selectionPath, JSON.stringify(stored));
    const warns = await captureWarn(() => runCircleStack([...t.base, "--reselect"], t.deps(translateTo("OpenAI publica as notas do Codex"))));
    assert.ok(warns.some((w) => /--reselect manteve 1 item/.test(w)), warns.join("\n"));
    assert.deepEqual(JSON.parse(readFileSync(t.selectionPath, "utf8")).excluded, [{ url: CODEX_URL }]);
    assert.doesNotMatch(readFileSync(t.mdPath, "utf8"), /Codex/);
  });
});

describe("#12555 — prévia HTML gerada por script", () => {
  it("leva título, avisos, texto da Stack em destaque, original ao lado, descartados e o comando de envio", () => {
    const s = sel({ opening: "Abertura escrita para quem constrói." });
    s.lancamentos[1] = { ...s.lancamentos[1], stackNote: "Nota para builders." };
    const excluded = [{ title: "O candidato com 278 entrevistas não era humano", note: "fraco" }];
    const html = renderCircleStackPreviewHtml({
      selection: applyCircleStackExclusions({ ...s, excluded }),
      excluded,
      previewTitle: "Lovable <sonha>",
      publishMonday: "261109",
      publishState: "draft",
      warnings: ["Aviso <x>"],
      mdPath: "data/weekly/26w45/circle-stack-26w45.md",
    });
    assert.match(html, /<title>Stack 26w45<\/title>/);
    assert.match(html, /Lovable &lt;sonha&gt;/);
    assert.match(html, /Aviso &lt;x&gt;/);
    assert.match(html, /Abertura escrita para a Stack/);
    assert.match(html, /<div class="stack"><span class="label">Texto para a Stack<\/span><p>Nota para builders\.<\/p>/);
    assert.match(html, /Original: Introducing Images 2\.6/);
    assert.match(html, /Descartados pelo editor/);
    assert.match(html, /--publish-monday 261109 --publish/);
    assert.match(html, /prefers-color-scheme:dark/);
    // descartado não aparece no corpo do post nem em Outros destaques
    assert.equal(html.split("278 entrevistas").length - 1, 1);
  });

  it("o dry-run grava _internal/circle-stack-preview.html", async () => {
    const t = setupRun();
    await runCircleStack(t.base, t.deps(translateTo("OpenAI publica as notas do Codex")));
    const htmlPath = join(t.dataRoot, "data", "weekly", "26w43", "_internal", "circle-stack-preview.html");
    assert.ok(existsSync(htmlPath));
    const html = readFileSync(htmlPath, "utf8");
    assert.match(html, /Cursor lança agentes em segundo plano/);
    assert.match(html, /Original: Codex Launch Notes/);
  });
});

describe("#12556 — link do post publicado", () => {
  it("extractStackPostUrl: só https, no topo ou em post", () => {
    assert.equal(extractStackPostUrl({ ok: true }), null);
    assert.equal(extractStackPostUrl({ ok: true, url: "https://plataforma.stack.com.br/c/radar/p1" }), "https://plataforma.stack.com.br/c/radar/p1");
    assert.equal(extractStackPostUrl({ ok: true, post: { permalink: "https://x.test/p" } }), "https://x.test/p");
    assert.equal(extractStackPostUrl({ ok: true, url: "javascript:alert(1)" }), null);
  });

  it("sendStackPost devolve o link quando o webhook manda", async () => {
    const payload = buildStackPostPayload("T", "Corpo");
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: true, post_url: "https://x.test/p" }), { status: 200 })) as typeof fetch;
    assert.deepEqual(await sendStackPost("https://hook.test", "k", payload, fakeFetch), { postUrl: "https://x.test/p" });
    const okOnly = (async () => new Response('{"ok": true}', { status: 200 })) as typeof fetch;
    assert.deepEqual(await sendStackPost("https://hook.test", "k", payload, okOnly), { postUrl: null });
  });

  it("publishCircleStackCycle grava post_url no state", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "stack-12556-")), "circle-stack-published.json");
    const r = await publishCircleStackCycle({
      statePath,
      cycle: "26w45",
      title: "T",
      payload: buildStackPostPayload("T", "Corpo"),
      force: false,
      send: async () => ({ postUrl: "https://x.test/p" }),
    });
    assert.equal(r.postUrl, "https://x.test/p");
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).post_url, "https://x.test/p");
  });

  it("sem link: a linha aponta o espaço e o título; e-mail de Publicado leva a linha", () => {
    assert.equal(circleStackPostLinkLine("https://x.test/p", "T"), "Link do post: https://x.test/p");
    assert.match(circleStackPostLinkLine(null, "Lovable sonha"), new RegExp(`${CIRCLE_STACK_RADAR_URL}.*"Lovable sonha"`));
    const outcome = classifyCircleStackRun({
      cycle: "26w45",
      runStartedAt: new Date("2026-11-09T09:00:00Z"),
      stateAfter: { cycle: "26w45", title: "Lovable sonha", attempted_at: "2026-11-09T09:00:01Z", published_at: "2026-11-09T09:00:02Z" },
    });
    const { body } = buildCircleStackOutcomeEmail(outcome, { cycle: "26w45", publishMonday: "261109", statePath: "s.json" });
    assert.match(body, /procure pelo título "Lovable sonha"/);
  });
});

// ── helpers do caminho do main ──────────────────────────────────────────────

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

function setupRun() {
  const dataRoot = mkdtempSync(join(tmpdir(), "circle-stack-12553-"));
  const dir = join(dataRoot, "data", "editions", "261020");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), EDITION_MD, "utf8");
  const selectionPath = join(dataRoot, "data", "weekly", "26w43", "_internal", "circle-stack-selection.json");
  const mdPath = join(dataRoot, "data", "weekly", "26w43", "circle-stack-26w43.md");
  const deps = (translateCall: RunCircleStackDeps["translateCall"]): RunCircleStackDeps => ({
    rootDir: ROOT,
    platformConfig: { circle_stack: { enabled: true } },
    env: {},
    translateCall,
    send: async () => {
      throw new Error("não deveria enviar");
    },
    ghRun: () => ({ status: 0, stdout: "[]", stderr: "" }),
    topVideo: async () => null,
  });
  return { dataRoot, selectionPath, mdPath, deps, base: ["--publish-monday", "261026", "--data-root", dataRoot] };
}

function translateTo(titlePt: string): RunCircleStackDeps["translateCall"] {
  return () => JSON.stringify({ items: [{ url: CODEX_URL, titlePt }] });
}

async function captureWarn(fn: () => Promise<unknown>): Promise<string[]> {
  const warns: string[] = [];
  const orig = console.warn;
  const origLog = console.log;
  console.warn = (...a: unknown[]) => {
    warns.push(a.join(" "));
  };
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.warn = orig;
    console.log = origLog;
  }
  return warns;
}
