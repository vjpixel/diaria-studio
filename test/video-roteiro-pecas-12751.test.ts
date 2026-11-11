/**
 * test/video-roteiro-pecas-12751.test.ts — #12751 (decisão do editor de
 * 10/11/2026: adotar as 3 propostas; o agendamento do vertical 2 é a #12774).
 *
 * O roteiro do `/diaria-video-roteiro` planeja 3 vídeos e define título e
 * capa de cada um; até aqui nada depois dele usava isso. Agora:
 *   1. `video-roteiro-blocos.ts` propõe os blocos da montagem para as três
 *      peças, com o vertical 2 como corte `guia` (título na tela e gancho);
 *   2. `publish-youtube.ts` usa o título do horizontal no roteiro quando não
 *      há `--title`, e o texto da capa entra no plano; a montagem mostra o
 *      mesmo título no Gate 2.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBlocksFile } from "../scripts/lib/diaria/video-montage.ts";
import { validarRoteiroFalas, type RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import {
  ROTEIRO_FALAS_FILE,
  blocoNaVertical,
  propostaBlocosDoRoteiro,
  readRoteiroHorizontal,
  renderPropostaBlocos,
  roteiroPecas,
} from "../scripts/lib/diaria/roteiro-videos.ts";
import { planYouTubePublish } from "../scripts/publish-youtube.ts";
import { videoTitlesFor } from "../scripts/video-montagem.ts";
import { EXIT_SEM_ROTEIRO, main as roteiroBlocosMain } from "../scripts/video-roteiro-blocos.ts";

/** Roteiro no formato da 261112 (o exemplo da skill): 3 vídeos de uma gravação. */
const ROTEIRO: RoteiroFalas = {
  edicao: "261112",
  veiculos: ["The Verge"],
  porVideo: {
    horizontal: { titulo: "Claude Code vazou senhas: 3 dicas para não cair nessa", capa: "Senha vazou?" },
    vertical1: { titulo: "Mais de 500 senhas vazadas pelo Claude Code", capa: "Vazou?" },
    vertical2: { titulo: "3 dicas para não vazar senha no Claude Code", capa: "Proteja suas senhas" },
  },
  falas: [
    { id: "H1", bloco: "gancho", texto: "Uma empresa de segurança achou mais de 500 senhas em projetos do Claude Code.", videos: ["horizontal", "vertical1"] },
    { id: "H2", bloco: "abertura", texto: "Oi! Eu sou o Pixel, editor da diar.ia.br.", videos: ["horizontal"] },
    { id: "H3", bloco: "resumo", texto: "O arquivo de configurações locais guardava as senhas sem ninguém perceber.", videos: ["horizontal", "vertical1"] },
    { id: "H4", bloco: "comentario", texto: "Primeira dica: guarda as senhas num cofre.", videos: ["horizontal", "vertical2"] },
    { id: "H5", bloco: "comentario", texto: "Isso me lembra um caso que aconteceu comigo.", videos: ["horizontal", "vertical1"] },
    { id: "V1-chamada", bloco: "cta_vertical", texto: "O vídeo completo está no YouTube.", videos: ["vertical1"], gravarAParte: true },
    { id: "V2-gancho", bloco: "gancho", texto: "Três dicas pra não vazar senha usando o Claude Code.", videos: ["vertical2"], gravarAParte: true },
  ],
};

const REVIEWED_MD = `DESTAQUE 1 | SEGURANÇA
Claude Code expõe senhas em projetos públicos
https://fonte.exemplo.com/artigo

Uma empresa de segurança achou senhas.

Por que isso importa:
Porque sim.
`;

describe("#12751: o JSON do roteiro carrega bloco, título e capa", () => {
  it("valida bloco e porVideo", () => {
    assert.deepEqual(validarRoteiroFalas(ROTEIRO), []);
    const ruim = { falas: [{ id: "H1", texto: "x", videos: ["horizontal"], bloco: "rodape" }], porVideo: { shorts: { titulo: "" }, horizontal: { capa: "" } } };
    const p = validarRoteiroFalas(ruim).join("\n");
    assert.match(p, /falas\[0\]\.bloco/);
    assert.match(p, /porVideo\.shorts: vídeo desconhecido/);
    assert.match(p, /porVideo\.horizontal\.capa deve ser texto não vazio/);
  });

  it("roteiroPecas devolve só o preenchido", () => {
    const p = roteiroPecas({ porVideo: { horizontal: { titulo: "  T  " }, vertical1: {} } });
    assert.deepEqual(p, { horizontal: { titulo: "T" } });
  });
});

describe("#12751 (1): proposta de blocos para os dois verticais", () => {
  const p = propostaBlocosDoRoteiro(ROTEIRO);

  it("três sequências: horizontal, vertical da edição e o corte guia", () => {
    assert.deepEqual(p.sequencias.map((s) => s.chave), ["youtube", "outras-redes", "guia"]);
    const v2 = p.sequencias[2];
    assert.deepEqual(v2.falas.map((f) => f.id), ["H4", "V2-gancho"]);
    assert.equal(v2.titulo, "3 dicas para não vazar senha no Claude Code");
    assert.equal(p.screenTitle, "Mais de 500 senhas vazadas pelo Claude Code");
  });

  it("o resumo do horizontal vira resumo curto na vertical; abertura fica fora dela", () => {
    assert.equal(blocoNaVertical("resumo"), "resumo_curto");
    assert.equal(blocoNaVertical("cta_yt"), "cta_vertical");
    assert.equal(blocoNaVertical("abertura"), null);
    const v1 = p.sequencias[1];
    assert.ok(v1.falas.some((f) => f.id === "H3" && f.bloco === "resumo_curto"));
  });

  it("targets por fala: só quem não está em todas as sequências do bloco leva targets", () => {
    const com = p.blocks.comentario!;
    assert.deepEqual(com.find((i) => i.text.startsWith("Primeira dica"))?.targets?.sort(), ["guia", "youtube"]);
    assert.deepEqual(com.find((i) => i.text.startsWith("Isso me lembra"))?.targets?.sort(), ["outras-redes", "youtube"]);
    // Abertura só existe no horizontal: sem targets.
    assert.equal(p.blocks.abertura![0].targets, undefined);
  });

  it("o corte do vertical 2 tem título na tela, gancho e a ordem das falas dele; o blocks.json resultante é válido", () => {
    assert.ok(p.sequences);
    const corte = p.sequences![2];
    assert.equal(corte.corte, "guia");
    assert.equal(corte.name, "Diaria comentada_Vertical_V1-guia");
    assert.equal(corte.screenTitle, "3 dicas para não vazar senha no Claude Code");
    assert.equal(corte.hook, "Três dicas pra não vazar senha usando o Claude Code.");
    assert.deepEqual(corte.order, ["gancho", "comentario"], "o gancho gravado à parte abre o vertical 2");
    const parsed = parseBlocksFile({ edition: "261112", blocks: p.blocks, sequences: p.sequences, screenTitle: p.screenTitle });
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
  });

  it("fala sem bloco fica fora com aviso; sem vertical 2 não há sequences", () => {
    const r = propostaBlocosDoRoteiro({ falas: [{ id: "H1", texto: "x", videos: ["horizontal"] }, { id: "H2", bloco: "comentario", texto: "y", videos: ["horizontal", "vertical1"] }] });
    assert.ok(r.avisos.some((a) => a.includes("H1")));
    assert.equal(r.sequences, undefined);
    assert.match(renderPropostaBlocos(p), /## vertical 2 \(sequência `guia`\)/);
  });
});

describe("#12751 (2): o /diaria-publica recebe título e capa do roteiro", () => {
  const base = {
    aammdd: "261112",
    reviewedMd: REVIEWED_MD,
    now: new Date("2026-11-11T12:00:00Z"),
    episode: 1,
    editionUrl: "https://diar.ia.br/p/x",
    video: { path: "/x.mp4", exists: false, sizeBytes: null },
    thumb: { path: "/t.jpg", exists: false },
  };

  it("sem --title, o título do horizontal no roteiro vale e o registro sabe a origem", () => {
    const p = planYouTubePublish({ ...base, roteiro: roteiroPecas(ROTEIRO).horizontal });
    assert.equal(p.metadata.title, "Claude Code vazou senhas: 3 dicas para não cair nessa");
    assert.equal(p.titleSource, "roteiro");
    assert.equal(p.request.body.snippet.title, p.metadata.title);
    assert.equal(p.roteiroCapa, "Senha vazou?");
    assert.ok(p.premises.some((l) => l.includes("roteiro do vídeo") && l.includes("Claude Code expõe senhas")));
  });

  it("--title vence o roteiro; sem roteiro, o D1", () => {
    const flag = planYouTubePublish({ ...base, title: "Outro título", roteiro: { titulo: "Do roteiro" } });
    assert.equal(flag.metadata.title, "Outro título");
    assert.equal(flag.titleSource, "flag");
    const d1 = planYouTubePublish(base);
    assert.equal(d1.titleSource, "d1");
    assert.equal(d1.roteiroCapa, undefined);
  });

  it("readRoteiroHorizontal: ausente = null em silêncio; inválido = null com aviso; válido = título e capa", () => {
    const dir = mkdtempSync(join(tmpdir(), "roteiro-12751-"));
    try {
      const warns: string[] = [];
      assert.equal(readRoteiroHorizontal(dir, (w) => warns.push(w)), null);
      assert.equal(warns.length, 0);
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), "{");
      assert.equal(readRoteiroHorizontal(dir, (w) => warns.push(w)), null);
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), JSON.stringify({ falas: [] }));
      assert.equal(readRoteiroHorizontal(dir, (w) => warns.push(w)), null);
      assert.equal(warns.length, 2);
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), JSON.stringify(ROTEIRO));
      assert.deepEqual(readRoteiroHorizontal(dir, (w) => warns.push(w)), { titulo: "Claude Code vazou senhas: 3 dicas para não cair nessa", capa: "Senha vazou?" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o Gate 2 da montagem mostra o título do roteiro no horizontal", () => {
    const t = videoTitlesFor([{ target: "youtube" }], { d1Title: "Claude Code expõe senhas", roteiroTitle: "Do roteiro" });
    assert.match(t.youtube, /^Do roteiro \(título do roteiro do vídeo/);
    assert.match(videoTitlesFor([{ target: "youtube" }], { d1Title: "Claude Code expõe senhas" }).youtube, /título do D1/);
  });
});

describe("#12751: CLI video-roteiro-blocos", () => {
  it("sem o JSON sai 3; com ele, imprime a proposta", () => {
    const dir = mkdtempSync(join(tmpdir(), "roteiro-blocos-12751-"));
    try {
      const out: string[] = [];
      const err: string[] = [];
      const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
      assert.equal(roteiroBlocosMain(["261112", "--falas", join(dir, "ausente.json")], io), EXIT_SEM_ROTEIRO);
      const path = join(dir, "roteiro-falas.json");
      writeFileSync(path, JSON.stringify(ROTEIRO));
      assert.equal(roteiroBlocosMain(["261112", "--falas", path, "--json"], io), 0);
      assert.equal(JSON.parse(out[0]).sequences[2].corte, "guia");
      assert.equal(roteiroBlocosMain(["261112", "--falas", path, "--corte", "Guia!"], io), 2);
      assert.equal(roteiroBlocosMain(["x"], io), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
