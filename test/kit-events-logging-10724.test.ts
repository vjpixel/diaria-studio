import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

it("kit-events desliga a coleta persistida de URLs com segredo (#10724)", () => {
  const config = readFileSync(new URL("../workers/kit-events/wrangler.toml", import.meta.url), "utf8");
  const observability = config.match(/^\[observability\]\s*\n([^]*?)(?=^\[|$(?![^]))/m)?.[1];
  assert.ok(observability, "declarar a política explicitamente, sem depender do default");
  assert.match(observability, /^enabled\s*=\s*false\s*$/m);
  assert.match(observability, /^head_sampling_rate\s*=\s*0\s*$/m);
  assert.doesNotMatch(config, /^\[.*observability\./m, "overrides de logs/traces/ambiente precisam de revisão da política");
});
