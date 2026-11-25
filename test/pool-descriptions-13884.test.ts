/**
 * Regressão #13884 (resíduo, decisão do editor de 25/11/2026):
 *   - item de POOL sem texto lido bloqueia o gate 4 (`source-not-read` error,
 *     `check-invariants --stage 4` sai 1); só o aceite do editor
 *     (`ack-source-not-read.ts`) o rebaixa a warning; destaque segue warning;
 *   - a descrição do item de pool passa a ser escrita a partir do texto lido
 *     (`writer-pool`, cercado por `pool-descriptions.ts --input/--apply`), e é
 *     esse passo que faz o download contar como fonte LIDA;
 *   - o Write do `writer-pool` fica restrito ao JSON de descrições (o agent lê
 *     texto externo não confiável);
 *   - o prefetch do pool mede o próprio tempo (`duration_ms`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { checkSourceNotRead, readSourceDownloads, readSourceNotReadAcks } from "../scripts/lib/diaria/source-readability.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";
import {
  applyPoolDescriptions,
  buildPoolDescriptionsInput,
  validatePoolDescription,
} from "../scripts/lib/diaria/pool-descriptions.ts";
import { poolSourceFileName, prefetchPoolSources, readPoolDescriptionsApplied } from "../scripts/lib/diaria/pool-sources.ts";
import { runApply, runInput } from "../scripts/pool-descriptions.ts";
import { writeAck } from "../scripts/ack-source-not-read.ts";
// @ts-expect-error -- hook .mjs sem .d.mts (TS7016).
import { shouldBlockWrite } from "../.claude/hooks/block-writer-destaque-write-path.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const D1 = "https://ex.com/d1";
const MS = "https://microsoft.ai/news/seven-new-world-class-models-at-scalable-price-performance/";
const BLOCKED = "https://blocked.example.com/post";
const TUT = "https://tut.example.com/guia";
const LONG = "Um resumo de verdade, com o fato, quem fez, quanto e por que importa para o leitor.";
const PAGE = Array.from({ length: 300 }, (_, i) => `palavra${i}`).join(" ");

function approved() {
  return {
    highlights: [{ rank: 1, url: D1, article: { url: D1, title: "d1", summary: "Curto." } }],
    lancamento: [{ url: MS, title: "Seven new world-class models", verify_verdict: "accessible", summary: "Microsoft lança modelos." }],
    radar: [{ url: BLOCKED, title: "Bloqueado", verify_verdict: "accessible", summary: LONG }],
    use_melhor: [{ url: TUT, title: "Guia", verify_verdict: "accessible", summary: "Guia curto (5 min)" }],
  };
}

const DRAFT = [
  "**DESTAQUE 1 | X**",
  "",
  `[d1](${D1})`,
  "",
  "**🛠️ USE MELHOR**",
  "",
  `**[Guia](${TUT})**  `,
  "Guia curto (5 min)",
  "",
  "**🚀 LANÇAMENTO**",
  "",
  `**[Seven new world-class models](${MS})**  `,
  "[TRADUZIR] Microsoft lança modelos.",
  "",
  "**📡 RADAR**",
  "",
  `**[Bloqueado](${BLOCKED})**  `,
  LONG,
  "",
].join("\n");

function setup(): string {
  const ed = mkdtempSync(join(tmpdir(), "pool-desc-13884-"));
  const internal = join(ed, "_internal");
  mkdirSync(join(internal, "pool-sources"), { recursive: true });
  writeFileSync(join(internal, "01-approved.json"), JSON.stringify(approved()));
  writeFileSync(join(internal, "02-draft.md"), DRAFT);
  writeFileSync(join(ed, "02-reviewed.md"), DRAFT);
  const entry = (url: string, bucket: string, over: Record<string, unknown> = {}) => {
    const file = poolSourceFileName(url);
    writeFileSync(join(internal, "pool-sources", file), PAGE);
    return { url, bucket, title: "t", file, status: "ok", erro: null, bytes: PAGE.length, fetched_at: "x", completeness: "full", words: 300, ...over };
  };
  writeFileSync(
    join(internal, "pool-sources", "manifest.json"),
    JSON.stringify([
      entry(MS, "lancamento"),
      entry(TUT, "use_melhor"),
      { url: BLOCKED, bucket: "radar", title: "Bloqueado", file: null, status: "blocked", erro: "HTTP 403: fonte bloqueada", bytes: 0, fetched_at: "x" },
    ]),
  );
  return ed;
}

function writerOutput(ed: string, descriptions: Array<{ url: string; description: string }>) {
  writeFileSync(join(ed, "_internal", "02-pool-descriptions.json"), JSON.stringify({ descriptions }));
}

const MS_DESC = "A Microsoft apresentou sete modelos novos de linguagem, com preço por desempenho menor que o da geração anterior.";
const TUT_DESC = "Guia que mostra, passo a passo, como configurar o assistente para acompanhar preços.";

describe("source-not-read: item de pool sem texto lido bloqueia o gate (#13884)", () => {
  it("error para o pool; check-invariants --stage 4 sai 1", () => {
    const ed = setup();
    try {
      const rule = getRulesForStage(4).find((r) => r.id === "source-not-read")!;
      const v = rule.run(ed);
      const err = v.find((x) => x.severity === "error");
      assert.ok(err, "item de pool sem texto lido tem de ser error");
      assert.match(err!.message, /"Seven new world-class models" \(resumo de 24 caracteres/);
      assert.match(err!.message, /"Bloqueado" \(download da página falhou: HTTP 403/);
      assert.match(err!.message, /ack-source-not-read\.ts/);
      assert.match(err!.message, /--no-gates, halt banner/);
      // Destaque (resumo curto, sem fact-check-sources) fica warning.
      const warn = v.find((x) => x.severity === "warning");
      assert.match(warn!.message, /\[DESTAQUE\] "d1"/);
      assert.doesNotMatch(err!.message, /\[DESTAQUE\]/);

      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/check-invariants.ts", "--stage", "4", "--rule", "source-not-read", "--edition-dir", ed],
        { cwd: ROOT, encoding: "utf8" },
      );
      assert.equal(r.status, 1, `gate 4 tem de bloquear; stderr: ${r.stderr}`);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("aceite do editor rebaixa o item a warning; --remove desfaz; aceite sem motivo é recusado", () => {
    const ed = setup();
    try {
      assert.throws(() => writeAck(ed, MS, { reason: "  " }), /--reason obrigatório/);
      writeAck(ed, MS, { reason: "editor abriu a página" });
      writeAck(ed, BLOCKED, { reason: "fonte conhecida" });
      writeAck(ed, TUT, { reason: "tutorial conferido" });
      assert.equal(readSourceNotReadAcks(join(ed, "_internal")).size, 3);
      const v = checkSourceNotRead(ed);
      assert.deepEqual(v.map((x) => x.severity), ["warning"]);
      assert.match(v[0].message, /\[aceito pelo editor: editor abriu a página\]/);

      writeAck(ed, BLOCKED, { remove: true });
      const v2 = checkSourceNotRead(ed);
      assert.equal(v2[0].severity, "error");
      assert.match(v2[0].message, /Bloqueado/);
      assert.doesNotMatch(v2[0].message, /Seven new/);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("aceite ilegível não libera o gate (fail-closed)", () => {
    const ed = setup();
    try {
      writeFileSync(join(ed, "_internal", "source-not-read-ack.json"), "{ quebrado");
      assert.equal(checkSourceNotRead(ed)[0].severity, "error");
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });
});

describe("descrição do pool a partir do texto lido (#13884 item 2)", () => {
  it("--input lista só os itens do draft com texto utilizável, sem [TRADUZIR]", () => {
    const ed = setup();
    try {
      const internal = join(ed, "_internal");
      const input = buildPoolDescriptionsInput(internal, join(internal, "02-draft.md"), DRAFT);
      assert.deepEqual(input.items.map((i) => i.url).sort(), [MS, TUT].sort());
      assert.equal(input.items.find((i) => i.url === MS)!.current_description, "Microsoft lança modelos.");
      assert.ok(existsSync(input.items[0].source_text_path));
      assert.deepEqual(input.skipped.map((s) => [s.url, s.reason]), [[BLOCKED, "HTTP 403: fonte bloqueada"]]);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("--input pula prévia de paywall, página quase vazia e item fora do draft", () => {
    const ed = setup();
    try {
      const internal = join(ed, "_internal");
      const m = JSON.parse(readFileSync(join(internal, "pool-sources", "manifest.json"), "utf8"));
      m[0].completeness = "preview";
      m[1].words = 20;
      m.push({ url: "https://fora.example.com/x", bucket: "radar", title: "fora", file: m[1].file, status: "ok", erro: null, bytes: 1, fetched_at: "x" });
      writeFileSync(join(internal, "pool-sources", "manifest.json"), JSON.stringify(m));
      const input = buildPoolDescriptionsInput(internal, "x", DRAFT);
      assert.deepEqual(input.items, []);
      assert.deepEqual(input.skipped.map((s) => s.reason), [
        "só a prévia do paywall foi baixada",
        "página baixada com 20 palavras (mínimo 100)",
        "HTTP 403: fonte bloqueada",
      ]);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("validação da forma", () => {
    assert.equal(validatePoolDescription(MS_DESC), null);
    assert.match(validatePoolDescription("Curta.")!, /mínimo 60/);
    assert.match(validatePoolDescription("x".repeat(281))!, /máximo 280/);
    assert.match(validatePoolDescription(`**Negrito** ${MS_DESC}`)!, /markdown/);
    assert.match(validatePoolDescription(`${MS_DESC} Veja → aqui`)!, /seta/);
    assert.match(validatePoolDescription(`${MS_DESC} https://x.com`)!, /URL/);
    assert.match(validatePoolDescription(`${MS_DESC}\nsegunda linha`)!, /mais de uma linha/);
    assert.match(validatePoolDescription(`[TRADUZIR] ${MS_DESC}`)!, /TRADUZIR/);
  });

  it("--apply troca a descrição, preserva o tempo do USE MELHOR e recusa URL fora do input", () => {
    const ed = setup();
    try {
      const internal = join(ed, "_internal");
      const input = buildPoolDescriptionsInput(internal, "x", DRAFT);
      const r = applyPoolDescriptions(DRAFT, input, [
        { url: MS, description: MS_DESC },
        { url: TUT, description: TUT_DESC },
        { url: BLOCKED, description: "Descrição inventada de uma página que ninguém conseguiu ler, sem fonte." },
        { url: MS, description: "duplicada é ignorada" },
      ]);
      assert.deepEqual(r.applied.map((a) => a.url), [MS, TUT]);
      assert.deepEqual(r.rejected, [{ url: BLOCKED, reason: "URL sem texto lido no input do writer-pool" }]);
      assert.ok(r.md.includes(`**[Seven new world-class models](${MS})**  \n${MS_DESC}\n`));
      assert.ok(r.md.includes(`${TUT_DESC} (5 min)`), "USE MELHOR herda a estimativa da descrição anterior");
      assert.ok(!r.md.includes("Microsoft lança modelos."));
      assert.ok(r.md.includes(`**[Bloqueado](${BLOCKED})**  \n${LONG}`), "item rejeitado fica como estava");
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("descrição inválida é rejeitada e não marca a página como lida", () => {
    const ed = setup();
    try {
      runInput(ed);
      writerOutput(ed, [{ url: MS, description: "Curta." }]);
      const out = runApply(ed);
      assert.deepEqual(out.applied, []);
      assert.match(out.rejected[0].reason, /mínimo 60/);
      assert.equal(readPoolDescriptionsApplied(join(ed, "_internal")).size, 0);
      assert.equal(readFileSync(join(ed, "_internal", "02-draft.md"), "utf8"), DRAFT);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("ponta a ponta: descrição aplicada faz o download contar como fonte lida no gate 4", () => {
    const ed = setup();
    try {
      const internal = join(ed, "_internal");
      // Antes: download ok sem descrição reescrita não limpa o resumo curto (#13907).
      assert.equal(readSourceDownloads(internal).has(MS), false);

      const i = runInput(ed);
      assert.equal(i.items, 2);
      writerOutput(ed, [{ url: MS, description: MS_DESC }, { url: TUT, description: TUT_DESC }]);
      const out = runApply(ed);
      assert.deepEqual(out.applied.sort(), [MS, TUT].sort());
      assert.deepEqual([...readPoolDescriptionsApplied(internal).keys()].sort(), [MS, TUT].sort());

      assert.deepEqual(readSourceDownloads(internal).get(MS), { ok: true });
      writeFileSync(join(ed, "02-reviewed.md"), readFileSync(join(internal, "02-draft.md"), "utf8"));
      const v = checkSourceNotRead(ed);
      const err = v.find((x) => x.severity === "error")!;
      assert.doesNotMatch(err.message, /Seven new/, "página lida e descrição reescrita: não bloqueia");
      assert.doesNotMatch(err.message, /Guia/);
      assert.match(err.message, /Bloqueado/, "o 403 segue bloqueando até o editor decidir");
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });
});

describe("writer-pool: Write restrito ao JSON de descrições (#13884)", () => {
  const W = (file_path: string) => ({ tool_name: "Write", agent_type: "writer-pool", tool_input: { file_path } });
  it("permite só _internal/02-pool-descriptions.json", () => {
    assert.equal(shouldBlockWrite(W("data/editions/2611/261125/_internal/02-pool-descriptions.json")), false);
    assert.equal(shouldBlockWrite(W(`${ROOT}/data/editions/261125/_internal/02-pool-descriptions.json`)), false);
    for (const p of [
      "data/editions/2611/261125/_internal/02-draft.md",
      "data/editions/2611/261125/_internal/pool-sources/descriptions-applied.json",
      "data/editions/2611/261125/_internal/02-pool-descriptions.json/../02-draft.md",
      "CLAUDE.md",
    ]) assert.equal(shouldBlockWrite(W(p)), true, p);
  });
  it("writer-destaque segue com a regra própria", () => {
    const D = (file_path: string) => ({ tool_name: "Write", agent_type: "writer-destaque", tool_input: { file_path } });
    assert.equal(shouldBlockWrite(D("data/editions/2611/261125/_internal/02-pool-descriptions.json")), true);
    assert.equal(shouldBlockWrite(D("data/editions/2611/261125/_internal/02-d1-draft.md")), false);
  });
});

describe("custo do download do pool (#13884 item 6)", () => {
  it("prefetch devolve duration_ms", async () => {
    const ed = mkdtempSync(join(tmpdir(), "pool-desc-dur-"));
    try {
      const fake = (async () => new Response(`<html><body><p>${PAGE}</p></body></html>`, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
      const r = await prefetchPoolSources(approved(), join(ed, "_internal"), { fetchImpl: fake });
      assert.equal(typeof r.duration_ms, "number");
      assert.ok(r.duration_ms >= 0);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });
});
