/**
 * test/robots-txt-drift-check.test.ts (#4910 item 3)
 *
 * Regressão pura pra `scripts/lib/robots-txt-drift-check.ts` — os 4 casos de
 * fixture que a própria issue #4910 pediu (arquivo servido hoje reprova;
 * saída limpa de `renderCuradoriaRobotsTxt` aprova; caso com Disallow pra
 * OAI-SearchBot reprova; caso com Disallow só de path específico aprova) +
 * fingerprint/idempotência do alarme. Nenhum teste bate em rede — o
 * resultado do fetch entra já resolvido (mesmo padrão de
 * `test/hub-drift-check.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderCuradoriaRobotsTxt } from "../scripts/lib/shared/robots-txt.ts";
import {
  parseRobotsBlocks,
  isBotBlockedByNamedGroup,
  analyzeRobotsTxt,
  evaluateRobotsDrift,
  evaluateAllRobotsDrift,
  hasPendingRobotsDrift,
  computeRobotsDriftFingerprint,
  emptyRobotsDriftAlarmState,
  advanceRobotsDriftState,
  shouldAlarmRobotsDrift,
  buildRobotsDriftAlarmEmail,
  type RobotsCheckInput,
} from "../scripts/lib/robots-txt-drift-check.ts";

const HOST = "arquivo.diar.ia.br";
const URL = `https://${HOST}/robots.txt`;

function input(overrides: Partial<RobotsCheckInput> = {}): RobotsCheckInput {
  return { host: HOST, url: URL, robotsTxt: null, httpStatus: null, fetchError: null, ...overrides };
}

/**
 * Fixture (a) — reconstrução do arquivo SERVIDO por arquivo.diar.ia.br em
 * 10/08/2026 (#4910, dump verificado ao vivo no corpo da issue): bloco
 * gerenciado da Cloudflare (9 Disallow: /, delimitado por
 * `# BEGIN Cloudflare Managed content` / `# END Cloudflare Managed
 * content`) ANEXADO antes do bloco próprio do Worker (2 Disallow: /,
 * Amazonbot + CloudflareBrowserRenderingCrawler — os únicos que
 * CURADORIA_BLOCKED_BOTS declara). O formato exato de cada bloco de bot
 * (delimitadores, ordem, linha em branco) segue o robots.txt gerenciado
 * documentado publicamente pela Cloudflare; o que este teste precisa
 * capturar fielmente é o INVARIANTE relatado na issue — 9+2 Disallow: /,
 * os 7 crawlers de assistente/treino do #4546 bloqueados pelo bloco da
 * Cloudflare, delimitador presente.
 */
const SERVED_ARQUIVO_ROBOTS_TXT_260810 = `# BEGIN Cloudflare Managed content
User-agent: *
Content-Signal: search=yes, ai-train=no, use=reference
Allow: /

User-agent: Amazonbot
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: CloudflareBrowserRenderingCrawler
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: GPTBot
Disallow: /

User-agent: meta-externalagent
Disallow: /
# END Cloudflare Managed content

User-agent: *
Content-Signal: search=yes,ai-train=yes,use=reference
Allow: /

User-agent: Amazonbot
Disallow: /

User-agent: CloudflareBrowserRenderingCrawler
Disallow: /

Sitemap: https://arquivo.diar.ia.br/sitemap.xml
`;

describe("parseRobotsBlocks (#4910)", () => {
  it("agrupa User-agent consecutivas no mesmo bloco (spec RFC 9309)", () => {
    const blocks = parseRobotsBlocks("User-agent: A\nUser-agent: B\nDisallow: /\n");
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].agents, ["A", "B"]);
    assert.deepEqual(blocks[0].directives, ["Disallow: /"]);
  });

  it("uma nova User-agent DEPOIS de já ter diretiva abre um bloco novo", () => {
    const blocks = parseRobotsBlocks("User-agent: A\nDisallow: /\nUser-agent: B\nDisallow: /x\n");
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0].agents, ["A"]);
    assert.deepEqual(blocks[1].agents, ["B"]);
  });

  it("ignora comentários e linhas em branco", () => {
    const blocks = parseRobotsBlocks("# comentário\nUser-agent: *\n\nAllow: / # outro comentário\n");
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].directives, ["Allow: /"]);
  });
});

describe("isBotBlockedByNamedGroup (#4910)", () => {
  it("bot com grupo nomeado + Disallow: / geral -> true", () => {
    const blocks = parseRobotsBlocks("User-agent: GPTBot\nDisallow: /\n");
    assert.equal(isBotBlockedByNamedGroup(blocks, "GPTBot"), true);
  });

  it("case-insensitive no nome do bot", () => {
    const blocks = parseRobotsBlocks("User-agent: gptbot\nDisallow: /\n");
    assert.equal(isBotBlockedByNamedGroup(blocks, "GPTBot"), true);
  });

  it("bot só no curinga * (sem grupo nomeado próprio) -> false", () => {
    const blocks = parseRobotsBlocks("User-agent: *\nDisallow: /\n");
    assert.equal(isBotBlockedByNamedGroup(blocks, "GPTBot"), false);
  });

  it("bot com grupo nomeado mas só Disallow de path específico -> false", () => {
    const blocks = parseRobotsBlocks("User-agent: GPTBot\nDisallow: /vote\n");
    assert.equal(isBotBlockedByNamedGroup(blocks, "GPTBot"), false);
  });

  it("bot sem grupo nenhum -> false", () => {
    const blocks = parseRobotsBlocks("User-agent: Amazonbot\nDisallow: /\n");
    assert.equal(isBotBlockedByNamedGroup(blocks, "GPTBot"), false);
  });
});

describe("analyzeRobotsTxt + evaluateRobotsDrift — os 4 casos de fixture pedidos pela issue #4910", () => {
  it("(a) arquivo servido hoje (10/08/2026, dump da issue) -> REPROVA: bloco gerenciado presente + 7 bots de assistente/treino bloqueados", () => {
    const analysis = analyzeRobotsTxt(SERVED_ARQUIVO_ROBOTS_TXT_260810);
    assert.equal(analysis.hasCloudflareManagedBlock, true);
    assert.deepEqual(
      [...analysis.unexpectedBlockedBots].sort(),
      [
        "Applebot-Extended",
        "Bytespider",
        "CCBot",
        "ClaudeBot",
        "GPTBot",
        "Google-Extended",
        "meta-externalagent",
      ].sort(),
    );
    // Amazonbot/CloudflareBrowserRenderingCrawler estão bloqueados mas SÃO
    // a allowlist (CURADORIA_BLOCKED_BOTS) — não devem aparecer aqui.
    assert.ok(!analysis.unexpectedBlockedBots.includes("Amazonbot"));
    assert.ok(!analysis.unexpectedBlockedBots.includes("CloudflareBrowserRenderingCrawler"));
    // Nenhum bot de recuperação está bloqueado hoje (ver "Por que importa"
    // da issue: OAI-SearchBot/Claude-SearchBot/PerplexityBot/Googlebot/
    // Bingbot caem no curinga com Allow: /).
    assert.deepEqual(analysis.blockedRecoveryBots, []);

    const result = evaluateRobotsDrift(
      input({ robotsTxt: SERVED_ARQUIVO_ROBOTS_TXT_260810, httpStatus: 200 }),
    );
    assert.equal(result.status, "drift");
    assert.match(result.message, /Cloudflare Managed content/);
    assert.match(result.message, /GPTBot/);
  });

  it("(b) saída limpa de renderCuradoriaRobotsTxt -> APROVA (sem bloco gerenciado, sem drift)", () => {
    const clean = renderCuradoriaRobotsTxt(`https://${HOST}/sitemap.xml`);
    const analysis = analyzeRobotsTxt(clean);
    assert.equal(analysis.hasCloudflareManagedBlock, false);
    assert.deepEqual(analysis.unexpectedBlockedBots, []);
    assert.deepEqual(analysis.blockedRecoveryBots, []);

    const result = evaluateRobotsDrift(input({ robotsTxt: clean, httpStatus: 200 }));
    assert.equal(result.status, "ok");
  });

  it("(c) Disallow: / geral pra OAI-SearchBot -> REPROVA por bot de recuperação bloqueado (caso mais grave)", () => {
    const withRecoveryBotBlocked = `User-agent: *
Allow: /

User-agent: OAI-SearchBot
Disallow: /
`;
    const analysis = analyzeRobotsTxt(withRecoveryBotBlocked);
    assert.deepEqual(analysis.blockedRecoveryBots, ["OAI-SearchBot"]);

    const result = evaluateRobotsDrift(input({ robotsTxt: withRecoveryBotBlocked, httpStatus: 200 }));
    assert.equal(result.status, "drift");
    assert.match(result.message, /RECUPERAÇÃO/);
    assert.match(result.message, /OAI-SearchBot/);
  });

  it("(d) Disallow só de path específico (/vote) sob User-agent: * -> APROVA (não é bloqueio geral)", () => {
    const pathSpecificOnly = renderCuradoriaRobotsTxt(`https://${HOST}/sitemap.xml`, {
      extraDisallowPaths: ["/vote"],
    });
    const analysis = analyzeRobotsTxt(pathSpecificOnly);
    assert.equal(analysis.hasCloudflareManagedBlock, false);
    assert.deepEqual(analysis.unexpectedBlockedBots, []);
    assert.deepEqual(analysis.blockedRecoveryBots, []);

    const result = evaluateRobotsDrift(input({ robotsTxt: pathSpecificOnly, httpStatus: 200 }));
    assert.equal(result.status, "ok");
  });
});

describe("evaluateRobotsDrift — falha de rede / HTTP != 200 (#4910)", () => {
  it("fetchError preenchido -> status error, nunca tenta analisar corpo", () => {
    const r = evaluateRobotsDrift(input({ fetchError: "ECONNREFUSED", httpStatus: 200, robotsTxt: "lixo" }));
    assert.equal(r.status, "error");
    assert.equal(r.httpStatus, null);
    assert.match(r.message, /ECONNREFUSED/);
  });

  it("HTTP 404 -> status error", () => {
    const r = evaluateRobotsDrift(input({ httpStatus: 404, robotsTxt: null }));
    assert.equal(r.status, "error");
    assert.match(r.message, /404/);
  });

  it("HTTP 200 mas robotsTxt null (defensivo) -> status error", () => {
    const r = evaluateRobotsDrift(input({ httpStatus: 200, robotsTxt: null }));
    assert.equal(r.status, "error");
  });
});

describe("evaluateAllRobotsDrift (#4910)", () => {
  it("mapeia evaluateRobotsDrift sobre a lista inteira, preservando ordem", () => {
    const clean = renderCuradoriaRobotsTxt(`https://${HOST}/sitemap.xml`);
    const results = evaluateAllRobotsDrift([
      input({ host: "a.example", robotsTxt: clean, httpStatus: 200 }),
      input({ host: "b.example", robotsTxt: SERVED_ARQUIVO_ROBOTS_TXT_260810, httpStatus: 200 }),
    ]);
    assert.deepEqual(results.map((r) => r.host), ["a.example", "b.example"]);
    assert.deepEqual(results.map((r) => r.status), ["ok", "drift"]);
  });

  it("lista vazia -> lista vazia", () => {
    assert.deepEqual(evaluateAllRobotsDrift([]), []);
  });
});

describe("idempotência do alarme (fingerprint + estado) — #4910", () => {
  const clean = renderCuradoriaRobotsTxt(`https://${HOST}/sitemap.xml`);
  const driftInput = input({ robotsTxt: SERVED_ARQUIVO_ROBOTS_TXT_260810, httpStatus: 200 });
  const okInput = input({ host: "outro.example", robotsTxt: clean, httpStatus: 200 });

  it("sem drift pendente -> hasPendingRobotsDrift false, shouldAlarm false", () => {
    const results = evaluateAllRobotsDrift([okInput]);
    assert.equal(hasPendingRobotsDrift(results), false);
    assert.equal(shouldAlarmRobotsDrift(emptyRobotsDriftAlarmState(), results), false);
  });

  it("drift novo -> shouldAlarm true a partir do estado vazio", () => {
    const results = evaluateAllRobotsDrift([driftInput]);
    assert.equal(hasPendingRobotsDrift(results), true);
    assert.equal(shouldAlarmRobotsDrift(emptyRobotsDriftAlarmState(), results), true);
  });

  it("mesmo drift já alarmado -> shouldAlarm false (não re-envia)", () => {
    const results = evaluateAllRobotsDrift([driftInput]);
    const fp = computeRobotsDriftFingerprint(results);
    const state = advanceRobotsDriftState(fp, new Date());
    assert.equal(shouldAlarmRobotsDrift(state, results), false);
  });

  it("drift resolvido (host limpo depois) -> cursor re-arma (fingerprint null)", () => {
    const driftResults = evaluateAllRobotsDrift([driftInput]);
    const fp = computeRobotsDriftFingerprint(driftResults);
    const alarmedState = advanceRobotsDriftState(fp, new Date());

    const cleanResults = evaluateAllRobotsDrift([okInput]);
    assert.equal(hasPendingRobotsDrift(cleanResults), false);
    const rearmedState = advanceRobotsDriftState(null, new Date());
    assert.equal(rearmedState.lastAlarmedFingerprint, null);

    // Se o MESMO drift original reaparecer depois, alarma de novo mesmo
    // partindo do cursor re-armado.
    assert.equal(shouldAlarmRobotsDrift(rearmedState, driftResults), true);
    void alarmedState;
  });

  it("fingerprint muda quando um motivo novo aparece (ex: bot de recuperação passa a bloquear)", () => {
    const before = evaluateAllRobotsDrift([driftInput]);
    const withRecoveryBotBlocked = input({
      robotsTxt: `${SERVED_ARQUIVO_ROBOTS_TXT_260810}\nUser-agent: Googlebot\nDisallow: /\n`,
      httpStatus: 200,
    });
    const after = evaluateAllRobotsDrift([withRecoveryBotBlocked]);
    assert.notEqual(computeRobotsDriftFingerprint(before), computeRobotsDriftFingerprint(after));
  });
});

describe("buildRobotsDriftAlarmEmail (#4910)", () => {
  it("lista só hosts com drift/error, cita motivo e URL", () => {
    const clean = renderCuradoriaRobotsTxt(`https://${HOST}/sitemap.xml`);
    const results = evaluateAllRobotsDrift([
      input({ host: "ok.example", url: "https://ok.example/robots.txt", robotsTxt: clean, httpStatus: 200 }),
      input({ robotsTxt: SERVED_ARQUIVO_ROBOTS_TXT_260810, httpStatus: 200 }),
    ]);
    const { subject, body } = buildRobotsDriftAlarmEmail(results);
    assert.match(subject, /1 host/);
    assert.doesNotMatch(body, /ok\.example/);
    assert.match(body, new RegExp(HOST));
    assert.match(body, /Cloudflare Managed content/);
  });
});
