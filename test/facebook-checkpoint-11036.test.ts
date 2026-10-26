import { it } from "node:test";
import assert from "node:assert/strict";
import { facebookCheckpointDiagnostic } from "../scripts/lib/facebook-checkpoint.ts";
import { publishFacebookCarouselByUrl } from "../scripts/publish-facebook.ts";
const body = { error: { message: "x".repeat(300), code: 190, error_data: { checkpoint_url: "https://www.facebook.com/checkpoint/?secret=private" } } };
const action = /checkpoint de segurança.*Ação do editor: entrar em https:\/\/www.facebook.com.*conta pessoal.*seguir as instruções.*reexecutar/;
it("#11036: reconhece checkpoint antes de truncar sem expor URL privada", () => {
  for (const value of [body, JSON.stringify(body)]) {
    const diagnostic = facebookCheckpointDiagnostic(value)!;
    assert.match(diagnostic, action);
    assert.doesNotMatch(diagnostic, /secret|private/);
  }
});
it("#11036: outros erros mantêm diagnóstico original", () => {
  for (const value of [null, "invalid json", { error: { code: 190 } },
    { error: { code: 190, error_data: { checkpoint_url: " " } } },
    { error: { code: 100, error_data: { checkpoint_url: "https://facebook.com" } } }]) {
    assert.equal(facebookCheckpointDiagnostic(value), null);
  }
});
it("#11036: Stage 5 informa ação no upload e no feed, inclusive erro em HTTP 200", async () => {
  const original = globalThis.fetch;
  try {
    for (const endpoint of ["photos", "feed"]) {
      for (const status of [401, 200]) {
        globalThis.fetch = async (url) => String(url).endsWith(`/${endpoint}`)
          ? new Response(JSON.stringify(body), { status })
          : new Response(JSON.stringify({ id: "p1" }));
        await assert.rejects(() => publishFacebookCarouselByUrl("111", "tok", "v25.0", ["https://example.com/a.jpg"], "Legenda", null), action);
      }
    }
  } finally { globalThis.fetch = original; }
});
