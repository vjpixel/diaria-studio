/**
 * #12429: legenda do horizontal só pela fala do export, sem plan.json
 * (horizontais 261021–261029, anteriores à skill de montagem). Antes, o
 * `srt --from-final` parava em "plan.json sem a sequência youtube" e não havia
 * caminho para essas edições. Agora `--no-plan` faz a legenda pelo texto
 * ouvido, com o vocabulário do projeto e a grafia dos nomes do 02-reviewed.md,
 * e `publish-youtube.ts --captions-list` confere a faixa enviada.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Word } from "../scripts/lib/diaria/video-montage.ts";
import { applyProperNounLexicon, properNounLexicon, summarizeLexiconChanges } from "../scripts/lib/diaria/video-caption-lexicon.ts";
import { main, srtFromExportNoPlan } from "../scripts/video-montagem.ts";
import { captionBackfillStatus, listCaptions, type CaptionTrack } from "../scripts/lib/diaria/youtube-captions.ts";
import { runCaptionsList } from "../scripts/publish-youtube.ts";
import type { YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";

const say = (text: string, t0: number, dur = 0.3): Word[] =>
  text.split(" ").map((w, i) => ({ start: +(t0 + i * dur).toFixed(3), end: +(t0 + (i + 1) * dur).toFixed(3), text: w }));

// Trecho real do 02-reviewed.md da 261021 (cabeçalhos em maiúsculas, link, URL).
const REVIEWED = `TÍTULO

Você já viu IA mentir. Já viu roubar?

---
Olá! Eu sou o [Pixel](https://www.linkedin.com/in/vjpixel/), editor desta newsletter.

**DESTAQUE 1 | 🔐 SEGURANÇA**

**[Você já viu IA mentir. Já viu roubar?](https://alignment.openai.com/misalignment-reports/x)**

Um modelo de pesquisa da OpenAI, da família GPT-5.6 Sol, gastou o saldo de uma carteira de criptomoedas de terceiros.

Sem saldo para pagar taxas na Sepolia, rede de testes do Ethereum, o modelo escreveu um script. A Meta também testou o Gemini e o Opus da Anthropic.

Use melhor: dá para use o modo de teste.
`;

describe("#12429 properNounLexicon: nomes próprios do texto da edição", () => {
  const lex = properNounLexicon(REVIEWED);

  it("pega nome no meio da frase e grafia com maiúscula interna", () => {
    assert.equal(lex.get("openai"), "OpenAI");
    assert.equal(lex.get("sepolia"), "Sepolia");
    assert.equal(lex.get("ethereum"), "Ethereum");
    assert.equal(lex.get("gemini"), "Gemini");
    assert.equal(lex.get("opus"), "Opus");
    assert.equal(lex.get("anthropic"), "Anthropic");
    assert.equal(lex.get("ia"), "IA");
    assert.equal(lex.get("gpt56"), "GPT-5.6");
    assert.equal(lex.get("pixel"), "Pixel", "o rótulo do link conta, a URL não");
  });

  it("fica fora: início de frase, cabeçalho em maiúsculas, palavra que também aparece minúscula, ambígua, URL", () => {
    assert.equal(lex.has("um"), false, "Um no início da frase");
    assert.equal(lex.has("sem"), false);
    assert.equal(lex.has("titulo"), false, "linha de cabeçalho");
    assert.equal(lex.has("destaque"), false);
    assert.equal(lex.has("seguranca"), false);
    assert.equal(lex.has("use"), false, "'Use' também aparece como 'use'");
    assert.equal(lex.has("meta"), false, "'Meta' é palavra comum (a meta do ano)");
    assert.equal(lex.has("sol"), false);
    assert.equal(lex.has("linkedin"), false, "só na URL");
    assert.equal(lex.has("alignment"), false);
  });
});

describe("#12429 applyProperNounLexicon", () => {
  const lex = properNounLexicon(REVIEWED);
  const aliases = [{ heard: "diária", written: "diar.ia.br" }];

  it("troca só maiúscula/acento, mantém a pontuação ouvida e os tempos", () => {
    const heard = say("um modelo da openai, testou o gemini e o opus.", 1);
    const { words, changes } = applyProperNounLexicon(heard, lex, aliases);
    assert.deepEqual(words.map((w) => w.text), ["um", "modelo", "da", "OpenAI,", "testou", "o", "Gemini", "e", "o", "Opus."]);
    assert.deepEqual(words.map((w) => [w.start, w.end]), heard.map((w) => [w.start, w.end]));
    assert.equal(changes.length, 3);
  });

  it("nunca troca palavra diferente: 'sepoia' ouvido fica (conferência humana)", () => {
    const { words, changes } = applyProperNounLexicon(say("taxas na sepoia, rede", 0), lex);
    assert.equal(words[2].text, "sepoia,");
    assert.deepEqual(changes, []);
  });

  it("alias só com maiúscula no meio da frase: 'editor da Diária' vira o nome, 'rotina diária' e início de frase ficam", () => {
    const a = applyProperNounLexicon(say("sou editor da Diária e hoje", 0), lex, aliases);
    assert.equal(a.words[3].text, "diar.ia.br");
    const b = applyProperNounLexicon(say("a rotina diária muda", 0), lex, aliases);
    assert.equal(b.words[2].text, "diária");
    const c = applyProperNounLexicon(say("acabou. Diária é a palavra", 0), lex, aliases);
    assert.equal(c.words[1].text, "Diária");
  });

  it("resumo das trocas agrupa o mesmo par", () => {
    const { changes } = applyProperNounLexicon(say("openai e openai e gemini", 0), lex);
    assert.deepEqual(summarizeLexiconChanges(changes), ['"openai" → "OpenAI" (grafia da edição, 2x)', '"gemini" → "Gemini" (grafia da edição)']);
  });
});

describe("#12429 srtFromExportNoPlan", () => {
  // Parte da fala real do export da 261021 (transcrição salva na pasta da edição).
  const heard = [
    ...say("Olá, eu sou o Pixel, sou editor da Diária e a partir de hoje", 14),
    ...say("Sem saldo para pagar taxas na sepoia, que é uma rede de testes do ethereum,", 55),
    ...say("o modelo da openai usou o chat EPT.", 61),
    ...say("fala depois do fim", 99),
  ];
  const rules = [{ pattern: "\\b[Cc]hat\\s?(?:EPT|GPT)\\b", replacement: "ChatGPT" }];
  const aliases = [{ heard: "diária", written: "diar.ia.br" }];

  it("legenda pelo texto ouvido, com vocabulário, grafia da edição e alias; nada a recusar", () => {
    const r = srtFromExportNoPlan({ heard, rules, aliases, reference: REVIEWED, durationS: 90 });
    assert.deepEqual(r.problems, []);
    const flat = r.srt.replace(/\r?\n/g, " ");
    assert.ok(flat.includes("editor da diar.ia.br"), flat);
    assert.ok(flat.includes("Ethereum,"), flat);
    assert.ok(flat.includes("OpenAI"), flat);
    assert.ok(flat.includes("ChatGPT."), "regra do vocabulário junta 'chat EPT'");
    assert.ok(flat.includes("sepoia"), "palavra diferente fica como ouvida");
    assert.ok(!flat.includes("depois do fim"), "fala depois do fim do export sai");
    assert.match(r.srt, /^1\r?\n00:00:14,000 --> /);
    const notes = r.notes.join("\n");
    assert.match(notes, /sem plan\.json/);
    assert.match(notes, /"ethereum," → "Ethereum,"|"ethereum" → "Ethereum"/);
    assert.match(notes, /descartada/);
  });

  it("sem o 02-reviewed.md: só o vocabulário, com aviso", () => {
    const r = srtFromExportNoPlan({ heard, rules, aliases, reference: null, durationS: 90 });
    assert.deepEqual(r.problems, []);
    assert.ok(r.srt.includes("openai"), "sem léxico, a grafia ouvida fica");
    assert.match(r.notes.join("\n"), /sem o texto da edição/);
  });

  it("legenda de duração zero recusa", () => {
    const r = srtFromExportNoPlan({ heard: [{ start: 1, end: 1, text: "oi." }], rules: [], aliases: [], durationS: 10 });
    assert.equal(r.problems.length, 1);
  });
});

describe("#12429 CLI srt --from-final --no-plan", () => {
  let dir: string;
  const origErr = console.error;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vm-12429-"));
    console.error = () => {};
  });
  afterEach(() => {
    console.error = origErr;
    rmSync(dir, { recursive: true, force: true });
  });
  const base = () => ["srt", "261021", "--state-dir", dir, "--work-dir", dir, "--out-dir", dir, "--no-drive-api", "--drive-root", dir];

  it("regressão: sem plan.json, o --from-final aponta o --no-plan", async () => {
    const exp = join(dir, "Diaria comentada_Youtube_261021.mp4");
    writeFileSync(exp, "");
    await assert.rejects(main([...base(), "--from-final", exp]), /sem plan\.json.*--no-plan/);
  });

  it("plan.json sem o horizontal também aponta o --no-plan (mantendo a mensagem antiga)", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ hash: "x", plans: [{ spec: { target: "instagram", name: "v", width: 1080, height: 1920 }, script: "oi" }], source: { fps: 30 } }));
    await assert.rejects(main([...base(), "--from-final", join(dir, "x.mp4")]), /plan\.json sem a sequência youtube.*--no-plan/);
  });

  it("--no-plan não lê o plan.json: export ausente é o único erro", async () => {
    await assert.rejects(main([...base(), "--from-final", join(dir, "nao-existe.mp4"), "--no-plan"]), /export não encontrado/);
  });

  it("--no-plan sem --from-final, ou com --seq de vertical, é recusado", async () => {
    await assert.rejects(main([...base(), "--no-plan"]), /--no-plan só vale com --from-final/);
    await assert.rejects(main([...base(), "--from-final", "x.mp4", "--no-plan", "--seq", "instagram"]), /só gera a legenda do horizontal/);
  });
});

describe("#12429 publish-youtube --captions-list (só leitura)", () => {
  const ENV = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs", YOUTUBE_REFRESH_TOKEN: "rt", YOUTUBE_CHANNEL_ID: "UCx" };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const tracksBody = {
    items: [
      { id: "asr1", snippet: { language: "pt", trackKind: "asr", name: "", isDraft: false, lastUpdated: "2026-10-21T10:00:00Z" } },
      { id: "cap1", snippet: { language: "pt-BR", trackKind: "standard", name: "Português (Brasil)", isDraft: false, lastUpdated: "2026-11-11T10:00:00Z" } },
    ],
  };
  function deps(calls: Array<{ url: string; method: string }>, captions = () => json(200, tracksBody)): YouTubeUploadDeps {
    return {
      now: () => new Date("2026-11-11T12:00:00Z"),
      fetch: async (url, init) => {
        calls.push({ url, method: init?.method ?? "GET" });
        if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "tok" });
        if (url.startsWith("https://www.googleapis.com/youtube/v3/captions?")) return captions();
        throw new Error(`rota não mockada: ${url}`);
      },
    };
  }
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-12429-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const writeRecord = (rec: unknown) => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "05-youtube-published.json"), JSON.stringify(rec));
  };

  it("listCaptions: GET com o videoId, devolve as faixas", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const tracks = await listCaptions(deps(calls), "tok", "VID 1");
    assert.equal(tracks.length, 2);
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /part=snippet&videoId=VID%201$/);
  });

  it("captionBackfillStatus: captionId do registro presente, rascunho, ausente; sem registro, qualquer pt-BR standard", () => {
    const tracks: CaptionTrack[] = [
      { id: "asr1", language: "pt", name: "", trackKind: "asr", isDraft: false, lastUpdated: null },
      { id: "cap1", language: "pt-BR", name: "x", trackKind: "standard", isDraft: false, lastUpdated: null },
    ];
    assert.equal(captionBackfillStatus(tracks, "cap1").ok, true);
    assert.equal(captionBackfillStatus([{ ...tracks[1], isDraft: true }], "cap1").ok, false);
    assert.equal(captionBackfillStatus(tracks, "outra").ok, false);
    assert.equal(captionBackfillStatus(tracks, null).ok, true);
    assert.equal(captionBackfillStatus([tracks[0]], null).ok, false, "só a automática não conta");
  });

  it("runCaptionsList: vídeo do registro, confere o captionId e só lê (nenhum POST/PUT de API do YouTube)", async () => {
    writeRecord({ aammdd: "261030", videoId: "VID", captions: { ok: true, captionId: "cap1" } });
    const calls: Array<{ url: string; method: string }> = [];
    const logs: string[] = [];
    const out = await runCaptionsList(deps(calls), { aammdd: "261030", editionDir: dir, env: ENV, log: (l) => logs.push(l) });
    assert.equal(out.exitCode, 0, logs.join("\n"));
    assert.equal(out.videoId, "VID");
    assert.ok(calls.filter((c) => c.url.includes("youtube")).every((c) => c.method === "GET"));
  });

  it("runCaptionsList: sem registro e sem --video-id = exit 1 sem chamar a API; com --video-id, confere", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const logs: string[] = [];
    const none = await runCaptionsList(deps(calls), { aammdd: "261021", editionDir: dir, env: ENV, log: (l) => logs.push(l) });
    assert.equal(none.exitCode, 1);
    assert.equal(calls.length, 0);
    const byId = await runCaptionsList(deps(calls), { aammdd: "261021", editionDir: dir, videoId: "VID", env: ENV, log: (l) => logs.push(l) });
    assert.equal(byId.exitCode, 0, logs.join("\n"));
  });

  it("runCaptionsList: sem a faixa pt-BR = exit 1; erro da API = exit 1", async () => {
    writeRecord({ aammdd: "261030", videoId: "VID" });
    const logs: string[] = [];
    const onlyAsr = await runCaptionsList(deps([], () => json(200, { items: [tracksBody.items[0]] })), { aammdd: "261030", editionDir: dir, env: ENV, log: (l) => logs.push(l) });
    assert.equal(onlyAsr.exitCode, 1);
    const err = await runCaptionsList(deps([], () => json(500, { error: "x" })), { aammdd: "261030", editionDir: dir, env: ENV, log: (l) => logs.push(l) });
    assert.equal(err.exitCode, 1);
    assert.match(logs.join("\n"), /captions\.list respondeu 500/);
  });
});
