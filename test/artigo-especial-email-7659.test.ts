/**
 * test/artigo-especial-email-7659.test.ts (#7659)
 *
 * Trava o canal `email` do Artigo Especial — o envio pros apoiadores R$10+.
 *
 * Os casos que justificam densidade aqui são os dois modos de falha caros do
 * domínio: (1) mandar conteúdo de apoiador pra base INTEIRA (um
 * `subscriber_filter` ausente no Kit significa exatamente isso, #6126), e (2)
 * a audiência do e-mail divergir do gate da web sobre quem tem direito ao
 * artigo — a mesma classe de erro que a #7658 corrigiu do outro lado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";

import {
  renderArtigoEspecialEmail,
  chamadaParagraphs,
  withArtigoEspecialEmailUtm,
  buildArtigoEspecialEmailSubject,
} from "../scripts/lib/artigo-especial-email-render.ts";
import {
  ARTIGO_ESPECIAL_EMAIL_UTM_SOURCE,
  buildArtigoEspecialEmailCampaign,
} from "../scripts/lib/shared/utm-registry.ts";
import {
  ARTIGO_ESPECIAL_EMAIL_NIVEIS,
  resolveArtigoEspecialTagName,
} from "../scripts/lib/artigo-especial-kit-channel.ts";
import { ARTIGOS_ESPECIAIS_APOIO_THRESHOLD } from "../workers/artigos/src/apoio-gate-config.ts";
import { ARTIGO_ESPECIAL_CHANNELS } from "../scripts/lib/artigo-especial-state.ts";
import { buildTagFilter } from "../scripts/lib/kit-broadcasts.ts";
import {
  buildArtigoEspecialKitBroadcastInput,
  verifyAudienceFilter,
  readEmailPublished,
  emailPublishedPath,
  runPublishArtigoEspecialKit,
  toPersistedVerification,
  type ArtigoEspecialKitDeps,
} from "../scripts/publish-artigo-especial-kit.ts";
import {
  ArtigoEspecialKitGuardError,
  readPlatformConfig,
} from "../scripts/lib/artigo-especial-kit-channel.ts";
import type { ResolvedAudience } from "../scripts/lib/shared/kit-apoio-tag.ts";
import type { ArtigoEspecialMeta } from "../scripts/lib/artigo-especial-meta.ts";

const META: ArtigoEspecialMeta = {
  title: "O agente | diar.ia.br",
  description: "O que muda quando o software passa a agir sozinho.",
  url: "https://especial.diar.ia.br/2026/o-agente/",
  image: "https://especial.diar.ia.br/2026/o-agente/capa.jpg",
  datePublished: "2026-09-01",
  dateModified: null,
  h1: "O agente",
  leadParagraphs: ["lede"],
};

const CHAMADA = "Primeiro parágrafo da chamada.\n\nSegundo parágrafo.\n\nhttps://especial.diar.ia.br/2026/o-agente/\n";

describe("#7659 — a audiência do e-mail é a MESMA do gate da web", () => {
  it("ARTIGO_ESPECIAL_EMAIL_NIVEIS é literalmente ARTIGOS_ESPECIAIS_APOIO_THRESHOLD", () => {
    // Não `deepEqual`: é a MESMA referência de propósito. Se alguém trocar por
    // uma cópia, esta asserção quebra e força a pergunta "por que duas listas?"
    // — que é o começo do e-mail e a web discordarem sobre quem paga por quê.
    assert.equal(ARTIGO_ESPECIAL_EMAIL_NIVEIS, ARTIGOS_ESPECIAIS_APOIO_THRESHOLD);
  });

  it("são os 3 níveis de R$10+ — `amigo` (R$5-10) fica de fora", () => {
    assert.deepEqual([...ARTIGO_ESPECIAL_EMAIL_NIVEIS], ["apoiador", "mantenedor", "patrono"]);
  });
});

describe("#7659 — tag de audiência: ausente/vazia é ERRO, nunca default", () => {
  for (const config of [undefined, null, {}, { audience_tag: "" }, { audience_tag: "   " }]) {
    it(`config ${JSON.stringify(config)} → não resolve`, () => {
      const r = resolveArtigoEspecialTagName(config);
      assert.equal(r.ok, false);
      // A mensagem tem que dizer POR QUE recusar é o caminho seguro — sem
      // isso, o próximo a ler pensa em "colocar um default".
      assert.match(r.ok === false ? r.reason : "", /BASE INTEIRA/);
    });
  }

  it("nome válido resolve com trim", () => {
    const r = resolveArtigoEspecialTagName({ audience_tag: "  apoio-especial " });
    assert.deepEqual(r, { ok: true, tagName: "apoio-especial" });
  });
});

describe("#7659 — chamadaParagraphs: a URL crua sai, o texto fica", () => {
  it("descarta o parágrafo que é só a URL (o botão já leva pra lá)", () => {
    assert.deepEqual(chamadaParagraphs(CHAMADA), ["Primeiro parágrafo da chamada.", "Segundo parágrafo."]);
  });

  it("descarta URL entre < > (formato que alguns geradores produzem)", () => {
    assert.deepEqual(chamadaParagraphs("Texto.\n\n<https://x.com/a>"), ["Texto."]);
  });

  it("NÃO descarta parágrafo que só CONTÉM uma URL junto de texto", () => {
    const p = chamadaParagraphs("Leia em https://x.com/a e conte pra gente.");
    assert.deepEqual(p, ["Leia em https://x.com/a e conte pra gente."]);
  });

  it("junta quebras simples dentro do mesmo parágrafo", () => {
    assert.deepEqual(chamadaParagraphs("uma\nlinha só"), ["uma linha só"]);
  });

  it("texto vazio → nenhum parágrafo", () => {
    assert.deepEqual(chamadaParagraphs("   \n\n  "), []);
  });
});

describe("#7659 — UTM do link do artigo", () => {
  it("acrescenta source/medium/campaign", () => {
    const href = withArtigoEspecialEmailUtm(META.url, "2026", "o-agente");
    const u = new URL(href);
    assert.equal(u.searchParams.get("utm_source"), ARTIGO_ESPECIAL_EMAIL_UTM_SOURCE);
    assert.equal(u.searchParams.get("utm_medium"), "email");
    assert.equal(u.searchParams.get("utm_campaign"), buildArtigoEspecialEmailCampaign("2026", "o-agente"));
  });

  it("preserva query e fragment que já existam", () => {
    const u = new URL(withArtigoEspecialEmailUtm("https://x.com/a?ref=1#sec", "2026", "o-agente"));
    assert.equal(u.searchParams.get("ref"), "1");
    assert.equal(u.hash, "#sec");
  });

  it("URL inválida volta INALTERADA — e-mail sem UTM é melhor que e-mail que não sai", () => {
    assert.equal(withArtigoEspecialEmailUtm("não é url", "2026", "o-agente"), "não é url");
  });
});

describe("#7659 — render do e-mail", () => {
  const email = renderArtigoEspecialEmail({
    title: META.h1,
    description: META.description,
    url: META.url,
    image: META.image,
    chamadaMarkdown: CHAMADA,
    ano: "2026",
    slug: "o-agente",
  });

  it("assunto diz o que é — o título sozinho não explica por que o e-mail chegou", () => {
    assert.equal(email.subject, "Artigo Especial: O agente");
    assert.equal(buildArtigoEspecialEmailSubject("  X  "), "Artigo Especial: X");
  });

  it("preview text é a description do artigo", () => {
    assert.equal(email.previewText, META.description);
  });

  it("os 2 parágrafos da chamada estão no corpo, a URL crua não", () => {
    assert.match(email.html, /Primeiro parágrafo da chamada\./);
    assert.match(email.html, /Segundo parágrafo\./);
    // A URL aparece só em ATRIBUTOS (href do botão, src da capa) — nunca como
    // texto solto, que é o que o descarte do parágrafo-URL evita. Casar por
    // `>https://` pega justamente a URL renderizada como conteúdo.
    assert.doesNotMatch(email.html, />\s*https?:\/\//);
  });

  it("o botão aponta pro artigo COM utm", () => {
    const m = email.html.match(/href="([^"]+)"/);
    assert.ok(m, "e-mail sem link nenhum");
    assert.match(m![1], new RegExp(`utm_source=${ARTIGO_ESPECIAL_EMAIL_UTM_SOURCE}`));
  });

  it("usa paperEmail (#FFFFFF), nunca o creme da web", () => {
    assert.match(email.html, /background:#FFFFFF/);
    assert.doesNotMatch(email.html, /#FBFAF6/);
  });

  it("sem <style> no head — tudo inline (Gmail descarta parte do head)", () => {
    assert.doesNotMatch(email.html, /<style/i);
  });

  it("capa ausente NÃO quebra o e-mail", () => {
    const semCapa = renderArtigoEspecialEmail({
      title: META.h1,
      description: META.description,
      url: META.url,
      image: null,
      chamadaMarkdown: CHAMADA,
      ano: "2026",
      slug: "o-agente",
    });
    assert.doesNotMatch(semCapa.html, /<img/);
    assert.match(semCapa.html, /Primeiro parágrafo da chamada\./);
  });

  it("escapa HTML do texto autoral (título e parágrafos)", () => {
    const r = renderArtigoEspecialEmail({
      title: "<script>x</script>",
      description: 'aspas " e & ',
      url: META.url,
      image: null,
      chamadaMarkdown: "5 < 6 & 7 > 3",
      ano: "2026",
      slug: "s",
    });
    assert.doesNotMatch(r.html, /<script>/);
    assert.match(r.html, /5 &lt; 6 &amp; 7 &gt; 3/);
  });

  it("chamada sem nenhum parágrafo LANÇA — melhor erro que e-mail oco", () => {
    assert.throws(
      () =>
        renderArtigoEspecialEmail({
          title: META.h1,
          description: META.description,
          url: META.url,
          image: null,
          chamadaMarkdown: "https://especial.diar.ia.br/2026/o-agente/",
          ano: "2026",
          slug: "o-agente",
        }),
      /nenhum parágrafo de chamada/,
    );
  });

  it("cabe folgado abaixo do corte de ~102KB do Gmail", () => {
    assert.ok(email.html.length < 20_000, `HTML grande demais: ${email.html.length} bytes`);
  });
});

describe("#7659 — payload do broadcast", () => {
  const email = renderArtigoEspecialEmail({
    title: META.h1,
    description: META.description,
    url: META.url,
    image: META.image,
    chamadaMarkdown: CHAMADA,
    ano: "2026",
    slug: "o-agente",
  });
  const audience = { tagName: "apoio-especial", tagId: 42, memberCount: 5 } as unknown as ResolvedAudience;
  const input = buildArtigoEspecialKitBroadcastInput(email, "2026", "o-agente", audience);

  it("SEMPRE rascunho — send_at null, nunca agendamento automático", () => {
    assert.equal(input.send_at, null);
  });

  it("SEMPRE com subscriber_filter de tag — filtro ausente = base inteira (#6126)", () => {
    assert.deepEqual(input.subscriber_filter, buildTagFilter(42));
  });

  it("public: false — não cria uma 2ª URL canônica competindo com o artigo", () => {
    assert.equal(input.public, false);
  });

  it("description interna identifica o artigo (o Kit não tem campo de nome)", () => {
    assert.match(input.description!, /2026\/o-agente/);
  });
});

describe("#7659 — verifyAudienceFilter: 2xx não é prova", () => {
  const expected = buildTagFilter(7);

  it("eco idêntico → verified true", () => {
    assert.deepEqual(verifyAudienceFilter(buildTagFilter(7), expected), { verified: true });
  });

  it("eco DIFERENTE → verified false (incidente, não aviso)", () => {
    const r = verifyAudienceFilter(buildTagFilter(8), expected);
    assert.equal(r.verified, false);
  });

  it("campo ausente → verified null, nunca true", () => {
    // A distinção importa: registrar null como true seria afirmar uma
    // verificação que não aconteceu.
    const r = verifyAudienceFilter(undefined, expected);
    assert.equal(r.verified, null);
  });
});

describe("#7659 — o canal `email` existe no state file", () => {
  it("ARTIGO_ESPECIAL_CHANNELS inclui email (senão mark-artigo-especial-channel o rejeita)", () => {
    assert.ok((ARTIGO_ESPECIAL_CHANNELS as readonly string[]).includes("email"));
  });
});

describe("#7659 — readEmailPublished é fail-soft, mas nunca silencioso", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "ae-email-"));

  it("arquivo ausente → null", () => {
    assert.equal(readEmailPublished(resolve(dir, "nao-existe.json")), null);
  });

  it("JSON corrompido → null (não lança)", () => {
    const p = resolve(dir, "corrompido.json");
    writeFileSync(p, "{{{", "utf8");
    assert.equal(readEmailPublished(p), null);
  });

  it("sem broadcastId numérico → null (o guard perderia o sentido com um id fake)", () => {
    const p = resolve(dir, "sem-id.json");
    writeFileSync(p, JSON.stringify({ ano: "2026", slug: "x" }), "utf8");
    assert.equal(readEmailPublished(p), null);
  });

  it("arquivo válido → objeto", () => {
    const p = resolve(dir, "ok.json");
    writeFileSync(p, JSON.stringify({ ano: "2026", slug: "x", broadcastId: 9 }), "utf8");
    assert.equal(readEmailPublished(p)?.broadcastId, 9);
  });
});

// ── runPublishArtigoEspecialKit, com deps injetadas ───────────────────────

function makeFixture(): { rootDir: string; dataDir: string } {
  // `runPublishArtigoEspecialKit` resolve a credencial do ambiente (só fora de
  // --dry-run). Mesma abordagem de `test/publish-monthly-apoiadores-kit.test.ts`:
  // uma key falsa basta, porque toda chamada de rede é injetada por `deps`.
  process.env.KIT_API_KEY = "fake_key_7659";
  const rootDir = mkdtempSync(resolve(tmpdir(), "ae-run-"));
  const dataDir = resolve(rootDir, "data");
  mkdirSync(resolve(dataDir, "artigo-especial", "2026-o-agente"), { recursive: true });
  writeFileSync(resolve(dataDir, "artigo-especial", "2026-o-agente", "email.md"), CHAMADA, "utf8");
  writeFileSync(
    resolve(rootDir, "platform.config.json"),
    JSON.stringify({ kit_artigo_especial: { audience_tag: "apoio-especial" } }),
    "utf8",
  );
  return { rootDir, dataDir };
}

function makeDeps(over: Partial<ArtigoEspecialKitDeps> = {}): ArtigoEspecialKitDeps {
  return {
    readMeta: () => META,
    readChamada: (p) => readFileSync(p, "utf8"),
    writeJson: (p, c) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c, "utf8");
    },
    findTagId: async () => 42,
    countTagMembers: async () => 5,
    createBroadcast: async () => ({ id: 555 }),
    getBroadcast: async () => ({ subscriber_filter: buildTagFilter(42) }),
    ...over,
  };
}

const silent = () => {};

describe("#7659 — runPublishArtigoEspecialKit: guards antes de qualquer criação", () => {
  it("tag não configurada → guard, INCLUSIVE em --dry-run", async () => {
    const { rootDir, dataDir } = makeFixture();
    writeFileSync(resolve(rootDir, "platform.config.json"), JSON.stringify({}), "utf8");
    await assert.rejects(
      () =>
        runPublishArtigoEspecialKit({
          ano: "2026",
          slug: "o-agente",
          dataDir,
          rootDir,
          dryRun: true,
          force: false,
          log: silent,
          deps: makeDeps(),
        }),
      ArtigoEspecialKitGuardError,
    );
  });

  it("email.md ausente → guard (não inventa conteúdo)", async () => {
    const { rootDir, dataDir } = makeFixture();
    writeFileSync(resolve(dataDir, "artigo-especial", "2026-o-agente", "email.md"), "", "utf8");
    // arquivo existe mas vazio: o render é quem recusa — aqui removemos o
    // arquivo pra exercitar o guard de ausência.
    const semArquivo = mkdtempSync(resolve(tmpdir(), "ae-vazio-"));
    mkdirSync(resolve(semArquivo, "data"), { recursive: true });
    writeFileSync(
      resolve(semArquivo, "platform.config.json"),
      JSON.stringify({ kit_artigo_especial: { audience_tag: "t" } }),
      "utf8",
    );
    await assert.rejects(
      () =>
        runPublishArtigoEspecialKit({
          ano: "2026",
          slug: "o-agente",
          dataDir: resolve(semArquivo, "data"),
          rootDir: semArquivo,
          dryRun: true,
          force: false,
          log: silent,
          deps: makeDeps(),
        }),
      /email\.md ausente|ausente —/,
    );
  });

  it("tag não existe no Kit → guard, e a mensagem diz qual sync rodar", async () => {
    const { rootDir, dataDir } = makeFixture();
    let criou = false;
    await assert.rejects(
      () =>
        runPublishArtigoEspecialKit({
          ano: "2026",
          slug: "o-agente",
          dataDir,
          rootDir,
          dryRun: false,
          force: false,
          log: silent,
          deps: makeDeps({
            findTagId: async () => null,
            createBroadcast: async () => {
              criou = true;
              return { id: 1 };
            },
          }),
        }),
      (e: Error) => e instanceof ArtigoEspecialKitGuardError && /sync-apoio-especial-tag-kit/.test(e.message),
    );
    assert.equal(criou, false, "não pode criar broadcast com a tag não resolvida");
  });

  it("tag VAZIA → guard (rascunho que reporta sucesso e não entrega a ninguém)", async () => {
    const { rootDir, dataDir } = makeFixture();
    let criou = false;
    await assert.rejects(
      () =>
        runPublishArtigoEspecialKit({
          ano: "2026",
          slug: "o-agente",
          dataDir,
          rootDir,
          dryRun: false,
          force: false,
          log: silent,
          deps: makeDeps({
            countTagMembers: async () => 0,
            createBroadcast: async () => {
              criou = true;
              return { id: 1 };
            },
          }),
        }),
      ArtigoEspecialKitGuardError,
    );
    assert.equal(criou, false);
  });

  it("credencial ausente → guard, sem criar nada", async () => {
    const { rootDir, dataDir } = makeFixture();
    const saved = process.env.KIT_API_KEY;
    delete process.env.KIT_API_KEY;
    let criou = false;
    try {
      await assert.rejects(
        () =>
          runPublishArtigoEspecialKit({
            ano: "2026",
            slug: "o-agente",
            dataDir,
            rootDir,
            dryRun: false,
            force: false,
            log: silent,
            deps: makeDeps({
              createBroadcast: async () => {
                criou = true;
                return { id: 1 };
              },
            }),
          }),
        ArtigoEspecialKitGuardError,
      );
    } finally {
      process.env.KIT_API_KEY = saved;
    }
    assert.equal(criou, false);
  });

  it("--dry-run NÃO exige credencial (preview local é sempre seguro)", async () => {
    const { rootDir, dataDir } = makeFixture();
    const saved = process.env.KIT_API_KEY;
    delete process.env.KIT_API_KEY;
    try {
      await runPublishArtigoEspecialKit({
        ano: "2026",
        slug: "o-agente",
        dataDir,
        rootDir,
        dryRun: true,
        force: false,
        log: silent,
        deps: makeDeps(),
      });
    } finally {
      process.env.KIT_API_KEY = saved;
    }
  });

  it("--dry-run NUNCA cria broadcast nem grava estado", async () => {
    const { rootDir, dataDir } = makeFixture();
    let criou = false;
    let gravou = false;
    await runPublishArtigoEspecialKit({
      ano: "2026",
      slug: "o-agente",
      dataDir,
      rootDir,
      dryRun: true,
      force: false,
      log: silent,
      deps: makeDeps({
        createBroadcast: async () => {
          criou = true;
          return { id: 1 };
        },
        writeJson: () => {
          gravou = true;
        },
      }),
    });
    assert.equal(criou, false);
    assert.equal(gravou, false);
  });
});

describe("#7867 item 2 — preview fixo sobrescreve o derivado do conteúdo", () => {
  it("createBroadcast recebe preview_text FIXO, não a description do artigo", async () => {
    const { rootDir, dataDir } = makeFixture();
    let previewEnviado: string | undefined;
    await runPublishArtigoEspecialKit({
      ano: "2026",
      slug: "o-agente",
      dataDir,
      rootDir,
      dryRun: false,
      force: false,
      log: silent,
      deps: makeDeps({
        createBroadcast: async (input) => {
          previewEnviado = input.preview_text ?? undefined;
          return { id: 555 };
        },
      }),
    });
    assert.equal(previewEnviado, "Exclusivo para apoiadores");
    assert.notEqual(previewEnviado, META.description, "não pode vazar o preview derivado do conteúdo");
  });
});

describe("#7659 — runPublishArtigoEspecialKit: caminho feliz e idempotência", () => {
  it("cria o rascunho e grava o detalhe + o canal no state", async () => {
    const { rootDir, dataDir } = makeFixture();
    await runPublishArtigoEspecialKit({
      ano: "2026",
      slug: "o-agente",
      dataDir,
      rootDir,
      dryRun: false,
      force: false,
      log: silent,
      deps: makeDeps(),
    });
    const detail = readEmailPublished(emailPublishedPath(dataDir, "2026", "o-agente"));
    assert.equal(detail?.broadcastId, 555);
    assert.deepEqual(detail?.audienceVerification, { status: "confirmed" });
    assert.equal(detail?.audienceMemberCount, 5);
    assert.equal(detail?.audienceTag, "apoio-especial");

    const state = JSON.parse(
      readFileSync(resolve(dataDir, "artigo-especial", "2026-o-agente", "published.json"), "utf8"),
    );
    assert.equal(state.channels.email.status, "done");
  });

  it("2ª execução sem --force NÃO cria um 2º rascunho", async () => {
    const { rootDir, dataDir } = makeFixture();
    const run = (force: boolean, onCreate: () => void) =>
      runPublishArtigoEspecialKit({
        ano: "2026",
        slug: "o-agente",
        dataDir,
        rootDir,
        dryRun: false,
        force,
        log: silent,
        deps: makeDeps({
          createBroadcast: async () => {
            onCreate();
            return { id: 555 };
          },
        }),
      });

    let criacoes = 0;
    await run(false, () => criacoes++);
    await assert.rejects(() => run(false, () => criacoes++), ArtigoEspecialKitGuardError);
    assert.equal(criacoes, 1);
  });

  it("--force cria de novo (decisão consciente, rascunho anterior fica órfão)", async () => {
    const { rootDir, dataDir } = makeFixture();
    let criacoes = 0;
    const run = (force: boolean) =>
      runPublishArtigoEspecialKit({
        ano: "2026",
        slug: "o-agente",
        dataDir,
        rootDir,
        dryRun: false,
        force,
        log: silent,
        deps: makeDeps({
          createBroadcast: async () => {
            criacoes++;
            return { id: 900 + criacoes };
          },
        }),
      });
    await run(false);
    await run(true);
    assert.equal(criacoes, 2);
  });

  it("filtro divergente na releitura → LANÇA, mas o id fica gravado antes", async () => {
    const { rootDir, dataDir } = makeFixture();
    await assert.rejects(
      () =>
        runPublishArtigoEspecialKit({
          ano: "2026",
          slug: "o-agente",
          dataDir,
          rootDir,
          dryRun: false,
          force: false,
          log: silent,
          deps: makeDeps({ getBroadcast: async () => ({ subscriber_filter: buildTagFilter(99) }) }),
        }),
      /AUDIÊNCIA NÃO CONFERE/,
    );
    // O ponto do teste: uma reexecução tem que cair no guard, não criar um 2º
    // rascunho por cima de um problema não resolvido.
    const detail = readEmailPublished(emailPublishedPath(dataDir, "2026", "o-agente"));
    assert.equal(detail?.broadcastId, 555);
    assert.equal(detail?.audienceVerification.status, "diverged");
    // A `reason` tem que sobreviver ao disco: sem ela, quem auditar depois vê
    // "divergiu" sem saber QUAL filtro veio.
    assert.match(
      detail?.audienceVerification.status === "diverged" ? detail.audienceVerification.reason : "",
      /DIVERGENTE/,
    );
  });

  it("releitura que NÃO confirma (rede falhou) também ABORTA, e o canal não vira done", async () => {
    // Mudança deliberada em relação à 1ª versão desta PR, que seguia com um
    // AVISO em stderr e exit 0. Este é o único ponto do fluxo sem gate humano
    // depois — tratar "não sei" como "confirmado" aqui era exatamente o
    // silêncio que o guard existe pra evitar.
    const { rootDir, dataDir } = makeFixture();
    let tentativas = 0;
    await assert.rejects(
      () =>
        runPublishArtigoEspecialKit({
          ano: "2026",
          slug: "o-agente",
          dataDir,
          rootDir,
          dryRun: false,
          force: false,
          log: silent,
          deps: makeDeps({
            getBroadcast: async () => {
              tentativas++;
              throw new Error("timeout");
            },
          }),
        }),
      /AUDIÊNCIA NÃO CONFIRMADA/,
    );
    // Retenta 1x antes de desistir — um timeout transitório não pode virar
    // "não sei" quando 1 chamada a mais responderia.
    assert.equal(tentativas, 2);

    const detail = readEmailPublished(emailPublishedPath(dataDir, "2026", "o-agente"));
    assert.equal(detail?.broadcastId, 555, "o id tem que ficar gravado — o rascunho existe");
    assert.equal(detail?.audienceVerification.status, "unconfirmed");

    const state = JSON.parse(
      readFileSync(resolve(dataDir, "artigo-especial", "2026-o-agente", "published.json"), "utf8"),
    );
    assert.equal(state.channels.email.status, "failed");
  });

  it("releitura que falha na 1ª e responde na 2ª → confirmado, sem abortar", async () => {
    const { rootDir, dataDir } = makeFixture();
    let tentativas = 0;
    await runPublishArtigoEspecialKit({
      ano: "2026",
      slug: "o-agente",
      dataDir,
      rootDir,
      dryRun: false,
      force: false,
      log: silent,
      deps: makeDeps({
        getBroadcast: async () => {
          tentativas++;
          if (tentativas === 1) throw new Error("timeout transitório");
          return { subscriber_filter: buildTagFilter(42) };
        },
      }),
    });
    assert.equal(readEmailPublished(emailPublishedPath(dataDir, "2026", "o-agente"))?.audienceVerification.status, "confirmed");
  });
});

describe("#7659 — falha do registro de idempotência é o 2º pior caso do domínio", () => {
  it("writeJson lançando → erro que MANDA conferir o painel antes de reexecutar", async () => {
    const { rootDir, dataDir } = makeFixture();
    await assert.rejects(
      () =>
        runPublishArtigoEspecialKit({
          ano: "2026",
          slug: "o-agente",
          dataDir,
          rootDir,
          dryRun: false,
          force: false,
          log: silent,
          deps: makeDeps({
            writeJson: () => {
              throw new Error("EACCES");
            },
          }),
        }),
      (e: Error) => /NÃO reexecute/.test(e.message) && /Drafts/.test(e.message),
    );
  });

  it("writeJson lançando E filtro divergente → a mensagem cobre os DOIS problemas", async () => {
    // O caso composto é o pior: existe um rascunho com audiência possivelmente
    // errada E o guard de duplicata não vai enxergá-lo.
    const { rootDir, dataDir } = makeFixture();
    await assert.rejects(
      () =>
        runPublishArtigoEspecialKit({
          ano: "2026",
          slug: "o-agente",
          dataDir,
          rootDir,
          dryRun: false,
          force: false,
          log: silent,
          deps: makeDeps({
            getBroadcast: async () => ({ subscriber_filter: buildTagFilter(99) }),
            writeJson: () => {
              throw new Error("EACCES");
            },
          }),
        }),
      (e: Error) => /AUDIÊNCIA NÃO CONFERE/.test(e.message) && /ADICIONALMENTE/.test(e.message),
    );
  });
});

describe("#7659 — toda falha fica registrada no status agregado", () => {
  it("guard antes de qualquer criação → canal email vira failed (como os canais irmãos)", async () => {
    const { rootDir, dataDir } = makeFixture();
    await assert.rejects(
      () =>
        runPublishArtigoEspecialKit({
          ano: "2026",
          slug: "o-agente",
          dataDir,
          rootDir,
          dryRun: false,
          force: false,
          log: silent,
          deps: makeDeps({ countTagMembers: async () => 0 }),
        }),
      ArtigoEspecialKitGuardError,
    );
    const state = JSON.parse(
      readFileSync(resolve(dataDir, "artigo-especial", "2026-o-agente", "published.json"), "utf8"),
    );
    assert.equal(state.channels.email.status, "failed");
    assert.match(state.channels.email.reason, /VAZIA/);
  });

  it("guard de \"já criado\" NÃO rebaixa um done anterior pra failed", async () => {
    // Recusar o 2º rascunho é o guard funcionando, não uma falha do canal.
    const { rootDir, dataDir } = makeFixture();
    const run = () =>
      runPublishArtigoEspecialKit({
        ano: "2026",
        slug: "o-agente",
        dataDir,
        rootDir,
        dryRun: false,
        force: false,
        log: silent,
        deps: makeDeps(),
      });
    await run();
    await assert.rejects(run, ArtigoEspecialKitGuardError);
    const state = JSON.parse(
      readFileSync(resolve(dataDir, "artigo-especial", "2026-o-agente", "published.json"), "utf8"),
    );
    assert.equal(state.channels.email.status, "done");
  });

  it("--dry-run que falha no guard NÃO escreve state nenhum", async () => {
    const { rootDir, dataDir } = makeFixture();
    writeFileSync(resolve(rootDir, "platform.config.json"), JSON.stringify({}), "utf8");
    await assert.rejects(
      () =>
        runPublishArtigoEspecialKit({
          ano: "2026",
          slug: "o-agente",
          dataDir,
          rootDir,
          dryRun: true,
          force: false,
          log: silent,
          deps: makeDeps(),
        }),
      ArtigoEspecialKitGuardError,
    );
    assert.equal(existsSync(resolve(dataDir, "artigo-especial", "2026-o-agente", "published.json")), false);
  });
});

describe("#7659 — platform.config.json malformado é GUARD, não SyntaxError cru", () => {
  it("JSON quebrado → ArtigoEspecialKitGuardError com o caminho do arquivo", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ae-cfg-"));
    writeFileSync(resolve(dir, "platform.config.json"), "{ isto não é json", "utf8");
    assert.throws(() => readPlatformConfig(dir), ArtigoEspecialKitGuardError);
  });

  it("arquivo ausente → {} (o guard de tag não configurada é quem recusa)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ae-cfg-vazio-"));
    assert.deepEqual(readPlatformConfig(dir), {});
  });
});

describe("#7659 — toPersistedVerification preserva a razão", () => {
  it("confirmed não carrega razão (não há o que explicar)", () => {
    assert.deepEqual(toPersistedVerification({ verified: true }), { status: "confirmed" });
  });

  it("diverged e unconfirmed carregam a razão — é o que sobra pra auditoria depois", () => {
    assert.deepEqual(toPersistedVerification({ verified: false, reason: "x" }), { status: "diverged", reason: "x" });
    assert.deepEqual(toPersistedVerification({ verified: null, reason: "y" }), { status: "unconfirmed", reason: "y" });
  });
});
