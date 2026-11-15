/**
 * test/roteiro-leitura-tolerante-seta-13173.test.ts
 *
 * #13173: a leitura tolerante do roteiro (`readRoteiroPecas`, que alimenta a
 * capa dos verticais na montagem, e `readRoteiroHorizontal`, que alimenta o
 * título e a capa do horizontal no `publish-youtube.ts`) devolvia o texto cru
 * de `porVideo.*.titulo`/`capa` de um roteiro inválido. Como a seta (→/←) no
 * título e na capa torna o roteiro inválido (#9721), era justamente a seta que
 * passava para a capa renderizada e o título publicado. O campo com seta agora
 * fica fora, com aviso que nomeia o campo, como `readRoteiroTelas` faz.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import { readRoteiroHorizontal, readRoteiroPecas, ROTEIRO_FALAS_FILE } from "../scripts/lib/diaria/roteiro-videos.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "roteiro-video", "roteiro-falas-261116.json");
const base = (): RoteiroFalas => JSON.parse(readFileSync(FIXTURE, "utf8"));

function comRoteiro<T>(r: unknown, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "roteiro-seta-13173-"));
  try {
    mkdirSync(join(dir, "_internal"));
    writeFileSync(join(dir, ROTEIRO_FALAS_FILE), JSON.stringify(r));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SETA = /[→←]/;

describe("#13173: seta no título/capa não vaza pela leitura tolerante", () => {
  it("capa dos verticais com seta fica fora; o resto segue, com aviso nomeando o campo", () => {
    const r = base();
    r.porVideo!.vertical1!.capa = "Drauzio → golpe";
    r.porVideo!.vertical2!.capa = "← volta da Busca";
    const avisos: string[] = [];
    const pecas = comRoteiro(r, (dir) => readRoteiroPecas(dir, (m) => void avisos.push(m)));
    assert.equal(pecas?.vertical1?.capa, undefined);
    assert.equal(pecas?.vertical2?.capa, undefined);
    assert.equal(pecas?.vertical1?.titulo, "Google te dá Gemini 4 Hydrogen de graça");
    assert.equal(pecas?.horizontal?.capa, "Já está na sua Busca");
    for (const p of Object.values(pecas ?? {})) {
      assert.ok(!SETA.test(p.titulo ?? "") && !SETA.test(p.capa ?? ""), JSON.stringify(p));
    }
    assert.ok(avisos.some((a) => /descartado\(s\) por seta.*porVideo\.vertical1\.capa, porVideo\.vertical2\.capa/.test(a)), avisos.join("\n"));
  });

  it("título e capa do horizontal com seta ficam fora do que vai ao YouTube", () => {
    const r = base();
    r.porVideo!.horizontal!.titulo = "Google → Gemini de graça";
    r.porVideo!.horizontal!.capa = "Já está na Busca →";
    const avisos: string[] = [];
    const h = comRoteiro(r, (dir) => readRoteiroHorizontal(dir, (m) => void avisos.push(m)));
    assert.equal(h, null, "sem título nem capa aproveitável: cai no D1");
    assert.ok(avisos.some((a) => /usando o D1.*porVideo\.horizontal\.titulo, porVideo\.horizontal\.capa/.test(a)), avisos.join("\n"));
  });

  it("só o título do horizontal com seta: a capa segue e o vertical 1 não herda o título com seta", () => {
    const r = base();
    r.porVideo!.horizontal!.titulo = "Google → Gemini de graça";
    delete r.porVideo!.vertical1!.titulo;
    const h = comRoteiro(r, (dir) => readRoteiroHorizontal(dir, () => {}));
    assert.deepEqual(h, { capa: "Já está na sua Busca" });
    const pecas = comRoteiro(r, (dir) => readRoteiroPecas(dir, () => {}));
    assert.equal(pecas?.vertical1?.titulo, undefined);
    assert.equal(pecas?.vertical1?.capa, "Sua Busca mudou de IA");
  });

  it("sem seta, nada muda e o aviso não cita descarte", () => {
    const r = base();
    r.falas.find((f) => f.id === "H4")!.cortes = { vertical1: "trecho que sumiu da fala" };
    const avisos: string[] = [];
    const pecas = comRoteiro(r, (dir) => readRoteiroPecas(dir, (m) => void avisos.push(m)));
    assert.equal(pecas?.vertical1?.capa, "Sua Busca mudou de IA");
    assert.ok(avisos.length > 0 && avisos.every((a) => !/descartado/.test(a)), avisos.join("\n"));
  });
});
