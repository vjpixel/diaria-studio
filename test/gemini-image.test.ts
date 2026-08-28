/**
 * test/gemini-image.test.ts (#6459)
 *
 * Edição 260828: a imagem B do EIA (águia-cobreira via Gemini) saiu com a
 * cabeça cortada no topo do frame — 2 gerações consecutivas com o mesmo
 * prompt reproduziram o corte; só a 3ª tentativa, com headroom pedido à mão
 * no prompt, saiu correta. `scripts/gemini-image.js` fazia
 * `sharp(trimmed).resize(w, h, { fit: 'cover' })` sem `position` explícito
 * (default `'centre'`) — crop uniforme em todos os lados, que corta o topo
 * quando o sujeito gerado já está próximo da borda superior.
 *
 * Fix de 2 pontas, os dois cobertos aqui:
 *   1. `buildPrompt` — instrução de headroom explícita, junto do "fill
 *      entire canvas" já existente (influencia o que o Gemini GERA).
 *   2. `buildResizeOptions` — `position: sharp.strategy.attention` em vez do
 *      default `'centre'` (rede de segurança determinística no CROP, cobre
 *      o caso em que o prompt sozinho não bastar, como aconteceu 2x na
 *      edição real antes da 3ª tentativa manual).
 *
 * Sem chamada real à API do Gemini — só as duas funções puras exportadas.
 * `buildResizeOptions` é testado tanto pelo valor da opção quanto por um
 * crop de verdade via sharp (imagem sintética com o "sujeito" perto do
 * topo), pra travar que 'attention' de fato preserva o topo onde 'centre'
 * cortaria — e que o caso comum (sujeito centralizado) não regride.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { buildPrompt, buildResizeOptions } from "../scripts/gemini-image.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Regressão #6486 (achado ao vivo, edição 260828).
 *
 * `scripts/gemini-image.js` comparava `import.meta.url` com
 * `` `file://${process.argv[1]}` `` cru — no Windows, `process.argv[1]` vem
 * como `C:\Users\...\gemini-image.js` (backslash, sem URL-encoding) enquanto
 * `import.meta.url` é `file:///C:/Users/.../gemini-image.js` (barras normais,
 * triplo-slash). A comparação nunca batia, `isMainModule` era sempre
 * `false`, `main()` nunca rodava, e o processo saía com exit 0 sem gerar a
 * imagem nem imprimir nada — falha silenciosa. O fix troca o guard inline
 * por uma comparação via `fileURLToPath` (node:url nativo), que normaliza
 * os dois lados antes de comparar.
 *
 * Revisão (#6492): a 1ª versão do fix importava `isMainModule` de
 * `scripts/lib/cli-args.ts` (extensão `.ts`) dentro deste `.js` — mas
 * `gemini-image.js` é invocado em produção via `node` PURO, não `tsx`
 * (`image-generate.ts` chama `execFileSync(process.execPath, [imageScript,
 * ...])`, sem loader). Importar `.ts` a partir de um `.js` rodado por `node`
 * puro só funciona em Node com type-stripping nativo sem flag (23.6+) — o
 * floor declarado do repo (`engines.node >=22.5.0`) é anterior a isso, e o
 * repo já documenta esse exato cuidado em `backfill-score-by-month.ts` pro
 * caso inverso (import `.ts`→`.ts`, seguro só porque o runner ali é sempre
 * `tsx`). O fix final usa `fileURLToPath` inline, sem cruzar a fronteira de
 * extensão.
 */
describe("gemini-image.js usa fileURLToPath (#6486)", () => {
  it("compara fileURLToPath(import.meta.url) inline, sem importar .ts nem montar o guard `file://` à mão", () => {
    const source = readFileSync(resolve(ROOT, "scripts/gemini-image.js"), "utf8");
    assert.doesNotMatch(
      source,
      /from ['"]\.\/lib\/cli-args(\.ts)?['"]/,
      "gemini-image.js não deve importar de ./lib/cli-args — é um .js invocado via `node` puro (execFileSync em image-generate.ts), não via tsx; importar um .ts quebraria em Node <23.6 (floor do repo é 22.5)",
    );
    assert.match(
      source,
      /fileURLToPath\(import\.meta\.url\)\s*===\s*process\.argv\[1\]/,
      "gemini-image.js deve comparar fileURLToPath(import.meta.url) com process.argv[1]",
    );
    assert.doesNotMatch(
      source,
      /import\.meta\.url\s*===\s*`file:\/\//,
      "gemini-image.js não deve mais comparar import.meta.url com um template `file://` cru (bug do #6486)",
    );
  });

  it("rodando via `node` puro (não tsx) — o mesmo jeito que image-generate.ts invoca de verdade — carrega e executa main()", () => {
    // Regressão da revisão do #6492: a 1ª versão do fix (import de .ts em
    // um .js rodado por node puro) não seria pega pela suíte de testes, que
    // roda tudo via `node --import tsx --test` (package.json) — o loader
    // tsx mascara justamente o problema. Este teste spawna o processo real,
    // sem loader nenhum, exatamente como `execFileSync(process.execPath, ...)`
    // em image-generate.ts — provando que o arquivo carrega de verdade e que
    // main() roda (chega no "Usage:" + exit 2, sem custo de API).
    const result = spawnSync(process.execPath, [resolve(ROOT, "scripts/gemini-image.js")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 2, `esperava exit 2 (uso incorreto); stderr: ${result.stderr}`);
    assert.match(result.stderr ?? "", /Usage: node scripts\/gemini-image\.js/);
  });

  it("reproduz o par (argv[1], import.meta.url) real do Windows — o guard cru nunca bateria", () => {
    // `fileURLToPath`/o par produzido por argv[1]+import.meta.url é
    // PLATFORM-DEPENDENT no próprio Node (confirmado ao vivo: rodando este
    // teste em Linux, `fileURLToPath("file:///C:/Users/.../gemini-image.js")`
    // devolve `/C:/Users/.../gemini-image.js`, não a forma com backslash que
    // um host Windows de verdade produziria) — então simular o par Windows
    // aqui não pode provar que `isMainModule` "resolve certo" nesse host
    // específico sem rodar em win32 de verdade. O que ESTE teste prova,
    // executável em qualquer SO: o guard ANTIGO (`file://${argv[1]}` cru)
    // nunca bate no par real que um Windows produz — é a causa raiz do
    // #6486. A correção em si (delegar a `fileURLToPath`, API nativa do
    // Node.js já testada para win32 fora deste repo) é validada quanto ao
    // PAR QUE O SO ATUAL produz pelo teste "isMainModule casa o par..." em
    // test/main-module-guard.test.ts — mesma técnica usada ali para o bug
    // gêmeo do #6191 em route-issue.ts.
    const windowsArgv1 = "C:\\Users\\ed\\Projects\\diaria-studio\\scripts\\gemini-image.js";
    const windowsMetaUrl = "file:///C:/Users/ed/Projects/diaria-studio/scripts/gemini-image.js";
    assert.notEqual(
      windowsMetaUrl,
      `file://${windowsArgv1}`,
      "o guard cru `file://${argv[1]}` nunca bate no par que um Windows real produz — é o bug inteiro do #6486",
    );
  });

  it("fileURLToPath casa o par (import.meta.url, argv[1]) que este SO produz de verdade, pro path de gemini-image.js", () => {
    // Complemento do teste acima, na técnica correta pra qualquer SO: usa o
    // par que a PRÓPRIA máquina rodando o teste produz para este arquivo
    // (fileURLToPath/pathToFileURL fazem o round-trip nativo do Node,
    // corretamente por plataforma) — no CI Linux é o caso que o bug NÃO
    // afetava (acerto por acidente); numa máquina Windows real seria
    // exatamente o caso que o guard antigo quebrava e o novo conserta.
    const scriptPath = resolve(ROOT, "scripts/gemini-image.js");
    const metaUrl = pathToFileURL(scriptPath).href;
    assert.equal(fileURLToPath(metaUrl), scriptPath);
    assert.notEqual(fileURLToPath(metaUrl), resolve(ROOT, "scripts/outro-script.ts"));
  });

  it("fileURLToPath continua correto no formato Unix/Linux (caminho que já funcionava)", () => {
    const unixArgv1 = "/home/ed/diaria-studio/scripts/gemini-image.js";
    const unixMetaUrl = "file:///home/ed/diaria-studio/scripts/gemini-image.js";
    assert.equal(fileURLToPath(unixMetaUrl), unixArgv1);
    assert.notEqual(fileURLToPath(unixMetaUrl), "/home/ed/diaria-studio/scripts/outro-script.ts");
  });
});

describe("buildPrompt (#6459)", () => {
  it("inclui instrução explícita de headroom acima do sujeito", () => {
    const prompt = buildPrompt({ positive: "a snake eagle perched on a branch" });
    assert.match(prompt, /headroom/i);
    assert.match(prompt, /never touching or almost touching the top edge/i);
  });

  it("mantém a instrução pré-existente de preencher o canvas inteiro", () => {
    const prompt = buildPrompt({ positive: "a snake eagle" });
    assert.match(prompt, /fill the ENTIRE image edge to edge/i);
  });

  it("preserva o texto positivo original e o negative prompt quando presente", () => {
    const prompt = buildPrompt({ positive: "base description", negative: "watermark, text" });
    assert.match(prompt, /^base description/);
    assert.match(prompt, /watermark, text/);
  });

  it("não quebra quando negative está ausente", () => {
    const prompt = buildPrompt({ positive: "base description" });
    assert.doesNotMatch(prompt, /undefined/);
  });
});

describe("buildResizeOptions (#6459)", () => {
  it("usa fit:cover com position:attention (saliency), não o default centre", () => {
    const opts = buildResizeOptions();
    assert.equal(opts.fit, "cover");
    assert.equal(opts.position, sharp.strategy.attention);
  });

  it("crop com attention preserva mais do topo que centre quando o sujeito está perto da borda superior", async () => {
    // Imagem sintética: faixa de alta saliência (ruído colorido, "sujeito")
    // no terço superior, resto uniforme (fundo liso) — mimetiza uma
    // composição gerada com a cabeça perto do topo do frame, como no
    // incidente real (águia-cobreira, edição 260828).
    const width = 800;
    const height = 800;
    const subjectBandHeight = 150; // faixa "sujeito" nas primeiras linhas

    const background = await sharp({
      create: { width, height, channels: 3, background: { r: 40, g: 40, b: 40 } },
    })
      .png()
      .toBuffer();

    const subjectBand = await sharp({
      create: { width, height: subjectBandHeight, channels: 3, background: { r: 0, g: 0, b: 0 }, noise: { type: "gaussian", mean: 128, sigma: 60 } },
    })
      .png()
      .toBuffer();

    const source = await sharp(background)
      .composite([{ input: subjectBand, top: 0, left: 0 }])
      .jpeg({ quality: 95 })
      .toBuffer();

    // Alvo 800x450 — mesmo aspect ratio do EIA (2:1), força crop vertical.
    const targetW = 800;
    const targetH = 450;

    const attentionCrop = await sharp(source)
      .resize(targetW, targetH, buildResizeOptions())
      .raw()
      .toBuffer({ resolveWithObject: true });

    const centreCrop = await sharp(source)
      .resize(targetW, targetH, { fit: "cover" }) // default position: 'centre'
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Média de luminância da 1ª linha do resultado: se o topo (faixa ruidosa,
    // média ~128) sobreviveu ao crop, a linha 0 tem média bem acima do fundo
    // liso (40). Com 'centre' num crop vertical de 800x800→800x450, a janela
    // fica no meio da imagem e a faixa de 150px do topo já não aparece mais
    // na linha 0 — cai no fundo escuro.
    function firstRowMean(buf: Buffer, channels: number): number {
      let sum = 0;
      const rowBytes = targetW * channels;
      for (let i = 0; i < rowBytes; i++) sum += buf[i];
      return sum / rowBytes;
    }

    const attentionMean = firstRowMean(attentionCrop.data, attentionCrop.info.channels);
    const centreMean = firstRowMean(centreCrop.data, centreCrop.info.channels);

    assert.ok(
      attentionMean > centreMean,
      `esperava attention (${attentionMean.toFixed(1)}) preservar mais do topo que centre (${centreMean.toFixed(1)})`,
    );
  });

  it("caso comum (sujeito centralizado) — crop com attention ainda produz as dimensões pedidas", async () => {
    // Regressão inversa: garantir que a mudança de position não quebra o
    // caso majoritário (composição já centralizada) — resize deve sempre
    // sair com exatamente as dimensões pedidas, independente de onde a
    // saliência mais forte cair.
    const source = await sharp({
      create: { width: 900, height: 900, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: "gaussian", mean: 128, sigma: 30 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const resized = await sharp(source)
      .resize(800, 450, buildResizeOptions())
      .jpeg({ quality: 90 })
      .toBuffer();

    const meta = await sharp(resized).metadata();
    assert.equal(meta.width, 800);
    assert.equal(meta.height, 450);
  });
});
