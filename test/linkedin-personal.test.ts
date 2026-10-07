/**
 * #9568 — LinkedIn PESSOAL automatizado: OAuth, post, arme no Stage 6,
 * disparo nas tasks e alarme. HTTP sempre injetado (nunca a LinkedIn de
 * verdade); edições em diretório temporário (nunca `data/`).
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
  LINKEDIN_POSTS_URL,
  LINKEDIN_USERINFO_URL,
  MAX_FIRE_LATENESS_MS,
  PERSONAL_CATCHUP_TASK_NAME,
  PERSONAL_TASK_NAME,
  REVOKED_REASON,
  TOKEN_ALARM_FINGERPRINT,
  aammddBrt,
  buildAuthorizeUrl,
  checkTokenRemote,
  decideFire,
  defaultLinkedInApiVersion,
  evaluatePersonalIntents,
  evaluateTokenExpiry,
  exchangeCodeForToken,
  fetchPersonUrn,
  fireWindowCheck,
  nextPersonalFireRun,
  nextRunOf,
  postToPersonalProfile,
  readPersonalCreds,
  toLittleText,
  type FetchFn,
  type PersonalIntentStatus,
  type PersonalPostIntent,
} from "../scripts/lib/linkedin-personal.ts";
import {
  ARM_EXIT,
  armPersonalPost,
  candidateEditions,
  fireDuePersonalPosts,
  fireExitCode,
  intentPath,
  lockPath,
  readIntent,
  type FireOutcome,
} from "../scripts/publish-linkedin-personal.ts";
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
function fakeFetch(responses: Array<(c: Call) => Response | Promise<Response>>): { fetchFn: FetchFn; calls: Call[] } {
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
const userinfoOk = () => json({ sub: "AbC123_x" });
/** fetch que responde userinfo 200 sempre (arme/check). */
const userinfoAlways: FetchFn = async () => userinfoOk();

describe("credenciais (#9568)", () => {
  it("sem token = não configurado (modo manual legítimo)", () => {
    const r = readPersonalCreds({}, new Date());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.configured, false);
  });
  it("URN malformada ou token expirado antes do horário do post = indisponível", () => {
    assert.equal(readPersonalCreds({ ...ENV_OK, [LINKEDIN_PERSONAL_ENV.personUrn]: "123" }, new Date()).ok, false);
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
  it("checkTokenRemote: 200 válido; 401/403 revogado; 5xx/rede indeterminado", async () => {
    assert.deepEqual(await checkTokenRemote(fakeFetch([userinfoOk]).fetchFn, "T"), { state: "valid" });
    for (const s of [401, 403]) {
      assert.deepEqual(await checkTokenRemote(fakeFetch([() => json({}, s)]).fetchFn, "T"), { state: "revoked", reason: REVOKED_REASON });
    }
    assert.equal((await checkTokenRemote(fakeFetch([() => json({}, 503)]).fetchFn, "T")).state, "unknown");
    const boom: FetchFn = async () => {
      throw new Error("ECONNRESET");
    };
    assert.equal((await checkTokenRemote(boom, "T")).state, "unknown");
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
    const f = fakeFetch([userinfoOk]);
    assert.equal(await fetchPersonUrn(f.fetchFn, "T"), URN);
    assert.equal(f.calls[0].url, LINKEDIN_USERINFO_URL);
    assert.equal((f.calls[0].init?.headers as Record<string, string>).Authorization, "Bearer T");
  });
  it("persistSecrets: Doppler + .env; falha do Doppler reportada COM o stderr, .env escrito mesmo assim", () => {
    let written = "";
    const r = persistSecrets({
      secrets: { A: "1", B: "2" },
      dopplerSet: (name) => (name === "B" ? { ok: false, error: "Doppler Error: you must run doppler setup" } : { ok: true }),
      envPath: "/x/.env",
      readEnv: () => "A=velho\nOUTRA=y",
      writeEnv: (_p, c) => {
        written = c;
      },
    });
    assert.deepEqual(r.doppler, ["A"]);
    assert.deepEqual(r.dopplerFailed, ["B"]);
    assert.deepEqual(r.dopplerErrors, ["Doppler Error: you must run doppler setup"]);
    assert.equal(written, "A=1\nOUTRA=y\n\nB=2\n");
  });
});

describe("texto little-text (#9568)", () => {
  it("escapa TODOS os reservados", () => {
    assert.equal(toLittleText("a\\b@c[d]e<f>g*h~i|j{k}l(m)n_o"), "a\\\\b\\@c\\[d\\]e\\<f\\>g\\*h\\~i\\|j\\{k\\}l\\(m\\)n\\_o");
  });
  it("o '1)' das listas e a UTM ficam escapados; hashtag vira template", () => {
    assert.equal(toLittleText("1) Faça (isto) #Planilhas"), "1\\) Faça \\(isto\\) {hashtag|\\#|Planilhas}");
    assert.equal(toLittleText("utm_source=linkedin"), "utm\\_source=linkedin");
  });
  it("hashtag no início, acentuada e depois de \\n; # no meio de palavra e de URL só escapado", () => {
    assert.equal(toLittleText("#IA no início"), "{hashtag|\\#|IA} no início");
    assert.equal(toLittleText("fim\n#InteligênciaArtificial"), "fim\n{hashtag|\\#|InteligênciaArtificial}");
    assert.equal(toLittleText("nota#1"), "nota\\#1");
    assert.equal(toLittleText("https://diar.ia.br/p/x#secao"), "https://diar.ia.br/p/x\\#secao");
  });
});

describe("postToPersonalProfile (#9568)", () => {
  const creds = { accessToken: "T", personUrn: URN, expiresAt: null };
  it("só texto: author = pessoa, commentary escapado no corpo, versão no header, URN do x-restli-id", async () => {
    const f = fakeFetch([() => new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:9" } })]);
    const r = await postToPersonalProfile({ fetchFn: f.fetchFn, creds, apiVersion: "202608", text: "Oi (teste) #IA" });
    assert.deepEqual(r, { ok: true, postUrn: "urn:li:share:9", imageUsed: false });
    assert.equal(f.calls[0].url, LINKEDIN_POSTS_URL);
    const body = JSON.parse(String(f.calls[0].init?.body));
    assert.equal(body.author, URN);
    assert.equal(body.commentary, "Oi \\(teste\\) {hashtag|\\#|IA}");
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
  it("classificação: upload falho/exceção no upload/4xx = before_send; 401/403 = revogado; exceção ou 5xx no POST = ambiguous", async () => {
    const up403 = await postToPersonalProfile({ fetchFn: fakeFetch([() => json({}, 403)]).fetchFn, creds, apiVersion: "v", text: "t", imageBytes: new Uint8Array([1]) });
    assert.deepEqual(up403, { ok: false, phase: "before_send", reason: REVOKED_REASON, revoked: true });
    const upBoom: FetchFn = async () => {
      throw new Error("ETIMEDOUT");
    };
    const r1 = await postToPersonalProfile({ fetchFn: upBoom, creds, apiVersion: "v", text: "t", imageBytes: new Uint8Array([1]) });
    assert.equal(r1.ok === false && r1.phase, "before_send");
    const r422 = await postToPersonalProfile({ fetchFn: fakeFetch([() => json({ message: "x" }, 422)]).fetchFn, creds, apiVersion: "v", text: "t" });
    assert.equal(r422.ok === false && r422.phase, "before_send");
    const r401 = await postToPersonalProfile({ fetchFn: fakeFetch([() => json({}, 401)]).fetchFn, creds, apiVersion: "v", text: "t" });
    assert.deepEqual(r401, { ok: false, phase: "before_send", reason: REVOKED_REASON, revoked: true });
    const r503 = await postToPersonalProfile({ fetchFn: fakeFetch([() => json({}, 503)]).fetchFn, creds, apiVersion: "v", text: "t" });
    assert.equal(r503.ok === false && r503.phase, "ambiguous");
    const r2 = await postToPersonalProfile({ fetchFn: upBoom, creds, apiVersion: "v", text: "t" });
    assert.equal(r2.ok === false && r2.phase, "ambiguous");
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
  const at = new Date(base.scheduled_at).getTime();
  it("limites exatos: = scheduled_at dispara; 3h exatas dispara; 3h+1ms expira; antes = not_due; ilegível = expired", () => {
    assert.equal(decideFire(base, new Date(at - 1)), "not_due");
    assert.equal(decideFire(base, new Date(at)), "fire");
    assert.equal(decideFire(base, new Date(at + MAX_FIRE_LATENESS_MS)), "fire");
    assert.equal(decideFire(base, new Date(at + MAX_FIRE_LATENESS_MS + 1)), "expired");
    assert.equal(decideFire({ ...base, scheduled_at: "ontem" }, new Date(at)), "expired");
  });
  it("todo status não-armed é done (nada dispara de novo sem novo --arm)", () => {
    for (const status of ["posting", "published", "failed_before_send", "send_unknown", "expired"] as PersonalIntentStatus[]) {
      assert.equal(decideFire({ ...base, status }, new Date(at)), "done", status);
    }
  });
  it("edições candidatas = hoje e ontem em BRT (meia-noite UTC ainda é o dia anterior)", () => {
    assert.equal(aammddBrt(new Date("2030-10-15T02:00:00Z")), "301014");
    assert.deepEqual(candidateEditions(new Date("2030-10-15T10:46:00Z")), ["301015", "301014"]);
  });
});

describe("janela das tasks (#9568)", () => {
  it("nextRunOf: daily 07:46 BRT e interval 1h em hora cheia BRT", () => {
    const daily = { kind: "daily", hour: 7, minute: 46 } as const;
    assert.equal(nextRunOf(daily, new Date("2030-10-15T07:45:00-03:00"))!.toISOString(), "2030-10-15T10:46:00.000Z");
    assert.equal(nextRunOf(daily, new Date("2030-10-15T07:46:00-03:00"))!.toISOString(), "2030-10-15T10:46:00.000Z");
    assert.equal(nextRunOf(daily, new Date("2030-10-15T07:47:00-03:00"))!.toISOString(), "2030-10-16T10:46:00.000Z");
    const hourly = { kind: "interval", hours: 1 } as const;
    assert.equal(nextRunOf(hourly, new Date("2030-10-15T09:10:00-03:00"))!.toISOString(), "2030-10-15T13:00:00.000Z");
    assert.equal(nextRunOf(hourly, new Date("2030-10-15T23:30:00-03:00"))!.toISOString(), "2030-10-16T03:00:00.000Z");
  });
  it("slot padrão sai às 07:46; slot deslocado (09:10) sai na repescagem das 10:00 — dentro da janela", () => {
    assert.equal(nextPersonalFireRun(new Date("2030-10-15T07:45:00-03:00"))!.toISOString(), "2030-10-15T10:46:00.000Z");
    const shifted = fireWindowCheck(new Date("2030-10-15T09:10:00-03:00"), new Date("2030-10-15T08:00:00-03:00"));
    assert.ok(shifted.ok);
    if (shifted.ok) assert.equal(shifted.nextRun.toISOString(), "2030-10-15T13:00:00.000Z");
  });
  it("arme depois da janela inteira (> 3h do scheduled_at) e scheduled_at ilegível = fora", () => {
    const late = fireWindowCheck(new Date("2030-10-15T07:45:00-03:00"), new Date("2030-10-15T11:00:00-03:00"));
    assert.equal(late.ok, false);
    assert.equal(fireWindowCheck(new Date("x"), new Date()).ok, false);
  });
});

// ── fixture de edição (mesmo molde de test/use-melhor-dispatch-9568.test.ts) ──
const ITEM = { url: "https://exame.com/guia-planilhas", title: "Guia de planilhas com IA", summary: "Resumo.", score: 88 };
const P = (s: string) => `${s} **Trecho em negrito.** Fim do parágrafo com algum detalhe a mais.`;
const UM_SOCIAL = [P("Um guia prático para planilhas."), P("Como pedir fórmulas."), P("Como revisar."), P("Quando não confiar."), "#Planilhas"].join("\n\n");
const CONFIG_ON = { publishing: { social: { use_melhor_time: "07:45", fallback_schedule: { d1_time: "10:00" } } } };
const SCHEDULED = "2030-10-15T07:45:00-03:00";
const ARM_NOW = new Date("2030-10-14T22:00:00-03:00");

function makeEdition(opts: { pageEntry?: boolean; postPixelOnly?: boolean; scheduledAt?: string } = {}): string {
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
      JSON.stringify({ posts: [{ platform: "linkedin", destaque: "um", url: null, status: "scheduled", scheduled_at: opts.scheduledAt ?? SCHEDULED }] }),
      "utf8",
    );
  }
  return ed;
}
function withEdition(fn: (ed: string) => Promise<void> | void, opts: Parameters<typeof makeEdition>[0] = {}): () => Promise<void> {
  return async () => {
    const ed = makeEdition(opts);
    try {
      await fn(ed);
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  };
}
const arm = (ed: string, extra: Partial<Parameters<typeof armPersonalPost>[0]> = {}) =>
  armPersonalPost({ editionDir: ed, config: CONFIG_ON, env: ENV_OK, now: ARM_NOW, fetchFn: userinfoAlways, ...extra });
function intentOf(ed: string): PersonalPostIntent {
  const r = readIntent(ed);
  assert.equal(r.kind, "ok");
  return (r as { kind: "ok"; intent: PersonalPostIntent }).intent;
}
function writeStatus(ed: string, status: PersonalIntentStatus): void {
  writeFileSync(intentPath(ed), JSON.stringify({ edition: "301015", status, text: "t", image: null, scheduled_at: SCHEDULED, armed_at: "x" }));
}

describe("--arm / --check no Stage 6 (#9568)", () => {
  it("com token: grava armed com texto do ## um (sem markdown), capa, horário da página e fingerprint do token", withEdition(async (ed) => {
    const r = await arm(ed);
    assert.equal(r.kind, "armed", JSON.stringify(r));
    const intent = intentOf(ed);
    assert.equal(intent.status, "armed");
    assert.equal(intent.scheduled_at, SCHEDULED);
    assert.equal(intent.image, USE_MELHOR_COVER_FILE);
    assert.equal(intent.token_fingerprint, FUTURE);
    assert.match(intent.text, /Um guia prático para planilhas/);
    assert.doesNotMatch(intent.text, /\*\*/);
    assert.ok(!JSON.stringify(intent).includes("tok-secreto"), "token nunca vai pro arquivo da edição");
  }));
  it("--check (dryRun) avalia tudo e não grava", withEdition(async (ed) => {
    const r = await arm(ed, { dryRun: true });
    assert.equal(r.kind, "would_arm");
    assert.equal(r.intent?.scheduled_at, SCHEDULED);
    assert.equal(existsSync(intentPath(ed)), false);
  }));
  it("sem token, token revogado (userinfo 401) ou fora da janela: unavailable (exit 3) e NENHUM arquivo", withEdition(async (ed) => {
    assert.equal((await arm(ed, { env: {} })).kind, "unavailable");
    const revoked = await arm(ed, { fetchFn: fakeFetch([() => json({}, 401)]).fetchFn });
    assert.deepEqual([revoked.kind, revoked.reason], ["unavailable", REVOKED_REASON]);
    const late = await arm(ed, { now: new Date("2030-10-15T11:00:00-03:00") });
    assert.equal(late.kind, "unavailable");
    assert.match(late.reason ?? "", /janela/);
    assert.equal(existsSync(intentPath(ed)), false);
  }));
  it("página sem entry linkedin/um (scheduled_at null) e edição legada: nothing", async () => {
    for (const opts of [{ pageEntry: false }, { postPixelOnly: true }]) {
      await withEdition(async (ed) => {
        assert.equal((await arm(ed)).kind, "nothing", JSON.stringify(opts));
        assert.equal(existsSync(intentPath(ed)), false);
      }, opts)();
    }
  });
  it("re-arme sobre cada estado: published/posting/send_unknown recusados; armed/failed_before_send/expired re-armam", async () => {
    const expected: Record<PersonalIntentStatus, string> = {
      published: "already_published",
      posting: "in_flight",
      send_unknown: "send_unknown",
      armed: "armed",
      failed_before_send: "armed",
      expired: "armed",
    };
    for (const [status, kind] of Object.entries(expected) as [PersonalIntentStatus, string][]) {
      await withEdition(async (ed) => {
        writeStatus(ed, status);
        const r = await arm(ed);
        assert.equal(r.kind, kind, status);
        if (kind !== "armed") assert.equal(intentOf(ed).status, status, `${status} não foi sobrescrito`);
      })();
    }
  });
  it("lock presente ou arquivo corrompido: recusa sem sobrescrever (exit 5)", withEdition(async (ed) => {
    writeFileSync(lockPath(ed), "x");
    assert.equal((await arm(ed)).kind, "in_flight");
    rmSync(lockPath(ed));
    writeFileSync(intentPath(ed), "{quebrado");
    const r = await arm(ed);
    assert.equal(r.kind, "corrupt");
    assert.equal(readFileSync(intentPath(ed), "utf8"), "{quebrado");
  }));
  it("exceção inesperada vira kind error (exit 4), nunca escapa", withEdition(async (ed) => {
    const boom: FetchFn = async () => {
      throw new Error("x");
    };
    // checkTokenRemote engole erro de rede (indeterminado → manual, exit 3).
    const r = await armPersonalPost({ editionDir: ed, config: CONFIG_ON, env: ENV_OK, now: ARM_NOW, fetchFn: boom });
    assert.equal(r.kind, "unavailable"); // rede = indeterminado = manual
    // 03-social.md virou diretório: readFileSync lança EISDIR.
    rmSync(join(ed, "03-social.md"));
    mkdirSync(join(ed, "03-social.md"));
    const bad = await armPersonalPost({ editionDir: ed, config: CONFIG_ON, env: ENV_OK, now: ARM_NOW, fetchFn: userinfoAlways });
    assert.equal(bad.kind, "error");
    assert.equal(ARM_EXIT[bad.kind], 4);
  }));
  it("mapeamento kind → exit code", () => {
    assert.deepEqual(ARM_EXIT, {
      armed: 0, would_arm: 0, already_published: 0, nothing: 1, unavailable: 3, error: 4, in_flight: 5, send_unknown: 5, corrupt: 5,
    });
  });
});

describe("--fire-due (#9568)", () => {
  const slotNow = new Date("2030-10-15T07:46:00-03:00");
  const okPost = (urn: string) => [
    () => json({ value: { uploadUrl: "https://up/x", image: "urn:li:image:1" } }),
    () => new Response("", { status: 201 }),
    () => new Response("", { status: 201, headers: { "x-restli-id": urn } }),
  ];

  it("posting é gravado ANTES da rede (o fetch do POST lê o arquivo e vê posting + lock)", withEdition(async (ed) => {
    await arm(ed);
    const seen: string[] = [];
    const f = fakeFetch([
      () => json({ value: { uploadUrl: "https://up/x", image: "urn:li:image:1" } }),
      () => new Response("", { status: 201 }),
      () => {
        seen.push(intentOf(ed).status, String(existsSync(lockPath(ed))));
        return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:7" } });
      },
    ]);
    const out = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: slotNow, fetchFn: f.fetchFn });
    assert.deepEqual(seen, ["posting", "true"]);
    assert.deepEqual(out, [{ edition: "301015", action: "published", post_url: "https://www.linkedin.com/feed/update/urn:li:share:7/" }]);
    assert.equal(intentOf(ed).status, "published");
    assert.equal(existsSync(lockPath(ed)), false, "lock liberado no fim");
    assert.deepEqual(await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: slotNow, fetchFn: fakeFetch([]).fetchFn }), []);
  }));
  it("lock já existente (outra execução): não chama a rede", withEdition(async (ed) => {
    await arm(ed);
    writeFileSync(lockPath(ed), "outra");
    const none = fakeFetch([]);
    const out = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: slotNow, fetchFn: none.fetchFn });
    assert.equal(out[0].action, "locked");
    assert.equal(none.calls.length, 0);
    assert.equal(intentOf(ed).status, "armed");
  }));
  it("antes do slot e --dry-run não chamam a rede nem mudam o arquivo", withEdition(async (ed) => {
    await arm(ed);
    const none = fakeFetch([]);
    assert.deepEqual(await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: new Date("2030-10-15T07:40:00-03:00"), fetchFn: none.fetchFn }), []);
    const dry = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: slotNow, fetchFn: none.fetchFn, dryRun: true });
    assert.deepEqual(dry, [{ edition: "301015", action: "would_publish" }]);
    assert.equal(none.calls.length, 0);
    assert.equal(intentOf(ed).status, "armed");
  }));
  it("5xx no POST = send_unknown (terminal); 4xx = failed_before_send (re-armável)", withEdition(async (ed) => {
    await arm(ed);
    const f = fakeFetch([() => json({ value: { uploadUrl: "u", image: "i" } }), () => new Response("", { status: 201 }), () => new Response("x", { status: 502 })]);
    const out = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: slotNow, fetchFn: f.fetchFn });
    assert.equal(out[0].action, "send_unknown");
    assert.equal(intentOf(ed).status, "send_unknown");
    assert.equal((await arm(ed)).kind, "send_unknown", "send_unknown nunca é re-armado");
    writeStatus(ed, "armed");
    // intenção só-texto (image null): a única chamada é o POST.
    const g = fakeFetch([() => new Response("x", { status: 422 })]);
    const out2 = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: slotNow, fetchFn: g.fetchFn });
    assert.equal(out2[0].action, "failed_before_send");
    assert.equal((await arm(ed)).kind, "armed", "failed_before_send re-arma");
  }));
  it("token ausente nesta máquina: failed_before_send com 'npm run sync-env no 300', sem rede", withEdition(async (ed) => {
    await arm(ed);
    const none = fakeFetch([]);
    const out = await fireDuePersonalPosts({ editionDirs: [ed], env: {}, now: slotNow, fetchFn: none.fetchFn });
    assert.equal(out[0].action, "failed_before_send");
    assert.match(out[0].reason ?? "", /npm run sync-env.*300/);
    assert.equal(none.calls.length, 0);
  }));
  it("token divergente do que armou: posta, com aviso de sync-env", withEdition(async (ed) => {
    await arm(ed);
    const env = { ...ENV_OK, [LINKEDIN_PERSONAL_ENV.expiresAt]: "2098-06-01T00:00:00.000Z" };
    const out = await fireDuePersonalPosts({ editionDirs: [ed], env, now: slotNow, fetchFn: fakeFetch(okPost("urn:li:share:8")).fetchFn });
    assert.equal(out[0].action, "published");
    assert.match(out[0].note ?? "", /sync-env/);
  }));
  it("imagem ausente no disparo: failed_before_send, nada enviado", withEdition(async (ed) => {
    await arm(ed);
    const none = fakeFetch([]);
    const out = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: slotNow, fetchFn: none.fetchFn, readImage: () => null });
    assert.equal(out[0].action, "failed_before_send");
    assert.equal(none.calls.length, 0);
    assert.equal(intentOf(ed).status, "failed_before_send");
  }));
  it("atraso > 3h vira expired sem postar; arquivo corrompido vira corrupt", withEdition(async (ed) => {
    await arm(ed);
    const none = fakeFetch([]);
    const out = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: new Date("2030-10-15T12:00:00-03:00"), fetchFn: none.fetchFn });
    assert.equal(out[0].action, "expired");
    assert.equal(intentOf(ed).status, "expired");
    writeFileSync(intentPath(ed), "{quebrado");
    const out2 = await fireDuePersonalPosts({ editionDirs: [ed], env: ENV_OK, now: slotNow, fetchFn: none.fetchFn });
    assert.equal(out2[0].action, "corrupt");
    assert.equal(none.calls.length, 0);
  }));
  it("exit code: falha/expired/send_unknown/corrupt = 1; published/locked/would_publish/vazio = 0", () => {
    const o = (action: FireOutcome["action"]): FireOutcome => ({ edition: "x", action });
    for (const a of ["failed_before_send", "send_unknown", "expired", "corrupt"] as const) assert.equal(fireExitCode([o("published"), o(a)]), 1, a);
    for (const a of ["published", "locked", "would_publish"] as const) assert.equal(fireExitCode([o(a)]), 0, a);
    assert.equal(fireExitCode([]), 0);
  });
});

describe("alarme (#9568)", () => {
  const now = new Date("2030-10-01T12:00:00Z");
  const env = (expiresAt?: string) => ({ ...ENV_OK, [LINKEDIN_PERSONAL_ENV.expiresAt]: expiresAt });
  const inDays = (d: number) => new Date(now.getTime() + d * 24 * 60 * 60 * 1000).toISOString();
  it("sem token: sem alarme", () => assert.equal(evaluateTokenExpiry({}, now), null));
  it("limites das faixas: 15d nada; 14d e 4d P2; 14,9d nada; 3,9d P2; 3d e <24h P1; expirado P1; ilegível P2", () => {
    const band = (d: number) => evaluateTokenExpiry(env(inDays(d)), now)?.contentSignature ?? null;
    assert.equal(band(15), null);
    assert.equal(band(14.9), null);
    assert.equal(band(14), "warn");
    assert.equal(band(4), "warn");
    assert.equal(band(3.9), "warn");
    assert.equal(band(3), "critical");
    assert.equal(band(0.5), "critical");
    assert.equal(band(-1), "expired");
    assert.equal(evaluateTokenExpiry(env(inDays(3)), now)!.priority, "P1");
    assert.equal(evaluateTokenExpiry(env(inDays(4)), now)!.priority, "P2");
    assert.equal(evaluateTokenExpiry(env("não é data"), now)!.contentSignature, "unknown");
    assert.equal(evaluateTokenExpiry(env(undefined), now)!.priority, "P2");
  });
  it("token revogado (userinfo 401) = P1 no MESMO fingerprint, mesmo com folga de expiração", () => {
    const f = evaluateTokenExpiry(env(inDays(50)), now, { state: "revoked", reason: REVOKED_REASON })!;
    assert.equal(f.priority, "P1");
    assert.equal(f.fingerprint, TOKEN_ALARM_FINGERPRINT);
    assert.match(f.title, /revogado — re-rode linkedin-personal-oauth\.ts/);
    assert.equal(f.family, "estado");
    assert.ok(!f.body.includes("tok-secreto"));
  });
  it("intenções: posting/send_unknown > 1h, armed > 3h vencido, armed sem token aqui", () => {
    const mk = (status: PersonalIntentStatus, extra: Partial<PersonalPostIntent> = {}): PersonalPostIntent => ({
      edition: "300930", status, text: "t", image: null, scheduled_at: "2030-10-01T10:45:00Z", armed_at: "x", ...extra,
    });
    const at = new Date("2030-10-01T10:45:00Z").getTime();
    const f1 = evaluatePersonalIntents([mk("posting", { posting_at: new Date(at).toISOString() })], ENV_OK, new Date(at + 61 * 60_000));
    assert.equal(f1.length, 1);
    assert.equal(f1[0].family, "evento");
    assert.equal(evaluatePersonalIntents([mk("send_unknown", { posting_at: new Date(at).toISOString() })], ENV_OK, new Date(at + 59 * 60_000)).length, 0);
    assert.equal(evaluatePersonalIntents([mk("armed")], ENV_OK, new Date(at + MAX_FIRE_LATENESS_MS + 1)).length, 1);
    assert.equal(evaluatePersonalIntents([mk("armed")], ENV_OK, new Date(at - 60_000)).length, 0);
    const noTok = evaluatePersonalIntents([mk("armed")], {}, new Date(at - 60_000));
    assert.equal(noTok.length, 1);
    assert.match(noTok[0].body, /sync-env/);
    assert.equal(evaluatePersonalIntents([mk("published")], {}, new Date(at + 10 * 3600_000)).length, 0);
  });
});

describe("tasks Diaria-LinkedIn-Personal (#9568)", () => {
  it("a diária roda 1 minuto depois de publishing.social.use_melhor_time e a repescagem é de hora em hora", () => {
    const task = getScheduledTaskByName(PERSONAL_TASK_NAME);
    const catchup = getScheduledTaskByName(PERSONAL_CATCHUP_TASK_NAME);
    assert.ok(task && catchup);
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    const [h, m] = String(cfg.publishing.social.use_melhor_time).split(":").map(Number);
    const slot = h * 60 + m + 1;
    assert.deepEqual(task!.schedule, { kind: "daily", hour: Math.floor(slot / 60), minute: slot % 60 });
    assert.deepEqual(catchup!.schedule, { kind: "interval", hours: 1 });
    assert.deepEqual(
      task!.steps.map((s) => [s.script, s.args ?? []]),
      [
        ["scripts/publish-linkedin-personal.ts", ["--fire-due"]],
        ["scripts/linkedin-personal-token-alarm.ts", []],
      ],
    );
    assert.deepEqual(catchup!.steps.map((s) => [s.script, s.args ?? []]), [["scripts/publish-linkedin-personal.ts", ["--fire-due"]]]);
  });
});
