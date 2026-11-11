/**
 * verify-accessibility-paywall-12645.test.ts (#12645)
 *
 * Regressão: `verify-accessibility.ts` dava `paywall` quando o HTML continha
 * qualquer frase solta de uma lista (`"assinantes"`, `"subscribe now"`,
 * `"premium content"`, `"subscribers only"`...). As frases aparecem em menu,
 * rodapé e caixa de newsletter de sites gratuitos (the-decoder, canaltech,
 * exame) e no título de notícia sobre assinaturas, e o Stage 1 tirava ~13
 * itens gratuitos por edição do pool. O veredito por conteúdo agora vem do
 * detector de prévia do #12537 (`lib/diaria/paywall-preview.ts`).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  detectPaywallPreview,
  isLegacyMarkerPaywallNote,
  PAYWALL_PREVIEW_NOTE_PREFIX,
  verify,
} from "../scripts/verify-accessibility.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";
import type { CacheEntry } from "../scripts/lib/url-verify-cache.ts";

function paragraphs(n: number, sentence: string): string {
  return Array.from({ length: n }, (_, i) => `<p>${sentence} Parágrafo ${i + 1} com mais detalhes do caso.</p>`).join("");
}

/** Artigo gratuito do canaltech: "assinantes" no título, menu com "Assine". */
const CANALTECH_FREE = `<!DOCTYPE html><html><head>
<title>OpenAI começa a negar novos assinantes do ChatGPT Plus - Canaltech</title>
</head><body>
<header><nav><a href="/assine">Assine</a> <a href="/premium">premium content</a></nav></header>
<article><h1>OpenAI começa a negar novos assinantes do ChatGPT Plus</h1>
${paragraphs(60, "A empresa disse que a demanda por assinantes superou a capacidade dos servidores e pausou as novas assinaturas.")}
</article>
<footer>Receba a newsletter, subscribe now. Conteúdo para assinantes e não assinantes.</footer>
</body></html>`;

/** the-decoder: caixa de newsletter com "subscribe now" e "subscribers only". */
const DECODER_FREE = `<!DOCTYPE html><html><head><title>Model X launches - THE DECODER</title></head><body>
<article>${paragraphs(50, "The model ships with a new reasoning mode and an open license for researchers.")}</article>
<div class="newsletter-box">Get the AI newsletter. Subscribe now! Extra analysis for subscribers only.</div>
</body></html>`;

/** Prévia de paywall de verdade: schema.org declara, texto curto, frase de corte. */
const REAL_PREVIEW = `<!DOCTYPE html><html><head><title>Exclusivo</title>
<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false,"wordCount":1800}</script>
</head><body><article>
${paragraphs(4, "O executivo contou à reportagem detalhes inéditos da negociação com o governo e com os bancos credores.")}
<p>Assine para continuar lendo esta reportagem.</p>
</article>${"<span> </span>".repeat(80)}</body></html>`;

/** Site que manda o texto inteiro no HTML e só esconde por JS: aberto. */
const FULL_BEHIND_JS = `<!DOCTYPE html><html><head><title>Longo</title>
<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false,"wordCount":600}</script>
</head><body><article>${paragraphs(40, "Texto completo da reportagem está no HTML e o site só esconde parte por JavaScript.")}</article>
<div class="paywall">Assine para continuar</div></body></html>`;

describe("detectPaywallPreview (#12645) — frase solta em site gratuito não é paywall", () => {
  it("canaltech: 'assinantes' no título + 'premium content' no menu → aberto", () => {
    assert.equal(detectPaywallPreview(CANALTECH_FREE), null);
  });

  it("the-decoder: 'subscribe now' / 'subscribers only' na caixa de newsletter → aberto", () => {
    assert.equal(detectPaywallPreview(DECODER_FREE), null);
  });

  it("prévia real (isAccessibleForFree:false + frase de corte + texto curto) → paywall", () => {
    const note = detectPaywallPreview(REAL_PREVIEW);
    assert.ok(note, "deveria detectar prévia");
    assert.ok(note!.startsWith(PAYWALL_PREVIEW_NOTE_PREFIX), note!);
    assert.match(note!, /isAccessibleForFree=false/);
    assert.match(note!, /de 1800 declaradas/);
  });

  it("texto inteiro no HTML com sinal de paywall → aberto (esconde só por JS)", () => {
    assert.equal(detectPaywallPreview(FULL_BEHIND_JS), null);
  });

  it("texto visível explícito (path do browser) prevalece sobre o HTML", () => {
    const note = detectPaywallPreview(
      `<html><body><div class="paywall"></div></body></html>`,
      "Primeiro parágrafo curto. Assine para continuar lendo.",
    );
    assert.ok(note && note.includes("html:paywall"), String(note));
  });
});

describe("isLegacyMarkerPaywallNote (#12645) — cache do detector antigo", () => {
  it("reconhece as notas do detector por substring", () => {
    assert.equal(isLegacyMarkerPaywallNote("marker: assinantes"), true);
    assert.equal(isLegacyMarkerPaywallNote("browser marker: subscribe now"), true);
  });
  it("não confunde domínio conhecido nem o detector novo", () => {
    assert.equal(isLegacyMarkerPaywallNote("known-paywall domain"), false);
    assert.equal(isLegacyMarkerPaywallNote(`${PAYWALL_PREVIEW_NOTE_PREFIX} texto:"x" (10 palavras)`), false);
    assert.equal(isLegacyMarkerPaywallNote(undefined), false);
  });
});

describe("verify() (#12645) — caminho GET real contra servidor local", () => {
  let server: Server;
  let base = "";

  before(async () => {
    server = createServer((req, res) => {
      const pages: Record<string, string> = {
        "/canaltech-free": CANALTECH_FREE,
        "/decoder-free": DECODER_FREE,
        "/real-preview": REAL_PREVIEW,
      };
      const html = pages[req.url ?? ""];
      if (!html) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it("canaltech com 'assinantes' no título sai accessible (antes: paywall 'marker: assinantes')", async () => {
    const r = await verify(`${base}/canaltech-free`, { timeoutMs: 5000 });
    assert.equal(r.verdict, "accessible", JSON.stringify(r));
  });

  it("the-decoder com caixa 'subscribe now' sai accessible", async () => {
    const r = await verify(`${base}/decoder-free`, { timeoutMs: 5000 });
    assert.equal(r.verdict, "accessible", JSON.stringify(r));
  });

  it("prévia de paywall de verdade continua paywall", async () => {
    const r = await verify(`${base}/real-preview`, { timeoutMs: 5000 });
    assert.equal(r.verdict, "paywall", JSON.stringify(r));
    assert.ok(r.note?.startsWith(PAYWALL_PREVIEW_NOTE_PREFIX), r.note);
  });

  it("paywall cacheado pelo detector antigo é reverificado, não devolvido", async () => {
    const url = `${base}/canaltech-free`;
    const cache = new Map<string, CacheEntry>([
      [canonicalize(url), { verdict: "paywall", note: "marker: assinantes", verified_at: new Date().toISOString() }],
    ]);
    const r = await verify(url, { timeoutMs: 5000, verifyCache: cache });
    assert.equal(r._cacheHit, undefined, "não deveria ser cache hit");
    assert.equal(r.verdict, "accessible", JSON.stringify(r));
  });

  it("paywall cacheado por domínio conhecido continua cache hit", async () => {
    const url = `${base}/canaltech-free`;
    const cache = new Map<string, CacheEntry>([
      [canonicalize(url), { verdict: "paywall", note: "known-paywall domain", verified_at: new Date().toISOString() }],
    ]);
    const r = await verify(url, { timeoutMs: 5000, verifyCache: cache });
    assert.equal(r._cacheHit, true);
    assert.equal(r.verdict, "paywall");
  });
});
