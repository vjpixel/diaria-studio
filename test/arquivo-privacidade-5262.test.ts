/**
 * test/arquivo-privacidade-5262.test.ts (#5262)
 *
 * Trava a rota `GET /privacidade` do Worker `arquivo`.
 *
 * Por que existe: a URL é declarada na tela de consentimento OAuth do projeto
 * Google Cloud `diaria-google-ads` como o link de Política de Privacidade, e o
 * Google REVALIDA essa URL enquanto a marca estiver verificada. Se a rota
 * voltar a 404 (refactor de roteamento, import removido), a verificação de
 * marca cai e, com ela, o caminho de Basic Access da Google Ads API — uma
 * quebra silenciosa que só apareceria semanas depois, num e-mail do Google.
 *
 * Nenhum teste toca a rede: a rota é servida antes de qualquer fetch de
 * sitemap, então não precisa de mock de `globalThis.fetch`.
 *
 * #8543: também trava a coerência entre a política e a coleta de IP, user
 * agent e _fbp ligada nos wrangler.toml de poll e cursos.
 *
 * #10414: e o lado do ENVIO — IP/UA de todo cadastro e reativação vão à
 * Meta (CAPI) com ou sem cookie, e a política não pode prometer o contrário.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../workers/arquivo/src/index.ts";
import { renderPrivacyPage } from "../workers/arquivo/src/render-privacy.ts";
import { parseWorkerKitFieldVars } from "../scripts/lib/kit-worker-custom-fields-guard.ts";
import {
  KIT_CLIENT_IP_FIELD_NAME,
  KIT_FBP_FIELD_NAME,
  KIT_USER_AGENT_FIELD_NAME,
} from "../scripts/lib/google-ads-confirmation-batch.ts";
import {
  buildCompleteRegistrationEvent,
  extractMetaCapiClientSignals,
  selectPersistableMatchSignals,
} from "../scripts/lib/shared/meta-capi.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("#5262 — GET /privacidade no Worker arquivo", () => {
  it("responde 200 em HTML, sem depender do sitemap", async () => {
    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/privacidade"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/html/);
  });

  it("aceita também a forma com barra final", async () => {
    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/privacidade/"));
    assert.equal(res.status, 200);
  });

  it("declara lang pt-BR e um <title> próprio", () => {
    const html = renderPrivacyPage();
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /<title>Política de Privacidade — diar\.ia\.br<\/title>/);
  });

  it("é indexável — a verificação do Google não pode bater numa página noindex", () => {
    assert.doesNotMatch(renderPrivacyPage(), /name="robots"[^>]*noindex/);
  });

  it("expõe um canal de contato para pedidos de LGPD", () => {
    assert.match(renderPrivacyPage(), /mailto:[^"]+@/);
  });

  it("nomeia os terceiros que de fato processam dado de leitor", () => {
    const html = renderPrivacyPage();
    // #7361: Kit é o processador real de 100% dos cadastros novos hoje, e
    // Meta/Microsoft são plataformas de anúncio que recebem confirmação de
    // cadastro (evento de conversão) — nenhum dos 3 era citado.
    for (const vendor of ["Beehiiv", "Kit", "Brevo", "MillionVerifier", "Cloudflare", "Google", "Meta", "Microsoft"]) {
      assert.match(html, new RegExp(`\\b${vendor}\\b`), `política não cita ${vendor}`);
    }
  });

  it("declara a coleta de IP/user agent/_fbp que os workers de cadastro fazem, com os nomes que o lote lê (#8543)", () => {
    // Coerência política × código × leitor. Os workers poll e cursos gravam
    // IP, user agent e _fbp no Kit quando o request tem sinal da Meta
    // (selectPersistableMatchSignals); o lote SubscriptionConfirmed relê pelas
    // constantes KIT_*_FIELD_NAME. Desligar a coleta derruba este teste de
    // propósito: a política tem de ser revista junto.
    const expected: Record<string, string> = {
      KIT_ORIGEM_CLIENTIP_FIELD: KIT_CLIENT_IP_FIELD_NAME,
      KIT_ORIGEM_USERAGENT_FIELD: KIT_USER_AGENT_FIELD_NAME,
      KIT_ORIGEM_FBP_FIELD: KIT_FBP_FIELD_NAME,
    };
    for (const worker of ["poll", "cursos"]) {
      const vars = parseWorkerKitFieldVars(worker, readFileSync(join(ROOT, "workers", worker, "wrangler.toml"), "utf8"));
      for (const [varName, fieldKey] of Object.entries(expected)) {
        const got = vars.find((v) => v.varName === varName);
        assert.equal(
          got?.fieldKey,
          fieldKey,
          `${worker}: ${varName} ausente ou diferente do que o lote lê (revisar a política junto)`,
        );
      }
    }
    const html = renderPrivacyPage();
    assert.match(html, /endereço IP/);
    assert.match(html, /enviados à Meta/);
    assert.match(html, /cookies de medição de anúncios/);
    assert.doesNotMatch(html, /não usam cookies de rastreamento publicitário/);
  });

  describe("#10414 — lado do ENVIO: IP/UA vão à Meta em todo cadastro e reativação", () => {
    // O #8543 travou o lado do ARMAZENAMENTO (Kit, gateado pelo cookie via
    // selectPersistableMatchSignals), mas a política dizia que IP/UA só
    // eram coletados "quando o seu navegador tem o cookie de medição da
    // Meta". O CAPI envia IP/UA de TODO cadastro (poll, cursos) e de TODA
    // reativação (reativar), sem gate. Decisão do editor (briefing 261018d):
    // alinhar o texto ao comportamento, não gatear o envio.

    it("o evento montado a partir de um request SEM cookie da Meta carrega IP e user agent", async () => {
      const headers = new Headers({
        "CF-Connecting-IP": "203.0.113.7",
        "user-agent": "Mozilla/5.0 (teste #10414)",
      });
      const clientSignals = extractMetaCapiClientSignals(headers);
      assert.equal(clientSignals.fbp, undefined, "premissa: request sem _fbp");
      // O que é PERSISTIDO continua gateado pelo cookie...
      assert.deepEqual(selectPersistableMatchSignals(clientSignals, undefined), {});
      // ...mas o que é ENVIADO à Meta não é.
      const event = await buildCompleteRegistrationEvent({
        email: "leitor@example.com",
        eventSourceUrl: "https://diar.ia.br/",
        clientSignals,
      });
      assert.equal(event.user_data.client_ip_address, "203.0.113.7");
      assert.equal(event.user_data.client_user_agent, "Mozilla/5.0 (teste #10414)");
    });

    it("os 3 workers que disparam o evento passam os sinais do request sem gate de cookie", () => {
      for (const file of ["workers/poll/src/subscribe.ts", "workers/cursos/src/subscribe.ts", "workers/reativar/src/index.ts"]) {
        const src = readFileSync(join(ROOT, file), "utf8");
        assert.match(src, /extractMetaCapiClientSignals\(/, `${file}: não extrai mais IP/UA do request — revisar a política junto`);
        assert.match(
          src,
          /sendCompleteRegistrationEvent\(\s*\{[^}]*\bclientSignals\b[^}]*\}/,
          `${file}: o evento CAPI não leva mais clientSignals — revisar a política junto`,
        );
      }
    });

    it("a política declara o envio em todo cadastro e reativação, sem prometer gate por cookie", () => {
      const html = renderPrivacyPage();
      assert.match(html, /em todo cadastro e em toda reativação/);
      assert.match(html, /tenha o seu navegador o cookie de medição da Meta ou não/);
      // A redação anterior, que condicionava a coleta ao cookie, não pode voltar.
      assert.doesNotMatch(html, /quando o seu navegador tem o cookie de medição da Meta/i);
      assert.doesNotMatch(html, /Dados técnicos do cadastro, quando/);
    });
  });
});
