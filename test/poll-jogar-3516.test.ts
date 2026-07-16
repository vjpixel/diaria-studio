/**
 * test/poll-jogar-3516.test.ts (#3516)
 *
 * Fundação do "É IA?" standalone (EPIC #3514): brand `web` isolado, página
 * jogável `/jogar`, identidade anônima por token (pseudo-email sintético).
 * Cobre:
 *   - `resolveJogarEdition` (default "hoje" BRT vs `?edition=` explícito)
 *   - `anonEmailForToken` satisfaz `isValidVoteEmailFormat` (reusa a mesma
 *     validação de `/vote`, sem exigir NENHUMA mudança lá)
 *   - `BRAND_INFO.web` + isolamento e2e: voto brand=web NÃO aparece nos
 *     namespaces `diaria`/`clarice` e vice-versa (mesmo padrão de
 *     test/worker-poll-brand.test.ts #1905)
 *   - `GET /jogar`: renderiza par de imagens da edição resolvida, tokens do
 *     DS, links pro `/vote`/`/leaderboard` já carregando `brand=web`
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BRAND_INFO,
  brandKvPrefix,
  isValidVoteEmailFormat,
  parseBrandParam,
} from "../workers/poll/src/lib.ts";
import {
  anonEmailForToken,
  renderJogarPageHtml,
  resolveJogarEdition,
} from "../workers/poll/src/jogar.ts";
import worker, { brandedNamespace, type Env } from "../workers/poll/src/index.ts";

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

describe("resolveJogarEdition (#3516)", () => {
  it("sem ?edition= → hoje em BRT", () => {
    // 2026-07-16T02:00:00Z ainda é 15/07 em BRT (UTC-3)
    const now = new Date("2026-07-16T02:00:00Z");
    assert.equal(resolveJogarEdition(null, now), "260715");
  });

  it("?edition= válido (AAMMDD) sobrepõe o default — hook de extensão pro arquivo (#3519)", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    assert.equal(resolveJogarEdition("260101", now), "260101");
  });

  it("?edition= malformado é ignorado silenciosamente — cai no default (nunca 500/400 numa página pública)", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    assert.equal(resolveJogarEdition("not-a-date", now), resolveJogarEdition(null, now));
    assert.equal(resolveJogarEdition("2026-07-16", now), resolveJogarEdition(null, now));
    assert.equal(resolveJogarEdition("", now), resolveJogarEdition(null, now));
  });
});

describe("anonEmailForToken (#3516) — pseudo-email da identidade anônima", () => {
  it("monta local@dominio.tld a partir de um token UUID", () => {
    const email = anonEmailForToken("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    assert.equal(email, "3fa85f64-5717-4562-b3fc-2c963f66afa6@web.eia.diaria.local");
  });

  it("passa isValidVoteEmailFormat (lib.ts) — reusa a MESMA validação de /vote sem mudança lá", () => {
    const email = anonEmailForToken("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    assert.equal(isValidVoteEmailFormat(email), true);
  });

  it("token com formato UUID v4 típico sempre produz email válido", () => {
    for (let i = 0; i < 5; i++) {
      const token = crypto.randomUUID();
      assert.equal(isValidVoteEmailFormat(anonEmailForToken(token)), true, `token ${token} deveria produzir email válido`);
    }
  });
});

describe("BRAND_INFO.web (#3516)", () => {
  it("brand 'web' registrado com leaderboard mensal (mesma cadência da diária, sugestão #2 do EPIC)", () => {
    assert.ok(BRAND_INFO.web, "BRAND_INFO deve ter entry 'web'");
    assert.equal(BRAND_INFO.web.leaderboardPeriod, "month");
    assert.equal(BRAND_INFO.web.siteUrl, "https://diar.ia.br");
  });

  it("parseBrandParam reconhece 'web' explicitamente (derivado de Object.keys(BRAND_INFO), #3118 item 12)", () => {
    assert.equal(parseBrandParam("web"), "web");
  });

  it("brandKvPrefix('web') → 'web:' — isolamento automático via mecânica #1905", () => {
    assert.equal(brandKvPrefix("web"), "web:");
  });
});

describe("isolamento e2e do brand web via router (#3516, mesmo padrão de #1905)", () => {
  const makeEnv = (): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
    POLL: makeMapKV(),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  });

  const voteReq = (brand: string | null, email: string, choice: string) => {
    const b = brand ? `&brand=${brand}` : "";
    return new Request(
      `https://poll.test/vote?email=${encodeURIComponent(email)}&edition=260531&choice=${choice}${b}`,
    );
  };

  it("voto web e voto diária escrevem em namespaces KV distintos", async () => {
    const env = makeEnv();
    const anonEmail = anonEmailForToken("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    const rWeb = await worker.fetch(voteReq("web", anonEmail, "A"), env);
    const rDiaria = await worker.fetch(voteReq(null, "leitor@example.com", "B"), env);
    assert.equal(rWeb.status, 200);
    assert.equal(rDiaria.status, 200);

    const m = env.POLL._map;
    assert.ok(m.has(`web:vote:260531:${anonEmail}`), "voto web prefixado");
    assert.ok(m.has("vote:260531:leitor@example.com"), "voto diária legado sem prefixo");
    assert.ok(m.has(`web:score:${anonEmail}`));
    assert.ok(m.has(`web:score-by-month:2026-05:${anonEmail}`));
    // Nada do brand web vaza pro namespace legado da diária.
    assert.equal(m.has(`score:${anonEmail}`), false);
  });

  it("re-voto do MESMO token na MESMA edição é dedup (mesma anti-fraude/dedup do resto do produto)", async () => {
    const env = makeEnv();
    const anonEmail = anonEmailForToken("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    await worker.fetch(voteReq("web", anonEmail, "A"), env);
    const dup = await worker.fetch(voteReq("web", anonEmail, "A"), env);
    const txt = await dup.text();
    assert.match(txt, /já votou/i);
  });

  it("brand=web isolado de brand=clarice também (3 marcas, sem cruzamento par-a-par)", async () => {
    const env = makeEnv();
    const anonEmail = anonEmailForToken("11111111-1111-4111-8111-111111111111");
    await worker.fetch(voteReq("web", anonEmail, "A"), env);
    await worker.fetch(voteReq("clarice", anonEmail, "B"), env);
    const m = env.POLL._map;
    assert.ok(m.has(`web:vote:260531:${anonEmail}`));
    assert.ok(m.has(`clarice:vote:260531:${anonEmail}`));
    assert.equal(JSON.parse(m.get(`web:vote:260531:${anonEmail}`)!).choice, "A");
    assert.equal(JSON.parse(m.get(`clarice:vote:260531:${anonEmail}`)!).choice, "B");
  });
});

describe("GET /jogar (#3516)", () => {
  const makeEnv = (seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
    POLL: makeMapKV(seed),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  });

  it("200 HTML com o par de imagens da edição resolvida (?edition= explícito)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /\/img\/img-260101-01-eia-A\.jpg/);
    assert.match(html, /\/img\/img-260101-01-eia-B\.jpg/);
  });

  it("form de voto aponta pro /vote existente com brand=web (reusa handleVote sem mudança)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), env);
    const html = await res.text();
    assert.match(html, /action="\/vote"/);
    assert.match(html, /name="brand"\s+value="web"/);
    assert.match(html, /name="edition"\s+value="260101"/);
    // email é hidden, preenchido via JS client-side (token anônimo) — não
    // exposto como input digitável (diferente do form do arquivo).
    assert.match(html, /id="jogar-email"/);
  });

  it("copy de apoio muda conforme o gabarito compartilhado (correct:{edition}) já existe ou não", async () => {
    const envOpen = makeEnv();
    const htmlOpen = await (await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), envOpen)).text();
    assert.match(htmlOpen, /resultado sai assim que o poll de hoje fechar/i);

    const envClosed = makeEnv({ "correct:260101": "A" });
    const htmlClosed = await (await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), envClosed)).text();
    assert.match(htmlClosed, /vote e veja na hora se acertou/i);
  });

  it("lê correct:{edition} DIRETO do KV cru (sem prefixo de brand) — fato compartilhado, não dado do brand web", async () => {
    // Mesmo que o KV branded 'web:correct:260101' não exista, a cópia
    // legada compartilhada (sem prefixo) já basta pra copy de apoio mudar.
    const env = makeEnv({ "correct:260101": "B" });
    assert.equal(env.POLL._map.has("web:correct:260101"), false);
    const html = await (await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), env)).text();
    assert.match(html, /vote e veja na hora se acertou/i);
  });

  it("link do leaderboard já carrega ?brand=web", async () => {
    const env = makeEnv();
    const html = await (await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), env)).text();
    assert.match(html, /\/leaderboard\?brand=web/);
  });

  it("identidade anônima: script inline gera/persiste token via localStorage+cookie, nunca no servidor", async () => {
    const env = makeEnv();
    const html = await (await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), env)).text();
    assert.match(html, /localStorage/);
    assert.match(html, /document\.cookie/);
    assert.match(html, /crypto\.randomUUID/);
    // O servidor nunca embute um token/email real no HTML — só o placeholder
    // vazio que o JS preenche.
    assert.match(html, /id="jogar-email"\s+value=""/);
  });

  it("fallback de par indisponível é simétrico — ambas as imagens (A e B) têm listener de erro", async () => {
    const env = makeEnv();
    const html = await (await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), env)).text();
    assert.match(html, /getElementById\("jogar-img-a"\)/);
    assert.match(html, /getElementById\("jogar-img-b"\)/);
    assert.match(html, /addEventListener\("error", onImgError\)/g);
    // ambas chamam o MESMO handler (não duas cópias divergentes)
    const occurrences = html.match(/addEventListener\("error", onImgError\)/g) ?? [];
    assert.equal(occurrences.length, 2, "as duas imagens devem usar o mesmo handler onImgError");
  });

  it("endpoints 404 listam /jogar", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/rota-inexistente"), env);
    const body = await res.json() as { endpoints: string[] };
    assert.ok(body.endpoints.includes("/jogar"));
  });
});

describe("renderJogarPageHtml pure render (#3516)", () => {
  it("anti-gaming: alt genérico ('Imagem A'/'Imagem B') pré-voto — não revela a resposta antes do clique, mesmo se já fechado", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: true });
    assert.match(html, /alt="Imagem A"/);
    assert.match(html, /alt="Imagem B"/);
    // não deve conter nenhum rótulo de IA/real antes do voto
    assert.doesNotMatch(html, /Gerada por IA/);
  });
});
