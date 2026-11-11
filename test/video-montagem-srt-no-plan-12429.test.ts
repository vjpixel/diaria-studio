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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sequenceKey, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { LEXICON_AMBIGUOUS, applyProperNounLexicon, editorialText, properNounLexicon, summarizeLexiconChanges } from "../scripts/lib/diaria/video-caption-lexicon.ts";
import { NO_PLAN_SEQ_KEY, applyYoutubeSrtCopy, main, srtFromExportNoPlan } from "../scripts/video-montagem.ts";
import { captionBackfillStatus, listCaptions, youtubeCaptionNoPlanMarkerPath, type CaptionTrack } from "../scripts/lib/diaria/youtube-captions.ts";
import { runCaptionsList, runCaptionsOnly } from "../scripts/publish-youtube.ts";
import type { YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";

const say = (text: string, t0: number, dur = 0.3): Word[] =>
  text.split(" ").map((w, i) => ({ start: +(t0 + i * dur).toFixed(3), end: +(t0 + (i + 1) * dur).toFixed(3), text: w }));

// Baseado no 02-reviewed.md da 261021 (cabeçalhos em maiúsculas, link, URL), com linhas sintéticas
// para os casos de borda (Meta/Opus/Use melhor/Casa Branca/Banco do Brasil). O texto real inteiro de
// uma edição está em test/fixtures/reviewed-261028-12429.md, usado mais abaixo.
const REVIEWED = `TÍTULO

Você já viu IA mentir. Já viu roubar?

---
Olá! Eu sou o [Pixel](https://www.linkedin.com/in/vjpixel/), editor desta newsletter.

**DESTAQUE 1 | 🔐 SEGURANÇA**

**[Você já viu IA mentir. Já viu roubar?](https://alignment.openai.com/misalignment-reports/x)**

Um modelo de pesquisa da OpenAI, da família GPT-5.6 Sol, gastou o saldo de uma carteira de criptomoedas de terceiros.

Sem saldo para pagar taxas na Sepolia, rede de testes do Ethereum, o modelo escreveu um script. A Meta também testou o Gemini e o Opus. O Opus é da Anthropic.

Use melhor: dá para use o modo de teste.

O teste saiu na Casa Branca, nos Estados Unidos, com o Claude Opus 5 e o Banco do Brasil.
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

  it("palavra que só aparece dentro de nome de várias palavras fica fora; 'ia' (verbo) também", () => {
    for (const k of ["casa", "branca", "estados", "unidos", "claude", "banco", "brasil"]) assert.equal(lex.has(k), false, k);
    assert.equal(lex.get("opus"), "Opus", "Opus também aparece sozinho no texto");
    const { words } = applyProperNounLexicon(say("eu ia ficar em casa no estados", 0), lex);
    assert.deepEqual(words.map((w) => w.text), ["eu", "ia", "ficar", "em", "casa", "no", "estados"]);
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
  // Baseado na fala do export da 261021 (transcrição salva na pasta da edição), com linhas sintéticas.
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

describe("#12429 léxico: achados do review (acento, pontuação interna, conectivo, cabeçalho, template)", () => {
  const texts = (ws: Word[]) => ws.map((w) => w.text);

  it("regressão: 'aí' falado nunca vira 'AI' (acento ouvido não sai; 'ai' é ambígua)", () => {
    assert.equal(LEXICON_AMBIGUOUS.has("ai"), true);
    assert.equal(properNounLexicon("Teste no Workers AI hoje.").has("ai"), false);
    // Mesmo com "AI" no léxico, o acento ouvido manda.
    const { words, changes } = applyProperNounLexicon(say("e aí o modelo", 0), new Map([["ai", "AI"]]));
    assert.deepEqual(texts(words), ["e", "aí", "o", "modelo"]);
    assert.deepEqual(changes, []);
    // Acento que o Whisper não escreveu entra; o que ele escreveu fica.
    const lex = new Map([["sao", "São"], ["camara", "Câmara"]]);
    assert.deepEqual(texts(applyProperNounLexicon(say("sao câmara", 0), lex).words), ["São", "Câmara"]);
  });

  it("regressão: pontuação interna diferente não troca ('GPT-55' ouvido não vira 'GPT-5.5')", () => {
    const lex = new Map([["gpt55", "GPT-5.5"]]);
    const a = applyProperNounLexicon(say("o GPT-55 saiu", 0), lex);
    assert.deepEqual(texts(a.words), ["o", "GPT-55", "saiu"]);
    assert.deepEqual(a.changes, []);
    assert.deepEqual(texts(applyProperNounLexicon(say("o gpt-5.5 saiu", 0), lex).words), ["o", "GPT-5.5", "saiu"]);
  });

  it("regressão: 'e' não une nomes ('Google e Microsoft' são dois nomes no léxico)", () => {
    const lex = properNounLexicon("Hoje a Google e Microsoft anunciaram acordos.");
    assert.equal(lex.get("google"), "Google");
    assert.equal(lex.get("microsoft"), "Microsoft");
  });

  it("regressão: cabeçalho citado em caixa-alta no meio da linha fica fora, sigla conhecida entra", () => {
    const lex = properNounLexicon("Errei no USE MELHOR e na seção RADAR de LANÇAMENTOS. O negócio depende do CADE e da OpenAI.");
    for (const k of ["melhor", "radar", "lancamentos"]) assert.equal(lex.has(k), false, k);
    assert.equal(lex.get("cade"), "CADE");
    assert.equal(lex.get("openai"), "OpenAI");
  });

  it("sigla também cai se o texto a escreve em minúscula (lowerSeen sem atalho)", () => {
    assert.equal(properNounLexicon("Usei a API hoje. A api caiu.").has("api"), false);
    assert.equal(properNounLexicon("Usei a API hoje.").get("api"), "API");
  });

  it("editorialText tira É IA?, ERRO INTENCIONAL, SORTEIO, PARA ENCERRAR e box de CTA; mantém destaques", () => {
    const md = readFileSync(join(import.meta.dirname, "fixtures", "reviewed-261028-12429.md"), "utf8");
    const t = editorialText(md);
    assert.match(t, /OpenAI lançou o GPT-6\.1 Terra/);
    assert.match(t, /\*\*\[Apple solta a nova Siri/, "título de link em negrito fica");
    for (const gone of ["Wispr Flow", "ChatGTP", "Bonde articulado", "caneca da diar.ia.br", "curadoria de livros", "Mais sobre Mercado"]) {
      assert.equal(t.includes(gone), false, gone);
    }
  });

  it("02-reviewed.md real (261028): pro/melhor/aí/mercado/geral/ajustes não mudam; nomes da edição sim", () => {
    const md = readFileSync(join(import.meta.dirname, "fixtures", "reviewed-261028-12429.md"), "utf8");
    const lex = properNounLexicon(md);
    for (const k of ["pro", "melhor", "ai", "mercado", "geral", "ajustes", "radar", "lancamentos", "wispr", "flow", "beehiiv", "chatgtp", "moscou"]) {
      assert.equal(lex.has(k), false, k);
    }
    const heard = say("e aí, o plano pro do mercado melhor vai pro ajustes geral da openai e da apple no iphone", 0);
    const { words } = applyProperNounLexicon(heard, lex);
    assert.equal(
      texts(words).join(" "),
      "e aí, o plano pro do mercado melhor vai pro ajustes geral da OpenAI e da Apple no iPhone",
    );
  });
});

describe("#12429 NO_PLAN_SEQ_KEY", () => {
  it("é a chave do horizontal pelo sequenceKey (a do cache da transcrição do export)", () => {
    assert.equal(NO_PLAN_SEQ_KEY, sequenceKey({ target: "youtube" }));
    assert.equal(NO_PLAN_SEQ_KEY, "youtube");
  });
});

describe("#12429 marca de legenda sem plano não revisada", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "srt-mark-12429-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("applyYoutubeSrtCopy com noPlan grava a marca e origin no registro; a cópia seguinte com plano a apaga", () => {
    const path = join(dir, "ed", "diaria-comentada-261021.srt");
    const recordPath = join(dir, "youtube-srt.json");
    const marker = youtubeCaptionNoPlanMarkerPath(path);
    assert.equal(applyYoutubeSrtCopy({ path, recordPath, srt: "1\n00:00:00,000 --> 00:00:01,000\noi\n", force: false, origin: { name: "x.mp4" }, noPlan: true }), "write");
    assert.equal(JSON.parse(readFileSync(recordPath, "utf8")).origin, "no-plan");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).origin, "no-plan");
    assert.equal(applyYoutubeSrtCopy({ path, recordPath, srt: "1\n00:00:00,000 --> 00:00:01,000\ntchau\n", force: false, origin: { name: "x.mp4" } }), "write");
    assert.equal(existsSync(marker), false);
    assert.equal(JSON.parse(readFileSync(recordPath, "utf8")).origin, undefined);
  });

  it("regressão: --captions-only recusa o SRT marcado sem --captions-reviewed, sem chamar a API", async () => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "05-youtube-published.json"), JSON.stringify({ aammdd: "261021", videoId: "VID" }));
    const srtPath = join(dir, "diaria-comentada-261021.srt");
    writeFileSync(srtPath, "1\n00:00:00,000 --> 00:00:01,000\noi\n");
    writeFileSync(youtubeCaptionNoPlanMarkerPath(srtPath), JSON.stringify({ origin: "no-plan" }));
    const calls: string[] = [];
    const deps: YouTubeUploadDeps = { now: () => new Date(), fetch: async (url) => { calls.push(url); throw new Error("sem rede"); } };
    const logs: string[] = [];
    const base = { aammdd: "261021", editionDir: dir, captionsPath: srtPath, force: false, readFile: (p: string) => readFileSync(p), log: (l: string) => logs.push(l) };
    const refused = await runCaptionsOnly(deps, { ...base, env: {} });
    assert.equal(refused.exitCode, 1);
    assert.match(logs.join("\n"), /--captions-reviewed/);
    assert.equal(calls.length, 0);
    // Com --captions-reviewed passa da marca (e para na credencial ausente, ainda sem rede).
    logs.length = 0;
    const reviewed = await runCaptionsOnly(deps, { ...base, env: {}, captionsReviewed: true });
    assert.equal(reviewed.exitCode, 1);
    assert.match(logs.join("\n"), /\[premissa\] legenda sem plano enviada como revisada/);
    assert.match(logs.join("\n"), /faltam/);
    assert.equal(calls.length, 0);
  });
});

describe("#12429 CLI --no-plan com plan.json que tem o horizontal", () => {
  let dir: string;
  const origErr = console.error;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vm-12429b-"));
    console.error = () => {};
  });
  afterEach(() => {
    console.error = origErr;
    rmSync(dir, { recursive: true, force: true });
  });
  const base = () => ["srt", "261021", "--state-dir", dir, "--work-dir", dir, "--out-dir", dir, "--no-drive-api", "--drive-root", dir];

  it("recusa sem --force; com --force segue (e para no export ausente)", async () => {
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ hash: "x", plans: [{ spec: { target: "youtube", name: "h", width: 1920, height: 1080 }, script: "oi" }], source: { fps: 30 } }));
    await assert.rejects(main([...base(), "--from-final", join(dir, "nao-existe.mp4"), "--no-plan"]), /--no-plan recusado.*--force/);
    await assert.rejects(main([...base(), "--from-final", join(dir, "nao-existe.mp4"), "--no-plan", "--force"]), /export não encontrado/);
  });
});

describe("#12429 captionBackfillStatus e runCaptionsList: casos de borda", () => {
  const ENV = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs", YOUTUBE_REFRESH_TOKEN: "rt", YOUTUBE_CHANNEL_ID: "UCx" };
  const okBody = { items: [{ id: "cap1", snippet: { language: "pt-BR", trackKind: "standard", isDraft: false } }] };
  function deps(calls: string[]): YouTubeUploadDeps {
    return {
      now: () => new Date("2026-11-11T12:00:00Z"),
      fetch: async (url) => {
        calls.push(url);
        if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "tok" });
        if (url.startsWith("https://www.googleapis.com/youtube/v3/captions?")) return Response.json(okBody);
        throw new Error(`rota não mockada: ${url}`);
      },
    };
  }
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-12429b-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const writeRecord = (rec: unknown) => writeFileSync(join(dir, "_internal", "05-youtube-published.json"), JSON.stringify(rec));

  it("captionBackfillStatus: captionId registrado que é asr ou de outra língua não conta", () => {
    const base: CaptionTrack = { id: "cap1", language: "pt-BR", name: "", trackKind: "standard", isDraft: false, lastUpdated: null };
    assert.equal(captionBackfillStatus([{ ...base, trackKind: "asr" }], "cap1").ok, false);
    assert.equal(captionBackfillStatus([{ ...base, language: "en" }], "cap1").ok, false);
    assert.equal(captionBackfillStatus([{ ...base, trackKind: "forced" }], null).ok, false);
  });

  it("listCaptions: trackKind fora do conhecido vira 'unknown'", async () => {
    const d: YouTubeUploadDeps = { now: () => new Date(), fetch: async () => Response.json({ items: [{ id: "x", snippet: { trackKind: "WeIrD", language: "pt-BR" } }] }) };
    assert.equal((await listCaptions(d, "tok", "V"))[0].trackKind, "unknown");
  });

  it("--video-id diferente do registrado: confere o --video-id, sem o captionId do registro", async () => {
    writeRecord({ aammdd: "261030", videoId: "REG", captions: { ok: true, captionId: "outra" } });
    const calls: string[] = [];
    const logs: string[] = [];
    const out = await runCaptionsList(deps(calls), { aammdd: "261030", editionDir: dir, videoId: "OUTRO", env: ENV, log: (l) => logs.push(l) });
    assert.equal(out.exitCode, 0, logs.join("\n"));
    assert.equal(out.videoId, "OUTRO");
    assert.match(logs.join("\n"), /difere do vídeo registrado/);
    assert.ok(calls.some((u) => u.includes("videoId=OUTRO")));
  });

  it("registro de outra edição: sem --video-id = exit 1 sem API; com --video-id, confere", async () => {
    writeRecord({ aammdd: "261029", videoId: "REG" });
    const calls: string[] = [];
    const logs: string[] = [];
    const none = await runCaptionsList(deps(calls), { aammdd: "261030", editionDir: dir, env: ENV, log: (l) => logs.push(l) });
    assert.equal(none.exitCode, 1);
    assert.equal(calls.length, 0);
    assert.match(logs.join("\n"), /outra edição/);
    const byId = await runCaptionsList(deps(calls), { aammdd: "261030", editionDir: dir, videoId: "V", env: ENV, log: (l) => logs.push(l) });
    assert.equal(byId.exitCode, 0, logs.join("\n"));
  });

  it("registro em estado incerto (pending): mensagem própria; sem --video-id = exit 1", async () => {
    writeRecord({ aammdd: "261030", status: "in_progress" });
    const calls: string[] = [];
    const logs: string[] = [];
    const out = await runCaptionsList(deps(calls), { aammdd: "261030", editionDir: dir, env: ENV, log: (l) => logs.push(l) });
    assert.equal(out.exitCode, 1);
    assert.equal(calls.length, 0);
    assert.match(logs.join("\n"), /estado incerto \(in_progress\).*--video-id/);
    logs.length = 0;
    const byId = await runCaptionsList(deps(calls), { aammdd: "261030", editionDir: dir, videoId: "V", env: ENV, log: (l) => logs.push(l) });
    assert.equal(byId.exitCode, 0, logs.join("\n"));
    assert.match(logs.join("\n"), /\[aviso\].*estado incerto/);
  });

  it("credencial ausente: exit 1 sem chamar a API", async () => {
    writeRecord({ aammdd: "261030", videoId: "REG" });
    const calls: string[] = [];
    const logs: string[] = [];
    const out = await runCaptionsList(deps(calls), { aammdd: "261030", editionDir: dir, env: {}, log: (l) => logs.push(l) });
    assert.equal(out.exitCode, 1);
    assert.equal(calls.length, 0);
    assert.match(logs.join("\n"), /faltam/);
  });
});

describe("#12429 CLI publish-youtube: flags de --captions-list e --captions-reviewed (spawnSync)", () => {
  it("combinações inválidas saem 2 antes de qualquer API", () => {
    const dir = mkdtempSync(join(tmpdir(), "yt-cli-12429-"));
    try {
      for (const [args, message] of [
        [["--captions-only", "--video-id", "X"], /--video-id só vale com --captions-list/],
        [["--captions-list", "--video-id"], /--video-id exige o VIDEO_ID/],
        [["--captions-list", "--dry-run"], /exclusivos/],
        [["--dry-run", "--captions-reviewed"], /--captions-reviewed só vale com --captions-only/],
        [[], /--captions-list.*--thumbnail-only/],
      ] as const) {
        const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/publish-youtube.ts", "261021", "--edition-dir", dir, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
        assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
        assert.match(r.stderr, message);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
