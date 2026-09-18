/**
 * test/image-pdf.test.ts (#8055)
 *
 * `scripts/lib/image-pdf.ts` escreve o PDF byte a byte, sem lib de
 * terceiro amortecendo erro de offset (ver docstring do módulo pelo
 * porquê). Então o teste NÃO se contenta com "não lançou": reabre o
 * arquivo gerado e confere que a tabela xref aponta de fato pro início de
 * cada objeto, que `startxref` aponta pro início da xref, e que os bytes
 * do JPEG entraram sem recompressão. Um offset errado produz PDF que abre
 * num leitor e falha em outro — o teste tem que pegar isso aqui, não na
 * hora de publicar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { buildImagePdf, readJpegHeader, type ImagePdfPage } from "../scripts/lib/image-pdf.ts";

/** JPEG baseline de verdade (via sharp, o mesmo encoder dos cards) — nunca
 *  um buffer sintético: metade do que este módulo faz é ler o header real. */
async function makeJpeg(width: number, height: number, opts: { progressive?: boolean; gray?: boolean } = {}): Promise<Uint8Array> {
  let img = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } },
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
});

describe("#8055 buildImagePdf — estrutura do arquivo, conferida de volta", () => {
  it("xref publica o offset REAL de cada objeto e startxref aponta pra xref", async () => {
    const jpeg = await makeJpeg(1080, 1350);
    const pages: ImagePdfPage[] = [
      { jpeg, widthPx: 1080, heightPx: 1350 },
      { jpeg, widthPx: 1080, heightPx: 1350 },
      { jpeg, widthPx: 1080, heightPx: 1350 },
    ];
    const pdf = buildImagePdf(pages);
    const s = text(pdf);

    assert.ok(s.startsWith("%PDF-1.4\n"), "cabeçalho PDF");
    assert.match(s, /%%EOF\n$/, "termina em %%EOF");

    // 2 objetos fixos + 3 por página.
    const objectCount = 2 + pages.length * 3;
    assert.match(s, new RegExp(`/Size ${objectCount + 1}\\b`), "trailer declara Size = objetos + 1");
    assert.match(s, new RegExp(`/Count ${pages.length}\\b`), "árvore de páginas declara Count");

    const startxrefMatch = s.match(/startxref\n(\d+)\n%%EOF/);
    assert.ok(startxrefMatch, "startxref presente");
    const xrefOffset = Number(startxrefMatch[1]);
    assert.equal(s.slice(xrefOffset, xrefOffset + 4), "xref", "startxref aponta pro início da tabela xref");

    // O coração do teste: cada entrada da xref tem que cair exatamente no
    // "<n> 0 obj" correspondente.
    const xrefBody = s.slice(xrefOffset);
    const entries = [...xrefBody.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    assert.equal(entries.length, objectCount, "uma entrada n por objeto");
    entries.forEach((off, idx) => {
      const num = idx + 1;
      assert.equal(s.slice(off, off + `${num} 0 obj`.length), `${num} 0 obj`, `xref do objeto ${num} aponta pro objeto ${num}`);
    });
  });

  it("os bytes do JPEG entram SEM recompressão (DCTDecode é passthrough)", async () => {
    const jpeg = await makeJpeg(400, 500);
    const pdf = buildImagePdf([{ jpeg, widthPx: 400, heightPx: 500 }]);
    assert.ok(
      Buffer.from(pdf).includes(Buffer.from(jpeg)),
      "o JPEG original aparece literalmente dentro do PDF — se falhar, houve reencode e o tamanho/qualidade mudaram",
    );
    assert.match(text(pdf), new RegExp(`/Length ${jpeg.length}\\b`), "/Length bate com o tamanho do JPEG");
  });

  it("página preserva o aspecto da imagem — nunca barra branca nem corte", async () => {
    const jpeg = await makeJpeg(1080, 1350);
    const pdf = buildImagePdf([{ jpeg, widthPx: 1080, heightPx: 1350 }], { pageWidthPt: 540 });
    // 540 × (1350/1080) = 675
    assert.match(text(pdf), /\/MediaBox \[0 0 540\.00 675\.00\]/);
  });

  it("imagem em tons de cinza sai como /DeviceGray (RGB fixo deixaria a página com cor errada)", async () => {
    const jpeg = await makeJpeg(100, 100, { gray: true });
    const pdf = buildImagePdf([{ jpeg, widthPx: 100, heightPx: 100, components: 1 }]);
    assert.match(text(pdf), /\/ColorSpace \/DeviceGray/);
    assert.doesNotMatch(text(pdf), /\/ColorSpace \/DeviceRGB/);
  });

  it("cada página ganha seu próprio XObject e Contents, com q/Q isolando a matriz", async () => {
    const jpeg = await makeJpeg(100, 125);
    const pdf = buildImagePdf([
      { jpeg, widthPx: 100, heightPx: 125 },
      { jpeg, widthPx: 100, heightPx: 125 },
    ]);
    const s = text(pdf);
    assert.equal((s.match(/\/Subtype \/Image/g) ?? []).length, 2);
    assert.equal((s.match(/q [\d.]+ 0 0 [\d.]+ 0 0 cm \/Im0 Do Q/g) ?? []).length, 2);
  });

  it("lista vazia falha alto — PDF sem página não é publicável", () => {
    assert.throws(() => buildImagePdf([]), /nenhuma página/);
  });

  it("dimensão inválida falha alto em vez de emitir MediaBox degenerado", async () => {
    const jpeg = await makeJpeg(100, 100);
    assert.throws(() => buildImagePdf([{ jpeg, widthPx: 0, heightPx: 100 }]), /dimensão inválida/);
  });
});
