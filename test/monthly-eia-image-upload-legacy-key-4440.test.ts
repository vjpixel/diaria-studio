/**
 * test/monthly-eia-image-upload-legacy-key-4440.test.ts (#4440)
 *
 * Regressão: `uploadEiaImages` tolera o naming legado local `01-eai-A.jpg`/
 * `01-eai-B.jpg` como fallback, mas a KEY de upload no KV vinha do filename
 * LOCAL (`monthlyEiaImageKey(edition, filePath)`) — se o par que casou fosse
 * o legado, a imagem subia pra `img-{edition}-01-eai-A.jpg`. O leitor
 * (`renderArchiveVoteHtml`, workers/poll/src/leaderboard-routes.ts) sempre
 * busca a grafia CORRETA (`01-eia-*`), hardcoded — 404 permanente e
 * silencioso pra qualquer ciclo cujas imagens locais ainda usem o nome
 * legado.
 *
 * `resolveEiaImagePair` é a peça pura testada aqui — nunca faz upload real
 * (sem rede, sem credenciais Cloudflare), só resolve QUAL par existe no disco
 * e quais filenames (local vs. key normalizada) usar.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveEiaImagePair,
  monthlyEiaImageKey,
} from "../scripts/lib/mensal/monthly-image-upload.ts";

const tmpDirs: string[] = [];
function makeTmpMonthlyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-eia-image-upload-4440-"));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("resolveEiaImagePair (#4440)", () => {
  it("par NOVO (01-eia-*) no disco → key normalizada é a mesma coisa (comportamento pré-existente preservado)", () => {
    const dir = makeTmpMonthlyDir();
    writeFileSync(join(dir, "01-eia-A.jpg"), "fake-a");
    writeFileSync(join(dir, "01-eia-B.jpg"), "fake-b");

    const pair = resolveEiaImagePair(dir);

    assert.ok(pair);
    assert.equal(pair!.localFilenameA, "01-eia-A.jpg");
    assert.equal(pair!.localFilenameB, "01-eia-B.jpg");
    assert.equal(pair!.keyFilenameA, "01-eia-A.jpg");
    assert.equal(pair!.keyFilenameB, "01-eia-B.jpg");
  });

  it("#4440 — par LEGADO (01-eai-*) no disco → key normalizada continua 01-eia-* (NÃO o typo legado)", () => {
    const dir = makeTmpMonthlyDir();
    writeFileSync(join(dir, "01-eai-A.jpg"), "fake-a-legacy");
    writeFileSync(join(dir, "01-eai-B.jpg"), "fake-b-legacy");

    const pair = resolveEiaImagePair(dir);

    assert.ok(pair, "deveria encontrar o par legado");
    // o filename LOCAL reflete o legado (usado pra ler o arquivo do disco)
    assert.equal(pair!.localFilenameA, "01-eai-A.jpg");
    assert.equal(pair!.localFilenameB, "01-eai-B.jpg");
    // mas a KEY normalizada é sempre a grafia correta — este é o fix do #4440
    assert.equal(pair!.keyFilenameA, "01-eia-A.jpg");
    assert.equal(pair!.keyFilenameB, "01-eia-B.jpg");

    // e a key final (via monthlyEiaImageKey) bate com o que o leitor busca —
    // NUNCA deve conter o typo "eai"
    const edition = "260601";
    const keyA = monthlyEiaImageKey(edition, pair!.keyFilenameA);
    const keyB = monthlyEiaImageKey(edition, pair!.keyFilenameB);
    assert.equal(keyA, "img-260601-01-eia-A.jpg");
    assert.equal(keyB, "img-260601-01-eia-B.jpg");
    assert.equal(keyA.includes("eai"), false, "key nunca deve conter o typo legado 'eai'");
    assert.equal(keyB.includes("eai"), false, "key nunca deve conter o typo legado 'eai'");
  });

  it("preferência: se AMBOS os pares existirem no disco, o par NOVO vence (ordem de namePairs)", () => {
    const dir = makeTmpMonthlyDir();
    writeFileSync(join(dir, "01-eia-A.jpg"), "novo-a");
    writeFileSync(join(dir, "01-eia-B.jpg"), "novo-b");
    writeFileSync(join(dir, "01-eai-A.jpg"), "legado-a");
    writeFileSync(join(dir, "01-eai-B.jpg"), "legado-b");

    const pair = resolveEiaImagePair(dir);

    assert.ok(pair);
    assert.equal(pair!.localFilenameA, "01-eia-A.jpg");
  });

  it("par INCOMPLETO (só um dos dois arquivos) → null, mesmo se for o legado", () => {
    const dir = makeTmpMonthlyDir();
    writeFileSync(join(dir, "01-eai-A.jpg"), "só-a-legado");
    // 01-eai-B.jpg ausente de propósito

    assert.equal(resolveEiaImagePair(dir), null);
  });

  it("nenhum par no disco → null (seção sem imagem, não-fatal)", () => {
    const dir = makeTmpMonthlyDir();
    assert.equal(resolveEiaImagePair(dir), null);
  });
});
