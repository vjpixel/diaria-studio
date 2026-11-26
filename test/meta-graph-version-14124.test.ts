/**
 * test/meta-graph-version-14124.test.ts (#14124)
 *
 * A versão da Graph API da Meta mora só em `scripts/lib/shared/meta-graph.ts`.
 * Este teste trava três coisas:
 *
 * 1. Os valores e as URLs geradas são os mesmos de antes da centralização
 *    (`v25.0` social, `v21.0` CAPI/Ads/Lead Ads), e os defaults antigos
 *    (`DEFAULT_FACEBOOK_API_VERSION`, `META_CAPI_DEFAULT_API_VERSION`,
 *    `DEFAULT_GRAPH_API_VERSION` do `meta-leads`) apontam para as constantes.
 * 2. Os `wrangler.toml`, que não importam TS, declaram o mesmo valor.
 * 3. Nenhum literal de versão da Graph reaparece em `.ts` de `scripts/` ou
 *    `workers/*\/src` fora do módulo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  META_ADS_GRAPH_VERSION,
  META_GRAPH_HOST,
  META_GRAPH_VERSION,
  metaGraphBase,
} from "../scripts/lib/shared/meta-graph.ts";
import { DEFAULT_FACEBOOK_API_VERSION, resolveFacebookApiVersion } from "../scripts/lib/facebook-pages.ts";
import { META_CAPI_DEFAULT_API_VERSION } from "../scripts/lib/shared/meta-capi.ts";
import { DEFAULT_GRAPH_API_VERSION as META_LEADS_DEFAULT } from "../workers/meta-leads/src/graph.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "scripts/lib/shared/meta-graph.ts";

describe("meta-graph (#14124) — valores e URLs idênticos aos de antes", () => {
  it("as versões são as que estavam literais no código", () => {
    assert.equal(META_GRAPH_VERSION, "v25.0");
    assert.equal(META_ADS_GRAPH_VERSION, "v21.0");
  });

  it("metaGraphBase monta a mesma base que os literais montavam", () => {
    assert.equal(META_GRAPH_HOST, "https://graph.facebook.com");
    assert.equal(metaGraphBase(), "https://graph.facebook.com/v25.0");
    assert.equal(metaGraphBase(META_ADS_GRAPH_VERSION), "https://graph.facebook.com/v21.0");
    assert.equal(metaGraphBase("v26.0"), "https://graph.facebook.com/v26.0");
  });

  it("os defaults antigos apontam para as constantes", () => {
    assert.equal(DEFAULT_FACEBOOK_API_VERSION, META_GRAPH_VERSION);
    assert.equal(resolveFacebookApiVersion({}, {}), META_GRAPH_VERSION);
    assert.equal(resolveFacebookApiVersion({ FACEBOOK_API_VERSION: "v26.0" }, {}), "v26.0");
    assert.equal(META_CAPI_DEFAULT_API_VERSION, META_ADS_GRAPH_VERSION);
    assert.equal(META_LEADS_DEFAULT, META_ADS_GRAPH_VERSION);
  });
  // O default das credenciais do `linkedin-cron` (`resolveInstagramCreds`)
  // segue travado em `workers/linkedin-cron/test/instagram-channel.test.ts`
  // ("default apiVersion v25.0"); importar o `src` do Worker daqui puxaria
  // os tipos do Cloudflare para o typecheck de `test/**`.
});

describe("meta-graph (#14124) — wrangler.toml acompanha a constante", () => {
  const tomlVar = (path: string, key: string): string | null => {
    const src = readFileSync(join(ROOT, path), "utf8");
    const m = src.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));
    return m ? m[1] : null;
  };

  it("linkedin-cron INSTAGRAM_API_VERSION = META_GRAPH_VERSION", () => {
    assert.equal(tomlVar("workers/linkedin-cron/wrangler.toml", "INSTAGRAM_API_VERSION"), META_GRAPH_VERSION);
  });

  it("meta-leads META_GRAPH_API_VERSION = META_ADS_GRAPH_VERSION", () => {
    assert.equal(tomlVar("workers/meta-leads/wrangler.toml", "META_GRAPH_API_VERSION"), META_ADS_GRAPH_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Guard de literal
// ---------------------------------------------------------------------------

/** Literal de versão da Graph: string `"vNN.N"` (major de 2 dígitos, que é o
 * formato da Graph da Meta; a Threads usa `v1.0` e fica de fora) ou URL
 * `graph.facebook.com/vN.N` / `graph.instagram.com/vN.N`. */
const VERSION_LITERAL = /["'`]v\d{2}\.\d+["'`]/;
const VERSIONED_URL = /graph\.(?:facebook|instagram)\.com\/v\d+\.\d+/;

/** Arquivos que podem ter o literal. Só encolhe; entrada nova precisa de motivo. */
const ALLOWLIST = new Set<string>([MODULE]);

function findGraphVersionLiterals(rel: string, src: string): string[] {
  const hits: string[] = [];
  src.split("\n").forEach((line, i) => {
    if (VERSION_LITERAL.test(line) || VERSIONED_URL.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
  return hits;
}

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && !f.split(sep).includes("node_modules"))
    .map((f) => join(dir, f));
}

function scannedFiles(): string[] {
  const out = tsFiles(join(ROOT, "scripts"));
  const workersDir = join(ROOT, "workers");
  for (const w of readdirSync(workersDir, { withFileTypes: true })) {
    if (w.isDirectory()) out.push(...tsFiles(join(workersDir, w.name, "src")));
  }
  return out;
}

describe("meta-graph (#14124) — nenhum literal de versão fora do módulo", () => {
  it("o detector pega string de versão e URL versionada, e ignora Threads e prosa sem aspas", () => {
    assert.equal(findGraphVersionLiterals("x.ts", 'const v = "v25.0";').length, 1);
    assert.equal(findGraphVersionLiterals("x.ts", "const v = env.X || 'v21.0';").length, 1);
    assert.equal(findGraphVersionLiterals("x.ts", "const u = `https://graph.facebook.com/v26.0/me`;").length, 1);
    assert.equal(findGraphVersionLiterals("x.ts", "fetch(\"https://graph.instagram.com/v25.0/me\")").length, 1);
    assert.equal(findGraphVersionLiterals("x.ts", 'const t = "v1.0"; // Threads').length, 0);
    assert.equal(findGraphVersionLiterals("x.ts", " * na v25.0 (#8260).").length, 0);
  });

  it("scripts/**/*.ts e workers/*/src/**/*.ts não têm literal fora da allowlist", () => {
    const hits: string[] = [];
    for (const file of scannedFiles()) {
      const rel = relative(ROOT, file).split(sep).join("/");
      if (ALLOWLIST.has(rel)) continue;
      hits.push(...findGraphVersionLiterals(rel, readFileSync(file, "utf8")));
    }
    assert.deepEqual(
      hits,
      [],
      `Literal de versão da Graph da Meta fora de ${MODULE} (#14124). Importe META_GRAPH_VERSION / META_ADS_GRAPH_VERSION / metaGraphBase:\n${hits.join("\n")}`,
    );
  });

  it("a allowlist só tem arquivos que ainda existem e ainda têm o literal", () => {
    for (const rel of ALLOWLIST) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      assert.ok(findGraphVersionLiterals(rel, src).length > 0, `${rel} está na allowlist sem literal: tire da lista`);
    }
  });
});
