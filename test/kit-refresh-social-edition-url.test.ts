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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  kitRefreshSocialEditionUrl,
  hasKitSlug,
  main,
  type KitRefreshSocialEditionUrlDeps,
} from "../scripts/kit-refresh-social-edition-url.ts";
import { writePublishedState } from "../scripts/publish-newsletter-kit.ts";

const EDITION_DIR = "/fake/root/data/editions/2609/260904";

function makeDeps(overrides: Partial<KitRefreshSocialEditionUrlDeps> = {}): KitRefreshSocialEditionUrlDeps {
  const files = new Map<string, string>();
  return {
    readPublished: overrides.readPublished ?? (() => ({ broadcast_id: 42 })),
    getBroadcastPublicUrl:
      overrides.getBroadcastPublicUrl ?? (async () => "https://diariabr.kit.com/posts/titulo-da-edicao"),
    readEditionUrlFile: overrides.readEditionUrlFile ?? ((dir) => files.get(`${dir}:url`) ?? null),
    writeEditionUrlFile: overrides.writeEditionUrlFile ?? ((dir, url) => files.set(`${dir}:url`, url)),
    readSocialMd:
      overrides.readSocialMd ??
      ((dir) => files.get(`${dir}:social`) ?? "## d1\n\nTexto do post. Mais em {edition_url} #IA\n"),
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

  it("slug resolvido pela 1ª vez → escreve 05-edition-url.txt + reescreve 03-social.md, resolved: true", async () => {
    const deps = makeDeps({
      getBroadcastPublicUrl: async () => "https://diariabr.kit.com/posts/titulo-da-edicao",
    });
    const result = await kitRefreshSocialEditionUrl(EDITION_DIR, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resolved, true);
      if (result.resolved) {
        assert.equal(result.editionUrl, "https://diariabr.kit.com/posts/titulo-da-edicao");
        assert.deepEqual(result.unresolvedPlaceholders, []);
      }
    }
    const writtenSocial = deps.readSocialMd(EDITION_DIR);
    assert.match(writtenSocial!, /Mais em https:\/\/diariabr\.kit\.com\/posts\/titulo-da-edicao #IA/);
    assert.doesNotMatch(writtenSocial!, /\{edition_url\}/);
  });

  it("já resolvida pra MESMA URL numa invocação anterior → idempotente, resolved: false, reason already_resolved, não reescreve nada", async () => {
    let writeUrlCalls = 0;
    let writeSocialCalls = 0;
    const deps = makeDeps({
      getBroadcastPublicUrl: async () => "https://diariabr.kit.com/posts/titulo-da-edicao",
      readEditionUrlFile: () => "https://diariabr.kit.com/posts/titulo-da-edicao",
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
        assert.equal(result.editionUrl, "https://diariabr.kit.com/posts/titulo-da-edicao");
      }
    }
    assert.equal(writeUrlCalls, 0);
    assert.equal(writeSocialCalls, 0);
  });

  it("03-social.md ausente (edição sem social ainda) → escreve a URL mesmo assim, sem tentar reescrever social", async () => {
    const deps = makeDeps({
      getBroadcastPublicUrl: async () => "https://diariabr.kit.com/posts/titulo-da-edicao",
      readSocialMd: () => null,
    });
    const result = await kitRefreshSocialEditionUrl(EDITION_DIR, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resolved, true);
      if (result.resolved) assert.deepEqual(result.unresolvedPlaceholders, []);
    }
  });

  it("placeholder remanescente após substituir {edition_url} → não-fatal, resolved: true com unresolvedPlaceholders preenchido", async () => {
    const deps = makeDeps({
      getBroadcastPublicUrl: async () => "https://diariabr.kit.com/posts/titulo-da-edicao",
      readSocialMd: () => "## d1\n\nMais em {edition_url}, veja também {outro_placeholder}\n",
    });
    const result = await kitRefreshSocialEditionUrl(EDITION_DIR, deps);
    assert.equal(result.ok, true);
    if (result.ok && result.resolved) {
      assert.deepEqual(result.unresolvedPlaceholders, ["{outro_placeholder}"]);
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
      writeFileSync(join(root, "03-social.md"), "## d1\n\nMais em {edition_url} #IA\n", "utf8");
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
      const { readFileSync } = await import("node:fs");
      assert.equal(readFileSync(join(root, "_internal", "05-edition-url.txt"), "utf8"), "https://diariabr.kit.com/posts/assunto");
      assert.match(readFileSync(join(root, "03-social.md"), "utf8"), /https:\/\/diariabr\.kit\.com\/posts\/assunto/);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
