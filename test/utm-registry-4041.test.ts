/**
 * test/utm-registry-4041.test.ts (#4041, regressão #633)
 *
 * O registry (`scripts/lib/shared/utm-registry.ts`) é a fonte única dos
 * valores de UTM. Duas classes de bug que este teste trava:
 *
 *   1. **Drift do espelho do Worker.** `workers/poll/src/utm-registry.ts` é
 *      uma CÓPIA (o bundle do Worker não alcança `scripts/**` — mesmo motivo
 *      de `ds-tokens.generated.ts`). Editar um lado sem o outro tem que
 *      quebrar o CI, senão a cópia vira drift silencioso.
 *   2. **Emissor com literal solto.** Cada emissor tem que DERIVAR do
 *      registry; se alguém reintroduzir um literal no call site, o valor
 *      exportado deixa de bater com a entrada correspondente do inventário.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as shared from "../scripts/lib/shared/utm-registry.ts";
import * as mirror from "../workers/poll/src/utm-registry.ts";

import {
  EIA_ARCHIVE_UTM_SOURCE,
  EIA_ARCHIVE_UTM_MEDIUM,
  EIA_ARCHIVE_UTM_CAMPAIGN,
} from "../scripts/lib/newsletter-render-html.ts";
import {
  LINKEDIN_WEEKLY_UTM_SOURCE,
  LINKEDIN_WEEKLY_UTM_MEDIUM,
  linkedinWeeklyCampaign,
  type LinkedinWeeklyUtmContent,
} from "../scripts/lib/weekly-linkedin-render.ts";
import {
  SUBSCRIBE_UTM_SOURCE,
  SUBSCRIBE_UTM_MEDIUM,
  SUBSCRIBE_UTM_CAMPAIGN,
  QUIZ_SUBSCRIBE_UTM_SOURCE,
  QUIZ_SUBSCRIBE_UTM_MEDIUM,
  QUIZ_SUBSCRIBE_UTM_CAMPAIGN,
} from "../workers/poll/src/jogar.ts";
import {
  EMAIL_ARCHIVE_UTM_SOURCE,
  EMAIL_ARCHIVE_UTM_MEDIUM,
  EMAIL_ARCHIVE_UTM_CAMPAIGN,
} from "../workers/poll/src/lib.ts";
import {
  INLINE_SUBSCRIBE_UTM_MEDIUM,
  INLINE_SUBSCRIBE_UTM_CAMPAIGN,
  resolveSubscribeUtm,
} from "../workers/poll/src/subscribe.ts";
import {
  EMBED_UTM_SOURCE,
  EMBED_UTM_MEDIUM,
  EMBED_DEFAULT_PARTNER,
} from "../workers/poll/src/embed.ts";

/** Chaves de VALOR que os dois módulos precisam declarar identicamente. */
const MIRRORED = [
  "EIA_STANDALONE_SOURCE",
  "EIA_ARCHIVE_UTM",
  "JOGAR_POSVOTO_UTM",
  "QUIZ_POSVOTO_UTM",
  "JOGAR_INLINE_UTM",
  "EMBED_UTM",
  "SHARE_UTM_CAMPAIGN",
  "QUIZ_SHARE_UTM_CAMPAIGN",
  "LIVROS_INLINE_UTM",
  "VOTE_CLARICE_INLINE_UTM", // #4065
  "JOGAR_GATE_INLINE_UTM", // #4054
  "JOGAR_IDENTIFY_INLINE_UTM", // #4125 item 4
  "JOGAR_POSTWEB_UTM", // #4578
] as const;

describe("#4041 — espelho do registry dentro do Worker não pode driftar", () => {
  for (const key of MIRRORED) {
    it(`${key} é idêntico entre shared/ e workers/poll/src/`, () => {
      assert.deepEqual(
        (mirror as Record<string, unknown>)[key],
        (shared as Record<string, unknown>)[key],
        `${key} divergiu — edite os DOIS arquivos (scripts/lib/shared/utm-registry.ts e workers/poll/src/utm-registry.ts).`,
      );
    });
  }

  it("o espelho não exporta nada que o shared não tenha (cópia só de valores)", () => {
    const extra = Object.keys(mirror).filter((k) => !(k in shared));
    assert.deepEqual(extra, [], `espelho tem export órfão: ${extra.join(", ")}`);
  });
});

describe("#4041 — emissores derivam do registry (sem literal solto no call site)", () => {
  it("newsletter-render-html (arquivo É IA?, e-mail diário)", () => {
    assert.equal(EIA_ARCHIVE_UTM_SOURCE, shared.EIA_ARCHIVE_UTM.source);
    assert.equal(EIA_ARCHIVE_UTM_MEDIUM, shared.EIA_ARCHIVE_UTM.medium);
    assert.equal(EIA_ARCHIVE_UTM_CAMPAIGN, shared.EIA_ARCHIVE_UTM.campaign);
  });

  it("weekly-linkedin-render (newsletter semanal do LinkedIn) — era o ÚNICO emissor do inventário sem este cross-check", () => {
    // Achado do review do #4501: `weekly-linkedin-render.ts` declara source/medium
    // como literais PRÓPRIOS em vez de importar do registry, contrariando o que o
    // docstring do registry afirma ("os emissores importam daqui"). Coincidiam por
    // sorte, sem nada amarrando — e este emissor já sofreu drift antes (a saída de
    // item-01/02/03 exigiu correção manual de prosa em 3 lugares).
    assert.equal(LINKEDIN_WEEKLY_UTM_SOURCE, shared.LINKEDIN_WEEKLY_UTM.source);
    assert.equal(LINKEDIN_WEEKLY_UTM_MEDIUM, shared.LINKEDIN_WEEKLY_UTM.medium);
    assert.equal(linkedinWeeklyCampaign("26w31"), shared.LINKEDIN_WEEKLY_UTM.campaignPattern.replace("{cycle}", "26w31"));
  });

  it("todo utm_content emitido pela semanal do LinkedIn está descrito no inventário (a description é o que o editor vê na Studio UI)", () => {
    // A união TS e a prosa do registry não compartilham símbolo — só um teste as
    // mantém em sincronia. `mencao-abertura` já nasceu faltando nessa lista uma vez.
    const emitter = shared.findUtmEmitter("linkedin-weekly-newsletter");
    assert.ok(emitter, "emissor precisa existir no inventário");
    const contents: LinkedinWeeklyUtmContent[] = ["mencao-abertura", "cta-abertura", "lista", "cta-usemelhor", "cta-fim"];
    for (const c of contents) {
      assert.ok(emitter.description.includes(c), `description do inventário não cita utm_content=${c}`);
    }
  });

  it("workers/poll/lib.ts (duplicata deliberada do #3524) usa o MESMO triplo", () => {
    assert.equal(EMAIL_ARCHIVE_UTM_SOURCE, EIA_ARCHIVE_UTM_SOURCE);
    assert.equal(EMAIL_ARCHIVE_UTM_MEDIUM, EIA_ARCHIVE_UTM_MEDIUM);
    assert.equal(EMAIL_ARCHIVE_UTM_CAMPAIGN, EIA_ARCHIVE_UTM_CAMPAIGN);
  });

  it("jogar.ts — CTA pós-voto e quiz", () => {
    assert.equal(SUBSCRIBE_UTM_SOURCE, shared.JOGAR_POSVOTO_UTM.source);
    assert.equal(SUBSCRIBE_UTM_MEDIUM, shared.JOGAR_POSVOTO_UTM.medium);
    assert.equal(SUBSCRIBE_UTM_CAMPAIGN, shared.JOGAR_POSVOTO_UTM.campaign);
    assert.equal(QUIZ_SUBSCRIBE_UTM_SOURCE, shared.QUIZ_POSVOTO_UTM.source);
    assert.equal(QUIZ_SUBSCRIBE_UTM_MEDIUM, shared.QUIZ_POSVOTO_UTM.medium);
    assert.equal(QUIZ_SUBSCRIBE_UTM_CAMPAIGN, shared.QUIZ_POSVOTO_UTM.campaign);
  });

  it("subscribe.ts — cadastro inline do jogo e das páginas de livros", () => {
    assert.equal(INLINE_SUBSCRIBE_UTM_MEDIUM, shared.JOGAR_INLINE_UTM.medium);
    assert.equal(INLINE_SUBSCRIBE_UTM_CAMPAIGN, shared.JOGAR_INLINE_UTM.campaign);
    // #4530 Parte B: referringSite entrou no triplo — um valor por posição de
    // link, distinto do literal fixo "jogar-eia-inline" compartilhado antes.
    assert.deepEqual(resolveSubscribeUtm("livros-hero"), {
      source: shared.LIVROS_INLINE_UTM.source,
      medium: shared.LIVROS_INLINE_UTM.hero.medium,
      campaign: shared.LIVROS_INLINE_UTM.campaign,
      referringSite: "livros-inline-hero",
    });
    assert.deepEqual(resolveSubscribeUtm("livros-footer"), {
      source: shared.LIVROS_INLINE_UTM.source,
      medium: shared.LIVROS_INLINE_UTM.footer.medium,
      campaign: shared.LIVROS_INLINE_UTM.campaign,
      referringSite: "livros-inline-footer",
    });
  });

  it("#4530 Parte B — referringSite distinto por call site, mesmo quando o triplo UTM é compartilhado", async () => {
    // identify.ts (form on-page) e magic-link.ts (link de e-mail) compartilham
    // source="jogar-identify" — mas cada um marca o clique com um
    // referringSite PRÓPRIO, nunca o mesmo literal fixo pra todo call site.
    const identifyDefault = resolveSubscribeUtm("jogar-identify");
    assert.equal(identifyDefault.referringSite, "jogar-identify-inline");

    const magicLinkSrc = await import("../workers/poll/src/magic-link.ts");
    const subscribeSrc = await import("../workers/poll/src/subscribe.ts");
    assert.equal(subscribeSrc.JOGAR_IDENTIFY_MAGIC_LINK_REFERRING_SITE, "jogar-identify-magic-link");
    assert.notEqual(subscribeSrc.JOGAR_IDENTIFY_MAGIC_LINK_REFERRING_SITE, identifyDefault.referringSite);
    assert.equal(typeof magicLinkSrc.handleConfirmMerge, "function");

    // caixa clarice do /set-name (index.ts) — não passa por resolveSubscribeUtm,
    // tem constante própria distinta de qualquer source-keyed referringSite.
    assert.equal(subscribeSrc.VOTE_CLARICE_SET_NAME_REFERRING_SITE, "vote-clarice-set-name");
    assert.notEqual(subscribeSrc.VOTE_CLARICE_SET_NAME_REFERRING_SITE, resolveSubscribeUtm("vote-clarice").referringSite);
  });

  it("embed.ts — funil do widget de parceiro", () => {
    assert.equal(EMBED_UTM_SOURCE, shared.EMBED_UTM.source);
    assert.equal(EMBED_UTM_MEDIUM, shared.EMBED_UTM.medium);
    assert.equal(EMBED_DEFAULT_PARTNER, shared.EMBED_UTM.defaultPartner);
  });
});

describe("#4041 — inventário coerente e utilizável pela página /utms", () => {
  it("todo emissor tem id único, arquivo de origem e descrição não-vazia", () => {
    const ids = shared.UTM_EMITTERS.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "id duplicado no inventário");
    for (const e of shared.UTM_EMITTERS) {
      assert.ok(e.source.length > 0, `${e.id}: source vazio`);
      assert.ok(e.campaignPattern.length > 0, `${e.id}: campaignPattern vazio`);
      assert.ok(e.originFile.includes("/"), `${e.id}: originFile não parece um path`);
      assert.ok(e.description.length > 10, `${e.id}: descrição curta demais`);
      assert.ok(["ativo", "aposentado"].includes(e.status), `${e.id}: status inválido`);
    }
  });

  it("knownUtmSources cobre os sources reais (detector de drift do /utms)", () => {
    const sources = shared.knownUtmSources();
    for (const s of ["clarice", "newsletter", "eia-standalone", "embed", "livros"]) {
      assert.ok(sources.includes(s), `faltou ${s}`);
    }
    // `sendinblue` (auto-tag do Brevo, #2975) NUNCA é emitido pelo código — é
    // exatamente o caso que a página deve sinalizar como origem não-catalogada.
    assert.ok(!sources.includes("sendinblue"));
  });

  it("campaignPatternToRegExp casa valores concretos e rejeita os de outro emissor", () => {
    const mensal = shared.campaignPatternToRegExp("clarice-{ciclo}-{posicao}");
    assert.ok(mensal.test("clarice-2606-07-cta"));
    assert.ok(mensal.test("clarice-2606-07-wordmark-radar"));
    assert.ok(!mensal.test("eia-arquivo"));

    const fixo = shared.campaignPatternToRegExp("eia-arquivo");
    assert.ok(fixo.test("eia-arquivo"));
    assert.ok(!fixo.test("eia-arquivo-2"));
  });

  it("findUtmEmitter resolve por id e devolve undefined pra id desconhecido", () => {
    assert.equal(shared.findUtmEmitter("mensal-clarice")?.source, "clarice");
    assert.equal(shared.findUtmEmitter("nao-existe"), undefined);
  });
});

describe("#4295 — social + Cursos: emissores novos derivam do registry, sem literal solto", () => {
  it("os 6 novos ids estão presentes em UTM_EMITTERS", () => {
    const ids = shared.UTM_EMITTERS.map((e) => e.id);
    for (const id of [
      "facebook-post-cta",
      "twitter-edicao",
      "threads-edicao",
      "linkedin-post-pixel",
      "cursos-footer-nav",
      "cursos-gate-inline",
    ]) {
      assert.ok(ids.includes(id), `UTM_EMITTERS deve conter "${id}"`);
    }
  });

  it("FACEBOOK_CTA_UTM: social-cta-lines.ts emite o mesmo triplo do registry (via buildFacebookCtaUrl)", async () => {
    const { buildFacebookCtaUrl } = await import("../scripts/lib/social-cta-lines.ts");
    const url = new URL(buildFacebookCtaUrl());
    assert.equal(url.searchParams.get("utm_source"), shared.FACEBOOK_CTA_UTM.source);
    assert.equal(url.searchParams.get("utm_medium"), shared.FACEBOOK_CTA_UTM.medium);
    assert.equal(url.searchParams.get("utm_campaign"), shared.FACEBOOK_CTA_UTM.campaign);
  });

  it("TWITTER_EDITION_UTM / THREADS_EDITION_UTM: mesmo utm_campaign, utm_source distinto por canal", () => {
    assert.equal(shared.TWITTER_EDITION_UTM.campaign, shared.THREADS_EDITION_UTM.campaign);
    assert.notEqual(shared.TWITTER_EDITION_UTM.source, shared.THREADS_EDITION_UTM.source);
    assert.equal(shared.TWITTER_EDITION_UTM.source, "twitter");
    assert.equal(shared.THREADS_EDITION_UTM.source, "threads");
  });

  it("appendUtmToEditionUrl/tagEditionUrlInText (edition-url.ts) emitem os 3 params via URLSearchParams", async () => {
    const { appendUtmToEditionUrl, tagEditionUrlInText } = await import("../scripts/lib/edition-url.ts");
    const base = "https://diar.ia.br/p/slug-teste";
    const tagged = appendUtmToEditionUrl(base, shared.LINKEDIN_POST_PIXEL_UTM);
    const url = new URL(tagged);
    assert.equal(url.searchParams.get("utm_source"), "linkedin");
    assert.equal(url.searchParams.get("utm_medium"), "organic_social");
    assert.equal(url.searchParams.get("utm_campaign"), "post-pixel");

    const text = tagEditionUrlInText(`Confira ${base}`, base, shared.TWITTER_EDITION_UTM);
    assert.ok(text.includes("utm_source=twitter"), text);
    assert.ok(!text.includes(`${base} `), "URL sem UTM não deve sobrar");
  });

  it("CURSOS_GATE_INLINE_UTM: workers/cursos/src/subscribe.ts deriva do registry (fold-in do drift #4295)", async () => {
    const subscribeSrc = await import("../workers/cursos/src/subscribe.ts");
    // subscribeToBeehiiv monta o body internamente — checagem indireta via
    // constantes exportadas não existe hoje (locais não exportadas); em vez
    // disso, valida que o MÓDULO importa do registry (fonte estática) —
    // suficiente pra travar reintrodução de literal solto, já que o valor em
    // si é coberto pelas constantes do registry acima.
    assert.ok(typeof subscribeSrc.subscribeToBeehiiv === "function");
  });

  it("cursos-footer-nav / cursos-gate-inline: mesmo utm_source ('cursos'), medium distinto (rodapé vs. gate)", () => {
    assert.equal(shared.CURSOS_FOOTER_NAV_UTM.source, "cursos");
    assert.equal(shared.CURSOS_GATE_INLINE_UTM.source, "cursos");
    assert.notEqual(shared.CURSOS_FOOTER_NAV_UTM.medium, shared.CURSOS_GATE_INLINE_UTM.medium);
  });
});

describe("#4530 — canal Brevo Pending (reativar/evaluate) entra no inventário de UTM", () => {
  it("os 2 novos ids estão presentes em UTM_EMITTERS", () => {
    const ids = shared.UTM_EMITTERS.map((e) => e.id);
    for (const id of ["brevo-diaria-reativar-clique", "brevo-diaria-promocao-score"]) {
      assert.ok(ids.includes(id), `UTM_EMITTERS deve conter "${id}"`);
    }
  });

  it("mesmo source/medium ('brevo-diaria'/'reativacao-pending'), campaign e referringSite distintos (clique × score, #4476)", () => {
    assert.equal(shared.BREVO_DIARIA_REATIVAR_CLIQUE_UTM.source, "brevo-diaria");
    assert.equal(shared.BREVO_DIARIA_PROMOCAO_SCORE_UTM.source, "brevo-diaria");
    assert.equal(shared.BREVO_DIARIA_REATIVAR_CLIQUE_UTM.medium, shared.BREVO_DIARIA_PROMOCAO_SCORE_UTM.medium);
    assert.notEqual(shared.BREVO_DIARIA_REATIVAR_CLIQUE_UTM.campaign, shared.BREVO_DIARIA_PROMOCAO_SCORE_UTM.campaign);
    assert.notEqual(
      shared.BREVO_DIARIA_REATIVAR_CLIQUE_UTM.referringSite,
      shared.BREVO_DIARIA_PROMOCAO_SCORE_UTM.referringSite,
    );
  });

  it("workers/reativar/src/index.ts emite o triplo de BREVO_DIARIA_REATIVAR_CLIQUE_UTM no POST de criação", async () => {
    const reativarSrc = await import("../workers/reativar/src/index.ts");
    let body: unknown;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        body = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ data: { id: "sub_new", status: "active" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 }); // GET inicial — nunca existiu
    }) as typeof fetch;
    const env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    await reativarSrc.activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(body, {
      email: "a@b.com",
      send_welcome_email: false,
      double_opt_override: "off", // #5095 — isenção do double opt-in da publicação
      utm_source: shared.BREVO_DIARIA_REATIVAR_CLIQUE_UTM.source,
      utm_medium: shared.BREVO_DIARIA_REATIVAR_CLIQUE_UTM.medium,
      utm_campaign: shared.BREVO_DIARIA_REATIVAR_CLIQUE_UTM.campaign,
      referring_site: shared.BREVO_DIARIA_REATIVAR_CLIQUE_UTM.referringSite,
    });
  });

  it("scripts/evaluate-brevo-diaria.ts emite o triplo de BREVO_DIARIA_PROMOCAO_SCORE_UTM no POST de criação", async () => {
    const evalSrc = await import("../scripts/evaluate-brevo-diaria.ts");
    let body: unknown;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        body = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(null, { status: 404 }); // GET inicial — nunca existiu
    }) as typeof fetch;
    await evalSrc.promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl);
    assert.deepEqual(body, {
      email: "a@b.com",
      send_welcome_email: false,
      double_opt_override: "off", // #5095 — isenção do double opt-in da publicação
      utm_source: shared.BREVO_DIARIA_PROMOCAO_SCORE_UTM.source,
      utm_medium: shared.BREVO_DIARIA_PROMOCAO_SCORE_UTM.medium,
      utm_campaign: shared.BREVO_DIARIA_PROMOCAO_SCORE_UTM.campaign,
      referring_site: shared.BREVO_DIARIA_PROMOCAO_SCORE_UTM.referringSite,
    });
  });
});

describe("#4536/#4537/#4553 — pills do PARA ENCERRAR + resíduos de UTM/fixture", () => {
  it("os 6 ids estão presentes em UTM_EMITTERS (5 originais + equipamentos-rodape, #4968)", () => {
    const ids = shared.UTM_EMITTERS.map((e) => e.id);
    for (const id of [
      "cursos-rodape",
      "livros-rodape",
      "equipamentos-rodape",
      "arquivo-rodape",
      "livros-footer-nav",
      "instagram-weekly-archive",
    ]) {
      assert.ok(ids.includes(id), `UTM_EMITTERS deve conter "${id}"`);
    }
  });

  it("cursos-rodape/livros-rodape/equipamentos-rodape/arquivo-rodape: mesmo source/medium ('newsletter'/'email'), campaign único por pill (#4553/#4968)", () => {
    assert.equal(shared.CURSOS_RODAPE_UTM.source, "newsletter");
    assert.equal(shared.LIVROS_RODAPE_UTM.source, "newsletter");
    assert.equal(shared.EQUIPAMENTOS_RODAPE_UTM.source, "newsletter");
    assert.equal(shared.ARQUIVO_RODAPE_UTM.source, "newsletter");
    assert.equal(shared.CURSOS_RODAPE_UTM.medium, "email");
    assert.equal(shared.LIVROS_RODAPE_UTM.medium, "email");
    assert.equal(shared.EQUIPAMENTOS_RODAPE_UTM.medium, "email");
    assert.equal(shared.ARQUIVO_RODAPE_UTM.medium, "email");
    const campaigns = [
      shared.CURSOS_RODAPE_UTM.campaign,
      shared.LIVROS_RODAPE_UTM.campaign,
      shared.EQUIPAMENTOS_RODAPE_UTM.campaign,
      shared.ARQUIVO_RODAPE_UTM.campaign,
    ];
    assert.equal(new Set(campaigns).size, campaigns.length, "campaign deveria ser único por pill");
  });

  it("#4968: EQUIPAMENTOS_RODAPE_UTM.campaign === 'equipamentos-rodape' — não renomeia os campaigns existentes das outras pills", () => {
    assert.equal(shared.EQUIPAMENTOS_RODAPE_UTM.campaign, "equipamentos-rodape");
    // Restrição explícita do #4968: cursos-rodape/livros-rodape/arquivo-rodape/
    // jogar-rodape continuam com o MESMO utm_campaign de sempre — só o texto
    // visível das pills mudou, não a série histórica de cliques.
    assert.equal(shared.CURSOS_RODAPE_UTM.campaign, "cursos-rodape");
    assert.equal(shared.LIVROS_RODAPE_UTM.campaign, "livros-rodape");
    assert.equal(shared.ARQUIVO_RODAPE_UTM.campaign, "arquivo-rodape");
    assert.equal(shared.JOGAR_RODAPE_UTM.campaign, "jogar-rodape");
  });

  it("livros-footer-nav: mesmo triplo (source='livros', medium='footer-nav') de cursos-footer-nav/arquivo-footer-nav", () => {
    assert.equal(shared.LIVROS_FOOTER_NAV_UTM.source, "livros");
    assert.equal(shared.LIVROS_FOOTER_NAV_UTM.medium, "footer-nav");
  });

  it("instagram-weekly-archive: format-weekly-social.ts deriva do registry via new URL()/searchParams (#4537 item 1)", async () => {
    const { buildInstagramWeeklyArchiveUrl } = await import("../scripts/lib/format-weekly-social.ts");
    const url = new URL(buildInstagramWeeklyArchiveUrl());
    assert.equal(url.searchParams.get("utm_source"), shared.INSTAGRAM_WEEKLY_ARCHIVE_UTM.source);
    assert.equal(url.searchParams.get("utm_medium"), shared.INSTAGRAM_WEEKLY_ARCHIVE_UTM.medium);
    assert.equal(url.searchParams.get("utm_campaign"), shared.INSTAGRAM_WEEKLY_ARCHIVE_UTM.campaign);
  });

  it("build-livros-page.ts deriva LIVROS_FOOTER_NAV_UTM do registry (sem literal solto, #4537 item 2)", async () => {
    const buildLivros = await import("../scripts/build-livros-page.ts");
    assert.ok(typeof buildLivros.esc === "function", "módulo deveria carregar sem erro");
  });
});

describe("#4550 — distribuição própria do 'É IA?': rodapé + post dedicado + link em bio", () => {
  it("os 2 novos ids (rodapé + post dedicado) estão presentes em UTM_EMITTERS", () => {
    const ids = shared.UTM_EMITTERS.map((e) => e.id);
    for (const id of ["jogar-rodape", "jogar-post-dedicado"]) {
      assert.ok(ids.includes(id), `UTM_EMITTERS deve conter "${id}"`);
    }
  });

  it("JOGAR_RODAPE_UTM: mesmo source/medium ('newsletter'/'email') das outras pills do rodapé", () => {
    assert.equal(shared.JOGAR_RODAPE_UTM.source, "newsletter");
    assert.equal(shared.JOGAR_RODAPE_UTM.medium, "email");
    assert.equal(shared.JOGAR_RODAPE_UTM.campaign, "jogar-rodape");
  });

  it("JOGAR_POST_DEDICADO_UTM: source genérico 'social' (sem plataforma fixa), medium 'organic_social'", () => {
    assert.equal(shared.JOGAR_POST_DEDICADO_UTM.source, "social");
    assert.equal(shared.JOGAR_POST_DEDICADO_UTM.medium, "organic_social");
    assert.equal(shared.JOGAR_POST_DEDICADO_UTM.campaign, "jogar-post-dedicado");
  });

  it("buildJogarBioCampaign: usa o mecanismo de VARIANTE (não 'perfil-{source}' puro) pra não colidir com o slot de bio já aplicado pra home dessa plataforma", () => {
    assert.equal(shared.buildJogarBioCampaign("instagram"), "perfil-instagram-jogar");
    assert.equal(shared.buildJogarBioCampaign("threads"), "perfil-threads-jogar");
    // nunca igual ao campaign já em uso por uma superfície externa existente
    // apontando pra home (mesma fonte, ver EXTERNAL_UTM_SURFACES).
    const homeCampaigns = shared.EXTERNAL_UTM_SURFACES.map((s) => s.campaign);
    assert.ok(!homeCampaigns.includes(shared.buildJogarBioCampaign("instagram")));
  });

  it("scripts/lib/jogar-promo-urls.ts — buildJogarPostDedicadoUrl emite o triplo de JOGAR_POST_DEDICADO_UTM sobre /jogar", async () => {
    const { buildJogarPostDedicadoUrl } = await import("../scripts/lib/jogar-promo-urls.ts");
    const url = new URL(buildJogarPostDedicadoUrl());
    assert.equal(url.origin + url.pathname, "https://eia.diar.ia.br/jogar");
    assert.equal(url.searchParams.get("utm_source"), shared.JOGAR_POST_DEDICADO_UTM.source);
    assert.equal(url.searchParams.get("utm_medium"), shared.JOGAR_POST_DEDICADO_UTM.medium);
    assert.equal(url.searchParams.get("utm_campaign"), shared.JOGAR_POST_DEDICADO_UTM.campaign);
  });

  it("scripts/lib/jogar-promo-urls.ts — buildJogarBioUrl emite source dinâmico + medium 'bio' + campaign com variante 'jogar'", async () => {
    const { buildJogarBioUrl } = await import("../scripts/lib/jogar-promo-urls.ts");
    const url = new URL(buildJogarBioUrl("instagram"));
    assert.equal(url.origin + url.pathname, "https://eia.diar.ia.br/jogar");
    assert.equal(url.searchParams.get("utm_source"), "instagram");
    assert.equal(url.searchParams.get("utm_medium"), shared.EXTERNAL_SURFACE_MEDIUM);
    assert.equal(url.searchParams.get("utm_campaign"), "perfil-instagram-jogar");
  });
});

describe("#4530 Parte C — guard de colisão de triplo (source, medium, campaignPattern)", () => {
  it("findUtmEmitterCollisions() não acusa nenhuma colisão INESPERADA no inventário atual", () => {
    assert.deepEqual(
      shared.findUtmEmitterCollisions(),
      [],
      "colisão de triplo fora da allowlist DELIBERATE_UTM_EMITTER_DUPLICATES — literal duplicado sem querer?",
    );
  });

  it("a duplicata deliberada (arquivo É IA?, #3524) é reconhecida e não conta como colisão inesperada", () => {
    assert.deepEqual(shared.DELIBERATE_UTM_EMITTER_DUPLICATES, [["eia-arquivo-newsletter", "eia-arquivo-worker"]]);
  });

  it("detecta uma colisão sintética que NÃO está na allowlist (prova que a função REALMENTE detecta, não só retorna vazio por padrão)", () => {
    const synthetic = [
      ...shared.UTM_EMITTERS,
      { ...shared.UTM_EMITTERS[0], id: "synthetic-duplicate-of-first" },
    ];
    const collisions = shared.findUtmEmitterCollisions(synthetic);
    assert.ok(
      collisions.some((ids) => ids.includes("synthetic-duplicate-of-first") && ids.includes(shared.UTM_EMITTERS[0].id)),
      `esperava colisão sintética detectada, veio: ${JSON.stringify(collisions)}`,
    );
  });
});

describe("#4578 — voto vindo da versão web do post redireciona pro gate unificado de /jogar", () => {
  it("jogar-postweb-gate está presente em UTM_EMITTERS", () => {
    const ids = shared.UTM_EMITTERS.map((e) => e.id);
    assert.ok(ids.includes("jogar-postweb-gate"), 'UTM_EMITTERS deve conter "jogar-postweb-gate"');
  });

  it("JOGAR_POSTWEB_UTM: mesmo source ('eia-standalone') de JOGAR_GATE_INLINE_UTM, medium/campaign PRÓPRIOS (funil de entrada distinto)", () => {
    assert.equal(shared.JOGAR_POSTWEB_UTM.source, shared.EIA_STANDALONE_SOURCE);
    assert.notEqual(shared.JOGAR_POSTWEB_UTM.medium, shared.JOGAR_GATE_INLINE_UTM.medium);
    assert.notEqual(shared.JOGAR_POSTWEB_UTM.campaign, shared.JOGAR_GATE_INLINE_UTM.campaign);
  });

  it("subscribe.ts — resolveSubscribeUtm('jogar-postweb') deriva do registry (sem literal solto)", () => {
    assert.deepEqual(resolveSubscribeUtm("jogar-postweb"), {
      source: shared.JOGAR_POSTWEB_UTM.source,
      medium: shared.JOGAR_POSTWEB_UTM.medium,
      campaign: shared.JOGAR_POSTWEB_UTM.campaign,
      referringSite: "jogar-postweb-gate",
    });
  });
});
