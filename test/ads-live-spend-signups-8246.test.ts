/**
 * test/ads-live-spend-signups-8246.test.ts (#8246)
 *
 * `scripts/ads-live-spend-signups.ts` porta `gasto-ao-vivo.mts` (só existia
 * fora do git, em `~/.claude/scheduled-tasks/relatorio-diario-teste-2608/`
 * no Neo) pro repo. Cobre as 3 partes puras testáveis sem rede: os 2
 * formatadores de tabela e o force de env restrito às 3 chaves conhecidas
 * poluídas (#8237) — nunca bate na API do Google/Microsoft/Meta/Kit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatSpendTable,
  formatSignupsTable,
  forceFromDotenvText,
  FORCE_FROM_DOTENV_KEYS,
} from "../scripts/ads-live-spend-signups.ts";

describe("#8246 — ads-live-spend-signups: formatadores e force de env", () => {
  it("formatSpendTable ordena por data e acumula, independente da ordem de entrada", () => {
    const out = formatSpendTable("Google Ads (teste 2608)", [
      { date: "2026-09-07", gastoBrl: 50 },
      { date: "2026-09-05", gastoBrl: 100 },
      { date: "2026-09-06", gastoBrl: 30 },
    ]);
    const lines = out.trim().split("\n");
    assert.equal(lines[0], "Google Ads (teste 2608)");
    assert.match(lines[2], /2026-09-05\s+100\.00\s+100\.00/);
    assert.match(lines[3], /2026-09-06\s+30\.00\s+130\.00/);
    assert.match(lines[4], /2026-09-07\s+50\.00\s+180\.00/);
  });

  it("formatSignupsTable acumula inteiros, sem casas decimais", () => {
    const out = formatSignupsTable("Microsoft Ads (teste 2608)", [
      { date: "2026-09-06", cadastros: 2 },
      { date: "2026-09-07", cadastros: 3 },
    ]);
    const lines = out.trim().split("\n");
    assert.match(lines[2], /2026-09-06\s+2\s+2/);
    assert.match(lines[3], /2026-09-07\s+3\s+5/);
  });

  it("formatSignupsTable avisa que a contagem é bruta (sem excluir e-mail de teste)", () => {
    const out = formatSignupsTable("Google Ads (teste 2608)", []);
    assert.match(out, /contagem bruta, sem excluir e-mail de teste/);
  });

  it("forceFromDotenvText só sobrescreve as 3 chaves da allowlist, nunca outras", () => {
    const target: NodeJS.ProcessEnv = {
      GOOGLE_CLIENT_ID: "poluido-pelo-app-desktop",
      GOOGLE_CLIENT_SECRET: "poluido-tambem",
      MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN: "token-velho",
      OUTRA_VAR_QUALQUER: "nunca deveria mudar",
    };
    const envText = [
      "GOOGLE_CLIENT_ID=id-do-dotenv",
      'GOOGLE_CLIENT_SECRET="secret-do-dotenv"',
      "MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN=refresh-do-dotenv",
      "OUTRA_VAR_QUALQUER=nao-deveria-forcar-mesmo-presente-no-dotenv",
    ].join("\n");
    forceFromDotenvText(envText, FORCE_FROM_DOTENV_KEYS, target);
    assert.equal(target.GOOGLE_CLIENT_ID, "id-do-dotenv");
    assert.equal(target.GOOGLE_CLIENT_SECRET, "secret-do-dotenv", "aspas do .env devem ser removidas");
    assert.equal(target.MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN, "refresh-do-dotenv");
    assert.equal(target.OUTRA_VAR_QUALQUER, "nunca deveria mudar", "força restrita às 3 chaves — nunca generalizar (#8237)");
  });

  it("forceFromDotenvText não mexe numa chave ausente do .env", () => {
    const target: NodeJS.ProcessEnv = { GOOGLE_CLIENT_ID: "valor-original" };
    forceFromDotenvText("OUTRA_COISA=x", FORCE_FROM_DOTENV_KEYS, target);
    assert.equal(target.GOOGLE_CLIENT_ID, "valor-original");
  });
});
