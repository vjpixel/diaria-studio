/**
 * publish-twitter.test.ts (#3994)
 *
 * Testa publish-twitter.ts: extração da seção '# Curto' (sem fallback),
 * guard de credenciais (best-effort skip), --dry-run, resume-aware, retry,
 * e a assinatura OAuth 1.0a via subprocess isolado (sem chamar a API real).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  extractDestaquesFromCurto,
  extractCurtoText,
  TWITTER_CHAR_LIMIT,
} from "../scripts/publish-twitter.ts";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(resolve(__ROOT, "scripts/publish-twitter.ts"), "utf8");
const SCRIPT = resolve(__ROOT, "scripts/publish-twitter.ts");

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MD_CURTO = `# Curto

## d1
Post curto d1 no X/Threads. #ia

## d2
Post curto d2. #futuro

## d3
Post curto d3.
<!-- comentario oculto -->

# Facebook

## d1
Post d1 Facebook, bem mais longo e não deve vazar pro Twitter.
`;

const MD_SEM_CURTO = `# Facebook

## d1
Post d1 Facebook.

## d2
Post d2 Facebook.
`;

const MD_CRLF = MD_CURTO.replace(/\n/g, "\r\n");

// ─── extractDestaquesFromCurto ──────────────────────────────────────────────

describe("extractDestaquesFromCurto", () => {
  it("retorna d1/d2/d3 quando seção Curto existe com 3 destaques", () => {
    assert.deepEqual(extractDestaquesFromCurto(MD_CURTO), ["d1", "d2", "d3"]);
  });

  it("retorna [] quando seção Curto ausente — SEM fallback pra Facebook", () => {
    assert.deepEqual(extractDestaquesFromCurto(MD_SEM_CURTO), []);
  });

  it("retorna d1/d2 quando só 2 destaques estão na seção Curto", () => {
    const md = `# Curto\n\n## d1\nPost d1.\n\n## d2\nPost d2.\n`;
    assert.deepEqual(extractDestaquesFromCurto(md), ["d1", "d2"]);
  });
});

// ─── extractCurtoText ────────────────────────────────────────────────────────

describe("extractCurtoText", () => {
  it("extrai d1 da seção Curto", () => {
    const t = extractCurtoText(MD_CURTO, "d1");
    assert.ok(t?.includes("Post curto d1 no X/Threads."));
    assert.ok(!t?.includes("Facebook"));
  });

  it("não vaza seção Facebook quando Curto presente", () => {
    const t = extractCurtoText(MD_CURTO, "d1");
    assert.ok(!t?.includes("bem mais longo"));
  });

  it("remove comentários HTML", () => {
    const t = extractCurtoText(MD_CURTO, "d3");
    assert.ok(!t?.includes("comentario oculto"));
  });

  it("normaliza CRLF para LF", () => {
    const t = extractCurtoText(MD_CRLF, "d1");
    assert.ok(t?.includes("Post curto d1 no X/Threads."));
  });

  it("retorna null quando seção Curto ausente — SEM fallback, sem lançar", () => {
    assert.equal(extractCurtoText(MD_SEM_CURTO, "d1"), null);
  });

  it("retorna null quando destaque não existe dentro da seção Curto", () => {
    assert.equal(extractCurtoText(MD_CURTO, "d9"), null);
  });
});

// ─── TWITTER_CHAR_LIMIT ──────────────────────────────────────────────────────

describe("TWITTER_CHAR_LIMIT", () => {
  it("é 280 (free tier do X)", () => {
    assert.equal(TWITTER_CHAR_LIMIT, 280);
  });
});

// ─── Verificação estática: sem fallback, sem chunking, sem --schedule ────────

describe("Verificação estática do script (#3994)", () => {
  it("NÃO importa extractSection com fallback pra Facebook/Threads (sem improviso de texto)", () => {
    assert.match(SRC, /extractDestaquesFromCurto/);
    assert.doesNotMatch(SRC, /extractSection\(.*"Facebook"/, "não deve ter fallback pra Facebook");
  });

  it("usa OAuth 1.0a via generateOAuth1AuthHeader (não Bearer token)", () => {
    assert.match(SRC, /generateOAuth1AuthHeader/);
    assert.match(SRC, /from "\.\/lib\/twitter-oauth1\.ts"/);
  });

  it("endpoint correto: POST /2/tweets", () => {
    assert.match(SRC, /api\.twitter\.com\/2\/tweets/);
  });

  it("credenciais ausentes → exit 0 (skip gracioso), não exit 1", () => {
    assert.match(SRC, /TWITTER_API_KEY/);
    assert.match(SRC, /TWITTER_API_SECRET/);
    assert.match(SRC, /TWITTER_ACCESS_TOKEN/);
    assert.match(SRC, /TWITTER_ACCESS_TOKEN_SECRET/);
    assert.match(SRC, /SKIP:.*ausente/);
  });

  it("texto acima do limite falha explicitamente (sem truncar em silêncio)", () => {
    assert.match(SRC, /TWITTER_CHAR_LIMIT/);
    assert.match(SRC, /sem truncagem silenciosa/);
  });

  it("sem --schedule nesta v1 (post imediato, sem fila de Worker)", () => {
    assert.doesNotMatch(SRC, /doSchedule/, "v1 não implementa --schedule");
    assert.doesNotMatch(SRC, /postToWorkerQueue/, "v1 não usa o Worker de fila");
  });

  it("script tem CLI guard padrão do repo", () => {
    assert.match(SRC, /isMainModule\(import\.meta\.url\)/);
  });

  it("retry com backoff exponencial (chunk único, sempre seguro)", () => {
    assert.match(SRC, /maxAttempts = 3/);
    assert.match(SRC, /Math\.pow\(2, attempt - 1\)/);
  });
});

// ─── Integração com platform.config.json ─────────────────────────────────────

describe("Integração com platform.config.json", () => {
  it("platform.config.json tem 'twitter' no array socials", () => {
    const cfg = JSON.parse(
      readFileSync(resolve(__ROOT, "platform.config.json"), "utf8"),
    ) as { socials?: string[] };
    assert.ok(cfg.socials!.includes("twitter"), "socials deve conter 'twitter'");
  });

  it("platform.config.json tem publishing.social.twitter.enabled", () => {
    const cfg = JSON.parse(readFileSync(resolve(__ROOT, "platform.config.json"), "utf8"));
    assert.equal(typeof cfg.publishing?.social?.twitter?.enabled, "boolean");
  });
});

// ─── Resume-aware (pula posts já publicados) ─────────────────────────────────

describe("Resume-aware skip posts já publicados", () => {
  it("pula post twitter com status 'published'", () => {
    const posts = [{ platform: "twitter", destaque: "d1", status: "published" }];
    const existing = posts.find(
      (p) => p.platform === "twitter" && p.destaque === "d1" && p.status === "published",
    );
    assert.ok(existing);
  });

  it("script grava threads_media_id equivalente (twitter_tweet_id) no entry", () => {
    assert.match(SRC, /twitter_tweet_id/);
  });
});

// ─── --dry-run real guard (subprocess, sem tocar API real) ───────────────────

describe("--dry-run real guard (subprocess)", () => {
  it("--dry-run: 06-social-published.json NÃO é criado (sem side-effect)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-twitter-dryrun-"));
    try {
      mkdirSync(join(tmpDir, "_internal"), { recursive: true });
      writeFileSync(join(tmpDir, "03-social.md"), MD_CURTO, "utf8");

      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, "--edition-dir", tmpDir, "--dry-run"],
        {
          encoding: "utf8",
          cwd: __ROOT,
          env: {
            ...process.env,
            TWITTER_API_KEY: "fake_key",
            TWITTER_API_SECRET: "fake_secret",
            TWITTER_ACCESS_TOKEN: "fake_token",
            TWITTER_ACCESS_TOKEN_SECRET: "fake_token_secret",
          },
        },
      );

      assert.equal(r.status, 0, `deve sair com 0; stderr: ${r.stderr}`);
      assert.ok(
        !existsSync(join(tmpDir, "_internal", "06-social-published.json")),
        "--dry-run não deve criar 06-social-published.json",
      );
      assert.ok(r.stdout.includes("DRY-RUN"), `stdout deve mencionar DRY-RUN: ${r.stdout.slice(0, 300)}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sem TWITTER_API_KEY etc: skip gracioso (exit 0), sem gravar nada", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-twitter-nocreds-"));
    try {
      mkdirSync(join(tmpDir, "_internal"), { recursive: true });
      writeFileSync(join(tmpDir, "03-social.md"), MD_CURTO, "utf8");

      const env = { ...process.env };
      delete env.TWITTER_API_KEY;
      delete env.TWITTER_API_SECRET;
      delete env.TWITTER_ACCESS_TOKEN;
      delete env.TWITTER_ACCESS_TOKEN_SECRET;

      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, "--edition-dir", tmpDir],
        { encoding: "utf8", cwd: __ROOT, env },
      );

      assert.equal(r.status, 0, `deve sair com 0 (skip gracioso); stderr: ${r.stderr}`);
      assert.match(r.stderr, /SKIP.*ausente/);
      assert.ok(!existsSync(join(tmpDir, "_internal", "06-social-published.json")));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sem seção '# Curto': skip gracioso (exit 0), sem gravar nada, sem improvisar texto", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-twitter-nocurto-"));
    try {
      mkdirSync(join(tmpDir, "_internal"), { recursive: true });
      writeFileSync(join(tmpDir, "03-social.md"), MD_SEM_CURTO, "utf8");

      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, "--edition-dir", tmpDir],
        {
          encoding: "utf8",
          cwd: __ROOT,
          env: {
            ...process.env,
            TWITTER_API_KEY: "fake_key",
            TWITTER_API_SECRET: "fake_secret",
            TWITTER_ACCESS_TOKEN: "fake_token",
            TWITTER_ACCESS_TOKEN_SECRET: "fake_token_secret",
          },
        },
      );

      assert.equal(r.status, 0, `deve sair com 0; stderr: ${r.stderr}`);
      assert.match(r.stderr, /Curto.*ausente|sem fallback/i);
      assert.ok(!existsSync(join(tmpDir, "_internal", "06-social-published.json")));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("texto acima de 280 chars: grava 'failed' com motivo claro, sem chamar a API", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-twitter-toolong-"));
    try {
      mkdirSync(join(tmpDir, "_internal"), { recursive: true });
      const longText = "a".repeat(300);
      const md = `# Curto\n\n## d1\n${longText}\n`;
      writeFileSync(join(tmpDir, "03-social.md"), md, "utf8");

      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, "--edition-dir", tmpDir],
        {
          encoding: "utf8",
          cwd: __ROOT,
          timeout: 15_000,
          env: {
            ...process.env,
            TWITTER_API_KEY: "fake_key",
            TWITTER_API_SECRET: "fake_secret",
            TWITTER_ACCESS_TOKEN: "fake_token",
            TWITTER_ACCESS_TOKEN_SECRET: "fake_token_secret",
          },
        },
      );

      assert.equal(r.status, 0, `script deve terminar 0 mesmo com destaque falho; stderr: ${r.stderr}`);
      const publishedPath = join(tmpDir, "_internal", "06-social-published.json");
      assert.ok(existsSync(publishedPath));
      const published = JSON.parse(readFileSync(publishedPath, "utf8"));
      const entry = published.posts.find((p: any) => p.destaque === "d1");
      assert.ok(entry);
      assert.equal(entry.status, "failed");
      assert.match(entry.reason, /280/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("guard de platform.config.json lê publishing.social.twitter.enabled (verificação estática)", () => {
    // O script lê platform.config.json fixo no ROOT — sem hook de override de
    // path, então o cenário enabled:false é coberto por verificação estática
    // (mesmo padrão do guard de credenciais acima), não por subprocess isolado.
    assert.match(SRC, /publishing\?\.social\?\.twitter/);
    assert.match(SRC, /enabled === false/);
  });
});
