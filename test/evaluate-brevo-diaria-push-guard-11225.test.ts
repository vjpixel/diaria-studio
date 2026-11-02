/**
 * test/evaluate-brevo-diaria-push-guard-11225.test.ts (#11225)
 *
 * `--push` sem `KIT_API_KEY` sai 2 antes do primeiro await de rede. O #11225
 * tornou a key obrigatória em todo `--push` (antes só com backend kit ou contato
 * de origem Kit); sem o guard, a rodada abortaria contato a contato.
 *
 * `KIT_API_KEY=""`, e não `delete`: `loadProjectEnv` usa dotenv com
 * `override: false`, que não sobrescreve a var já definida mesmo vazia. Sem isso
 * o `.env` local devolveria a key real e o teste seguiria para a rede.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../scripts/evaluate-brevo-diaria.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brevoKeyEnv = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")).brevo_diaria.api_key_env as string;

describe("#11225 evaluate-brevo-diaria --push sem KIT_API_KEY", () => {
  const FAKE_ENV: Record<string, string> = {
    KIT_API_KEY: "",
    BEEHIIV_API_KEY: "fake",
    BEEHIIV_PUBLICATION_ID: "pub_fake",
    [brevoKeyEnv]: "fake",
  };
  const savedEnv = new Map<string, string | undefined>();
  const savedArgv = process.argv;
  const savedFetch = globalThis.fetch;
  const savedWrite = process.stderr.write;
  let fetchCalls = 0;
  let stderr = "";

  before(() => {
    for (const [k, v] of Object.entries(FAKE_ENV)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    process.argv = [process.argv[0], "evaluate-brevo-diaria.ts", "--push"];
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("rede proibida neste teste");
    }) as typeof fetch;
  });

  after(() => {
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.argv = savedArgv;
    globalThis.fetch = savedFetch;
  });

  it("devolve 2, nomeia a key e não toca a rede", async () => {
    process.stderr.write = ((chunk: string) => {
      stderr += chunk;
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await main();
    } finally {
      process.stderr.write = savedWrite;
    }
    assert.equal(code, 2);
    assert.match(stderr, /KIT_API_KEY não definido/);
    assert.equal(fetchCalls, 0, "o guard roda antes do primeiro await de rede");
  });
});
