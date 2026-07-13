import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPublicImagesManifest } from "../scripts/monthly-preview-cloudflare.ts";
import { embedImagesAsDataUri } from "../scripts/embed-images-base64.ts";

/**
 * #3392: o pipeline MENSAL reproduzia a mesma regressão de CSP do diário
 * (#3214/#3370) — Claude Artifacts bloqueiam `<img src="https://...">` remoto
 * (só `data:` URI), então `cloudflare-preview.html` (imagens em
 * poll.diaria.workers.dev) nunca renderizava imagem dentro do preview do
 * gate Etapa 3/4. O diário já tinha `scripts/embed-images-base64.ts`
 * (testado, #3370) — faltava só o manifest `{ url, filename, mime_type }`
 * que o mensal não gravava (o diário grava via `upload-images-public.ts`,
 * o mensal não tinha equivalente). `buildPublicImagesManifest` (adicionado
 * em `monthly-preview-cloudflare.ts`) fecha esse gap.
 *
 * Estes testes cobrem (a) a função pura de montagem do manifest e (b) que o
 * manifest produzido realmente funciona como input de `embedImagesAsDataUri`
 * — ou seja, que a composição dos dois scripts resolve o bug de ponta a
 * ponta, não só cada peça isoladamente.
 */

describe("buildPublicImagesManifest (#3392)", () => {
  it("inclui eia_a/eia_b só quando url E filename (upload bem-sucedido) estão presentes", () => {
    const manifest = buildPublicImagesManifest(
      { a: "https://poll.diaria.workers.dev/img/x-eia-a.jpg", b: "https://poll.diaria.workers.dev/img/x-eia-b.jpg", aFilename: "01-eia-A.jpg", bFilename: "01-eia-B.jpg" },
      {},
      undefined,
    );
    assert.deepEqual(manifest.eia_a, { url: "https://poll.diaria.workers.dev/img/x-eia-a.jpg", filename: "01-eia-A.jpg", mime_type: "image/jpeg" });
    assert.deepEqual(manifest.eia_b, { url: "https://poll.diaria.workers.dev/img/x-eia-b.jpg", filename: "01-eia-B.jpg", mime_type: "image/jpeg" });
  });

  it("usa o filename legado (01-eai-*) quando é o par que a upload resolveu", () => {
    const manifest = buildPublicImagesManifest(
      { a: "https://poll.diaria.workers.dev/img/y.jpg", b: "https://poll.diaria.workers.dev/img/z.jpg", aFilename: "01-eai-A.jpg", bFilename: "01-eai-B.jpg" },
      {},
      undefined,
    );
    assert.equal(manifest.eia_a.filename, "01-eai-A.jpg");
    assert.equal(manifest.eia_b.filename, "01-eai-B.jpg");
  });

  it("omite eia_a/eia_b quando uploadEiaImages não achou o par (sem url, sem filename)", () => {
    const manifest = buildPublicImagesManifest({}, {}, undefined);
    assert.equal(manifest.eia_a, undefined);
    assert.equal(manifest.eia_b, undefined);
  });

  it("monta slots d1/d2/d3 a partir do map de destaqueImages, com filename 04-d{n}-2x1.jpg", () => {
    const manifest = buildPublicImagesManifest(
      {},
      { 1: "https://poll.diaria.workers.dev/img/d1.jpg", 3: "https://poll.diaria.workers.dev/img/d3.jpg" },
      undefined,
    );
    assert.deepEqual(manifest.d1, { url: "https://poll.diaria.workers.dev/img/d1.jpg", filename: "04-d1-2x1.jpg", mime_type: "image/jpeg" });
    assert.deepEqual(manifest.d3, { url: "https://poll.diaria.workers.dev/img/d3.jpg", filename: "04-d3-2x1.jpg", mime_type: "image/jpeg" });
    assert.equal(manifest.d2, undefined);
  });

  it("inclui livros_promo só quando livrosImageUrl está presente", () => {
    const withLivros = buildPublicImagesManifest({}, {}, "https://poll.diaria.workers.dev/img/livros.jpg");
    assert.deepEqual(withLivros.livros_promo, {
      url: "https://poll.diaria.workers.dev/img/livros.jpg",
      filename: "04-livros-promo.jpg",
      mime_type: "image/jpeg",
    });

    const withoutLivros = buildPublicImagesManifest({}, {}, undefined);
    assert.equal(withoutLivros.livros_promo, undefined);
  });

  it("sem nenhum upload (ex: --dry-run) retorna manifest vazio, não lança", () => {
    assert.deepEqual(buildPublicImagesManifest({}, {}, undefined), {});
  });
});

describe("manifest mensal + embedImagesAsDataUri — composição de ponta a ponta (#3392)", () => {
  const dir = mkdtempSync(join(tmpdir(), "monthly-embed-"));
  writeFileSync(join(dir, "04-d1-2x1.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  writeFileSync(join(dir, "01-eia-A.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("embute D1 e É IA? A no cloudflare-preview.html usando o manifest gerado pelo preview script", () => {
    const html = [
      `<img src="https://poll.diaria.workers.dev/img/img-260531-04-d1-2x1.jpg" alt="D1"/>`,
      `<img src="https://poll.diaria.workers.dev/img/img-260531-01-eia-A.jpg" alt="A"/>`,
      `<img src="https://poll.diaria.workers.dev/img/img-260531-04-d2-2x1.jpg" alt="D2 sem arquivo local"/>`,
    ].join("\n");

    const manifest = buildPublicImagesManifest(
      {
        a: "https://poll.diaria.workers.dev/img/img-260531-01-eia-A.jpg",
        b: "https://poll.diaria.workers.dev/img/img-260531-01-eia-B.jpg", // sem arquivo local — não interfere no teste (não aparece no HTML)
        aFilename: "01-eia-A.jpg",
        bFilename: "01-eia-B.jpg",
      },
      {
        1: "https://poll.diaria.workers.dev/img/img-260531-04-d1-2x1.jpg",
        2: "https://poll.diaria.workers.dev/img/img-260531-04-d2-2x1.jpg", // referenciado no HTML mas SEM arquivo local → missing
      },
      undefined,
    );

    const result = embedImagesAsDataUri(html, manifest, dir);

    assert.ok(result.embedded.includes("04-d1-2x1.jpg"));
    assert.ok(result.embedded.includes("01-eia-A.jpg"));
    assert.deepEqual(result.missing, ["04-d2-2x1.jpg"]);

    // D1 e É IA? A viraram data: URI — CSP do Artifact não bloqueia mais.
    assert.ok(result.html.includes("data:image/jpeg;base64,"));
    assert.ok(!result.html.includes("img-260531-04-d1-2x1.jpg"));
    assert.ok(!result.html.includes("img-260531-01-eia-A.jpg"));
    // D2 (sem arquivo local) mantém a URL remota — fail-open, preview parcial.
    assert.ok(result.html.includes("https://poll.diaria.workers.dev/img/img-260531-04-d2-2x1.jpg"));
  });
});
