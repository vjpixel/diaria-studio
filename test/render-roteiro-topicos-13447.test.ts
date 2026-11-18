/**
 * test/render-roteiro-topicos-13447.test.ts
 *
 * #13447: `render-roteiro-video.ts --topicos` gera a página só de tópicos
 * (ordem do horizontal, trechoInserido marcado, gravadas à parte no fim) e
 * `--sem-topicos` o roteiro sem a coluna.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import { renderRoteiroPagina, renderTopicosPagina } from "../scripts/lib/diaria/roteiro-pagina.ts";
import { main } from "../scripts/render-roteiro-video.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "roteiro-video", "roteiro-falas-261116.json");
// Formato estruturado da #13437 (o que o roteiro grava hoje); o hotfix pós-#13456
// existe porque a página de tópicos lia `trechoInserido.origem` direto e lançava
// TypeError com este formato.
function roteiro(trecho: RoteiroFalas["falas"][number]["trechoInserido"] = { video: "261110", inicio: "3:42", fim: "4:00", texto: "trecho citado" }): RoteiroFalas {
  const r: RoteiroFalas = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const h = r.falas.filter((f) => f.videos.includes("horizontal") && !f.gravarAParte);
  h[0].topicos = ["primeiro tópico", "segundo tópico"];
  h[1].topicos = ["tópico da H2"];
  h[1].trechoInserido = trecho;
  return r;
}

describe("renderTopicosPagina (#13447)", () => {
  it("lista os tópicos na ordem do horizontal, com a faixa do trecho inserido", () => {
    const html = renderTopicosPagina(roteiro());
    assert.ok(html.indexOf("primeiro tópico") < html.indexOf("tópico da H2"));
    assert.match(html, /class="faixa"><b>Entra o trecho<\/b>Vídeo de 10\/11 \(261110\), 3:42 a 4:00/);
    assert.ok(html.indexOf("tópico da H2") < html.indexOf("Entra o trecho"));
    assert.doesNotMatch(html, /class="fala"/);
  });
  it("lê o formato antigo { origem, texto } com link do YouTube e intervalo (#13437)", () => {
    const html = renderTopicosPagina(roteiro({ origem: "Vídeo de 10/11, youtu.be/abcdefghijk, 3:42 a 4:00", texto: "trecho citado" }));
    assert.match(html, /class="faixa"><b>Entra o trecho<\/b>youtu\.be\/abcdefghijk, 3:42 a 4:00/);
  });
  it("põe as falas gravadas à parte no fim, depois do separador", () => {
    const r = roteiro();
    const aparte = r.falas.find((f) => f.gravarAParte);
    assert.ok(aparte, "a fixture precisa de fala gravada à parte");
    const html = renderTopicosPagina(r);
    const sep = html.indexOf("Gravadas à parte");
    assert.ok(sep > html.indexOf("tópico da H2"));
    assert.ok(html.indexOf(`>${aparte.id}<`, sep) > sep);
  });
  it("usa fonte grande e o mesmo esquema de temas do roteiro", () => {
    const html = renderTopicosPagina(roteiro());
    assert.match(html, /font-size: 30px/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /data-theme="dark"/);
  });
  it("preserva o link do artefato na 1ª linha", () => {
    assert.ok(renderTopicosPagina(roteiro(), { artifactUrl: "https://claude.ai/artifact/x" }).startsWith("<!-- artifact: https://claude.ai/artifact/x -->"));
  });
});

describe("renderRoteiroPagina semTopicos (#13447)", () => {
  it("tira a coluna de tópicos e mantém a fala", () => {
    const r = roteiro();
    assert.match(renderRoteiroPagina(r), /<ul class="topicos">/);
    const sem = renderRoteiroPagina(r, { semTopicos: true });
    assert.doesNotMatch(sem, /<ul class="topicos">/);
    assert.doesNotMatch(sem, /class="row com-topicos"/);
    assert.ok(sem.includes("Entra o trecho"));
  });
});

describe("render-roteiro-video CLI (#13447)", () => {
  const cap = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  it("--topicos e --sem-topicos juntos = exit 2", () => {
    const { io, err } = cap();
    assert.equal(main(["261116", "--topicos", "--sem-topicos", "--falas", FIXTURE], io), 2);
    assert.match(err.join("\n"), /não combinam/);
  });
  it("--topicos --stdout imprime a página de tópicos", () => {
    const { io, out } = cap();
    assert.equal(main(["261116", "--topicos", "--stdout", "--falas", FIXTURE], io), 0);
    assert.match(out.join("\n"), /<title>Tópicos /);
  });
  it("--topicos com trechoInserido no formato estruturado não lança (#13437)", () => {
    const dir = mkdtempSync(join(tmpdir(), "topicos-13447-"));
    const falas = join(dir, "roteiro-falas.json");
    writeFileSync(falas, JSON.stringify(roteiro()));
    const { io, out } = cap();
    assert.equal(main(["261116", "--topicos", "--stdout", "--falas", falas], io), 0);
    assert.match(out.join("\n"), /Entra o trecho<\/b>Vídeo de 10\/11 \(261110\), 3:42 a 4:00/);
  });
  it("--sem-topicos --stdout imprime o roteiro sem a coluna", () => {
    const { io, out } = cap();
    assert.equal(main(["261116", "--sem-topicos", "--stdout", "--falas", FIXTURE], io), 0);
    assert.doesNotMatch(out.join("\n"), /<ul class="topicos">/);
    assert.match(out.join("\n"), /<title>Roteiro D1/);
  });
});
