import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { avisosTomConversacional, parseRoteiroFalas } from "../scripts/lib/diaria/roteiro-videos.ts";
import type { RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import { main } from "../scripts/video-roteiro-blocos.ts";

const roteiro = (texto: string): RoteiroFalas => ({ falas: [{ id: "H1", bloco: "comentario", texto, videos: ["horizontal", "vertical1"] }] });
it("avisa os verbos de relatório, com limites de palavra e sem duplicar por vídeo", () => {
  for (const verbo of ["relatou", "relataram", "acompanhou", "afirmou", "constatou", "verificou-se"]) {
    const avisos = avisosTomConversacional(roteiro(`Ele ${verbo.toUpperCase()} o caso.`));
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], /^H1: verbo de relatório/);
  }
  assert.deepEqual(avisosTomConversacional(roteiro("Ele conta o que viu, né? A gente tá aqui pra ouvir. Desacompanhou.")), []);
});
it("avisa acima de 30 palavras consecutivas; pontuação e nova linha reiniciam a contagem", () => {
  const palavras = (n: number) => Array(n).fill("palavra").join(" ");
  assert.deepEqual(avisosTomConversacional(roteiro(palavras(30))), []);
  assert.match(avisosTomConversacional(roteiro(palavras(31)))[0], /31 palavras sem pausa/);
  for (const pausa of [",", ".", ";", ":", "?", "!", "…", "—", "\n"]) {
    assert.deepEqual(avisosTomConversacional(roteiro(`${palavras(20)}${pausa} ${palavras(20)}`)), []);
  }
});
it("fixture 261117 é válida e conserva as falas conversacionais aprovadas", () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/roteiro-video/roteiro-falas-261117.json", import.meta.url), "utf8"));
  const parsed = parseRoteiroFalas(raw);
  assert.equal(parsed.ok, true);
  assert.deepEqual(avisosTomConversacional(raw), []);
  assert.ok(raw.falas.some((f: { texto: string }) => f.texto.startsWith("Denunciar adianta?")));
});
it("CLI mantém exit 0 e JSON válido mesmo com avisos de tom", () => {
  const dir = mkdtempSync(join(tmpdir(), "roteiro-13165-"));
  try {
    const path = join(dir, "falas.json");
    writeFileSync(path, JSON.stringify(roteiro(`Ele relatou ${Array(31).fill("palavra").join(" ")}`)));
    const err: string[] = [], out: string[] = [];
    assert.equal(main(["261117", "--falas", path, "--json"], { err: s => err.push(s), out: s => out.push(s) }, dir), 0);
    assert.ok(err.some(s => s.startsWith("[aviso] H1: verbo de relatório")));
    assert.ok(err.some(s => /\[aviso\] H1: trecho com 33 palavras sem pausa/.test(s)));
    assert.ok(JSON.parse(out[0]).duracoes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
