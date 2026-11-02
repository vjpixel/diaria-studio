/**
 * #11828: o timer do Instagram que acha o Reel feito à mão na conta e o registra
 * (`already` em `instagramTimerGate`) relê os collaborators e avisa quando falta
 * a @vjpixel, sem bloquear o registro. Fetch injetado: nada toca a Graph API.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instagramConfirmExpectedCollabs, instagramTimerAlreadyCollabWarnings, type GraphDeps } from "../scripts/publish-shorts.ts";
import { interpretInstagramTimerOutput } from "../scripts/shorts-instagram-timer.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function seqFetch(seq: Array<{ json: unknown; status?: number }>): { deps: Pick<GraphDeps, "fetch">; urls: string[] } {
  const urls: string[] = [];
  return {
    deps: {
      fetch: async (url) => {
        urls.push(url);
        const r = seq[urls.length - 1];
        if (!r) throw new Error(`chamada inesperada: ${url}`);
        return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
      },
    },
    urls,
  };
}

const base = { mediaId: "m1", token: "tok", apiVersion: "v25.0" };
// Produção (#11794): a autora à mão é a própria conta da API, e a @vjpixel entra sempre.
const expected = instagramConfirmExpectedCollabs({ account: "primary", sameAccount: true, configCollaborators: [] });

describe("#11828: collab do Reel feito à mão que o timer registra", () => {
  it("o esperado na produção inclui a @vjpixel mesmo sem instagram_collaborators", () => {
    assert.deepEqual(expected, ["vjpixel"]);
  });

  it("Reel achado pelo marcador sem a @vjpixel nos collabs → aviso", async () => {
    const { deps, urls } = seqFetch([{ json: { data: [] } }]);
    const w = await instagramTimerAlreadyCollabWarnings(deps, { ...base, matchedBy: "marker", expected });
    assert.match(urls[0], /\/m1\/collaborators\?/);
    assert.match(urls[0], /access_token=tok/);
    assert.equal(w.length, 1);
    assert.match(w[0], /@vjpixel/);
  });

  it("com a @vjpixel (mesmo Pending) → sem aviso", async () => {
    const { deps } = seqFetch([{ json: { data: [{ username: "VJPixel", invite_status: "Pending" }] } }]);
    assert.deepEqual(await instagramTimerAlreadyCollabWarnings(deps, { ...base, matchedBy: "media-id", expected }), []);
  });

  it("leitura que falha vira aviso, nunca lança (o registro já foi gravado)", async () => {
    const { deps } = seqFetch([{ json: { error: { message: "boom" } }, status: 500 }]);
    const w = await instagramTimerAlreadyCollabWarnings(deps, { ...base, matchedBy: "marker", expected });
    assert.match(w[0], /não deu pra conferir/);
  });

  it("registro anterior (registry) ou nenhum collab esperado → não lê a API", async () => {
    const { deps, urls } = seqFetch([]);
    assert.deepEqual(await instagramTimerAlreadyCollabWarnings(deps, { ...base, matchedBy: "registry", expected }), []);
    assert.deepEqual(await instagramTimerAlreadyCollabWarnings(deps, { ...base, matchedBy: "marker", expected: [] }), []);
    assert.equal(urls.length, 0);
  });

  it("o timer não alarma, mas o aviso aparece no detalhe do done", () => {
    const out = JSON.stringify({
      dry_run: false,
      items: [],
      results: [{ destination: "instagram", ok: true, alreadyRegistered: true, matchedBy: "marker", entry: { status: "published", id: "m1", url: "https://i/m1" }, warnings: ["convite de collab descartado pelo Instagram: @vjpixel — convide à mão no app"] }],
    });
    const r = interpretInstagramTimerOutput(0, out);
    assert.equal(r.kind, "done");
    assert.match(r.detail, /já estava na conta\/registro/);
    assert.match(r.detail, /@vjpixel/);
  });

  it("o caminho `already` do timer em publish-shorts.ts chama a conferência e passa os avisos adiante", () => {
    const src = readFileSync(resolve(ROOT, "scripts/publish-shorts.ts"), "utf8");
    // #11870: o bloco passou a cobrir também o achado da reconferência antes do publish.
    const i = src.indexOf("if (already) {");
    assert.ok(i > 0, "bloco already do timer não encontrado");
    const block = src.slice(i, src.indexOf("continue;", i));
    assert.match(block, /instagramTimerAlreadyCollabWarnings\(/);
    assert.match(block, /warnings: collabWarnings/);
  });
});
