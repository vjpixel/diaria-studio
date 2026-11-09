/**
 * #12463 (decisão do editor de 08/11/2026): `#Shorts` vai sempre na
 * descrição, nunca no título. Regressão:
 *   - o título do Short é só o D1 e a descrição leva a tag;
 *   - o Short ANTIGO (`{D1} #Shorts` no título) continua reconhecido no canal,
 *     senão o mesmo Short volta a ser enviado;
 *   - com o mesmo título do horizontal, o Short nunca é lido como o horizontal;
 *   - a detecção de Short (`isShort`, `isShortVideo`) segue valendo pela tag
 *     na descrição.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildYouTubeShortMetadata, buildYouTubeShortTitle } from "../scripts/lib/diaria/short-video.ts";
import { buildYouTubeTitle } from "../scripts/lib/diaria/youtube-video.ts";
import { matchEditionVideo } from "../scripts/lib/diaria/youtube-upload.ts";
import { isShortVideo } from "../scripts/lib/mensal/clarice-video-do-mes.ts";

const D1 = { title: "Você já viu IA mentir. Já viu roubar?", body: "Um modelo da OpenAI gastou o saldo de uma carteira de terceiros. Depois mais." };

describe("#12463 título do Short sem #Shorts", () => {
  it("título = D1 (o mesmo do horizontal); a tag fica na descrição", () => {
    const m = buildYouTubeShortMetadata({ d1: D1 });
    assert.equal(m.title, "Você já viu IA mentir. Já viu roubar?");
    assert.equal(m.title, buildYouTubeTitle(D1.title));
    assert.doesNotMatch(m.title, /#shorts/i);
    assert.match(m.description, /(^|\s)#Shorts(\s|$)/);
  });

  it("o teto de 100 caracteres vale para o título inteiro, sem reservar espaço pra tag", () => {
    const t = buildYouTubeShortTitle("a".repeat(99));
    assert.equal(Array.from(t).length, 99);
    assert.ok(!t.endsWith("…"));
  });
});

describe("#12463 reconhecimento do Short já no canal (antigo e novo)", () => {
  const criteria = { aammdd: "261109", title: buildYouTubeShortTitle(D1.title), kind: "short" as const };

  it("Short antigo, com `{D1} #Shorts` no título, casa pelo título", () => {
    const old = { id: "old", snippet: { title: `${D1.title} #Shorts`, description: "gancho", publishedAt: "2026-11-01T09:30:00Z" }, status: { privacyStatus: "public" } };
    const r = matchEditionVideo([old], criteria);
    assert.equal(r?.videoId, "old");
    assert.equal(r?.matchedBy, "title");
  });

  it("Short novo, sem a tag no título e com ela na descrição, casa pelo título", () => {
    const fresh = { id: "new", snippet: { title: D1.title, description: "gancho\n\n#Shorts #IA", publishedAt: "2026-11-01T09:30:00Z" }, status: { privacyStatus: "private" } };
    const r = matchEditionVideo([fresh], criteria);
    assert.equal(r?.videoId, "new");
    assert.equal(r?.matchedBy, "title");
  });

  it("critério com o título antigo também reconhece o Short novo (comparação sem a tag final)", () => {
    const fresh = { id: "new", snippet: { title: D1.title, description: "#Shorts", publishedAt: "2026-11-01T09:30:00Z" } };
    assert.equal(matchEditionVideo([fresh], { ...criteria, title: `${D1.title} #Shorts` })?.videoId, "new");
  });

  it("corte avulso (titleOnly) também aceita as duas formas", () => {
    const old = { id: "c-old", snippet: { title: "Tratar IA como humano #Shorts", description: "" } };
    const fresh = { id: "c-new", snippet: { title: "Tratar IA como humano", description: "x\n\n#Shorts" } };
    const c = { aammdd: "261102", title: "Tratar IA como humano", kind: "short" as const, titleOnly: true };
    assert.equal(matchEditionVideo([old], c)?.videoId, "c-old");
    assert.equal(matchEditionVideo([fresh], c)?.videoId, "c-new");
  });

  it("o horizontal (sem a tag) nunca é tomado pelo Short", () => {
    const longVideo = { id: "long", snippet: { title: D1.title, description: "descrição do horizontal", publishedAt: "2026-11-09T09:00:00Z" } };
    assert.equal(matchEditionVideo([longVideo], criteria), null);
  });
});

describe("#12463 horizontal × Short com o mesmo título", () => {
  it("na busca do horizontal, o Short com o título do D1 não casa por título", () => {
    const short = { id: "short", snippet: { title: D1.title, description: "gancho\n\n#Shorts #IA", publishedAt: "2026-11-01T09:30:00Z" } };
    assert.equal(matchEditionVideo([short], { aammdd: "261109", title: buildYouTubeTitle(D1.title), kind: "long" }), null);
  });

  it("com os dois no canal, a busca do horizontal devolve o horizontal", () => {
    const short = { id: "short", snippet: { title: D1.title, description: "#Shorts", publishedAt: "2026-11-01T09:30:00Z" } };
    const longVideo = { id: "long", snippet: { title: D1.title, description: "descrição", publishedAt: "2026-11-01T09:00:00Z" } };
    assert.equal(matchEditionVideo([short, longVideo], { aammdd: "261109", title: D1.title, kind: "long" })?.videoId, "long");
  });
});

describe("#12463 detecção de Short pela descrição", () => {
  it("isShortVideo (vídeo do mês da Clarice) reconhece o Short pela tag só na descrição", () => {
    assert.equal(
      isShortVideo({ snippet: { title: D1.title, description: "gancho\n\n#Shorts #IA" }, contentDetails: { duration: "PT10M" } } as Parameters<typeof isShortVideo>[0]),
      true,
    );
  });
});
