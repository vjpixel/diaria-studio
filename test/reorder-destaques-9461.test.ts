/**
 * #9461 — escritas pós-lote de reorder-destaques (crop-review, public-images,
 * intentional-error/carimbos) precisam avisar que o lote principal JÁ foi
 * aplicado, senão o operador re-roda o mesmo --new-order e permuta os
 * destaques uma 2ª vez.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotateMainBatchAlreadyApplied,
  writePostBatchVerified,
} from "../scripts/reorder-destaques.ts";
import type { WriteFilesVerifiedDeps } from "../scripts/lib/write-files-verified.ts";

test("#9461: falha injetada na escrita do 04-crop-review.json carrega o aviso de lote já aplicado", () => {
  const original = Buffer.from('{"old":true}\n', "utf8");
  const files = new Map<string, Buffer>([["/ed/_internal/04-crop-review.json", original]]);
  // Simula o OneDrive revertendo a escrita: writeFileSync "funciona" mas a
  // releitura devolve o conteúdo antigo.
  const deps: WriteFilesVerifiedDeps = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p) ?? Buffer.alloc(0),
    writeFileSync: () => {},
    unlinkSync: (p) => {
      files.delete(p);
    },
  };
  assert.throws(
    () =>
      writePostBatchVerified(
        [{ path: "/ed/_internal/04-crop-review.json", content: '{"new":true}\n' }],
        [2, 1, 3],
        deps,
      ),
    (err: Error) => {
      assert.match(err.message, /04-crop-review\.json/);
      assert.match(err.message, /lote principal JÁ foi aplicado/);
      assert.match(err.message, /NÃO re-rodar o mesmo --new-order/);
      assert.match(err.message, /--new-order 2,1,3/);
      return true;
    },
  );
});

test("#9461: sucesso não lança", () => {
  const files = new Map<string, Buffer>();
  const deps: WriteFilesVerifiedDeps = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p) ?? Buffer.alloc(0),
    writeFileSync: (p, d) => {
      files.set(p, d);
    },
    unlinkSync: (p) => {
      files.delete(p);
    },
  };
  writePostBatchVerified([{ path: "/ed/06-public-images.json", content: "{}\n" }], [2, 1, 3], deps);
  assert.equal(files.get("/ed/06-public-images.json")?.toString("utf8"), "{}\n");
});

test("#9461: annotateMainBatchAlreadyApplied aceita não-Error e preserva a mensagem original", () => {
  const e = annotateMainBatchAlreadyApplied("boom", [3, 1, 2]);
  assert.ok(e instanceof Error);
  assert.match(e.message, /^boom ATENÇÃO/);
  assert.match(e.message, /--new-order 3,1,2/);
});
