// #13437 (PR 1 = formato): trechoInserido estruturado { video, inicio, fim, texto },
// decisão do editor de 17/11/2026, com migração do texto livre `origem`. Fixture
// real: o roteiro da 261118 (v9, a versão gravada), que usa o formato antigo.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fmtTempoTrecho,
  intervaloDaOrigem,
  lerTrechoInserido,
  migrarTrechoInserido,
  rotuloTrecho,
  segundosTrecho,
  videoIdDaOrigem,
} from "../scripts/lib/diaria/trecho-inserido-formato.ts";
import { validarRoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import { main as migrarMain, migrarRoteiro } from "../scripts/migrar-trecho-inserido.ts";

const V9_PATH = new URL("./fixtures/roteiro-video/roteiro-falas-261118-v9.json", import.meta.url);
const v9 = () => JSON.parse(readFileSync(V9_PATH, "utf8")) as { falas: Array<Record<string, unknown>> };

const problemas = (raw: unknown): string[] => {
  const r = lerTrechoInserido(raw);
  return r.ok ? [] : r.problemas;
};

describe("tempo do trecho", () => {
  it("m:ss, h:mm:ss, fração com vírgula ou ponto, e segundos", () => {
    assert.equal(segundosTrecho("3:42"), 222);
    assert.equal(segundosTrecho("1:03:42"), 3822);
    assert.equal(segundosTrecho("3:54,88"), 234.88);
    assert.equal(segundosTrecho("3:54.5"), 234.5);
    assert.equal(segundosTrecho(222.5), 222.5);
    for (const ruim of ["3:75", "1:61:00", "3.42", "", "abc", -1, Number.NaN, null]) assert.equal(segundosTrecho(ruim), null, String(ruim));
  });

  it("formata de volta em m:ss com centésimos", () => {
    assert.equal(fmtTempoTrecho(222), "3:42");
    assert.equal(fmtTempoTrecho(234.88), "3:54,88");
    assert.equal(fmtTempoTrecho(3822), "1:03:42");
    assert.equal(fmtTempoTrecho(59.999), "1:00");
  });

  it("a origem antiga ainda é lida (migração)", () => {
    assert.equal(videoIdDaOrigem("Vídeo de 10/11 (youtu.be/lyh6IZux4FE), de 3:42 a 3:46"), "lyh6IZux4FE");
    assert.equal(videoIdDaOrigem("https://youtube.com/live/lyh6IZux4FE"), "lyh6IZux4FE");
    assert.deepEqual(intervaloDaOrigem("3:54,88 a 4:27"), { inicio: 234.88, fim: 267 });
    assert.equal(intervaloDaOrigem("de 4:00 a 3:00"), null);
  });
});

describe("lerTrechoInserido: formato estruturado", () => {
  it("link do YouTube vira youtu.be/ID; edição AAMMDD fica como está", () => {
    const yt = lerTrechoInserido({ video: "https://www.youtube.com/watch?v=lyh6IZux4FE", inicio: "3:42", fim: "3:46", texto: " E ele pode. " });
    assert.deepEqual(yt, { ok: true, trecho: { video: "youtu.be/lyh6IZux4FE", youtubeId: "lyh6IZux4FE", edicao: null, inicioS: 222, fimS: 226, texto: "E ele pode.", migrado: false } });
    const ed = lerTrechoInserido({ video: "261110", inicio: 222, fim: "3:46", texto: "x" });
    assert.ok(ed.ok);
    assert.deepEqual([ed.trecho.video, ed.trecho.youtubeId, ed.trecho.edicao], ["261110", null, "261110"]);
  });

  it("recusa erro de digitação: vídeo, tempo, intervalo invertido, campo a mais", () => {
    assert.match(problemas({ video: "youtu.be/curto", inicio: "1:00", fim: "1:05", texto: "x" })[0], /^video "youtu.be\/curto" não é link do YouTube/);
    assert.match(problemas({ video: "261310", inicio: "1:00", fim: "1:05", texto: "x" })[0], /^video "261310" não é uma edição AAMMDD válida/);
    assert.match(problemas({ video: "261110", inicio: "1:75", fim: "1:05", texto: "x" })[0], /^inicio "1:75" deve ser "m:ss"/);
    assert.match(problemas({ video: "261110", fim: "1:05", texto: "x" })[0], /^inicio null deve ser/);
    assert.match(problemas({ video: "261110", inicio: "1:05", fim: "1:00", texto: "x" })[0], /^fim \(1:00\) deve vir depois do inicio \(1:05\)/);
    assert.match(problemas({ video: "261110", inicio: "1:00", fim: "1:05", texto: "x", tempo: "1:00" })[0], /^campos desconhecidos: tempo/);
    assert.match(problemas({ video: "261110", inicio: "1:00", fim: "1:05", texto: "x", origem: "y" })[0], /^origem é do formato antigo/);
    assert.match(problemas({ video: "261110", inicio: "1:00", fim: "1:05", texto: "" })[0], /^texto deve ser texto não vazio/);
    assert.match(problemas({ video: "261110", inicio: "1:00", fim: "1:05", texto: "a → b" })[0], /^texto usa seta/);
    assert.match(problemas("texto")[0], /^deve ser objeto/);
  });

  it("rótulo da página e do marcador", () => {
    const yt = lerTrechoInserido({ video: "youtu.be/lyh6IZux4FE", inicio: "3:54,88", fim: "4:27", texto: "x" });
    const ed = lerTrechoInserido({ video: "261110", inicio: "3:42", fim: "3:46", texto: "x" });
    assert.ok(yt.ok && ed.ok);
    assert.equal(rotuloTrecho(yt.trecho), "youtu.be/lyh6IZux4FE, 3:54,88 a 4:27");
    assert.equal(rotuloTrecho(ed.trecho), "Vídeo de 10/11 (261110), 3:42 a 3:46");
  });
});

describe("migração do formato antigo (origem em texto livre)", () => {
  it("origem com link e intervalo migra; sem um deles, pede o formato novo", () => {
    const antigo = { origem: "Vídeo de 10/11 (youtu.be/lyh6IZux4FE), de 3:54,88 a 4:27", texto: "Trecho." };
    const r = lerTrechoInserido(antigo);
    assert.ok(r.ok);
    assert.equal(r.trecho.migrado, true);
    assert.deepEqual(migrarTrechoInserido(antigo), { video: "youtu.be/lyh6IZux4FE", inicio: "3:54,88", fim: "4:27", texto: "Trecho." });
    assert.match(problemas({ origem: "Vídeo de 10/11, de 3:42 a 3:46", texto: "x" })[0], /sem link do YouTube; use \{ video, inicio, fim, texto \}/);
    assert.match(problemas({ origem: "youtu.be/lyh6IZux4FE", texto: "x" })[0], /sem intervalo legível/);
    assert.match(problemas({ origem: "Vídeo de 10/11", texto: "x" })[0], /sem link do YouTube nem intervalo legível/);
    assert.equal(migrarTrechoInserido({ origem: "Vídeo de 10/11", texto: "x" }), null);
    const novo = { video: "261110", inicio: "1:00", fim: "1:05", texto: "x" };
    assert.equal(migrarTrechoInserido(novo), novo, "o formato novo fica como está");
  });

  it("o roteiro real da 261118 (v9) migra inteiro e continua válido", () => {
    const raw = v9();
    assert.deepEqual(validarRoteiroFalas(raw), [], "o formato antigo segue válido por migração");
    const r = migrarRoteiro(raw);
    assert.deepEqual(r.erros, []);
    const terceiro = r.migrados[2].depois as Record<string, unknown>;
    assert.match(String(terceiro.texto), /^E isso pode causar um aumento do preço desses componentes/);
    assert.deepEqual(
      r.migrados.map((m) => m.depois),
      [
        { video: "youtu.be/lyh6IZux4FE", inicio: "3:42", fim: "3:46", texto: "E ele pode chegar a perder o cargo atual dele." },
        { video: "youtu.be/lyh6IZux4FE", inicio: "3:47", fim: "3:55", texto: "É provável que haja um fortalecimento da fiscalização de exportação de GPUs." },
        { video: "youtu.be/lyh6IZux4FE", inicio: "3:54", fim: "4:27", texto: terceiro.texto },
      ],
    );
    assert.deepEqual(validarRoteiroFalas(raw), [], "migrado, segue válido");
    assert.deepEqual(migrarRoteiro(raw).migrados, [], "idempotente");
  });

  it("CLI: dry-run não grava; --write grava; trecho sem intervalo é erro sem gravar o resto inventado", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrar-trecho-13437-"));
    const path = join(dir, "roteiro-falas.json");
    const original = readFileSync(V9_PATH, "utf8");
    writeFileSync(path, original);
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) };
    assert.equal(migrarMain(["--falas", path], io), 0);
    assert.equal(readFileSync(path, "utf8"), original, "dry-run");
    assert.ok(out.some((l) => l.startsWith("dry-run: 3 trecho(s) a migrar")), out.join("\n"));
    assert.equal(migrarMain(["--falas", path, "--write"], io), 0);
    const gravado = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(gravado.falas.filter((f: Record<string, unknown>) => f.trechoInserido && "origem" in (f.trechoInserido as object)).length, 0);
    assert.deepEqual(validarRoteiroFalas(gravado), []);

    const ruim = { falas: [{ id: "H1", texto: "x", videos: ["horizontal"], trechoInserido: { origem: "Vídeo de 10/11", texto: "y" } }] };
    writeFileSync(path, JSON.stringify(ruim));
    err.length = 0;
    assert.equal(migrarMain(["--falas", path, "--write"], io), 1);
    assert.ok(err.some((l) => l.startsWith("[erro] H1: origem \"Vídeo de 10/11\"")), err.join("\n"));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), ruim, "nada a migrar: arquivo intacto");
    assert.equal(migrarMain([], io), 2);
  });
});
