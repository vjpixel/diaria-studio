/**
 * test/image-pdf.test.ts (#8055)
 *
 * `scripts/lib/image-pdf.ts` escreve o PDF byte a byte, sem lib de
 * terceiro amortecendo erro de offset (ver docstring do módulo pelo
 * porquê). Então o teste NÃO se contenta com "não lançou": reabre o
 * arquivo gerado e confere que a tabela xref aponta de fato pro início de
 * cada objeto, que `startxref` aponta pro início da xref, e que os bytes
 * do JPEG entraram sem recompressão.
 *
 * **Cada página usa um JPEG DIFERENTE** (#8305 review): com o mesmo buffer
 * repetido, nada distinguiria "página 1 mostra a capa" de "página 1 mostra
 * o slide 3" — um bug que invertesse a ordem, duplicasse ou trocasse o
 * XObject de uma página passaria batido mantendo `/Count` correto. Como o
 * artefato é um carrossel (capa → notícias → CTA), ordem errada é a falha
 * mais consequente que existe aqui, e era justamente a que a versão
 * anterior deste arquivo não pegava.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { buildImagePdf, readJpegHeader, type ImagePdfPage } from "../scripts/lib/image-pdf.ts";

/** JPEG baseline de verdade (via sharp, o mesmo encoder dos cards) — nunca
 *  um buffer sintético: metade do que este módulo faz é ler o header real.
 *  `tint` muda os BYTES, o que é o que permite provar qual imagem foi parar
 *  em qual página. */
async function makeJpeg(
  width: number,
  height: number,
  opts: { progressive?: boolean; gray?: boolean; tint?: { r: number; g: number; b: number } } = {},
): Promise<Uint8Array> {
  let img = sharp({
    create: { width, height, channels: 3, background: opts.tint ?? { r: 200, g: 40, b: 90 } },
  });
  // `.grayscale()` sozinho só dessatura — o JPEG sai com 3 componentes
  // mesmo assim. `toColourspace("b-w")` é o que de fato emite 1 canal.
  if (opts.gray) img = img.grayscale().toColourspace("b-w");
  const buf = await img.jpeg({ quality: 80, progressive: opts.progressive ?? false }).toBuffer();
  return new Uint8Array(buf);
}

function text(pdf: Uint8Array): string {
  return Buffer.from(pdf).toString("latin1");
}

/** Reabre o PDF como um leitor faria — entra pela `startxref`, lê a tabela,
 *  e devolve, POR PÁGINA e na ordem da árvore, os bytes exatos do stream da
 *  imagem. É o que permite afirmar "a página N embute a imagem N". */
function readPdfPageImages(pdf: Uint8Array): Uint8Array[] {
  const s = text(pdf);
  const startxref = s.match(/startxref\n(\d+)\n%%EOF/);
  assert.ok(startxref, "startxref presente");
  const xrefOff = Number(startxref[1]);
  const entries = [...s.slice(xrefOff).matchAll(/^(\d{10}) \d{5} n $/gm)].map((m) => Number(m[1]));

  const objBody = (num: number): string => {
    const off = entries[num - 1];
    assert.equal(s.slice(off, off + `${num} 0 obj`.length), `${num} 0 obj`, `xref do objeto ${num} aponta pro objeto ${num}`);
    return s.slice(off, s.indexOf("endobj", off));
  };

  const rootNum = Number(s.match(/\/Root (\d+) 0 R/)![1]);
  const pagesNum = Number(objBody(rootNum).match(/\/Pages (\d+) 0 R/)![1]);
  const kids = [...objBody(pagesNum).matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));

  return kids.map((kid) => {
    const imNum = Number(objBody(kid).match(/\/Im0 (\d+) 0 R/)![1]);
    const off = entries[imNum - 1];
    const len = Number(objBody(imNum).match(/\/Length (\d+)/)![1]);
    const start = s.indexOf("stream\n", off) + "stream\n".length;
    return pdf.subarray(start, start + len);
  });
}

describe("#8055 readJpegHeader — dimensões e componentes direto dos bytes", () => {
  it("lê largura/altura/componentes de um JPEG baseline colorido", async () => {
    const jpeg = await makeJpeg(1080, 1350);
    assert.deepEqual(readJpegHeader(jpeg), { widthPx: 1080, heightPx: 1350, components: 3 });
  });

  it("JPEG em tons de cinza reporta 1 componente (vira /DeviceGray, não /DeviceRGB)", async () => {
    const jpeg = await makeJpeg(100, 200, { gray: true });
    assert.equal(readJpegHeader(jpeg).components, 1);
  });

  it("JPEG PROGRESSIVO é recusado com mensagem acionável — DCTDecode renderiza página em branco", async () => {
    const jpeg = await makeJpeg(100, 100, { progressive: true });
    assert.throws(() => readJpegHeader(jpeg), /progressivo.*DCTDecode|DCTDecode.*progressiv/i);
  });

  it("não-JPEG falha alto em vez de gerar PDF corrompido", () => {
    assert.throws(() => readJpegHeader(new Uint8Array([1, 2, 3, 4])), /não é um JPEG/);
  });

  it("#8305 — JPEG TRUNCADO (sem EOI) é recusado: header íntegro esconderia uma página corrompida", async () => {
    // Cortar DEPOIS do SOF deixa largura/altura corretas — exatamente o caso
    // em que todas as checagens estruturais passam e a página sai quebrada.
    const full = await makeJpeg(400, 500);
    const truncated = full.subarray(0, Math.floor(full.length * 0.6));
    assert.throws(() => readJpegHeader(truncated), /EOI|truncado/i);
  });
});

describe("#8055 buildImagePdf — estrutura do arquivo, conferida de volta", () => {
  it("xref publica o offset REAL de cada objeto e startxref aponta pra xref", async () => {
    const jpeg = await makeJpeg(1080, 1350);
    const pages: ImagePdfPage[] = [{ jpeg }, { jpeg }, { jpeg }];
    const pdf = buildImagePdf(pages);
    const s = text(pdf);

    assert.ok(s.startsWith("%PDF-1.4\n"), "cabeçalho PDF");
    assert.match(s, /%%EOF\n$/, "termina em %%EOF");

    const objectCount = 2 + pages.length * 3;
    assert.match(s, new RegExp(`/Size ${objectCount + 1}\\b`), "trailer declara Size = objetos + 1");
    assert.match(s, new RegExp(`/Count ${pages.length}\\b`), "árvore de páginas declara Count");

    const startxrefMatch = s.match(/startxref\n(\d+)\n%%EOF/);
    assert.ok(startxrefMatch, "startxref presente");
    const xrefOffset = Number(startxrefMatch[1]);
    assert.equal(s.slice(xrefOffset, xrefOffset + 4), "xref", "startxref aponta pro início da tabela xref");

    const xrefBody = s.slice(xrefOffset);
    const entries = [...xrefBody.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    assert.equal(entries.length, objectCount, "uma entrada n por objeto");
    entries.forEach((off, idx) => {
      const num = idx + 1;
      assert.equal(s.slice(off, off + `${num} 0 obj`.length), `${num} 0 obj`, `xref do objeto ${num} aponta pro objeto ${num}`);
    });
  });

  it("#8305 — a página N embute a imagem N: ordem e ligação página↔imagem, não só contagem", async () => {
    // 3 JPEGs com cores diferentes = bytes diferentes. É isto que distingue
    // "montou na ordem" de "montou 3 páginas".
    const jpegs = [
      await makeJpeg(400, 500, { tint: { r: 255, g: 0, b: 0 } }),
      await makeJpeg(400, 500, { tint: { r: 0, g: 255, b: 0 } }),
      await makeJpeg(400, 500, { tint: { r: 0, g: 0, b: 255 } }),
    ];
    assert.notDeepEqual(jpegs[0], jpegs[1], "fixture precisa ser distinguível, senão o teste não vale nada");

    const embedded = readPdfPageImages(buildImagePdf(jpegs.map((jpeg) => ({ jpeg }))));
    assert.equal(embedded.length, 3);
    embedded.forEach((bytes, i) => {
      assert.deepEqual(Buffer.from(bytes), Buffer.from(jpegs[i]), `página ${i + 1} tem que embutir a imagem ${i + 1}`);
    });
  });

  it("os bytes do JPEG entram SEM recompressão, e o stream começa/termina onde /Length diz", async () => {
    const jpeg = await makeJpeg(400, 500);
    const pdf = buildImagePdf([{ jpeg }]);
    // Fatia pelo /Length declarado e compara — mais forte que um `includes`,
    // que passaria mesmo com o /Length errado.
    const [embedded] = readPdfPageImages(pdf);
    assert.deepEqual(Buffer.from(embedded), Buffer.from(jpeg));
    assert.match(text(pdf), new RegExp(`/Length ${jpeg.length}\\b`), "/Length bate com o tamanho do JPEG");
  });

  it("página preserva o aspecto da imagem — nunca barra branca nem corte", async () => {
    const jpeg = await makeJpeg(1080, 1350);
    const pdf = buildImagePdf([{ jpeg }], { pageWidthPt: 540 });
    // 540 × (1350/1080) = 675
    assert.match(text(pdf), /\/MediaBox \[0 0 540\.00 675\.00\]/);
  });

  it("#8305 — páginas com aspectos DIFERENTES ganham MediaBox diferentes", async () => {
    const quadrada = await makeJpeg(400, 400);
    const retrato = await makeJpeg(400, 800);
    const s = text(buildImagePdf([{ jpeg: quadrada }, { jpeg: retrato }], { pageWidthPt: 300 }));
    assert.match(s, /\/MediaBox \[0 0 300\.00 300\.00\]/, "1ª página quadrada");
    assert.match(s, /\/MediaBox \[0 0 300\.00 600\.00\]/, "2ª página retrato");
  });

  it("imagem em tons de cinza sai como /DeviceGray (RGB fixo deixaria a página com cor errada)", async () => {
    const jpeg = await makeJpeg(100, 100, { gray: true });
    const pdf = buildImagePdf([{ jpeg }]);
    assert.match(text(pdf), /\/ColorSpace \/DeviceGray/);
    assert.doesNotMatch(text(pdf), /\/ColorSpace \/DeviceRGB/);
  });

  it("cada página ganha seu próprio XObject e Contents, com q/Q isolando a matriz", async () => {
    const jpeg = await makeJpeg(100, 125);
    const pdf = buildImagePdf([{ jpeg }, { jpeg }]);
    const s = text(pdf);
    assert.equal((s.match(/\/Subtype \/Image/g) ?? []).length, 2);
    assert.equal((s.match(/q [\d.]+ 0 0 [\d.]+ 0 0 cm \/Im0 Do Q/g) ?? []).length, 2);
  });

  it("lista vazia falha alto — PDF sem página não é publicável", () => {
    assert.throws(() => buildImagePdf([]), /nenhuma página/);
  });

  it("#8305 — JPEG inválido numa página nomeia QUAL página falhou", async () => {
    const ok = await makeJpeg(100, 100);
    assert.throws(() => buildImagePdf([{ jpeg: ok }, { jpeg: new Uint8Array([1, 2, 3, 4]) }]), /página 2/);
  });

  it("#8305 — pageWidthPt inválido falha alto em vez de emitir MediaBox degenerado", async () => {
    const jpeg = await makeJpeg(100, 100);
    assert.throws(() => buildImagePdf([{ jpeg }], { pageWidthPt: 0 }), /pageWidthPt/);
  });
});
