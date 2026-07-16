/**
 * test/poll-share-3517.test.ts (#3517)
 *
 * Share card pós-jogo do "É IA?" standalone (EPIC #3514) — construído sobre a
 * fundação do #3516 (brand `web`, página `/jogar`, slot `#jogar-result-slot`
 * reservado). Cobre:
 *   - serializeSharePayload/deserializeSharePayload (pure, sem PII)
 *   - encodeShareToken/decodeShareToken (HMAC assinado, adulteração rejeitada)
 *   - buildShareText (correct true/false/null)
 *   - renderShareCardBlock / renderShareCardSvg / renderSharePageHtml (pure)
 *   - GET /og/{token} e GET /share/{token} (rotas)
 *   - self-review #2038: /vote?brand=web embute o card; /vote sem brand=web
 *     (diaria/clarice) NÃO embute; GET /jogar (pré-voto) não vaza o gabarito.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildShareText,
  decodeShareToken,
  deserializeSharePayload,
  encodeShareToken,
  renderShareCardBlock,
  renderShareCardSvg,
  renderSharePageHtml,
  serializeSharePayload,
  type SharePayload,
} from "../workers/poll/src/share.ts";
import { anonEmailForToken } from "../workers/poll/src/jogar.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async getWithMetadata(key: string) {
      const v = m.get(key);
      return { value: v ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    _map: m,
  };
}

function makeEnv(seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeMapKV> } {
  return {
    POLL: makeMapKV(seed),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  };
}

describe("serializeSharePayload / deserializeSharePayload (#3517) — pure, sem PII", () => {
  it("round-trip preserva edition + correct=true/false/null", () => {
    for (const correct of [true, false, null] as const) {
      const payload: SharePayload = { edition: "260716", correct };
      const body = serializeSharePayload(payload);
      assert.deepEqual(deserializeSharePayload(body), payload);
    }
  });

  it("nunca contém email/token do jogador — só edition (público) + correct", () => {
    const body = serializeSharePayload({ edition: "260716", correct: true });
    assert.doesNotMatch(body, /@/);
    assert.equal(body, "260716.1");
  });

  it("deserializeSharePayload rejeita forma malformada sem lançar (nunca 500 numa rota pública)", () => {
    assert.equal(deserializeSharePayload(""), null);
    assert.equal(deserializeSharePayload("not-a-payload"), null);
    assert.equal(deserializeSharePayload("2026-07-16.1"), null);
    assert.equal(deserializeSharePayload("260716.2"), null);
  });

  it("aceita qualquer 6 dígitos (mesma leniência de AAMMDD_RE/resolveJogarEdition — validação de mês/dia REAL fica em formatEditionDate, que já cai pro fallback raw-string pra mm/dd fora do range)", () => {
    // Consistente com o resto do worker: o gate de parsing só valida FORMA
    // (6 dígitos), nunca semântica de calendário — nunca lança nem aqui.
    assert.deepEqual(deserializeSharePayload("999999.1"), { edition: "999999", correct: true });
  });
});

describe("encodeShareToken / decodeShareToken (#3517) — HMAC assinado", () => {
  it("round-trip: token gerado decodifica de volta ao payload original", async () => {
    const payload: SharePayload = { edition: "260716", correct: true };
    const token = await encodeShareToken("secret-a", payload);
    const decoded = await decodeShareToken("secret-a", token);
    assert.deepEqual(decoded, payload);
  });

  it("token adulterado (sig trocado) é rejeitado — retorna null, não lança", async () => {
    const token = await encodeShareToken("secret-a", { edition: "260716", correct: true });
    const [body] = token.split(".");
    const tampered = `${body}.0000000000000000`;
    assert.equal(await decodeShareToken("secret-a", tampered), null);
  });

  it("payload adulterado (correct trocado, sig do payload original) é rejeitado", async () => {
    const token = await encodeShareToken("secret-a", { edition: "260716", correct: false });
    const sig = token.slice(token.lastIndexOf(".") + 1);
    const forged = `260716.1.${sig}`;
    assert.equal(await decodeShareToken("secret-a", forged), null);
  });

  it("token válido com secret ERRADO é rejeitado (rotação de secret invalida links antigos, fail-soft)", async () => {
    const token = await encodeShareToken("secret-a", { edition: "260716", correct: true });
    assert.equal(await decodeShareToken("secret-b", token), null);
  });

  it("token malformado (sem ponto de sig, string vazia) nunca lança", async () => {
    assert.equal(await decodeShareToken("secret-a", ""), null);
    assert.equal(await decodeShareToken("secret-a", "lixo-sem-formato"), null);
  });
});

describe("buildShareText (#3517)", () => {
  it("correct=true — texto de acerto, sem revelar dado do jogador", () => {
    const text = buildShareText({ edition: "260716", correct: true });
    assert.match(text, /Acertei/);
    assert.doesNotMatch(text, /@/);
  });

  it("correct=false — texto de erro, ainda convida a jogar", () => {
    const text = buildShareText({ edition: "260716", correct: false });
    assert.match(text, /Não foi dessa vez/);
  });

  it("correct=null — gabarito ainda não revelado, texto não afirma acerto nem erro", () => {
    const text = buildShareText({ edition: "260716", correct: null });
    assert.match(text, /resultado sai em breve/i);
    assert.doesNotMatch(text, /Acertei/);
    assert.doesNotMatch(text, /Não foi dessa vez/);
  });
});

describe("renderShareCardBlock (#3517) — bloco reusado por votePageHtml e /jogar", () => {
  it("contém id=jogar-share-card e os 2 botões de ação apontando pra /share/{token}", () => {
    const html = renderShareCardBlock("260716.1.abc123", { edition: "260716", correct: true });
    assert.match(html, /id="jogar-share-card"/);
    assert.match(html, /data-share-action="native"/);
    assert.match(html, /data-share-action="copy"/);
    assert.match(html, /\/share\/260716\.1\.abc123\?utm_medium=social/);
    assert.match(html, /\/share\/260716\.1\.abc123\?utm_medium=copy/);
  });

  it("htmlEscape no texto/token — sem XSS via payload adulterado hipotético", () => {
    const html = renderShareCardBlock('"><script>alert(1)</script>', { edition: "260716", correct: true });
    assert.doesNotMatch(html, /<script>alert/);
  });
});

describe("renderShareCardSvg (#3517) — OG image dinâmica", () => {
  it("é um SVG válido 1200x630 (proporção OG padrão)", () => {
    const svg = renderShareCardSvg({ edition: "260716", correct: true });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="630"/);
    assert.match(svg, /<\/svg>$/);
  });

  it("varia o texto conforme correct=true/false/null (resultado visível no card)", () => {
    const trueCard = renderShareCardSvg({ edition: "260716", correct: true });
    const falseCard = renderShareCardSvg({ edition: "260716", correct: false });
    const nullCard = renderShareCardSvg({ edition: "260716", correct: null });
    assert.match(trueCard, /Acertou!/);
    assert.match(falseCard, /Quase!/);
    assert.match(nullCard, /Já votou!/);
  });

  it("nunca contém PII (sem @ — payload não carrega email/token)", () => {
    const svg = renderShareCardSvg({ edition: "260716", correct: true });
    assert.doesNotMatch(svg, /@/);
  });
});

describe("renderSharePageHtml (#3517) — página /share/{token}, destino dos unfurlers", () => {
  it("og:image/twitter:image apontam pra /og/{token} — resolve a lacuna de #3106 (antes: nenhuma imagem buscável)", () => {
    const html = renderSharePageHtml({
      token: "260716.1.abc123",
      payload: { edition: "260716", correct: true },
      utmMedium: "social",
    });
    assert.match(html, /<meta property="og:image" content="https:\/\/poll\.diaria\.workers\.dev\/og\/260716\.1\.abc123">/);
    assert.match(html, /<meta name="twitter:image" content="https:\/\/poll\.diaria\.workers\.dev\/og\/260716\.1\.abc123">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  });

  it("CTA 'Jogar agora' propaga utm_source=share e o utm_medium recebido", () => {
    const html = renderSharePageHtml({
      token: "260716.1.abc123",
      payload: { edition: "260716", correct: true },
      utmMedium: "copy",
    });
    // htmlEscape escapa "&" pra "&amp;" no atributo href (comportamento HTML
    // correto — a página escapa TUDO que interpola em atributo, ver htmlEscape em lib.ts).
    assert.match(html, /href="\/jogar\?utm_source=share&amp;utm_medium=copy"/);
  });

  it("og:title/description presentes (mesmo helper renderSeoMeta do resto do worker)", () => {
    const html = renderSharePageHtml({
      token: "t",
      payload: { edition: "260716", correct: null },
      utmMedium: "link",
    });
    assert.match(html, /<meta property="og:title" content="[^"]+">/);
    assert.match(html, /<meta property="og:description" content="[^"]+">/);
  });
});

describe("GET /og/{token} e GET /share/{token} (#3517, rotas)", () => {
  it("GET /og/{token válido} → 200 image/svg+xml, cache immutable (conteúdo é função pura do token)", async () => {
    const env = makeEnv();
    const token = await encodeShareToken(env.POLL_SECRET, { edition: "260716", correct: true });
    const res = await worker.fetch(new Request(`https://poll.test/og/${token}`), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(res.headers.get("cache-control") ?? "", /immutable/);
    const svg = await res.text();
    assert.match(svg, /<svg/);
  });

  it("GET /og/{token inválido} → 404 (imagem embutida via <img src>, 404 é o comportamento HTTP correto)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/og/lixo-invalido"), env);
    assert.equal(res.status, 404);
  });

  it("GET /share/{token válido} → 200 HTML com og:image", async () => {
    const env = makeEnv();
    const token = await encodeShareToken(env.POLL_SECRET, { edition: "260716", correct: true });
    const res = await worker.fetch(new Request(`https://poll.test/share/${token}`), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /property="og:image"/);
  });

  it("GET /share/{token inválido} → 302 pra /jogar (link quebrado NUNCA vira dead-end)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/share/lixo-invalido"), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/jogar");
  });

  it("GET /share/{token} propaga ?utm_medium= pro CTA de /jogar", async () => {
    const env = makeEnv();
    const token = await encodeShareToken(env.POLL_SECRET, { edition: "260716", correct: true });
    const res = await worker.fetch(new Request(`https://poll.test/share/${token}?utm_medium=whatsapp`), env);
    const html = await res.text();
    assert.match(html, /utm_medium=whatsapp/);
  });

  it("endpoints 404 listam /share/{token} e /og/{token}", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/rota-inexistente"), env);
    const body = (await res.json()) as { endpoints: string[] };
    assert.ok(body.endpoints.some((e) => e.startsWith("/share/")));
    assert.ok(body.endpoints.some((e) => e.startsWith("/og/")));
  });
});

describe("integração /vote?brand=web (#3517, self-review #2038) — card embutido só onde faz sentido", () => {
  const voteReq = (brand: string | null, email: string, choice: string, edition = "260531") => {
    const b = brand ? `&brand=${brand}` : "";
    return new Request(
      `https://poll.test/vote?email=${encodeURIComponent(email)}&edition=${edition}&choice=${choice}${b}`,
    );
  };

  it("voto NOVO em brand=web embute #jogar-share-card com token decodificável", async () => {
    const env = makeEnv();
    const anonEmail = anonEmailForToken("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    const res = await worker.fetch(voteReq("web", anonEmail, "A"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /id="jogar-share-card"/);
    const match = /data-share-url="https:\/\/poll\.diaria\.workers\.dev\/share\/([^"?]+)\?utm_medium=social"/.exec(html);
    assert.ok(match, "share URL com token não encontrada no HTML de resultado");
    const token = decodeURIComponent(match![1]);
    const decoded = await decodeShareToken(env.POLL_SECRET, token);
    assert.ok(decoded, "token embutido no HTML deve decodificar de volta");
    assert.equal(decoded!.edition, "260531");
  });

  it("voto em brand=diaria (e-mail assinante) NÃO embute card de compartilhamento", async () => {
    const env = makeEnv();
    const res = await worker.fetch(voteReq(null, "leitor@example.com", "B"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /id="jogar-share-card"/);
  });

  it("voto em brand=clarice (e-mail assinante mensal) também NÃO embute card", async () => {
    const env = makeEnv();
    const res = await worker.fetch(voteReq("clarice", "leitor@example.com", "A"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /id="jogar-share-card"/);
  });

  it("self-review: GET /jogar (pré-voto) nunca vaza o gabarito nem um card de resultado", async () => {
    const env = makeEnv({ "correct:260101": "A" });
    const res = await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), env);
    const html = await res.text();
    // Nota: o JS estático da página REFERENCIA o seletor "#jogar-share-card"
    // (querySelector, pra extrair o card injetado depois de um fetch) — isso é
    // esperado e não é um vazamento. O que não pode existir é o ELEMENTO
    // renderizado (a tag <div id="jogar-share-card" ...>, produzida só por
    // renderShareCardBlock) no HTML inicial, pré-voto.
    assert.doesNotMatch(html, /<div id="jogar-share-card"/);
    assert.doesNotMatch(html, /Acertei/);
    assert.doesNotMatch(html, /Não foi dessa vez/);
    // O slot existe mas vazio/hidden — confirma que é só o ponto de extensão,
    // não conteúdo pré-preenchido.
    assert.match(html, /<div id="jogar-result-slot" hidden><\/div>/);
  });
});
