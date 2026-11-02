/**
 * #11794: Reel sempre com @diar.ia.br autora e @vjpixel em collab, também à mão.
 * A armadilha da inversão: `instagram_author_page: null` (produção) e a página
 * `diaria` são a mesma conta. Comparar os dois valores crus faria o timer pedir a
 * credencial de uma página que ele não precisa, e travar em `author-unchecked`
 * com a conta da API vazia. O post à mão aparece na própria conta da API, e é lá
 * que a conferência anti-duplicação o acha.
 */
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirmChromeAuthorDeps,
  confirmInstagram,
  defaultGraphDeps,
  decideInstagramConfirm,
  decideInstagramConfirmAcrossAccounts,
  decideInstagramTimerAcrossAccounts,
  instagramConfirmExpectedCollabs,
  instagramTimerGate,
  resolveChromeAuthorReader,
  timerChromeAuthorDeps,
  type GraphDeps,
  type InstagramConfirmDecision,
} from "../scripts/publish-shorts.ts";
import { buildInstagramTimerAlarm } from "../scripts/shorts-instagram-timer.ts";
import { INSTAGRAM_CHROME_ROUTE, buildReelsCaption, instagramChromeRouteText, type ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const AT = "2026-10-27T11:00:00.000Z";
const D1 = { title: "Você já viu IA mentir. Já viu roubar?", body: "Um modelo da OpenAI gastou o saldo de uma carteira de terceiros." };
const caption = buildReelsCaption({ platform: "instagram", d1: D1 });
const reel = (id: string) => ({ id, caption, timestamp: "2026-10-27T11:05:00+0000", media_product_type: "REELS", permalink: `https://www.instagram.com/reel/${id}/` });
const decideFrom = (data: unknown[]) => async (): Promise<InstagramConfirmDecision> =>
  decideInstagramConfirm({
    published: { aammdd: "261027", entries: [] },
    media: { data },
    sinceIso: "2026-10-27T03:00:00.000Z",
    markers: ["utm_campaign=261027", D1.title],
    nowIso: "2026-10-27T20:00:00.000Z",
    expectedAtIso: AT,
  });

/** Qualquer chamada à Graph falha o teste: a mesma conta não lê página nenhuma. */
const noGraph: Pick<GraphDeps, "fetch"> = {
  fetch: async (url) => {
    throw new Error(`chamada inesperada à Graph: ${url}`);
  },
};
const noPages: ResolvedFacebookPage[] = [];
const neverRead = () => () => {
  throw new Error("não deveria ler um segundo perfil");
};

describe("#11794: wiring do confirmInstagram com a autora na conta da API", () => {
  /** Só `/media` e `/collaborators`: ler a página `diaria` ou outro perfil lança. */
  const graph = (media: unknown[]): { deps: GraphDeps; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        ...defaultGraphDeps,
        fetch: async (url) => {
          calls.push(url);
          if (url.includes("/collaborators")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
          if (url.includes("/IG1/media")) return new Response(JSON.stringify({ data: media }), { status: 200 });
          throw new Error(`chamada inesperada à Graph: ${url}`);
        },
      },
    };
  };
  const repoConfig = JSON.parse(readFileSync("platform.config.json", "utf8"));
  const configSemCollab = { ...repoConfig, publishing: { ...repoConfig.publishing, shorts: { ...repoConfig.publishing.shorts, instagram_author_page: null, instagram_collaborators: [] } } };

  async function run(t: TestContext, media: unknown[]) {
    t.mock.method(console, "error", () => {});
    const log = t.mock.method(console, "log", () => {});
    const saved = { id: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID, token: process.env.INSTAGRAM_ACCESS_TOKEN };
    process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = "IG1";
    process.env.INSTAGRAM_ACCESS_TOKEN = "tok";
    const dir = mkdtempSync(join(tmpdir(), "shorts-ig-11794-"));
    const g = graph(media);
    const persisted: ShortPublishedEntry[] = [];
    try {
      const code = await confirmInstagram(
        "261027",
        dir,
        (e) => {
          persisted.push(e);
          return { aammdd: "261027", entries: persisted };
        },
        { aammdd: "261027", entries: [] },
        "2026-10-27T03:00:00.000Z",
        undefined,
        undefined,
        undefined,
        { graph: g.deps, config: configSemCollab },
      );
      return { code, persisted, calls: g.calls, out: JSON.parse(String(log.mock.calls.at(-1)?.arguments[0])) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (saved.id === undefined) delete process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
      else process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = saved.id;
      if (saved.token === undefined) delete process.env.INSTAGRAM_ACCESS_TOKEN;
      else process.env.INSTAGRAM_ACCESS_TOKEN = saved.token;
    }
  }
  const marked = { ...reel("M1"), caption: `${caption}\nutm_campaign=261027` };

  it("Reel achado com instagram_collaborators vazio: ainda cobra a @vjpixel, lendo os collabs", async (t) => {
    const r = await run(t, [marked]);
    assert.equal(r.code, 0);
    assert.equal(r.persisted.length, 1);
    assert.ok(r.calls.some((u) => u.includes("M1/collaborators")));
    assert.ok(r.out.warnings.some((w: string) => /@vjpixel/.test(w)), JSON.stringify(r.out.warnings));
  });

  it("recusa sem o Reel: nada gravado, sem nota de perfil não consultado, sem ler outra conta", async (t) => {
    const r = await run(t, []);
    assert.equal(r.code, 1);
    assert.equal(r.persisted.length, 0);
    assert.equal(r.out.fallback, undefined);
    assert.ok(r.calls.every((u) => u.includes("/IG1/media")));
  });
});

describe("#11794: alarmes avisam do risco de duplicar ao postar à mão", () => {
  const body = (key: "publish-failed" | "credentials" | "late") => buildInstagramTimerAlarm({ aammdd: "261027", key, reason: "x", videoArg: "x.mp4" }).body;

  for (const key of ["publish-failed", "credentials"] as const) {
    it(`${key}: o timer ainda tenta de novo → avisa da hora cheia e dos 30 a 60 s`, () => {
      assert.match(body(key), /perto da hora cheia pode duplicar/);
      assert.match(body(key), /30 a 60 s/);
    });
  }

  it("late: o timer não tenta mais → sem o aviso", () => {
    assert.doesNotMatch(body("late"), /perto da hora cheia/);
  });
});

describe("#11794: autoria da rota manual", () => {
  it("@diar.ia.br autora, @vjpixel em collab, igual à rota da API", () => {
    assert.equal(INSTAGRAM_CHROME_ROUTE.authorUsername, "diar.ia.br");
    assert.equal(INSTAGRAM_CHROME_ROUTE.collaboratorUsername, "vjpixel");
    assert.equal(instagramChromeRouteText(), "como @diar.ia.br (autora), com a @vjpixel em collab");
  });

  it("o Passo B3b manda postar logado na @diar.ia.br e convidar a @vjpixel", () => {
    const skill = readFileSync(".claude/skills/diaria-publica-video/SKILL.md", "utf8");
    assert.match(skill, /Conferir no avatar que a conta é @diar\.ia\.br/);
    assert.match(skill, /\*\*Add collaborators:\*\* digitar `vjpixel`/);
    assert.doesNotMatch(skill, /Conferir no avatar que a conta é @vjpixel/);
    assert.doesNotMatch(skill, /Add collaborators:\*\* digitar `diar\.ia\.br`/);
  });

  it("o alarme guided não manda procurar em outro perfil", () => {
    const { body } = buildInstagramTimerAlarm({ aammdd: "261027", key: "guided", reason: "acima do teto", videoArg: "x.mp4", verticalHhmm: "08:00" });
    assert.ok(body.includes(instagramChromeRouteText()));
    assert.doesNotMatch(body, /perfil do @/);
    assert.doesNotMatch(body, /collab está pendente/);
  });
});

describe("#11794: a autora à mão é a conta da API", () => {
  for (const apiAuthorPage of [null, "diaria"]) {
    it(`instagram_author_page ${JSON.stringify(apiAuthorPage)} → mesma conta, sem pedir credencial de página nem chamar a Graph`, async () => {
      const r = await resolveChromeAuthorReader(apiAuthorPage, noPages, "v25.0", noGraph);
      assert.equal(r.sameAccount, true);
      assert.equal(r.reader, null);
    });
  }

  it("outra autora na API (vjpixel) ainda consulta a página diaria, sem marcar mesma conta", async () => {
    const r = await resolveChromeAuthorReader("vjpixel", noPages, "v25.0", noGraph);
    assert.equal(r.sameAccount, undefined);
    assert.match(r.unavailable ?? "", /"diaria" não existe/);
  });
});

describe("#11794: conferência anti-duplicação com a autora na conta da API", () => {
  const chromeDeps = async () => timerChromeAuthorDeps(await resolveChromeAuthorReader(null, noPages, "v25.0", noGraph), neverRead);

  it("Reels com o marcador da edição na conta da API → timer registra e NÃO publica, sem ler segundo perfil", async () => {
    const deps = await chromeDeps();
    const persisted: unknown[] = [];
    const r = await instagramTimerGate({ decide: () => decideInstagramTimerAcrossAccounts({ primary: decideFrom([reel("M1")]), ...deps }), persist: (e) => persisted.push(e) });
    assert.equal(r.kind, "already");
    assert.equal(persisted.length, 1);
  });

  it("conta da API vazia → publica; não trava em author-unchecked esperando credencial de página", async () => {
    const deps = await chromeDeps();
    assert.deepEqual(deps, { chromeAuthor: null });
    assert.deepEqual(await instagramTimerGate({ decide: () => decideInstagramTimerAcrossAccounts({ primary: decideFrom([]), ...deps }), persist: () => {} }), { kind: "publish" });
  });

  it("risco aceito (#11794): Reel só na @vjpixel não é lido, e o timer publica na @diar.ia.br", async () => {
    // A conta da API (@diar.ia.br) não tem o Reel, e nada lê o perfil da @vjpixel: `noGraph` e `neverRead` lançam.
    const deps = await chromeDeps();
    assert.deepEqual(await instagramTimerGate({ decide: () => decideInstagramTimerAcrossAccounts({ primary: decideFrom([]), ...deps }), persist: () => {} }), { kind: "publish" });
    const skill = readFileSync(".claude/skills/diaria-publica-video/SKILL.md", "utf8");
    assert.match(skill, /Nunca postar logado como @vjpixel/);
    assert.match(skill, /--confirm-instagram --url URL` antes do horário/);
  });

  it("--confirm-instagram acha o Reels na conta da API, sem segundo perfil", async () => {
    const deps = confirmChromeAuthorDeps(await resolveChromeAuthorReader(null, noPages, "v25.0", noGraph), neverRead);
    const r = await decideInstagramConfirmAcrossAccounts({ primary: decideFrom([reel("M1")]), ...deps });
    assert.equal(r.account, "primary");
    assert.equal(r.decision.kind, "register");
  });

  it("recusa do --confirm-instagram sem o Reels não fala de perfil não consultado", async () => {
    const deps = confirmChromeAuthorDeps(await resolveChromeAuthorReader(null, noPages, "v25.0", noGraph), neverRead);
    const r = await decideInstagramConfirmAcrossAccounts({ primary: decideFrom([]), ...deps });
    assert.equal(r.decision.kind, "refuse");
    assert.equal(r.fallbackNote, undefined);
  });

  it("outra conta sem credencial: o motivo segue chegando à recusa", () => {
    assert.deepEqual(confirmChromeAuthorDeps({ reader: null, unavailable: "sem credencial" }, neverRead), { chromeAuthor: null, chromeAuthorUnavailable: "sem credencial" });
  });
});

describe("#11794: o --confirm-instagram continua exigindo a @vjpixel", () => {
  it("mesma conta: exige a @vjpixel, mesmo com instagram_collaborators vazio", () => {
    assert.deepEqual(instagramConfirmExpectedCollabs({ account: "primary", sameAccount: true, configCollaborators: [] }), ["vjpixel"]);
  });

  it("mesma conta com a @vjpixel no config: não duplica e preserva os demais", () => {
    assert.deepEqual(instagramConfirmExpectedCollabs({ account: "primary", sameAccount: true, configCollaborators: ["vjpixel", "outra"] }), ["vjpixel", "outra"]);
  });

  it("achado no perfil da autora em outra conta: a @vjpixel", () => {
    assert.deepEqual(instagramConfirmExpectedCollabs({ account: "chrome-author", sameAccount: false, configCollaborators: ["diar.ia.br"] }), ["vjpixel"]);
  });

  it("outra conta na API: valem os do config", () => {
    assert.deepEqual(instagramConfirmExpectedCollabs({ account: "primary", sameAccount: false, configCollaborators: ["diar.ia.br"] }), ["diar.ia.br"]);
  });
});
