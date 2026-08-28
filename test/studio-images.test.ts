/**
 * test/studio-images.test.ts (#6447 Fatia 4, achados 6 + 9)
 *
 * `scripts/studio-ui/studio-images.ts` — galeria de imagens (leitura pura de
 * disco, mesmo padrão de `test/studio-gate.test.ts`) e regeneração
 * assíncrona (`startRegenerateJob`, com `runScript` injetado — NUNCA spawna
 * um script real, que chamaria uma API de imagem paga de verdade).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildImagesGallery,
  buildRegenerateSteps,
  startRegenerateJob,
  getRegenerateJob,
  isImageTarget,
  defaultRunScript,
} from "../scripts/studio-ui/studio-images.ts";

function makeEdition(root: string, aammdd: string): string {
  const dir = resolve(root, "data", "editions", aammdd);
  mkdirSync(dir, { recursive: true });
  mkdirSync(resolve(dir, "_internal"), { recursive: true });
  return dir;
}

describe("isImageTarget", () => {
  it("aceita d1/d2/d3/eia", () => {
    assert.equal(isImageTarget("d1"), true);
    assert.equal(isImageTarget("d2"), true);
    assert.equal(isImageTarget("d3"), true);
    assert.equal(isImageTarget("eia"), true);
  });
  it("rejeita qualquer outra coisa", () => {
    assert.equal(isImageTarget("d4"), false);
    assert.equal(isImageTarget(""), false);
    assert.equal(isImageTarget("D1"), false);
  });
});

describe("buildImagesGallery (#6447 Fatia 4, achado 9)", () => {
  let root: string;
  const aammdd = "260828";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-images-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("AAMMDD inválido -> available:false", () => {
    const gallery = buildImagesGallery(root, "not-a-date");
    assert.equal(gallery.available, false);
  });

  it("edição inexistente -> available:false", () => {
    const gallery = buildImagesGallery(root, aammdd);
    assert.equal(gallery.available, false);
  });

  it("edição existente sem nenhuma imagem gerada ainda -> 3 destaques (default), tudo exists:false", () => {
    makeEdition(root, aammdd);
    const gallery = buildImagesGallery(root, aammdd);
    assert.equal(gallery.available, true);
    if (!gallery.available) return;
    assert.equal(gallery.destaques.length, 3);
    for (const d of gallery.destaques) {
      assert.equal(d.regenerating, false);
      for (const img of d.images) assert.equal(img.exists, false);
    }
    for (const img of gallery.eia.images) assert.equal(img.exists, false);
  });

  it("destaqueCount:2 (01-approved-capped.json) -> só D1/D2 na galeria", () => {
    const dir = makeEdition(root, aammdd);
    writeFileSync(
      resolve(dir, "_internal", "01-approved-capped.json"),
      JSON.stringify({ highlights: [{}, {}] }),
      "utf8",
    );
    const gallery = buildImagesGallery(root, aammdd);
    assert.equal(gallery.available, true);
    if (!gallery.available) return;
    assert.deepEqual(gallery.destaques.map((d) => d.n), [1, 2]);
  });

  it("imagens presentes em disco -> exists:true pros arquivos certos", () => {
    const dir = makeEdition(root, aammdd);
    writeFileSync(resolve(dir, "04-d1-2x1.jpg"), "fake", "utf8");
    writeFileSync(resolve(dir, "01-eia-A.jpg"), "fake", "utf8");
    const gallery = buildImagesGallery(root, aammdd);
    assert.equal(gallery.available, true);
    if (!gallery.available) return;
    const d1 = gallery.destaques.find((d) => d.n === 1);
    const twoByOne = d1?.images.find((img) => img.type === "2x1");
    assert.equal(twoByOne?.exists, true);
    const oneByOne = d1?.images.find((img) => img.type === "1x1");
    assert.equal(oneByOne?.exists, false);
    const eiaA = gallery.eia.images.find((img) => img.type === "eia-a");
    assert.equal(eiaA?.exists, true);
  });
});

describe("buildRegenerateSteps (#6447 Fatia 4 — espelha stage-3-run.ts)", () => {
  it("d1: 5 passos (lint pre-flight, 2x1/1x1, 4x5 nativo, compose, carrossel)", () => {
    const steps = buildRegenerateSteps("d1", "/tmp/edicao", "260828");
    assert.equal(steps.length, 5);
    // #6447 review (comment-analyzer, P1): lint-image-prompt.ts SEMPRE roda
    // primeiro, ANTES de qualquer chamada paga a image-generate.ts — mesma
    // ordem de stage-3-run.ts (linha ~420-436, lint pre-flight por destaque).
    assert.match(steps[0].script, /lint-image-prompt\.ts$/);
    assert.ok(steps[0].args[0].includes("02-d1-prompt.md"), "1º arg posicional deve ser o path do prompt");
    assert.match(steps[1].script, /image-generate\.ts$/);
    assert.ok(!steps[1].args.includes("--ratio"));
    assert.match(steps[2].script, /image-generate\.ts$/);
    assert.ok(steps[2].args.includes("--ratio"));
    assert.match(steps[3].script, /gen-social-card-4x5\.ts$/);
    assert.match(steps[4].script, /gen-carousel-cards\.ts$/);
  });

  it("eia: 1 passo (eia-compose --edition AAMMDD --force — CLI distinta, não --edition-dir)", () => {
    const steps = buildRegenerateSteps("eia", "/tmp/edicao", "260828");
    assert.equal(steps.length, 1);
    assert.match(steps[0].script, /eia-compose\.ts$/);
    assert.ok(steps[0].args.includes("--force"));
    const editionFlagIdx = steps[0].args.indexOf("--edition");
    assert.ok(editionFlagIdx >= 0, "--edition deve estar presente");
    assert.equal(steps[0].args[editionFlagIdx + 1], "260828");
    assert.ok(!steps[0].args.includes("--edition-dir"));
  });
});

// `jobs` (studio-images.ts) é um Map módulo-level, chaveado só por
// `{aammdd}:{target}` (não por `rootDir`) — cada teste usa um AAMMDD ÚNICO
// (nunca "260828" repetido) pra nunca colidir com o estado de um job
// deixado propositalmente pendurado (nunca resolvido, ver testes de
// duplo-clique/independência abaixo) de OUTRO teste desta mesma suíte.
let aammddCounter = 0;
function uniqueAammdd(): string {
  aammddCounter++;
  return String(300000 + aammddCounter);
}

describe("startRegenerateJob (#6447 Fatia 4 — runScript injetado, nunca spawn real)", () => {
  let root: string;
  let editionDir: string;
  let aammdd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-images-job-"));
    aammdd = uniqueAammdd();
    editionDir = makeEdition(root, aammdd);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("AAMMDD inválido -> ok:false", () => {
    const result = startRegenerateJob(root, "xx", "d1");
    assert.equal(result.ok, false);
  });

  it("target inválido -> ok:false", () => {
    const result = startRegenerateJob(root, aammdd, "d9");
    assert.equal(result.ok, false);
  });

  it("edição inexistente -> ok:false", () => {
    const result = startRegenerateJob(root, "999999", "d1");
    assert.equal(result.ok, false);
  });

  it("d1 sem prompt editorial em disco -> ok:false, mensagem nomeia o arquivo esperado", () => {
    const result = startRegenerateJob(root, aammdd, "d1");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /02-d1-prompt\.md/);
  });

  it("job de sucesso: roda os 4 passos em ordem, status termina 'done'", async () => {
    writeFileSync(resolve(editionDir, "_internal", "02-d1-prompt.md"), "cena de teste", "utf8");
    const calls: string[] = [];
    const runScript = async (script: string) => {
      calls.push(script);
      return { code: 0, stderr: "" };
    };
    const result = startRegenerateJob(root, aammdd, "d1", { runScript });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.alreadyRunning, false);
    assert.equal(result.job.status, "running");

    // A cadeia roda em background (fire-and-forget) — espera as 4 chamadas
    // assíncronas resolverem antes de checar o estado final.
    await new Promise((r) => setTimeout(r, 20));
    const job = getRegenerateJob(aammdd, "d1");
    assert.equal(job?.status, "done");
    assert.equal(calls.length, 5); // lint + image-generate x2 + gen-social-card-4x5 + gen-carousel-cards
    assert.ok(job?.steps.every((s) => s.code === 0));
  });

  it("job de falha no meio da cadeia: para no passo que falhou, status 'error' com o motivo", async () => {
    writeFileSync(resolve(editionDir, "_internal", "02-d1-prompt.md"), "cena de teste", "utf8");
    let call = 0;
    const runScript = async () => {
      call++;
      if (call === 2) return { code: 1, stderr: "linha 1\nlinha 2 do erro real" };
      return { code: 0, stderr: "" };
    };
    startRegenerateJob(root, aammdd, "d1", { runScript });
    await new Promise((r) => setTimeout(r, 20));
    const job = getRegenerateJob(aammdd, "d1");
    assert.equal(job?.status, "error");
    assert.equal(call, 2); // parou no 2º passo, nunca chegou no 3º/4º
    assert.match(job?.error ?? "", /linha 2 do erro real/);
  });

  it("#6447 review (silent-failure-hunter): runScript que REJEITA (em vez de resolver) nunca vira unhandled rejection — job termina 'error'", async () => {
    writeFileSync(resolve(editionDir, "_internal", "02-d1-prompt.md"), "cena de teste", "utf8");
    let call = 0;
    const runScript = async () => {
      call++;
      if (call === 2) throw new Error("falha síncrona inesperada no runScript");
      return { code: 0, stderr: "" };
    };
    startRegenerateJob(root, aammdd, "d1", { runScript });
    await new Promise((r) => setTimeout(r, 20));
    const job = getRegenerateJob(aammdd, "d1");
    assert.equal(job?.status, "error");
    assert.match(job?.error ?? "", /falha síncrona inesperada no runScript/);
    assert.ok(job?.finishedAt);
  });

  it("#6447 review (code-reviewer): buildImagesGallery expõe lastError do último job que falhou pro destaque", async () => {
    writeFileSync(resolve(editionDir, "_internal", "02-d1-prompt.md"), "cena de teste", "utf8");
    const runScript = async () => ({ code: 1, stderr: "violação: Starry Night mencionado" });
    startRegenerateJob(root, aammdd, "d1", { runScript });
    await new Promise((r) => setTimeout(r, 20));
    const gallery = buildImagesGallery(root, aammdd);
    assert.equal(gallery.available, true);
    if (!gallery.available) return;
    const d1 = gallery.destaques.find((d) => d.n === 1);
    assert.match(d1?.lastError ?? "", /Starry Night/);
    assert.equal(d1?.regenerating, false); // já terminou (com erro), não está mais rodando
  });

  it("duplo-clique enquanto running -> alreadyRunning:true, NUNCA dispara um 2º processo", async () => {
    writeFileSync(resolve(editionDir, "_internal", "02-d1-prompt.md"), "cena de teste", "utf8");
    let calls = 0;
    let releaseFirstStep: (() => void) | null = null;
    const runScript = () =>
      new Promise<{ code: number; stderr: string }>((resolvePromise) => {
        calls++;
        releaseFirstStep = () => resolvePromise({ code: 0, stderr: "" });
      });
    const first = startRegenerateJob(root, aammdd, "d1", { runScript });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.alreadyRunning, false);

    const second = startRegenerateJob(root, aammdd, "d1", { runScript });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.alreadyRunning, true);
    assert.equal(calls, 1); // só 1 processo real disparado, apesar dos 2 cliques

    releaseFirstStep?.();
  });

  it("eia e d1 são jobs INDEPENDENTES — regenerar um não bloqueia o outro", () => {
    writeFileSync(resolve(editionDir, "_internal", "02-d1-prompt.md"), "cena de teste", "utf8");
    let released: (() => void) | null = null;
    const blockingRunScript = () =>
      new Promise<{ code: number; stderr: string }>((r) => {
        released = () => r({ code: 0, stderr: "" });
      });
    const d1Result = startRegenerateJob(root, aammdd, "d1", { runScript: blockingRunScript });
    assert.equal(d1Result.ok, true);

    const eiaResult = startRegenerateJob(root, aammdd, "eia", { runScript: async () => ({ code: 0, stderr: "" }) });
    assert.equal(eiaResult.ok, true);
    if (!eiaResult.ok) return;
    assert.equal(eiaResult.alreadyRunning, false); // não é bloqueado pelo job de d1 em progresso

    released?.();
  });
});

// #6447 review (pr-test-analyzer, P2): toda a cobertura acima injeta
// `runScript` — o wrapper de `spawn` de verdade (`defaultRunScript`) nunca
// era exercitado. Usa um script Node fixture descartável (nunca um script
// real da pipeline) — zero custo de API, valida só a mecânica de
// captura/exit-code.
describe("defaultRunScript (#6447 review — spawn real, script fixture descartável)", () => {
  // `--import tsx` precisa resolver o pacote `tsx` a partir do `cwd` do
  // processo filho — por isso `cwd` aqui é a RAIZ DO REPO (onde `node_modules/
  // tsx` existe de verdade), nunca o tmpdir do fixture. `scriptRelPath` pode
  // ser um path ABSOLUTO (o `resolve(cwd, scriptRelPath)` interno de
  // `defaultRunScript` devolve o absoluto inalterado independente do `cwd`),
  // então o fixture pode morar fora do repo sem afetar a resolução do `tsx`.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "studio-images-runscript-"));
  });
  afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

  it("captura stdout: exit 0, escreve em stdout -> code:0, stdout aparece no stderr combinado com marcador [stdout]", async () => {
    const scriptPath = resolve(fixtureDir, "ok.ts");
    writeFileSync(scriptPath, 'console.log("linha de progresso no stdout"); process.exit(0);\n', "utf8");
    const result = await defaultRunScript(scriptPath, [], repoRoot);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /\[stdout\]/);
    assert.match(result.stderr, /linha de progresso no stdout/);
  });

  it("captura stderr + exit code não-zero", async () => {
    const scriptPath = resolve(fixtureDir, "fail.ts");
    writeFileSync(scriptPath, 'process.stderr.write("erro real do script\\n"); process.exit(1);\n', "utf8");
    const result = await defaultRunScript(scriptPath, [], repoRoot);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /erro real do script/);
  });

  it("script com args recebidos corretamente (positional + flag)", async () => {
    const scriptPath = resolve(fixtureDir, "echo-args.ts");
    writeFileSync(scriptPath, 'console.error(JSON.stringify(process.argv.slice(2))); process.exit(0);\n', "utf8");
    const result = await defaultRunScript(scriptPath, ["--foo", "bar", "positional"], repoRoot);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /"--foo","bar","positional"/);
  });
});
