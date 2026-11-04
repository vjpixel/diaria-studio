/**
 * #12159 — a cota semanal do box do vídeo (#12073) contava como "já teve box"
 * toda edição anterior com `05-video-url.txt` no disco no momento do render de
 * hoje. Cenário: o Stage 5 de terça roda sem o link do vídeo (o e-mail sai sem
 * box); depois o upload grava `05-video-url.txt` na pasta de terça; no render de
 * quarta, terça contava como "teve box" e quarta perdia o seu. Agora vale o
 * registro gravado no Stage 5 (`_internal/video-box0.json`).
 *
 * Semana usada: segunda 261102 ... sexta 261106.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countVideoBox0Shown } from "../scripts/lib/diaria/video-box0.ts";
import { readVideoBox0Shown, videoBox0RecordPath, writeVideoBox0Record } from "../scripts/lib/diaria/video-box0-record.ts";
import { extractContent, resolveVideoBox0 } from "../scripts/lib/newsletter-parse.ts";

const ID = "abcdefghijk";
const EIA = "**É IA?**\n\nFoto teste. [Autor](https://example.com/a) / CC.\n\nResultado da última edição: 40% das pessoas acertaram.\n";
const d = (n: number) => `**DESTAQUE ${n} | 💼 MERCADO**\n\n**[Título D${n}](https://example.com/d${n})**\n\nCorpo ${n}.\n\nPor que isso importa:\n\nWhy ${n}.\n`;
const REVIEWED = `TÍTULO: Edição de teste\n\n---\n\nOlá! Eu sou o [Pixel](https://example.com/pixel). Hoje li 80 notícias.\n\n---\n\n${d(1)}\n\n---\n\n${d(2)}\n\n---\n\n${d(3)}\n\n---\n\n${EIA}\n`;

function withWeek<T>(days: string[], fn: (dirOf: (aammdd: string) => string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "video-box0-12159-"));
  const dirOf = (aammdd: string) => join(root, aammdd.slice(0, 4), aammdd);
  try {
    for (const day of days) {
      mkdirSync(join(dirOf(day), "_internal"), { recursive: true });
      writeFileSync(join(dirOf(day), "02-reviewed.md"), REVIEWED, "utf8");
      writeFileSync(join(dirOf(day), "01-eia.md"), EIA, "utf8");
    }
    return fn(dirOf);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const addVideo = (dir: string) => writeFileSync(join(dir, "_internal", "05-video-url.txt"), `https://youtu.be/${ID}\n`);

describe("#12159 cota do box do vídeo conta o que foi enviado", () => {
  it("terça saiu sem box e o vídeo chegou depois: a quarta leva o box", () => {
    withWeek(["261103", "261104"], (dirOf) => {
      // Stage 5 de terça: ainda sem vídeo, o render não leva box e o registro diz isso.
      const tue = extractContent(dirOf("261103"));
      assert.equal(tue.videoBox0, false);
      writeVideoBox0Record(dirOf("261103"), Boolean(tue.videoBox0));
      // Depois do envio, o upload grava o link na pasta de terça.
      addVideo(dirOf("261103"));
      addVideo(dirOf("261104"));
      assert.match(resolveVideoBox0(dirOf("261104"), false) ?? "", /video-box0-261104/, "quarta herda a vaga que a terça não usou");
    });
  });

  it("sem registro (edição de antes do #12159): recálculo do disco, como antes", () => {
    withWeek(["261103", "261104"], (dirOf) => {
      addVideo(dirOf("261103"));
      addVideo(dirOf("261104"));
      assert.equal(resolveVideoBox0(dirOf("261104"), false), null);
    });
  });

  it("terça registrou o box: a quarta fica sem, mesmo sem vídeo no disco de terça", () => {
    withWeek(["261103", "261104"], (dirOf) => {
      writeVideoBox0Record(dirOf("261103"), true);
      addVideo(dirOf("261104"));
      assert.equal(resolveVideoBox0(dirOf("261104"), false), null);
    });
  });

  it("render com o box marca videoBox0; registro ilegível conta como ausente", () => {
    withWeek(["261103"], (dirOf) => {
      addVideo(dirOf("261103"));
      assert.equal(extractContent(dirOf("261103")).videoBox0, true);
      assert.equal(readVideoBox0Shown(dirOf("261103")), undefined);
      writeFileSync(videoBox0RecordPath(dirOf("261103")), "{não é json");
      assert.equal(readVideoBox0Shown(dirOf("261103")), undefined);
      writeVideoBox0Record(dirOf("261103"), true);
      assert.equal(readVideoBox0Shown(dirOf("261103")), true);
    });
  });

  it("puro: registro vence o recálculo, dia a dia", () => {
    const withVideo = { hasVideo: true, slot0Busy: false };
    // Terça (2) registrou sem box, quarta (3) registrou com box: conta 1, não 2.
    assert.equal(countVideoBox0Shown([{ weekday: 2, state: withVideo, recorded: false }, { weekday: 3, state: withVideo, recorded: true }]), 1);
    assert.equal(countVideoBox0Shown([{ weekday: 2, state: withVideo }, { weekday: 3, state: withVideo }]), 1);
  });
});
