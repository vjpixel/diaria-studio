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
import { join, resolve } from "node:path";
import {
  buildImagesGallery,
  buildRegenerateSteps,
  startRegenerateJob,
  getRegenerateJob,
  isImageTarget,
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
  it("d1: 4 passos (2x1/1x1, 4x5 nativo, compose, carrossel)", () => {
    const steps = buildRegenerateSteps("d1", "/tmp/edicao", "260828");
    assert.equal(steps.length, 4);
    assert.match(steps[0].script, /image-generate\.ts$/);
    assert.ok(!steps[0].args.includes("--ratio"));
    assert.match(steps[1].script, /image-generate\.ts$/);
    assert.ok(steps[1].args.includes("--ratio"));
    assert.match(steps[2].script, /gen-social-card-4x5\.ts$/);
    assert.match(steps[3].script, /gen-carousel-cards\.ts$/);
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
    assert.equal(calls.length, 4);
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
