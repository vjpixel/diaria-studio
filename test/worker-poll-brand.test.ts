/**
 * test/worker-poll-brand.test.ts (#1905)
 *
 * Leaderboard separado por marca (brand): `diaria` (diário/Beehiiv) vs
 * `clarice` (digest mensal/Brevo). Cobre:
 *   - helpers puros: parseBrandParam, brandKvPrefix, leaderboardHref
 *   - brandedNamespace: prefixa toda chave KV; list injeta o prefixo na query
 *     e o stripa dos names retornados
 *   - isolamento e2e via o router: um voto brand=clarice e um voto diária
 *     (default) NÃO se cruzam — escrevem em namespaces de KV distintos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseBrandParam,
  brandKvPrefix,
  leaderboardHref,
  BRAND_INFO,
} from "../workers/poll/src/lib.ts";
import { brandedNamespace, votePageHtml, type Env } from "../workers/poll/src/index.ts";
import worker from "../workers/poll/src/index.ts";

// ── Mock KV backed por Map ───────────────────────────────────────────
function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  const kv = {
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
    async list({ prefix = "", cursor }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...m.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    _map: m,
  };
  return kv;
}

describe("brand helpers (#1905)", () => {
  it("parseBrandParam: só 'clarice' é não-default; resto → diaria", () => {
    assert.equal(parseBrandParam("clarice"), "clarice");
    assert.equal(parseBrandParam("diaria"), "diaria");
    assert.equal(parseBrandParam(null), "diaria");
    assert.equal(parseBrandParam("xyz"), "diaria");
    assert.equal(parseBrandParam(""), "diaria");
  });

  it("brandKvPrefix: diaria → '' (legado), clarice → 'clarice:'", () => {
    assert.equal(brandKvPrefix("diaria"), "");
    assert.equal(brandKvPrefix("clarice"), "clarice:");
  });

  it("leaderboardHref: brand no query só p/ não-default; slug opcional", () => {
    assert.equal(leaderboardHref("diaria"), "/leaderboard");
    assert.equal(leaderboardHref("clarice"), "/leaderboard?brand=clarice");
    assert.equal(leaderboardHref("diaria", "2026-05"), "/leaderboard/2026-05");
    assert.equal(leaderboardHref("clarice", "2026-05"), "/leaderboard/2026-05?brand=clarice");
  });

  it("BRAND_INFO tem nome + site das duas marcas", () => {
    assert.equal(BRAND_INFO.diaria.name, "Diar.ia");
    assert.equal(BRAND_INFO.clarice.name, "Clarice News");
    assert.ok(BRAND_INFO.clarice.siteUrl.startsWith("https://"));
  });
});

describe("brandedNamespace (#1905)", () => {
  it("prefixo vazio retorna o MESMO kv (diaria = sem overhead)", () => {
    const base = makeMapKV();
    assert.strictEqual(brandedNamespace(base as never, ""), base as never);
  });

  it("prefixa get/put/delete; namespaces não se enxergam", async () => {
    const base = makeMapKV();
    const clarice = brandedNamespace(base as never, "clarice:");
    await clarice.put("score:a@x.com", "1");
    // chave física no KV vem prefixada
    assert.equal(base._map.get("clarice:score:a@x.com"), "1");
    // leitura pela clarice resolve; pela diária (kv cru) não
    assert.equal(await clarice.get("score:a@x.com"), "1");
    assert.equal(await base.get("score:a@x.com"), null);
    await clarice.delete("score:a@x.com");
    assert.equal(base._map.has("clarice:score:a@x.com"), false);
  });

  it("list injeta o prefixo e STRIPA dos names retornados", async () => {
    const base = makeMapKV({
      "score:a@x.com": "1",
      "clarice:score:b@x.com": "2",
      "clarice:score:c@x.com": "3",
      "clarice:vote:260531:b@x.com": "v",
    });
    const clarice = brandedNamespace(base as never, "clarice:");
    const res = await clarice.list({ prefix: "score:" });
    // só as keys da clarice, com os names já sem o prefixo de brand
    assert.deepEqual(
      res.keys.map((k: { name: string }) => k.name).sort(),
      ["score:b@x.com", "score:c@x.com"],
    );
  });
});

describe("isolamento e2e via router (#1905)", () => {
  const makeEnv = (): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
    POLL: makeMapKV(),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  });

  // sig ausente = merge-tag mode (aceito sem HMAC); valid_editions ausente = fail-open.
  const voteReq = (brand: string | null, choice: string) => {
    const b = brand ? `&brand=${brand}` : "";
    return new Request(
      `https://poll.test/vote?email=a@x.com&edition=260531&choice=${choice}${b}`,
    );
  };

  it("voto clarice e voto diária escrevem em namespaces distintos", async () => {
    const env = makeEnv();
    const rC = await worker.fetch(voteReq("clarice", "A"), env);
    const rD = await worker.fetch(voteReq(null, "B"), env);
    assert.equal(rC.status, 200);
    assert.equal(rD.status, 200);

    const m = env.POLL._map;
    // votos isolados por brand
    assert.ok(m.has("clarice:vote:260531:a@x.com"), "voto clarice prefixado");
    assert.ok(m.has("vote:260531:a@x.com"), "voto diária legado");
    assert.equal(JSON.parse(m.get("clarice:vote:260531:a@x.com")!).choice, "A");
    assert.equal(JSON.parse(m.get("vote:260531:a@x.com")!).choice, "B");

    // scores isolados
    assert.ok(m.has("clarice:score:a@x.com"));
    assert.ok(m.has("score:a@x.com"));
    // score-by-month isolados
    assert.ok(m.has("clarice:score-by-month:2026-05:a@x.com"));
    assert.ok(m.has("score-by-month:2026-05:a@x.com"));
  });

  it("re-voto na MESMA marca é dedup; na outra marca é voto novo", async () => {
    const env = makeEnv();
    await worker.fetch(voteReq("clarice", "A"), env);
    const dup = await worker.fetch(voteReq("clarice", "A"), env);
    const txt = await dup.text();
    assert.match(txt, /já votou/i, "2º voto clarice = dedup");

    // mas a diária (outra marca) aceita o voto desse mesmo email normalmente
    const other = await worker.fetch(voteReq(null, "A"), env);
    assert.equal(other.status, 200);
    assert.ok(env.POLL._map.has("vote:260531:a@x.com"));
  });

  it("brand desconhecido cai em diária (back-compat)", async () => {
    const env = makeEnv();
    await worker.fetch(voteReq("xyz", "A"), env);
    // chave legada (sem prefixo), não 'xyz:'
    assert.ok(env.POLL._map.has("vote:260531:a@x.com"));
    assert.equal([...env.POLL._map.keys()].some((k) => k.startsWith("xyz:")), false);
  });
});

describe("votePageHtml propaga brand no form de set-name (code-review #1907)", () => {
  const form = { email: "a@x.com", sig: "deadbeef" };

  it("brand=clarice: form tem input hidden brand + título da marca", () => {
    const html = votePageHtml("ok", true, form, null, "2026-05", "clarice");
    assert.match(html, /name="brand"\s+value="clarice"/);
    assert.match(html, /<title>É IA\? \| Clarice News<\/title>/);
    // o link do leaderboard também carrega o brand
    assert.match(html, /\/leaderboard\/2026-05\?brand=clarice/);
  });

  it("brand=diaria: SEM input hidden brand (back-compat) + título Diar.ia", () => {
    const html = votePageHtml("ok", true, form, null, "2026-05", "diaria");
    assert.equal(/name="brand"/.test(html), false);
    assert.match(html, /<title>É IA\? \| Diar\.ia<\/title>/);
  });
});
