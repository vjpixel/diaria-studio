/**
 * #13326: AlphaSignal e Data Points (DeepLearning.AI) saíam com 100% dos links
 * filtrados em toda edição — o tracker opaco (destino só no Location) ficava no
 * domínio do sender e caía como "sender-own". Fixtures: envio real de cada
 * (261117), anonimizado, com o Location real que cada tracker devolveu.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  extractHubspotRedirectHref,
  isOpaqueTrackerUrl,
  resolveOpaqueTracker,
  resolveOpaqueTrackers,
  type FetchLike,
} from "../scripts/lib/newsletter-opaque-redirect.ts";
import { processThreads, type CapturedThread } from "../scripts/capture-newsletter-urls.ts";
import { attachResolvedRedirects, mergeCaptured } from "../scripts/fetch-newsletter-threads.ts";
import { buildIntake } from "../scripts/audit-newsletter-intake.ts";
import type { SenderRegistry } from "../scripts/lib/newsletter-senders.ts";

interface Fixture { thread: CapturedThread; network: Record<string, string> }
const FIX = resolve(import.meta.dirname, "fixtures/newsletter-opaque-13326");
const load = (name: string): Fixture => JSON.parse(readFileSync(resolve(FIX, `${name}.json`), "utf8"));
const alpha = load("alphasignal");
const datapoints = load("datapoints");

/** Página intermediária do HubSpot (estrutura real de 17/11/2026, token anonimizado). */
const hubspotInterstitial = (tracker: string) => {
  const cont = tracker.replace(/\/e3t\/[A-Za-z]+\//, "/events/public/v1/encoded/track/tc/") + "?_ud=00000000-0000-0000-0000-000000000000&amp;_jss=0";
  return `<!DOCTYPE html><html><head><script>function isWebDriver(){}</script></head><body>
<h4>You're being redirected</h4><p>If you're not redirected in a few seconds,
<a href="${cont}" rel="noreferrer" class="private-link">click here</a></p></body></html>`;
};

/** Fake de rede: AlphaSignal 307 direto; HubSpot 200 intermediário → 307. Registra cada URL pedida. */
function fakeNetwork(network: Record<string, string>) {
  const calls: string[] = [];
  const res = (status: number, location: string | null, body = "") => ({
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "location" ? location : null) },
    text: async () => body,
  });
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    if (url.includes("/events/public/v1/encoded/track/tc/")) {
      const tracker = url.replace("/events/public/v1/encoded/track/tc/", "/e3t/Ctc/").replace(/\?.*$/, "");
      return network[tracker] ? res(307, network[tracker]) : res(404, null);
    }
    if (url.includes("/e3t/")) return network[url] ? res(200, null, hubspotInterstitial(url)) : res(404, null);
    return network[url] ? res(307, network[url]) : res(200, null);
  };
  return { fetchImpl, calls };
}

const registry: SenderRegistry = { version: 1, senders: {
  "news@alphasignal.ai": { status: "aprovado", reason: "fixture", decided_at: "2026-11-17" },
  "datapoints@deeplearning.ai": { status: "aprovado", reason: "fixture", decided_at: "2026-11-17" },
} };

async function withResolved(fx: Fixture): Promise<{ thread: CapturedThread; calls: string[] }> {
  const thread: CapturedThread = structuredClone(fx.thread);
  const { fetchImpl, calls } = fakeNetwork(fx.network);
  await attachResolvedRedirects([thread], (urls) => resolveOpaqueTrackers(urls, { fetchImpl }));
  return { thread, calls };
}

describe("#13326 tracker opaco de newsletter", () => {
  it("reconhece só os formatos conhecidos — nunca unsubscribe, feedback ou preferências", () => {
    const opaque = alpha.thread.urls_extraidas!.filter(isOpaqueTrackerUrl);
    assert.equal(opaque.length, Object.keys(alpha.network).length);
    assert.ok(datapoints.thread.urls_extraidas!.filter(isOpaqueTrackerUrl).length >= 40);
    for (const u of [
      "https://app.alphasignal.ai/unsubscribe/u/ANON?cid=1",
      "https://app.alphasignal.ai/fb/ANON?cid=1&feedback=Awesome",
      "https://info.deeplearning.ai/hs/preferences-center/en/page?data=ANON",
      "https://alphasignal.ai/archive?utm_source=forward",
      "https://example.com/c?lid=1",
      "https://example.com/blog/e3t/post",
    ]) assert.equal(isOpaqueTrackerUrl(u), false, u);
  });

  it("REGRESSÃO: sem resolver, as duas newsletters saem com 0 links (o bug); resolvidas, trazem os artigos", async () => {
    for (const fx of [alpha, datapoints]) {
      const before = processThreads([fx.thread], { processed_thread_ids: [] });
      assert.equal(before.articles.length, 0, `${fx.thread.sender}: estado do bug`);
      assert.equal(before.result.urls_filtered, before.result.urls_extracted);
    }
    const a = processThreads([(await withResolved(alpha)).thread], { processed_thread_ids: [] }).articles.map((x) => x.url);
    assert.ok(a.includes("https://arxiv.org/abs/2611.17309"), a.join("\n"));
    assert.ok(a.includes("https://github.com/FinanceFlash/unvibecode"));
    assert.ok(!a.some((u) => /x\.com\/AlphaSignalAI|alphasignal\.ai/.test(u)), "perfil social e domínio do sender seguem fora");

    const d = processThreads([(await withResolved(datapoints)).thread], { processed_thread_ids: [] }).articles.map((x) => x.url);
    assert.ok(d.includes("https://deepmind.google/blog/introducing-gemini-4-hydrogen"), d.join("\n"));
    assert.ok(d.some((u) => u.startsWith("https://huggingface.co/blog/ggml-org/llama-cpp-v1")));
    assert.ok(!d.some((u) => /deeplearning\.ai|linkedin\.com\/company|twitter\.com\/DeepLearningAI|facebook\.com\/\d+$|youtube\.com\/channel/.test(u)), d.join("\n"));
    assert.ok(!d.some((u) => /_hsenc|_hsmi|utm_/.test(u)), "token de assinante do HubSpot nunca vai pro pool");
    assert.equal(new Set(d).size, d.length, "mesmo artigo citado 2x (tokens _hsenc diferentes) colapsa");
  });

  it("intake do gate 4 deixa de marcar as duas como 'falhou ... N extraídos, N filtrados'", async () => {
    const threads = [(await withResolved(alpha)).thread, (await withResolved(datapoints)).thread];
    const { rows } = buildIntake(threads, registry, [], undefined, {});
    for (const r of rows) {
      assert.ok(r.links_capturados > 0, `${r.remetente}: ${r.estado_motivo}`);
      assert.doesNotMatch(r.estado_motivo, /sem nenhum link capturado/);
    }
  });

  it("só pede ao provedor as URLs de tracker — nunca feedback/unsubscribe, nem o destino", async () => {
    const { calls } = await withResolved(alpha);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((u) => /alphasignal\.ai\/c\?/.test(u)), calls.join("\n"));
    const dp = await withResolved(datapoints);
    assert.ok(dp.calls.every((u) => /info\.deeplearning\.ai\/(e3t|events\/public)\//.test(u)), dp.calls.join("\n"));
  });

  it("falha de rede vira null por link e a captura segue (link fica filtrado como antes)", async () => {
    const boom: FetchLike = async () => { throw new Error("ECONNRESET"); };
    const thread = structuredClone(alpha.thread);
    const r = await attachResolvedRedirects([thread], (urls) => resolveOpaqueTrackers(urls, { fetchImpl: boom }));
    assert.equal(r.resolved, 0);
    assert.equal(r.failed, r.attempted);
    assert.equal(thread.resolved_redirects, undefined);
    assert.equal(await resolveOpaqueTracker("https://example.com/x", { fetchImpl: boom }), null);
  });

  it("página do HubSpot: só segue o link de tracking do mesmo host", () => {
    const tracker = "https://info.deeplearning.ai/e3t/Ctc/LX+113/cJhC404/ANONTOKEN000";
    assert.match(extractHubspotRedirectHref(hubspotInterstitial(tracker), tracker) ?? "", /^https:\/\/info\.deeplearning\.ai\/events\/public\/v1\/encoded\/track\/tc\/.*_jss=0$/);
    assert.equal(extractHubspotRedirectHref('<a href="https://evil.example/events/public/v1/encoded/track/tc/x">x</a>', tracker), null);
    assert.equal(extractHubspotRedirectHref('<a href="https://info.deeplearning.ai/hs/preferences-center/x">x</a>', tracker), null);
  });

  it("teto de URLs: o excedente não é pedido e é reportado", async () => {
    const { fetchImpl, calls } = fakeNetwork(alpha.network);
    const r = await resolveOpaqueTrackers(Object.keys(alpha.network), { fetchImpl, maxUrls: 3 });
    assert.equal(calls.length, 3);
    assert.equal(r.skipped_over_cap, Object.keys(alpha.network).length - 3);
  });

  it("re-run: thread já gravada sem resolved_redirects ganha os destinos; o resto fica intacto", async () => {
    const old: CapturedThread = { ...structuredClone(alpha.thread), body: "corpo antigo" };
    const { thread: fresh } = await withResolved(alpha);
    const [merged] = mergeCaptured([old], [fresh]);
    assert.equal(merged.body, "corpo antigo");
    assert.deepEqual(merged.resolved_redirects, fresh.resolved_redirects);
  });
});
