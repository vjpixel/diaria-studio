/**
 * #11427: timer do Reels com a credencial da página `vjpixel` presente, mas a
 * Graph API respondendo 5xx ao ler a conta do Instagram vinculada. Antes do
 * fix, `resolveChromeAuthorReader` devolvia só `unavailable` e o gate lançava
 * `author-unchecked` ("forneça a credencial da página vjpixel no 300"), alarme
 * `acao` falso que ainda suprimia o `late` da edição. Agora a leitura que falha
 * vira `read-failed` (urgente, com nova tentativa); `author-unchecked` fica só
 * para credencial ausente de verdade.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideInstagramConfirm,
  decideInstagramTimerAcrossAccounts,
  instagramTimerGate,
  instagramTimerPublishStep,
  resolveChromeAuthorReader,
  timerChromeAuthorDeps,
  type GraphDeps,
  type InstagramConfirmDecision,
} from "../scripts/publish-shorts.ts";
import { alarmSuppressed, interpretInstagramTimerOutput } from "../scripts/shorts-instagram-timer.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const AT = "2026-10-27T11:00:00.000Z";
const MARKERS = ["utm_campaign=261027", "Título do D1"];
const decideEmpty = async (): Promise<InstagramConfirmDecision> =>
  decideInstagramConfirm({
    published: { aammdd: "261027", entries: [] },
    media: { data: [] },
    sinceIso: "2026-10-27T03:00:00.000Z",
    markers: MARKERS,
    nowIso: "2026-10-27T20:00:00.000Z",
    expectedAtIso: AT,
  });

const vjpixel: ResolvedFacebookPage = { slug: "vjpixel", enabled: false, pageId: "937", token: "tok", missing: [], utmContent: "page-vjpixel" };
const semCredencial: ResolvedFacebookPage = { ...vjpixel, pageId: "", token: "", missing: ["FACEBOOK_VJPIXEL_PAGE_ID", "FACEBOOK_VJPIXEL_PAGE_TOKEN"] };

/** Fake da Graph: cada chamada consome a próxima resposta da fila. */
function graphFake(seq: Array<{ json: unknown; status: number }>): { deps: Pick<GraphDeps, "fetch">; calls: string[] } {
  const calls: string[] = [];
  return {
    deps: {
      fetch: async (url) => {
        calls.push(url);
        const r = seq[calls.length - 1];
        if (!r) throw new Error(`chamada inesperada: ${url}`);
        return new Response(JSON.stringify(r.json), { status: r.status });
      },
    },
    calls,
  };
}
const fail5xx = { json: { error: { message: "An unexpected error has occurred.", code: 2 } }, status: 500 };
const linked = { json: { instagram_business_account: { id: "1784", username: "vjpixel" } }, status: 200 };

/** O gate do timer como o `--publish` o monta: conta da API vazia + perfil do autor resolvido. */
async function runGate(chromeDeps: Pick<GraphDeps, "fetch">, pages: ResolvedFacebookPage[]): Promise<{ published: number; error: unknown }> {
  const chrome = await resolveChromeAuthorReader("diaria", pages, "v25.0", chromeDeps);
  let published = 0;
  let error: unknown = null;
  try {
    await instagramTimerPublishStep({
      gate: () =>
        instagramTimerGate({
          decide: () => decideInstagramTimerAcrossAccounts({ primary: decideEmpty, ...timerChromeAuthorDeps(chrome, () => decideEmpty) }),
          persist: () => {},
        }),
      publish: async () => {
        published++;
        return "ok";
      },
    });
  } catch (e) {
    error = e;
  }
  return { published, error };
}

describe("#11427: leitura da conta do @vjpixel que falha não é credencial ausente", () => {
  it("resolveChromeAuthorReader: 5xx com credencial presente → readFailed; sem credencial → sem readFailed, sem chamar a Graph", async () => {
    const r = await resolveChromeAuthorReader("diaria", [vjpixel], "v25.0", graphFake([fail5xx]).deps);
    assert.equal(r.reader, null);
    assert.equal(r.readFailed, true);
    assert.match(r.unavailable ?? "", /não foi possível ler a conta do Instagram vinculada à página vjpixel/);

    const g = graphFake([]);
    const s = await resolveChromeAuthorReader("diaria", [semCredencial], "v25.0", g.deps);
    assert.equal(s.reader, null);
    assert.equal(s.readFailed, undefined);
    assert.match(s.unavailable ?? "", /sem credencial/);
    assert.equal(g.calls.length, 0);
  });

  it("falha transitória (5xx) → gate read-failed, não author-unchecked; nada publicado", async () => {
    const { published, error } = await runGate(graphFake([fail5xx]).deps, [vjpixel]);
    assert.equal(published, 0);
    assert.equal((error as { name?: string }).name, "InstagramTimerGateError");
    assert.equal((error as { failure?: string }).failure, "read-failed");
    assert.doesNotMatch((error as Error).message, /forneça a credencial/);
  });

  it("credencial realmente ausente (falha persistente) → continua author-unchecked", async () => {
    const { published, error } = await runGate(graphFake([]).deps, [semCredencial]);
    assert.equal(published, 0);
    assert.equal((error as { failure?: string }).failure, "author-unchecked");
    assert.match((error as Error).message, /forneça a credencial da página vjpixel/);
  });

  it("rodada seguinte com a Graph de volta → lê o perfil e publica", async () => {
    const { published, error } = await runGate(graphFake([linked]).deps, [vjpixel]);
    assert.equal(error, null);
    assert.equal(published, 1);
  });

  it("read-failed no timer: alarme preflight-read-failed, e não suprime o late da edição", () => {
    const out = JSON.stringify({
      dry_run: false,
      items: [],
      results: [{ destination: "instagram", ok: false, cause: "preflight", preflight: "read-failed", error: "a leitura da conta do Instagram falhou" }],
    });
    const r = interpretInstagramTimerOutput(1, out);
    assert.equal(r.kind, "alarm");
    assert.equal((r as { key: string }).key, "preflight-read-failed");
    assert.equal(alarmSuppressed(JSON.stringify({ alarmed: ["preflight-read-failed"] }), "late"), false);
  });

  it("timerChromeAuthorDeps: mesma conta da API → sem chromeAuthor e sem motivo (segue a API)", () => {
    const d = timerChromeAuthorDeps({ reader: null, unavailable: "é a mesma conta da API", sameAccount: true }, () => decideEmpty);
    assert.deepEqual(d, { chromeAuthor: null });
  });
});
