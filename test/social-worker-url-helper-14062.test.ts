/**
 * #14062 — `resolveSocialWorkerUrl`/`resolveSocialWorkerToken` substituem as
 * cadeias manuais de URL/token do Worker social. Este teste trava que o helper
 * devolve EXATAMENTE o que cada uma das 4 formas antigas devolvia, para toda
 * combinação de env (ausente / vazia / setada) × slot instagram / threads /
 * linkedin (ausente / setado) no config. As formas antigas estão copiadas
 * literalmente abaixo como referência.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSocialWorkerToken,
  resolveSocialWorkerUrl,
  resolveSocialWorkerUrlFromRoot,
} from "../scripts/lib/worker-queue-client.ts";

type Env = Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cfg = any;

// ── Formas antigas (copiadas das cadeias substituídas) ──
/** publish-linkedin, publish-artigo-especial-linkedin, link-video-d1, retract-social-destaque, divulgacao-slot-planner, video-d1-link-watch */
const oldLinkedinNullish = (env: Env, c: Cfg) =>
  env.DIARIA_LINKEDIN_CRON_URL ?? c?.publishing?.social?.linkedin?.cloudflare_worker_url ?? "";
/** publish-weekly-social (×4), publish-retrospectiva-social, publish-shorts, resolveInstagramWorkerUrl */
const oldInstagram = (env: Env, c: Cfg) =>
  env.DIARIA_LINKEDIN_CRON_URL ??
  c?.publishing?.social?.instagram?.cloudflare_worker_url ??
  c?.publishing?.social?.linkedin?.cloudflare_worker_url ??
  "";
/** publish-threads */
const oldThreads = (env: Env, c: Cfg) =>
  env.DIARIA_LINKEDIN_CRON_URL ??
  c?.publishing?.social?.threads?.cloudflare_worker_url ??
  c?.publishing?.social?.linkedin?.cloudflare_worker_url ??
  "";
/** verify-stage-4-dispatch, verify-social-worker-dispatch, delete-test-schedules */
const oldTruthy = (env: Env, c: Cfg) => {
  const fromEnv = env.DIARIA_LINKEDIN_CRON_URL;
  if (fromEnv) return fromEnv;
  return c?.publishing?.social?.linkedin?.cloudflare_worker_url ?? "";
};

const ENV_STATES: Env[] = [
  {},
  { DIARIA_LINKEDIN_CRON_URL: "" },
  { DIARIA_LINKEDIN_CRON_URL: "https://env.example" },
];
const SLOT_VALUES = [undefined, "", "https://slot.example"];

function* configs(): Generator<Cfg> {
  yield undefined;
  yield null;
  yield {};
  yield { publishing: {} };
  for (const ig of SLOT_VALUES)
    for (const th of SLOT_VALUES)
      for (const li of SLOT_VALUES) {
        const social: Record<string, unknown> = {};
        if (ig !== undefined) social.instagram = { cloudflare_worker_url: ig.replace("slot", "ig") };
        if (th !== undefined) social.threads = { cloudflare_worker_url: th.replace("slot", "th") };
        if (li !== undefined) social.linkedin = { cloudflare_worker_url: li.replace("slot", "li") };
        // slot presente sem o campo
        if (ig === undefined) social.instagram = {};
        yield { publishing: { social } };
      }
}

test("#14062: tabela env × config — helper bate com as 4 formas antigas", () => {
  let n = 0;
  for (const env of ENV_STATES) {
    for (const cfg of configs()) {
      const label = JSON.stringify({ env, cfg });
      assert.equal(resolveSocialWorkerUrl(cfg, { env }), oldLinkedinNullish(env, cfg), `linkedin ${label}`);
      assert.equal(resolveSocialWorkerUrl(cfg, { env, preferSlot: "instagram" }), oldInstagram(env, cfg), `instagram ${label}`);
      assert.equal(resolveSocialWorkerUrl(cfg, { env, preferSlot: "threads" }), oldThreads(env, cfg), `threads ${label}`);
      assert.equal(resolveSocialWorkerUrl(cfg, { env, emptyEnvFallsThrough: true }), oldTruthy(env, cfg), `truthy ${label}`);
      n++;
    }
  }
  assert.ok(n > 80, `cobriu ${n} combinações`);
});

test("#14062: precedência explícita — env > slot preferido > linkedin > vazio", () => {
  const cfg = {
    publishing: {
      social: {
        instagram: { cloudflare_worker_url: "ig" },
        linkedin: { cloudflare_worker_url: "li" },
      },
    },
  };
  assert.equal(resolveSocialWorkerUrl(cfg, { env: { DIARIA_LINKEDIN_CRON_URL: "env" }, preferSlot: "instagram" }), "env");
  assert.equal(resolveSocialWorkerUrl(cfg, { env: {}, preferSlot: "instagram" }), "ig");
  assert.equal(resolveSocialWorkerUrl(cfg, { env: {} }), "li");
  assert.equal(resolveSocialWorkerUrl(cfg, { env: {}, preferSlot: "threads" }), "li");
  assert.equal(resolveSocialWorkerUrl({}, { env: {} }), "");
  // env vazia: `??` mantém "" (não configurado); a forma truthy cai pro config.
  assert.equal(resolveSocialWorkerUrl(cfg, { env: { DIARIA_LINKEDIN_CRON_URL: "" } }), "");
  assert.equal(resolveSocialWorkerUrl(cfg, { env: { DIARIA_LINKEDIN_CRON_URL: "" }, emptyEnvFallsThrough: true }), "li");
});

test("#14062: resolveSocialWorkerToken — env ?? ''", () => {
  assert.equal(resolveSocialWorkerToken({}), "");
  assert.equal(resolveSocialWorkerToken({ DIARIA_LINKEDIN_CRON_TOKEN: "" }), "");
  assert.equal(resolveSocialWorkerToken({ DIARIA_LINKEDIN_CRON_TOKEN: "tok" }), "tok");
});

test("#14062: resolveSocialWorkerUrlFromRoot — lê platform.config.json fail-soft", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-14062-"));
  try {
    // sem arquivo: só o env conta
    assert.equal(resolveSocialWorkerUrlFromRoot(dir, { env: {} }), "");
    assert.equal(resolveSocialWorkerUrlFromRoot(dir, { env: { DIARIA_LINKEDIN_CRON_URL: "env" } }), "env");
    // JSON inválido: idem
    writeFileSync(join(dir, "platform.config.json"), "{nope");
    assert.equal(resolveSocialWorkerUrlFromRoot(dir, { env: {} }), "");
    // config válido
    writeFileSync(
      join(dir, "platform.config.json"),
      JSON.stringify({ publishing: { social: { linkedin: { cloudflare_worker_url: "li" } } } }),
    );
    assert.equal(resolveSocialWorkerUrlFromRoot(dir, { env: {} }), "li");
    assert.equal(resolveSocialWorkerUrlFromRoot(dir, { env: { DIARIA_LINKEDIN_CRON_URL: "" }, emptyEnvFallsThrough: true }), "li");
    assert.equal(resolveSocialWorkerUrlFromRoot(dir, { env: { DIARIA_LINKEDIN_CRON_URL: "" } }), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
