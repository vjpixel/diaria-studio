/**
 * test/newsletter-subscriber-source.test.ts (#6051)
 *
 * Mesmo padrão de `test/newsletter-read-source.test.ts` (#6184/#6362), pro
 * eixo SUBSCRIBER em vez de POST — cobre `resolveNewsletterSubscriberBackend`
 * (default/parse tolerante/log/JSON inválido) e
 * `resolveNewsletterSubscriberConfig` (delega pra resolveBeehiivConfig/
 * resolveKitConfig conforme o backend; JSON corrompido propaga erro em vez
 * de mascarar como default).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveNewsletterSubscriberBackend,
  resolveNewsletterSubscriberConfig,
} from "../scripts/lib/shared/newsletter-subscriber-source.ts";

async function withCapturedConsoleError<T>(fn: () => Promise<T> | T): Promise<{ result: T; errors: string[] }> {
  const orig = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, errors };
  } finally {
    console.error = orig;
  }
}

describe("resolveNewsletterSubscriberBackend (#6051)", () => {
  it('default "beehiiv" quando platform.config.json não existe', () => {
    assert.equal(resolveNewsletterSubscriberBackend(join(tmpdir(), "nao-existe-6051.json")), "beehiiv");
  });

  it('lê publishing.newsletter.subscriber_backend === "kit" (chave PRÓPRIA, não "backend"/"read_backend")', () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-subscriber-backend-"));
    const path = join(dir, "platform.config.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({
          publishing: { newsletter: { backend: "kit", read_backend: "kit", subscriber_backend: "kit" } },
        }),
      );
      assert.equal(resolveNewsletterSubscriberBackend(path), "kit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('"backend"/"read_backend" = "kit" sem "subscriber_backend" NÃO afeta este eixo — continua "beehiiv"', () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-subscriber-backend-envio-only-"));
    const path = join(dir, "platform.config.json");
    try {
      writeFileSync(path, JSON.stringify({ publishing: { newsletter: { backend: "kit", read_backend: "kit" } } }));
      assert.equal(resolveNewsletterSubscriberBackend(path), "beehiiv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parser tolerante: "Kit" (maiúscula) e "kit " (espaço) resolvem pra "kit"', () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-subscriber-backend-tolerant-"));
    try {
      const p1 = join(dir, "a.json");
      writeFileSync(p1, JSON.stringify({ publishing: { newsletter: { subscriber_backend: "Kit" } } }));
      assert.equal(resolveNewsletterSubscriberBackend(p1), "kit");

      const p2 = join(dir, "b.json");
      writeFileSync(p2, JSON.stringify({ publishing: { newsletter: { subscriber_backend: "kit " } } }));
      assert.equal(resolveNewsletterSubscriberBackend(p2), "kit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('valor desconhecido/typo cai no default "beehiiv" e LOGA o valor bruto', async () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-subscriber-backend-typo-"));
    const path = join(dir, "platform.config.json");
    try {
      writeFileSync(path, JSON.stringify({ publishing: { newsletter: { subscriber_backend: "beehiv" } } }));
      const { result, errors } = await withCapturedConsoleError(() => resolveNewsletterSubscriberBackend(path));
      assert.equal(result, "beehiiv");
      assert.ok(
        errors.some((e) => e.includes("subscriber_backend desconhecido") && e.includes("beehiv")),
        `esperava log do valor bruto desconhecido, recebi: ${JSON.stringify(errors)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON inválido cai no default sem lançar (versão não-checada)", () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-subscriber-backend-badjson-"));
    const path = join(dir, "platform.config.json");
    try {
      writeFileSync(path, "{ not json");
      assert.equal(resolveNewsletterSubscriberBackend(path), "beehiiv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveNewsletterSubscriberConfig (#6051)", () => {
  it("platform.config.json PRESENTE mas JSON inválido propaga ok:false (nunca mascara como beehiiv default)", () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-subscriber-config-badjson-"));
    const path = join(dir, "platform.config.json");
    try {
      writeFileSync(path, "{ not json");
      const result = resolveNewsletterSubscriberConfig({ configPath: path });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /platform\.config\.json inválido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("platform.config.json AUSENTE segue default beehiiv normalmente (distinção do caso acima)", () => {
    const result = resolveNewsletterSubscriberConfig({
      configPath: join(tmpdir(), "nao-existe-6051-config.json"),
      env: { BEEHIIV_API_KEY: "k", BEEHIIV_PUBLICATION_ID: "pub_1" },
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.config.backend, "beehiiv");
  });

  it("backend beehiiv sem BEEHIIV_API_KEY falha com reason explícito", () => {
    const result = resolveNewsletterSubscriberConfig({ backend: "beehiiv", env: {} });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /BEEHIIV_API_KEY/);
  });

  it("backend kit sem KIT_API_KEY falha com reason explícito", () => {
    const result = resolveNewsletterSubscriberConfig({ backend: "kit", env: {} });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /KIT_API_KEY/);
  });

  it("backend beehiiv com credenciais resolve config discriminada", () => {
    const result = resolveNewsletterSubscriberConfig({
      backend: "beehiiv",
      env: { BEEHIIV_API_KEY: "k", BEEHIIV_PUBLICATION_ID: "pub_1" },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.backend, "beehiiv");
      assert.deepEqual(result.config.config, { apiKey: "k", publicationId: "pub_1" });
    }
  });

  it("backend kit com credenciais resolve config discriminada", () => {
    const result = resolveNewsletterSubscriberConfig({ backend: "kit", env: { KIT_API_KEY: "kit_k" } });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.backend, "kit");
      assert.deepEqual(result.config.config, { apiKey: "kit_k" });
    }
  });
});
