/**
 * test/kit-refresh-social-edition-url.test.ts (#7405)
 *
 * Cobre `scripts/kit-refresh-social-edition-url.ts` — refresh de
 * `_internal/05-edition-url.txt`/`03-social.md` no Stage 6, depois do
 * agendamento Kit confirmado (`schedule-newsletter-kit.ts`), quando o
 * `public_url` do broadcast finalmente ganha slug real. `getBroadcastPublicUrl`/
 * `readPublished`/leitura-escrita de arquivo injetados — nenhuma chamada de
 * rede/I/O real. Mesmo padrão de `test/schedule-newsletter-kit.test.ts`.
 */
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  kitRefreshSocialEditionUrl,
  hasKitSlug,
  warnUnresolvedPlaceholders,
  main,
  type KitRefreshSocialEditionUrlDeps,
} from "../scripts/kit-refresh-social-edition-url.ts";
import { writePublishedState } from "../scripts/publish-newsletter-kit.ts";

const EDITION_DIR = "/fake/root/data/editions/2609/260904";

// #7405 achado do code-reviewer: o fixture default precisa refletir o
// estado REAL de `03-social.md` no Stage 6, não o estado ingênuo
// "placeholder ainda literal". A Etapa 5 (§5c-2 de `orchestrator-stage-5.md`)
// já roda `resolve-edition-url.ts --validate-social` ANTES do Stage 6 —
// `{edition_url}` já foi substituído pelo valor que `05-edition-url.txt`
// tinha naquele momento, que pro backend Kit é o STUB sem slug. Por isso o
// fixture default simula exatamente isso: `readEditionUrlFile` default
// devolve o stub (não `null`), e `readSocialMd` default já tem o stub
// embutido no texto (não o placeholder `{edition_url}` literal).
const STUB_URL = "https://diariabr.kit.com/posts/";
const RESOLVED_URL = "https://diariabr.kit.com/posts/titulo-da-edicao";

function makeDeps(overrides: Partial<KitRefreshSocialEditionUrlDeps> = {}): KitRefreshSocialEditionUrlDeps {
  const files = new Map<string, string>();
  return {
    readPublished: overrides.readPublished ?? (() => ({ broadcast_id: 42 })),
    getBroadcastPublicUrl: overrides.getBroadcastPublicUrl ?? (async () => RESOLVED_URL),
    readEditionUrlFile: overrides.readEditionUrlFile ?? ((dir) => files.get(`${dir}:url`) ?? STUB_URL),
    writeEditionUrlFile: overrides.writeEditionUrlFile ?? ((dir, url) => files.set(`${dir}:url`, url)),
    readSocialMd:
      overrides.readSocialMd ?? ((dir) => files.get(`${dir}:social`) ?? `## d1\n\nTexto do post. Mais em ${STUB_URL} #IA\n`),
    writeSocialMd: overrides.writeSocialMd ?? ((dir, content) => files.set(`${dir}:social`, content)),
  };
}

describe("hasKitSlug (#7405)", () => {
  it("stub sem slug (com barra final) → false", () => {
    assert.equal(hasKitSlug("https://diariabr.kit.com/posts/"), false);
  });

  it("stub sem slug (sem barra final) → false", () => {
    assert.equal(hasKitSlug("https://diariabr.kit.com/posts"), false);
  });

  it("URL com slug → true", () => {
    assert.equal(hasKitSlug("https://diariabr.kit.com/posts/titulo-da-edicao"), true);
  });

  it("undefined → false", () => {
    assert.equal(hasKitSlug(undefined), false);
  });

  it("string vazia → false", () => {
    assert.equal(hasKitSlug(""), false);
  });
});

describe("kitRefreshSocialEditionUrl (#7405)", () => {
  it("draft ausente (Etapa 5 não rodou o publisher Kit) → code 3, nunca chama a API", async () => {
    let getCalled = false;
    const deps = makeDeps({
      readPublished: () => null,
      getBroadcastPublicUrl: async () => {
        getCalled = true;
        return "https://diariabr.kit.com/posts/x";
      },
    });
    const result = await kitRefreshSocialEditionUrl(EDITION_DIR, deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 3);
    assert.equal(getCalled, false);
  });

  it("readPublished lança (JSON corrompido/parcialmente escrito) → code 3 com o motivo, nunca propaga como exceção", async () => {
    const deps = makeDeps({
      readPublished: () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });
    const result = await kitRefreshSocialEditionUrl(EDITION_DIR, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 3);
      assert.match(result.reason, /Unexpected end of JSON input/);
    }
  });

  it("GET falha → code 4 com o motivo", async () => {
    const deps = makeDeps({
      getBroadcastPublicUrl: async () => {
        throw new Error("timeout");
      },
    });
    const result = await kitRefreshSocialEditionUrl(EDITION_DIR, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 4);
      assert.match(result.reason, /timeout/);
    }
  });

  it("public_url ainda sem slug (broadcast provavelmente draft) → ok, resolved: false, reason no_slug_yet — nunca escreve nada", async () => {
    let wroteUrl = false;
    let wroteSocial = false;
    const deps = makeDeps({
      getBroadcastPublicUrl: async () => "https://diariabr.kit.com/posts/",
      writeEditionUrlFile: () => {
        wroteUrl = true;
      },
      writeSocialMd: () => {
        wroteSocial = true;
      },
    });
    const result = await kitRefreshSocialEditionUrl(EDITION_DIR, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resolved, false);
      if (!result.resolved) assert.equal(result.reason, "no_slug_yet");
    }
    assert.equal(wroteUrl, false);
    assert.equal(wroteSocial, false);
  });

  it("caso REAL (#7405, achado do code-reviewer): 03-social.md já tem o STUB embutido (não o placeholder {edition_url} — a Etapa 5 já substituiu por ele antes do Stage 6) → substitui o stub ANTIGO pelo novo, resolved: true", async () => {
    const deps = makeDeps();
    const result = await kitRefreshSocialEditionUrl(EDITION_DIR, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resolved, true);
      if (result.resolved) {
        assert.equal(result.editionUrl, RESOLVED_URL);
        assert.deepEqual(result.unresolvedPlaceholders, []);
      }
    }
    const writtenSocial = deps.readSocialMd(EDITION_DIR);
    assert.match(writtenSocial!, new RegExp(`Mais em ${RESOLVED_URL.replace(/\//g, "\\/")} #IA`));
    assert.doesNotMatch(writtenSocial!, /\{edition_url\}/);
    assert.doesNotMatch(writtenSocial!, /posts\/\s/, "o stub sem slug não pode sobrar no texto");
  });

  it("caso de borda: placeholder {edition_url} ainda LITERAL (sem stub prévio — Etapa 5 não rodou o guard ainda) → substituteEditionUrl cobre, resolved: true", async () => {
    let writtenSocial: string | null = null;
    const deps = makeDeps({
      readEditionUrlFile: () => null,
      readSocialMd: () => "## d1\n\nTexto do post. Mais em {edition_url} #IA\n",
      writeSocialMd: (_dir, content) => {
        writtenSocial = content;
      },
    });
    const result = await kitRefreshSocialEditionUrl(EDITION_DIR, deps);
    assert.equal(result.ok, true);
    if (result.ok && result.resolved) {
      assert.deepEqual(result.unresolvedPlaceholders, []);
    }
    assert.match(writtenSocial!, new RegExp(`Mais em ${RESOLVED_URL.replace(/\//g, "\\/")} #IA`));
  });

  it("já resolvida pra MESMA URL numa invocação anterior → idempotente, resolved: false, reason already_resolved, não reescreve nada", async () => {
    let writeUrlCalls = 0;
    let writeSocialCalls = 0;
    const deps = makeDeps({
      readEditionUrlFile: () => RESOLVED_URL,
      writeEditionUrlFile: () => {
        writeUrlCalls += 1;
      },
      writeSocialMd: () => {
        writeSocialCalls += 1;
      },
    });
    const result = await kitRefreshSocialEditionUrl(EDITION_DIR, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resolved, false);
      if (!result.resolved) {
        assert.equal(result.reason, "already_resolved");
        assert.equal(result.editionUrl, RESOLVED_URL);
      }
    }
    assert.equal(writeUrlCalls, 0);
    assert.equal(writeSocialCalls, 0);
  });

  it("existe URL PRÉVIA DIFERENTE em 05-edition-url.txt (não null, não igual à nova, não é o stub genérico) → regrava tanto o .txt quanto o texto antigo embutido em 03-social.md", async () => {
    const OLD_RESOLVED_URL = "https://diariabr.kit.com/posts/titulo-antigo";
    let writtenUrl: string | null = null;
    let writtenSocial: string | null = null;
    const deps = makeDeps({
      readEditionUrlFile: () => OLD_RESOLVED_URL,
      readSocialMd: () => `## d1\n\nTexto do post. Mais em ${OLD_RESOLVED_URL} #IA\n`,
      writeEditionUrlFile: (_dir, url) => {
        writtenUrl = url;
      },
      writeSocialMd: (_dir, content) => {
        writtenSocial = content;
      },
    });
    const result = await kitRefreshSocialEditionUrl(EDITION_DIR, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resolved, true);
      if (result.resolved) assert.equal(result.editionUrl, RESOLVED_URL);
    }
    assert.equal(writtenUrl, RESOLVED_URL);
    assert.match(writtenSocial!, new RegExp(`Mais em ${RESOLVED_URL.replace(/\//g, "\\/")} #IA`));
    assert.doesNotMatch(writtenSocial!, /titulo-antigo/);
  });

  it("03-social.md ausente (edição sem social ainda) → escreve a URL mesmo assim, sem tentar reescrever social", async () => {
    const deps = makeDeps({ readSocialMd: () => null });
    const result = await kitRefreshSocialEditionUrl(EDITION_DIR, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resolved, true);
      if (result.resolved) assert.deepEqual(result.unresolvedPlaceholders, []);
    }
  });

  it("placeholder remanescente diferente de {edition_url}/stub → não-fatal, resolved: true com unresolvedPlaceholders preenchido", async () => {
    const deps = makeDeps({
      readSocialMd: () => `## d1\n\nMais em ${STUB_URL}, veja também {outro_placeholder}\n`,
    });
    const result = await kitRefreshSocialEditionUrl(EDITION_DIR, deps);
    assert.equal(result.ok, true);
    if (result.ok && result.resolved) {
      assert.deepEqual(result.unresolvedPlaceholders, ["{outro_placeholder}"]);
    }
  });
});

describe("warnUnresolvedPlaceholders (#7405, achado do silent-failure-hunter)", () => {
  it("grava um evento warn em data/run-log.jsonl com o prefixo do guard #3277 e não lança", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-refresh-social-warn-"));
    try {
      warnUnresolvedPlaceholders(
        ["{outro_placeholder}"],
        "260904",
        "https://diariabr.kit.com/posts/titulo",
        join(root, "data", "editions", "2609", "260904", "03-social.md"),
        root,
      );
      const logPath = join(root, "data", "run-log.jsonl");
      assert.ok(existsSync(logPath), "data/run-log.jsonl deveria ter sido gravado");
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      const event = JSON.parse(lines[lines.length - 1]);
      assert.equal(event.level, "warn");
      assert.equal(event.stage, 6);
      assert.equal(event.agent, "kit-refresh-social-edition-url");
      assert.match(event.message, /guard anti-placeholder \(#3277\)/);
      assert.deepEqual(event.details.unresolved, ["{outro_placeholder}"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("main() — integração (guard de CLI)", () => {
  let originalArgv: string[];
  let originalFetch: typeof fetch;
  const API_KEY_ENV_ORIG = process.env.KIT_API_KEY;

  beforeEach(() => {
    process.env.KIT_API_KEY = "kit_test_key_7405_refresh";
    originalArgv = process.argv;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    process.argv = originalArgv;
    globalThis.fetch = originalFetch;
  });

  after(() => {
    if (API_KEY_ENV_ORIG === undefined) delete process.env.KIT_API_KEY;
    else process.env.KIT_API_KEY = API_KEY_ENV_ORIG;
  });

  function writePlatformConfig(root: string, backend: string): void {
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ publishing: { newsletter: { backend } } }), "utf8");
  }

  it("--edition-dir ausente: exitCode 1, nenhuma chamada de rede", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-refresh-social-main-"));
    try {
      writePlatformConfig(root, "kit");
      globalThis.fetch = (async () => {
        throw new Error("não deveria chamar fetch");
      }) as typeof fetch;
      process.argv = ["node", "kit-refresh-social-edition-url.ts"];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("backend != kit: exitCode 0, resolved: false, reason backend_not_kit, nenhuma chamada de rede", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-refresh-social-main-"));
    try {
      writePlatformConfig(root, "beehiiv");
      globalThis.fetch = (async () => {
        throw new Error("não deveria chamar fetch");
      }) as typeof fetch;
      process.argv = ["node", "kit-refresh-social-edition-url.ts", "--edition-dir", root];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 0);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("draft ausente: exitCode 3, sem chamada de rede", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-refresh-social-main-"));
    try {
      writePlatformConfig(root, "kit");
      globalThis.fetch = (async () => {
        throw new Error("não deveria chamar fetch");
      }) as typeof fetch;
      process.argv = ["node", "kit-refresh-social-edition-url.ts", "--edition-dir", root];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 3);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caminho feliz de ponta a ponta: GET mockado com slug, exitCode 0, arquivos gravados", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-refresh-social-main-"));
    try {
      writePlatformConfig(root, "kit");
      mkdirSync(join(root, "_internal"), { recursive: true });
      writePublishedState(root, {
        broadcast_id: 555,
        subject: "Assunto",
        preview_text: "Preview",
        status: "scheduled",
        test_broadcast_ids: [],
      });
      // #7405 achado do code-reviewer: simula o estado REAL do Stage 6 — a
      // Etapa 5 já rodou `resolve-edition-url.ts --validate-social` e
      // substituiu `{edition_url}` pelo stub Kit (sem slug) em AMBOS
      // `05-edition-url.txt` e `03-social.md`, não deixando o placeholder
      // literal.
      mkdirSync(join(root, "_internal"), { recursive: true });
      writeFileSync(join(root, "_internal", "05-edition-url.txt"), "https://diariabr.kit.com/posts/", "utf8");
      writeFileSync(join(root, "03-social.md"), "## d1\n\nMais em https://diariabr.kit.com/posts/ #IA\n", "utf8");
      globalThis.fetch = (async (url: string) => {
        const u = new URL(url);
        if (u.pathname === "/v4/broadcasts/555") {
          const body = JSON.stringify({
            broadcast: { id: 555, status: "scheduled", public_url: "https://diariabr.kit.com/posts/assunto" },
          });
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            text: async () => body,
          } as unknown as Response;
        }
        throw new Error(`chamada inesperada: ${u.pathname}`);
      }) as typeof fetch;
      process.argv = ["node", "kit-refresh-social-edition-url.ts", "--edition-dir", root];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 0);
      assert.equal(readFileSync(join(root, "_internal", "05-edition-url.txt"), "utf8"), "https://diariabr.kit.com/posts/assunto");
      const finalSocial = readFileSync(join(root, "03-social.md"), "utf8");
      assert.match(finalSocial, /https:\/\/diariabr\.kit\.com\/posts\/assunto/);
      assert.doesNotMatch(finalSocial, /posts\/\s/, "o stub sem slug (Mais em https://.../posts/ #IA) não pode sobrar");
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
