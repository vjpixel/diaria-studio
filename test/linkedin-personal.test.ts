/**
 * #9568 — LinkedIn PESSOAL automatizado: OAuth, post, arme no Stage 6,
 * disparo no slot e alarme de expiração. HTTP sempre injetado (nunca a
 * LinkedIn de verdade); edições em diretório temporário (nunca `data/`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  LINKEDIN_PERSONAL_ENV,
  LINKEDIN_PERSONAL_REDIRECT_URI,
  TOKEN_ALARM_FINGERPRINT,
  aammddBrt,
  buildAuthorizeUrl,
  decideFire,
  defaultLinkedInApiVersion,
  evaluateTokenExpiry,
  exchangeCodeForToken,
  fetchPersonUrn,
  postToPersonalProfile,
  readPersonalCreds,
  toLittleText,
  type FetchFn,
  type PersonalPostIntent,
} from "../scripts/lib/linkedin-personal.ts";
import { armPersonalPost, candidateEditions, fireDuePersonalPosts, intentPath, readIntent } from "../scripts/publish-linkedin-personal.ts";
import { persistSecrets } from "../scripts/linkedin-personal-oauth.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";
import { writeUseMelhorPostState } from "../scripts/lib/use-melhor-post.ts";
import { buildUseMelhorSlides, hashUseMelhorSlides } from "../scripts/lib/use-melhor-carousel.ts";
import { useMelhorCarouselHashPath } from "../scripts/lib/use-melhor-slide-files.ts";
import { USE_MELHOR_COVER_FILE } from "../scripts/lib/use-melhor-dispatch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const URN = "urn:li:person:AbC123_x";
const FUTURE = "2099-01-01T00:00:00.000Z";
const ENV_OK = {
  [LINKEDIN_PERSONAL_ENV.accessToken]: "tok-secreto",
  [LINKEDIN_PERSONAL_ENV.personUrn]: URN,
  [LINKEDIN_PERSONAL_ENV.expiresAt]: FUTURE,
};

type Call = { url: string; init?: RequestInit };
function fakeFetch(responses: Array<(c: Call) => Response>): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (url, init) => {
    const c = { url: String(url), init };
    calls.push(c);
    const r = responses[i++];
    if (!r) throw new Error(`chamada inesperada: ${url}`);
    return r(c);
  };
  return { fetchFn, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("credenciais (#9568)", () => {
  it("sem token = não configurado (modo manual legítimo)", () => {
    const r = readPersonalCreds({}, new Date());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.configured, false);
  });
  it("URN malformada ou token expirado antes do horário do post = indisponível", () => {
    const bad = readPersonalCreds({ ...ENV_OK, [LINKEDIN_PERSONAL_ENV.personUrn]: "123" }, new Date());
    assert.equal(bad.ok, false);
    const at = new Date("2030-10-15T10:45:00Z");
    const exp = readPersonalCreds({ ...ENV_OK, [LINKEDIN_PERSONAL_ENV.expiresAt]: "2030-10-15T10:00:00Z" }, at);
    assert.equal(exp.ok, false);
    if (!exp.ok) assert.equal(exp.configured, true);
    assert.equal(readPersonalCreds(ENV_OK, at).ok, true);
  });
  it("LinkedIn-Version = 2 meses atrás, inclusive na virada de ano", () => {
    assert.equal(defaultLinkedInApiVersion(new Date("2026-10-07T12:00:00Z")), "202608");
    assert.equal(defaultLinkedInApiVersion(new Date("2027-01-15T12:00:00Z")), "202611");
  });
});

describe("OAuth (#9568)", () => {
  it("authorize URL: redirect local exato + escopos openid profile w_member_social", () => {
    const u = new URL(buildAuthorizeUrl("cid", "st"));
    assert.equal(LINKEDIN_PERSONAL_REDIRECT_URI, "http://localhost:8766/linkedin/callback");
    assert.equal(u.searchParams.get("redirect_uri"), LINKEDIN_PERSONAL_REDIRECT_URI);
    assert.equal(u.searchParams.get("scope"), "openid profile w_member_social");
    assert.equal(u.searchParams.get("state"), "st");
  });
  it("troca de código: devolve token; recusa token sem w_member_social; erro não ecoa o corpo", async () => {
    const ok = fakeFetch([() => json({ access_token: "T", expires_in: 5184000, scope: "openid,profile,w_member_social" })]);
    const t = await exchangeCodeForToken(ok.fetchFn, { code: "c", clientId: "i", clientSecret: "s" });
    assert.equal(t.accessToken, "T");
    assert.equal(t.expiresInSec, 5184000);
    assert.match(String(ok.calls[0].init?.body), /redirect_uri=http%3A%2F%2Flocalhost%3A8766%2Flinkedin%2Fcallback/);
    const semEscopo = fakeFetch([() => json({ access_token: "T", expires_in: 1, scope: "openid profile" })]);
    await assert.rejects(exchangeCodeForToken(semEscopo.fetchFn, { code: "c", clientId: "i", clientSecret: "s" }), /w_member_social/);
    const falha = fakeFetch([() => json({ error_description: "bad code" }, 400)]);
    await assert.rejects(exchangeCodeForToken(falha.fetchFn, { code: "c", clientId: "i", clientSecret: "s" }), /bad code/);
  });
  it("URN da pessoa vem do sub do /v2/userinfo", async () => {
    const f = fakeFetch([() => json({ sub: "AbC123_x" })]);
    assert.equal(await fetchPersonUrn(f.fetchFn, "T"), URN);
    assert.equal((f.calls[0].init?.headers as Record<string, string>).Authorization, "Bearer T");
  });
  it("persistSecrets: Doppler + .env, falha do Doppler reportada, .env escrito mesmo assim", () => {
    let written = "";
    const r = persistSecrets({
      secrets: { A: "1", B: "2" },
      dopplerSet: (name) => (name === "B" ? { ok: false, error: "x" } : { ok: true }),
      envPath: "/x/.env",
      readEnv: () => "A=velho\nOUTRA=y",
      writeEnv: (_p, c) => {
        written = c;
      },
    });
    assert.deepEqual(r.doppler, ["A"]);
    assert.deepEqual(r.dopplerFailed, ["B"]);
    assert.equal(written, "A=1\nOUTRA=y\n\nB=2\n");
  });
});

describe("texto little-text (#9568)", () => {
  it("escapa reservados (o '1)' cortaria o post) e transforma hashtag em template", () => {
    assert.equal(toLittleText("1) Faça (isto) #Planilhas"), "1\\) Faça \\(isto\\) {hashtag|\\#|Planilhas}");
    assert.equal(toLittleText("utm_source=linkedin"), "utm\\_source=linkedin");
    assert.equal(toLittleText("#IA no início"), "{hashtag|\\#|IA} no início");
    assert.equal(toLittleText("nota#1"), "nota\\#1");
  });
});

describe("postToPersonalProfile (#9568)", () => {
  const creds = { accessToken: "T", personUrn: URN, expiresAt: null };
  it("só texto: POST /rest/posts com author = pessoa, versão no header, URN do post do x-restli-id", async () => {
    const f = fakeFetch([() => new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:9" } })]);
    const r = await postToPersonalProfile({ fetchFn: f.fetchFn, creds, apiVersion: "202608", text: "Oi (teste)" });
    assert.deepEqual(r, { ok: true, postUrn: "urn:li:share:9", imageUsed: false });
    const body = JSON.parse(String(f.calls[0].init?.body));
    assert.equal(body.author, URN);
    assert.equal(body.commentary, "Oi \\(teste\\)");
    assert.equal(body.lifecycleState, "PUBLISHED");
    assert.equal(body.content, undefined);
    assert.equal((f.calls[0].init?.headers as Record<string, string>)["LinkedIn-Version"], "202608");
  });
  it("com imagem: initializeUpload(owner=pessoa) → PUT → post com content.media", async () => {
    const f = fakeFetch([
      () => json({ value: { uploadUrl: "https://up/x", image: "urn:li:image:1" } }),
      () => new Response("", { status: 201 }),
      () => new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:2" } }),
    ]);
    const r = await postToPersonalProfile({ fetchFn: f.fetchFn, creds, apiVersion: "202608", text: "t", imageBytes: new Uint8Array([1, 2]) });
    assert.equal(r.ok, true);
    assert.equal(JSON.parse(String(f.calls[0].init?.body)).initializeUploadRequest.owner, URN);
    assert.equal(f.calls[1].url, "https://up/x");
    assert.deepEqual(JSON.parse(String(f.calls[2].init?.body)).content, { media: { id: "urn:li:image:1" } });
  });
  it("upload falhou → post NÃO sai; erro de rede vira ok:false, nunca exceção", async () => {
    const f = fakeFetch([() => json({ message: "no" }, 403)]);
    const r = await postToPersonalProfile({ fetchFn: f.fetchFn, creds, apiVersion: "v", text: "t", imageBytes: new Uint8Array([1]) });
    assert.equal(r.ok, false);
    assert.equal(f.calls.length, 1);
    const boom: FetchFn = async () => {
      throw new Error("ECONNRESET");
    };
    const r2 = await postToPersonalProfile({ fetchFn: boom, creds, apiVersion: "v", text: "t" });
    assert.equal(r2.ok, false);
  });
});

describe("decideFire (#9568)", () => {
  const base: PersonalPostIntent = {
    edition: "301015",
    status: "armed",
    text: "t",
    image: null,
    scheduled_at: "2030-10-15T07:45:00-03:00",
    armed_at: "x",
  };
  it("antes do slot = not_due; no slot = fire; > 3h de atraso = expired; posting/published = done", () => {
    assert.equal(decideFire(base, new Date("2030-10-15T07:44:00-03:00")), "not_due");
    assert.equal(decideFire(base, new Date("2030-10-15T07:46:00-03:00")), "fire");
    assert.equal(decideFire(base, new Date("2030-10-15T11:00:00-03:00")), "expired");
    assert.equal(decideFire({ ...base, status: "posting" }, new Date("2030-10-15T07:46:00-03:00")), "done");
    assert.equal(decideFire({ ...base, status: "published" }, new Date("2030-10-15T07:46:00-03:00")), "done");
  });
  it("edições candidatas = hoje e ontem em BRT (meia-noite UTC ainda é o dia anterior)", () => {
    assert.equal(aammddBrt(new Date("2030-10-15T02:00:00Z")), "301014");
    assert.deepEqual(candidateEditions(new Date("2030-10-15T10:46:00Z")), ["301015", "301014"]);
  });
});

// ── fixture de edição (mesmo molde de test/use-melhor-dispatch-9568.test.ts) ──
const ITEM = { url: "https://exame.com/guia-planilhas", title: "Guia de planilhas com IA", summary: "Resumo.", score: 88 };
const P = (s: string) => `${s} **Trecho em negrito.** Fim do parágrafo com algum detalhe a mais.`;
const UM_SOCIAL = [P("Um guia prático para planilhas."), P("Como pedir fórmulas."), P("Como revisar."), P("Quando não confiar."), "#Planilhas"].join("\n\n");
const CONFIG_ON = { publishing: { social: { use_melhor_time: "07:45", fallback_schedule: { d1_time: "10:00" } } } };
const SCHEDULED = "2030-10-15T07:45:00-03:00";

function makeEdition(opts: { pageEntry?: boolean; postPixelOnly?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "li-personal-"));
  const ed = join(dir, "301015");
  mkdirSync(join(ed, "_internal"), { recursive: true });
  const social = opts.postPixelOnly
    ? "# Social\n\n## d1\n\nTexto.\n\n## post_pixel\n\nPost antigo.\n"
    : `# Social\n\n## d1\n\nTexto.\n\n## um\n\n${UM_SOCIAL}\n`;
  writeFileSync(join(ed, "03-social.md"), social, "utf8");
  writeFileSync(join(ed, "02-reviewed.md"), `**USE MELHOR**\n\n[${ITEM.title}](${ITEM.url})\nResumo.\n`, "utf8");
  writeFileSync(join(ed, "_internal", "01-approved-capped.json"), JSON.stringify({ use_melhor: [ITEM] }), "utf8");
  writeFileSync(join(ed, USE_MELHOR_COVER_FILE), "jpg", "utf8");
  const slides = buildUseMelhorSlides(UM_SOCIAL, ITEM.title);
  writeFileSync(useMelhorCarouselHashPath(ed), JSON.stringify({ hash: hashUseMelhorSlides(slides), slots: slides.map((s) => s.slot) }), "utf8");
  writeUseMelhorPostState(ed, { enabled: true, time: "07:45", item: ITEM, generated_at: "x" });
  if (opts.pageEntry !== false) {
    writeFileSync(
      join(ed, "_internal", "06-social-published.json"),
      JSON.stringify({ posts: [{ platform: "linkedin", destaque: "um", url: null, status: "scheduled", scheduled_at: SCHEDULED }] }),
      "utf8",
    );
  }
  return ed;
}

describe("--arm no Stage 6 (#9568)", () => {
  const now = new Date("2030-10-14T22:00:00-03:00");
  it("com token: grava intenção armed com o texto do ## um (sem markdown, com UTM), capa e horário da página", () => {
    const ed = makeEdition();
    try {
      const r = armPersonalPost({ editionDir: ed, config: CONFIG_ON, env: ENV_OK, now });
      assert.equal(r.kind, "armed", JSON.stringify(r));
      const intent = readIntent(ed)!;
      assert.equal(intent.status, "armed");
      assert.equal(intent.scheduled_at, SCHEDULED);
      assert.equal(intent.image, USE_MELHOR_COVER_FILE);
      assert.match(intent.text, /Um guia prático para planilhas/);
      assert.doesNotMatch(intent.text, /\*\*/);
      assert.ok(!JSON.stringify(intent).includes("tok-secreto"), "token nunca vai pro arquivo da edição");
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });
  it("sem token: unavailable e NENHUM arquivo (o Stage 6 mantém o lembrete manual)", () => {
    const ed = makeEdition();
    try {
      const r = armPersonalPost({ editionDir: ed, config: CONFIG_ON, env: {}, now });
      assert.equal(r.kind, "unavailable");
      assert.equal(existsSync(intentPath(ed)), false);
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });
  it("página sem entry linkedin/um, ou edição legada com ## post_pixel: nothing", () => {
    for (const opts of [{ pageEntry: false }, { postPixelOnly: true }]) {
      const ed = makeEdition(opts);
      try {
        assert.equal(armPersonalPost({ editionDir: ed, config: CONFIG_ON, env: ENV_OK, now }).kind, "nothing", JSON.stringify(opts));
        assert.equal(existsSync(intentPath(ed)), false);
      } finally {
        rmSync(dirname(ed), { recursive: true, force: true });
      }
    }
  });
  it("re-arme de edição já publicada não sobrescreve o resultado", () => {
    const ed = makeEdition();
    try {
      writeFileSync(intentPath(ed), JSON.stringify({ edition: "301015", status: "published", text: "t", image: null, scheduled_at: SCHEDULED, armed_at: "x" }));
      assert.equal(armPersonalPost({ editionDir: ed, config: CONFIG_ON, env: ENV_OK, now }).kind, "already_published");
      assert.equal(readIntent(ed)!.status, "published");
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });
});

describe("--fire-due (#9568)", () => {
  function armed(ed: string): void {
    const r = armPersonalPost({ editionDir: ed, config: CONFIG_ON, env: ENV_OK, now: new Date("2030-10-14T22:00:00-03:00") });
    assert.equal(r.kind, "armed");
  }
  const slotNow = new Date("2030-10-15T07:46:00-03:00");

  it("no slot: publica UMA vez (2ª execução não repete) e grava published + post_url", async () => {
    const ed = makeEdition();
    try {
      armed(ed);
      const f = fakeFetch([
        () => json({ value: { uploadUrl: "https://up/x", image: "urn:li:image:1" } }),
        () => new Response("", { status: 201 }),
        () => new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:7" } }),
      ]);
      const out = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: slotNow, fetchFn: f.fetchFn });
      assert.deepEqual(out, [{ edition: "301015", action: "published", post_url: "https://www.linkedin.com/feed/update/urn:li:share:7/" }]);
      assert.equal(readIntent(ed)!.status, "published");
      const again = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: slotNow, fetchFn: fakeFetch([]).fetchFn });
      assert.deepEqual(again, []);
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });
  it("antes do slot e --dry-run não chamam a rede nem mudam o arquivo", async () => {
    const ed = makeEdition();
    try {
      armed(ed);
      const none = fakeFetch([]);
      assert.deepEqual(await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: new Date("2030-10-15T07:40:00-03:00"), fetchFn: none.fetchFn }), []);
      const dry = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: slotNow, fetchFn: none.fetchFn, dryRun: true });
      assert.deepEqual(dry, [{ edition: "301015", action: "would_publish" }]);
      assert.equal(none.calls.length, 0);
      assert.equal(readIntent(ed)!.status, "armed");
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });
  it("falha da API grava failed com motivo; token que venceu entre o arme e o slot = failed sem chamar a rede", async () => {
    const ed = makeEdition();
    try {
      armed(ed);
      const f = fakeFetch([() => json({ value: { uploadUrl: "u", image: "i" } }), () => new Response("x", { status: 500 })]);
      const out = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: slotNow, fetchFn: f.fetchFn });
      assert.equal(out[0].action, "failed");
      assert.equal(readIntent(ed)!.status, "failed");
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
    const ed2 = makeEdition();
    try {
      armed(ed2);
      const none = fakeFetch([]);
      const env = { ...ENV_OK, [LINKEDIN_PERSONAL_ENV.expiresAt]: "2030-10-15T07:00:00-03:00" };
      const out = await fireDuePersonalPosts({ editionDirs: [ed2], env, now: slotNow, fetchFn: none.fetchFn });
      assert.equal(out[0].action, "failed");
      assert.equal(none.calls.length, 0);
    } finally {
      rmSync(dirname(ed2), { recursive: true, force: true });
    }
  });
  it("imagem ilegível no disparo: post sai só com texto e o motivo fica registrado", async () => {
    const ed = makeEdition();
    try {
      armed(ed);
      const f = fakeFetch([() => new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:3" } })]);
      const out = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: slotNow, fetchFn: f.fetchFn, readImage: () => null });
      assert.equal(out[0].action, "published");
      assert.match(readIntent(ed)!.reason ?? "", /só com texto/);
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });
  it("atraso > 3h vira expired sem postar", async () => {
    const ed = makeEdition();
    try {
      armed(ed);
      const none = fakeFetch([]);
      const out = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: new Date("2030-10-15T12:00:00-03:00"), fetchFn: none.fetchFn });
      assert.equal(out[0].action, "expired");
      assert.equal(readIntent(ed)!.status, "expired");
      assert.equal(none.calls.length, 0);
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });
});

describe("alarme de expiração do token (#9568)", () => {
  const now = new Date("2030-10-01T12:00:00Z");
  const env = (expiresAt?: string) => ({ ...ENV_OK, [LINKEDIN_PERSONAL_ENV.expiresAt]: expiresAt });
  it("sem token configurado: sem alarme; folga > 14 dias: sem alarme", () => {
    assert.equal(evaluateTokenExpiry({}, now), null);
    assert.equal(evaluateTokenExpiry(env("2030-10-20T12:00:00Z"), now), null);
  });
  it("faixas: ≤14d P2, ≤3d P1, expirado P1, sem data P2 — mesmo fingerprint, família estado", () => {
    const warn = evaluateTokenExpiry(env("2030-10-10T12:00:00Z"), now)!;
    assert.equal(warn.priority, "P2");
    assert.equal(warn.contentSignature, "warn");
    const crit = evaluateTokenExpiry(env("2030-10-03T12:00:00Z"), now)!;
    assert.equal(crit.priority, "P1");
    assert.equal(crit.contentSignature, "critical");
    const gone = evaluateTokenExpiry(env("2030-09-30T12:00:00Z"), now)!;
    assert.equal(gone.priority, "P1");
    assert.match(gone.title, /expirou/);
    const unknown = evaluateTokenExpiry(env(undefined), now)!;
    assert.equal(unknown.contentSignature, "unknown");
    for (const f of [warn, crit, gone, unknown]) {
      assert.equal(f.fingerprint, TOKEN_ALARM_FINGERPRINT);
      assert.equal(f.family, "estado");
      assert.ok(!f.body.includes("tok-secreto"));
    }
  });
});

describe("task Diaria-LinkedIn-Personal (#9568)", () => {
  it("roda 1 minuto depois de publishing.social.use_melhor_time (mudou o slot? mude a task)", () => {
    const task = getScheduledTaskByName("Diaria-LinkedIn-Personal");
    assert.ok(task);
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    const [h, m] = String(cfg.publishing.social.use_melhor_time).split(":").map(Number);
    const slot = h * 60 + m + 1;
    assert.deepEqual(task!.schedule, { kind: "daily", hour: Math.floor(slot / 60), minute: slot % 60 });
    assert.deepEqual(
      task!.steps.map((s) => [s.script, s.args ?? []]),
      [
        ["scripts/publish-linkedin-personal.ts", ["--fire-due"]],
        ["scripts/linkedin-personal-token-alarm.ts", []],
      ],
    );
  });
});
