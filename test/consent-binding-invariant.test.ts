/**
 * test/consent-binding-invariant.test.ts (#1575, moved to stage-5 in #1612)
 *
 * Cobre o invariant `consent-binding` em stage-5 (era stage-4 até review
 * #1612 — data verificada só existe pós-dispatch). Canais com consent=auto
 * devem ter dispatch real (não pending_manual / ausente / vazio).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// #2154 pass-2: checkConsentBinding vive em stage-5.ts (dados pós-dispatch).
// A cópia órfã em stage-4.ts foi removida; testes agora importam da fonte canônica.
import { STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";
import { checkConsentBinding, loadSocialsFromConfig, checkInstagramCredsSet, STAGE_5_RULES } from "../scripts/lib/invariant-checks/stage-5.ts";

function makeEditionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "consent-binding-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function writeConsent(
  dir: string,
  consent: { newsletter?: string; linkedin?: string; facebook?: string },
): void {
  writeFileSync(
    resolve(dir, "_internal", "05-publish-consent.json"),
    JSON.stringify(consent),
  );
}

function writePublished(
  dir: string,
  pub: { status?: string; draft_url?: string; post_id?: string },
): void {
  writeFileSync(
    resolve(dir, "_internal", "05-published.json"),
    JSON.stringify(pub),
  );
}

function writeSocialPublished(
  dir: string,
  posts: Array<{ platform: string; status?: string; url?: string | null }>,
): void {
  writeFileSync(
    resolve(dir, "_internal", "06-social-published.json"),
    JSON.stringify({ posts }),
  );
}

describe("consent-binding stage registration (#1612 followup)", () => {
  it("rule registrada em STAGE_5_RULES (data verificada é pós-dispatch)", () => {
    assert.ok(
      STAGE_5_RULES.some((r) => r.id === "consent-binding"),
      "consent-binding deve estar em STAGE_5_RULES",
    );
  });

  it("rule NÃO está em STAGE_4_RULES (regression guard #1602)", () => {
    assert.ok(
      !STAGE_4_RULES.some((r) => r.id === "consent-binding"),
      "consent-binding em STAGE_4_RULES short-circuita (files post-dispatch ausentes em 4a-bis)",
    );
  });
});

describe("checkConsentBinding (#1575)", () => {
  it("sem 05-publish-consent.json → no-op (zero violations)", () => {
    const dir = makeEditionDir();
    try {
      const violations = checkConsentBinding(dir);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.newsletter=auto + 05-published.json ausente → violation", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "auto", linkedin: "manual", facebook: "manual" });
      const violations = checkConsentBinding(dir);
      assert.ok(violations.length > 0);
      const nl = violations.find((v) => v.rule === "consent-binding-newsletter");
      assert.ok(nl);
      assert.match(nl!.message, /05-published\.json ausente/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.newsletter=auto + 05-published.json com pending_manual → violation", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "auto", linkedin: "manual", facebook: "manual" });
      writePublished(dir, { status: "pending_manual" });
      const violations = checkConsentBinding(dir);
      assert.ok(violations.length > 0);
      const nl = violations.find((v) => v.rule === "consent-binding-newsletter");
      assert.ok(nl);
      assert.match(nl!.message, /pending_manual/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.newsletter=auto + 05-published.json com draft_url → ok", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "auto", linkedin: "manual", facebook: "manual" });
      writePublished(dir, {
        status: "draft",
        draft_url: "https://app.beehiiv.com/posts/abc/edit",
      });
      const violations = checkConsentBinding(dir);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.newsletter=manual → não exige dispatch (sem violation)", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "manual", facebook: "manual" });
      // Nada em 05-published.json — manual, ok não dispatchar
      const violations = checkConsentBinding(dir);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.linkedin=auto + 06-social-published.json ausente → violation", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "auto", facebook: "manual" });
      const violations = checkConsentBinding(dir);
      const li = violations.find((v) => v.rule === "consent-binding-social");
      assert.ok(li);
      assert.match(li!.message, /linkedin/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.facebook=auto + posts[platform=facebook] vazio → violation", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "manual", facebook: "auto" });
      writeSocialPublished(dir, [
        { platform: "linkedin", url: "https://linkedin.com/x" },
      ]);
      const violations = checkConsentBinding(dir);
      const fb = violations.find((v) => v.rule === "consent-binding-facebook");
      assert.ok(fb);
      assert.match(fb!.message, /vazio/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.{linkedin,facebook}=auto + ambos com posts → ok", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "auto", facebook: "auto" });
      writeSocialPublished(dir, [
        // Shape REAL: LinkedIn worker_queue grava url=null no write (a URL só
        // existe depois que o Worker dispara o post agendado). Facebook (Graph
        // API) retorna url na hora.
        { platform: "linkedin", status: "scheduled", url: null },
        { platform: "facebook", status: "draft", url: "https://facebook.com/x" },
      ]);
      const violations = checkConsentBinding(dir);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("regression #1664 false-positive: LinkedIn auto-dispatch (scheduled, url=null) NÃO viola", () => {
    // O review da PR pegou: o check `!p.url` flagava TODA edição real
    // (260525-260601) porque LinkedIn worker_queue grava url=null no write.
    // Um post scheduled sem url é dispatch legítimo, não bypass.
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "auto", facebook: "manual" });
      writeSocialPublished(dir, [
        { platform: "linkedin", status: "scheduled", url: null },
        { platform: "linkedin", status: "scheduled", url: null },
        { platform: "linkedin", status: "scheduled", url: null },
      ]);
      const violations = checkConsentBinding(dir);
      assert.ok(
        !violations.some((v) => v.rule === "consent-binding-linkedin"),
        `LinkedIn scheduled/url=null é dispatch real, não deveria violar; got: ${JSON.stringify(violations)}`,
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("regression #1664: consent.linkedin=auto + post stub pending_manual (sem url) → violation", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "auto", facebook: "manual" });
      // O bypass que escapava pré-#1664: post existe mas é pending_manual (não dispatchado).
      writeSocialPublished(dir, [{ platform: "linkedin", status: "pending_manual" }]);
      const violations = checkConsentBinding(dir);
      const li = violations.find((v) => v.rule === "consent-binding-linkedin");
      assert.ok(li, `esperava violation linkedin; got: ${JSON.stringify(violations)}`);
      assert.match(li!.message, /pending_manual|dispatch automático/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#1682: bypass PARCIAL (1 scheduled + 2 pending_manual) → violation (allowlist)", () => {
    // O blacklist anterior (.every pending_manual) NÃO pegava: 1 dispatchado já
    // fazia .every() false. A allowlist viola se QUALQUER post não tem status de
    // dispatch reconhecido.
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "auto", facebook: "manual" });
      writeSocialPublished(dir, [
        { platform: "linkedin", status: "scheduled", url: null },
        { platform: "linkedin", status: "pending_manual" },
        { platform: "linkedin", status: "pending_manual" },
      ]);
      const violations = checkConsentBinding(dir);
      assert.ok(
        violations.some((v) => v.rule === "consent-binding-linkedin"),
        `bypass parcial deveria violar; got: ${JSON.stringify(violations)}`,
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#1682: status off-enum ('skipped') → violation (allowlist, não blacklist)", () => {
    // 'skipped' é truthy != pending_manual → o blacklist tratava como dispatched.
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "auto", facebook: "manual" });
      writeSocialPublished(dir, [{ platform: "linkedin", status: "skipped" }]);
      const violations = checkConsentBinding(dir);
      assert.ok(
        violations.some((v) => v.rule === "consent-binding-linkedin"),
        `status off-enum deveria violar; got: ${JSON.stringify(violations)}`,
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#1682: all-failed → SEM consent violation (foi tentado; sibling no-failed cobre)", () => {
    // 'failed' está no allowlist de dispatch — a tentativa aconteceu. A falha em
    // si é coberta por social-published-no-failed (stage-5), não pelo consent.
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "auto", facebook: "manual" });
      writeSocialPublished(dir, [
        { platform: "linkedin", status: "failed", url: null },
        { platform: "linkedin", status: "failed", url: null },
        { platform: "linkedin", status: "failed", url: null },
      ]);
      const violations = checkConsentBinding(dir);
      assert.ok(
        !violations.some((v) => v.rule === "consent-binding-linkedin"),
        `all-failed NÃO deve violar consent (foi dispatchado); got: ${JSON.stringify(violations)}`,
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#1664: consent.facebook=auto + post sem url → violation", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "manual", facebook: "auto" });
      writeSocialPublished(dir, [{ platform: "facebook" }]); // sem url, sem status
      const violations = checkConsentBinding(dir);
      assert.ok(violations.some((v) => v.rule === "consent-binding-facebook"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#1682 (reverte #1664): dispatch parcial (1 real + 1 manual) VIOLA — allowlist", () => {
    // #1664 originalmente tratava "pelo menos 1 real" como OK. #1682 reverteu:
    // consent=auto significa que TODOS devem dispatchar; 1 real + 1 pending_manual
    // é silent-bypass parcial (o exato gap que o #1575 existe pra pegar). A
    // allowlist viola se QUALQUER post não tem status de dispatch reconhecido.
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "auto", facebook: "manual" });
      writeSocialPublished(dir, [
        { platform: "linkedin", status: "scheduled", url: null }, // dispatch real (worker_queue)
        { platform: "linkedin", status: "pending_manual" }, // não dispatchado → bypass parcial
      ]);
      const violations = checkConsentBinding(dir);
      assert.ok(
        violations.some((v) => v.rule === "consent-binding-linkedin"),
        `esperava violation linkedin (bypass parcial); got: ${JSON.stringify(violations)}`,
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Cenário real 260529: consent=tudo auto + dispatch newsletter pulado → violation loud", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "auto", linkedin: "auto", facebook: "auto" });
      // Newsletter ausente (orchestrator bypassou Chrome MCP)
      // Social com posts
      writeSocialPublished(dir, [
        { platform: "linkedin", status: "scheduled", url: null },
        { platform: "facebook", status: "draft", url: "https://facebook.com/x" },
      ]);
      const violations = checkConsentBinding(dir);
      assert.ok(violations.length > 0);
      assert.ok(violations.some((v) => v.rule === "consent-binding-newsletter"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ─── #2488: loadSocialsFromConfig + checkConsentBinding dinâmico ─────────────
// Regressão: checagem de consent deve iterar platform.config.json#socials
// em vez de hard-codar ["linkedin","facebook","instagram"].

describe("loadSocialsFromConfig (#2488)", () => {
  it("retorna array quando platform.config.json tem socials válido", () => {
    // Testa o path real do repo — platform.config.json tem ["linkedin","facebook","instagram"]
    const socials = loadSocialsFromConfig();
    assert.ok(Array.isArray(socials), "deve retornar array");
    assert.ok(socials.length >= 2, "deve ter ao menos 2 canais");
    assert.ok(socials.includes("linkedin"), "deve incluir linkedin");
    assert.ok(socials.includes("facebook"), "deve incluir facebook");
  });

  it("inclui instagram (canal adicionado em #49)", () => {
    const socials = loadSocialsFromConfig();
    assert.ok(socials.includes("instagram"), "deve incluir instagram do config atual");
  });

  it("inclui threads (canal adicionado em #2479)", () => {
    const socials = loadSocialsFromConfig();
    assert.ok(socials.includes("threads"), "deve incluir threads do config atual");
  });
});

// #2486 / #633: regressão de severity — Instagram sem creds é warning (não error),
// espelhando a assimetria documentada (best-effort, não bloqueia o pipeline).
describe("checkInstagramCredsSet — severity warning (#2486)", () => {
  it("creds ausentes → violations com severity 'warning' (não 'error')", () => {
    const saved = {
      id: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
      token: process.env.INSTAGRAM_ACCESS_TOKEN,
    };
    try {
      delete process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
      delete process.env.INSTAGRAM_ACCESS_TOKEN;
      const violations = checkInstagramCredsSet();
      assert.ok(violations.length >= 1, "creds ausentes devem gerar ao menos 1 violation");
      assert.ok(
        violations.every((v) => v.severity === "warning"),
        `todas as violations de IG creds devem ser warning; got: ${JSON.stringify(violations.map((v) => v.severity))}`,
      );
    } finally {
      if (saved.id !== undefined) process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = saved.id;
      if (saved.token !== undefined) process.env.INSTAGRAM_ACCESS_TOKEN = saved.token;
    }
  });
});

describe("checkConsentBinding — canais dinâmicos via platform.config (#2488)", () => {
  it("canal do config com consent=auto e sem posts → violation para esse canal", () => {
    // Verifica que o canal "instagram" (presente no config) gera violation
    // quando consent=auto mas posts ausentes — via iteração do config, não hard-code.
    const dir = makeEditionDir();
    try {
      writeFileSync(
        resolve(dir, "_internal", "05-publish-consent.json"),
        JSON.stringify({ newsletter: "manual", linkedin: "manual", facebook: "manual", instagram: "auto" }),
      );
      writeSocialPublished(dir, [
        // linkedin e facebook OK, instagram ausente
        { platform: "linkedin", status: "scheduled", url: null },
        { platform: "facebook", status: "scheduled", url: null },
      ]);
      const violations = checkConsentBinding(dir);
      assert.ok(
        violations.some((v) => v.rule === "consent-binding-instagram"),
        `esperava consent-binding-instagram; got: ${JSON.stringify(violations.map((v) => v.rule))}`,
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // #2486: Instagram é best-effort — consent.instagram=auto sem posts (creds ausentes →
  // publish-instagram sai 0 sem escrever) deve ser WARNING, não ERROR (não trava o gate).
  it("#2486: consent.instagram=auto + sem posts IG → severity warning (best-effort)", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(
        resolve(dir, "_internal", "05-publish-consent.json"),
        JSON.stringify({ newsletter: "manual", linkedin: "manual", facebook: "manual", instagram: "auto" }),
      );
      writeSocialPublished(dir, [{ platform: "linkedin", status: "scheduled", url: null }]);
      const violations = checkConsentBinding(dir);
      const ig = violations.find((v) => v.rule === "consent-binding-instagram");
      assert.ok(ig, "esperava consent-binding-instagram");
      assert.equal(ig!.severity, "warning", "Instagram best-effort → warning, não error");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // #2486: contraste — Facebook tem creds obrigatórias, então consent=auto sem posts
  // permanece ERROR (a assimetria de severity vale só para os best-effort).
  it("#2486: consent.facebook=auto + sem posts FB → severity error (creds obrigatórias)", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(
        resolve(dir, "_internal", "05-publish-consent.json"),
        JSON.stringify({ newsletter: "manual", linkedin: "manual", facebook: "auto", instagram: "manual" }),
      );
      writeSocialPublished(dir, [{ platform: "linkedin", status: "scheduled", url: null }]);
      const violations = checkConsentBinding(dir);
      const fb = violations.find((v) => v.rule === "consent-binding-facebook");
      assert.ok(fb, "esperava consent-binding-facebook");
      assert.equal(fb!.severity, "error", "Facebook (creds obrigatórias) → error");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("canal desconhecido no consent (não no config) é ignorado silenciosamente", () => {
    // Se consent contiver "tiktok" mas config#socials não tiver, não deve produzir violation.
    // (O canal seria ignorado pelo loop "for platform of socials".)
    // #2479: usa "tiktok" como canal hipotético — "threads" virou canal real do config,
    // então não serve mais como exemplo de canal-não-configurado.
    const dir = makeEditionDir();
    try {
      writeFileSync(
        resolve(dir, "_internal", "05-publish-consent.json"),
        JSON.stringify({ newsletter: "manual", linkedin: "auto", facebook: "auto", tiktok: "auto" }),
      );
      writeSocialPublished(dir, [
        { platform: "linkedin", status: "scheduled", url: null },
        { platform: "facebook", status: "scheduled", url: null },
      ]);
      const violations = checkConsentBinding(dir);
      // tiktok não está no config → não gera violation
      assert.ok(
        !violations.some((v) => v.rule === "consent-binding-tiktok"),
        `não deve emitir violation para canal não configurado; got: ${JSON.stringify(violations.map((v) => v.rule))}`,
      );
      // linkedin e facebook OK → sem violation
      assert.equal(violations.length, 0,
        `sem violations esperadas; got: ${JSON.stringify(violations)}`);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
