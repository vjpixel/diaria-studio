/**
 * Invariants pós-publicação — Stage 5 (#1007 Fase 1, #1694).
 *
 * Rodam após Stage 5 (Publicação) dispatch completo (newsletter + LinkedIn + Facebook),
 * antes do auto-reporter. Detectam falhas silenciosas que aparecem só após
 * publicar — ex: sentinel não escrito, social-published incompleto.
 *
 * (#1694: Stage 5 era Stage 4 antes do split Revisão+Publicação)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantRule, InvariantViolation } from "./types.ts";
// #1694 finding 9: checkConsentBinding movida para cá — elimina acoplamento
// cruzado com stage-4.ts. A função verifica dados pós-dispatch (05-published.json,
// 06-social-published.json) que só existem no Stage 5 (Publicação).
// #2154: env-var checks de publicação (facebook, linkedin) movidas para cá —
// eliminando o import cross-stage stage-5→stage-4. As funções pertencem
// logicamente ao Stage 5 (Publicação) onde são de fato necessárias.

/**
 * `FACEBOOK_PAGE_ID` env var deve estar setada — publish-facebook usa pra postar
 * via Graph API. Nome confirmado em scripts/publish-facebook.ts:376.
 */
function checkFbPageIdSet(): InvariantViolation[] {
  if (!process.env.FACEBOOK_PAGE_ID || process.env.FACEBOOK_PAGE_ID.trim().length === 0) {
    return [
      {
        rule: "facebook-page-id-set",
        message:
          "FACEBOOK_PAGE_ID env var ausente — publish-facebook vai falhar. " +
          "Configure em .env.local.",
        source_issue: "#facebook",
        severity: "error",
      },
    ];
  }
  return [];
}

/**
 * `FACEBOOK_PAGE_ACCESS_TOKEN` deve estar setado. Nome confirmado em
 * scripts/publish-facebook.ts:377.
 */
function checkFbTokenSet(): InvariantViolation[] {
  if (
    !process.env.FACEBOOK_PAGE_ACCESS_TOKEN ||
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN.trim().length === 0
  ) {
    return [
      {
        rule: "facebook-token-set",
        message: "FACEBOOK_PAGE_ACCESS_TOKEN ausente — Facebook publishing vai falhar",
        source_issue: "#facebook",
        severity: "error",
      },
    ];
  }
  return [];
}

/**
 * `DIARIA_LINKEDIN_CRON_URL` deve estar setado — publish-linkedin envia
 * agendamento pro Cloudflare Worker. Sem ele, fallback é Make webhook
 * (#971 com graceful degrade). Nome confirmado em
 * scripts/publish-linkedin.ts:305.
 *
 * RESPONSABILIDADE ÚNICA (#2172): esta função checa APENAS PRESENÇA da env var.
 * A verificação de esquema (HTTP vs HTTPS) foi extraída para checkLinkedinWorkerUrlHttps.
 *
 * ASSIMETRIA INTENCIONAL DE SEVERIDADE (#2154 pass-2):
 * Stage-0 verifica a mesma env var com severity="error" (linkedin-cron-creds-set).
 * Aqui é "warning" porque Stage 5 é o momento de dispatch — se o var está ausente
 * agora, o publish-linkedin degrada graciosamente para o Make webhook (post
 * imediato em vez de agendado). Isso é indesejável mas não catastrófico. Em
 * Stage 0, o error é correto: queremos parar o pipeline ANTES de 30min de
 * pesquisa pra não chegar no Stage 5 sem config. Em Stage 5, já estamos
 * publicando — warning informa o editor do degrade sem abortar.
 */
function checkLinkedinWorkerUrlSet(): InvariantViolation[] {
  const url = process.env.DIARIA_LINKEDIN_CRON_URL;
  if (!url || url.trim().length === 0) {
    return [
      {
        rule: "linkedin-worker-url-set",
        message:
          "DIARIA_LINKEDIN_CRON_URL env var ausente — publish-linkedin cai pra Make webhook " +
          "(post imediato, sem agendamento). Configure em .env.local pra evitar.",
        source_issue: "#971",
        severity: "warning",
      },
    ];
  }
  return [];
}

/**
 * `DIARIA_LINKEDIN_CRON_URL`, quando presente, deve usar HTTPS.
 * HTTP expõe o token Bearer em trânsito — erro de configuração (severity=error).
 *
 * RESPONSABILIDADE ÚNICA (#2172): esta função checa APENAS O ESQUEMA.
 * Quando a URL está ausente, retorna [] sem emitir violation — checkLinkedinWorkerUrlSet
 * cuida do caso "ausente". As duas funções cobrem subconjuntos disjuntos do espaço
 * de estados, eliminando o double-report que ocorria quando ambas as entries de
 * STAGE_5_RULES chamavam checkLinkedinWorkerUrlSet (que emitia linkedin-worker-url-https
 * no ramo não-HTTPS).
 */
function checkLinkedinWorkerUrlHttps(): InvariantViolation[] {
  const raw = process.env.DIARIA_LINKEDIN_CRON_URL;
  // Ausente → não emite; checkLinkedinWorkerUrlSet cuida disso.
  // #2172 finding 8: extrair trimmedUrl uma vez (evita dupla leitura + guard duplicado).
  const url = raw?.trim() ?? "";
  if (!url) return [];
  // #2172 finding 1+2: testar o valor trimado + flag /i para case-insensitive (RFC 3986).
  if (/^https:\/\//i.test(url)) return [];
  // #2172 finding 3: mascarar userinfo (user:token@host) para não vazar credencial na mensagem.
  let safeScheme: string;
  try {
    safeScheme = new URL(url).protocol; // ex: "http:"
  } catch {
    safeScheme = url.split(":")[0] + ":"; // fallback se URL malformada
  }
  return [
    {
      rule: "linkedin-worker-url-https",
      message: `DIARIA_LINKEDIN_CRON_URL deve ser HTTPS, esquema recebido: "${safeScheme}"`,
      source_issue: "#971",
      severity: "error",
    },
  ];
}

/**
 * `DIARIA_LINKEDIN_CRON_TOKEN` deve estar setado — autoriza POST pro worker.
 * Nome confirmado em scripts/publish-linkedin.ts:308.
 *
 * ASSIMETRIA INTENCIONAL DE SEVERIDADE (#2154 pass-2):
 * Stage-0 emite "error" via linkedin-cron-creds-set; aqui é "warning" pelo
 * mesmo motivo que checkLinkedinWorkerUrlSet: graceful degrade para Make webhook.
 */
function checkCloudflareTokenSet(): InvariantViolation[] {
  if (
    !process.env.DIARIA_LINKEDIN_CRON_TOKEN ||
    process.env.DIARIA_LINKEDIN_CRON_TOKEN.trim().length === 0
  ) {
    return [
      {
        rule: "linkedin-worker-token-set",
        message:
          "DIARIA_LINKEDIN_CRON_TOKEN ausente — publish-linkedin não consegue autenticar no worker " +
          "(cai pra Make webhook).",
        source_issue: "#971",
        severity: "warning",
      },
    ];
  }
  return [];
}

interface SocialPublishedJson {
  posts?: Array<{ platform?: string; status?: string }>;
}

/**
 * `_internal/.step-4-done.json` deve existir após Stage 4 completo. Sem isso,
 * resume-aware do orchestrator (Stage 0b) não detecta que Stage 4 rodou e
 * pode tentar re-disparar publish-* no próximo run.
 *
 * Valida o sentinel escrito por scripts/pipeline-sentinel.ts (#780).
 */
function checkStep4Sentinel(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", ".step-4-done.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "step-4-sentinel-exists",
        message:
          `_internal/.step-4-done.json ausente — pipeline-sentinel.ts não foi chamado. ` +
          `Resume-aware no próximo run pode re-publicar.`,
        source_issue: "#780",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * `_internal/06-social-published.json` deve ter `posts[]` com pelo menos 1
 * entry (idealmente 6 = 3 LinkedIn + 3 Facebook), nenhuma com `status:
 * "failed"`. Sinal de que dispatch social rodou e publish-{linkedin,facebook}
 * completaram.
 */
function checkSocialPublishedComplete(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "06-social-published.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "social-published-exists",
        message:
          `_internal/06-social-published.json ausente — publish-linkedin/facebook não rodaram ` +
          `ou falharam antes de gravar. Stage 5 (Publicação) incompleto.`,
        source_issue: "#272",
        severity: "error",
        file: path,
      },
    ];
  }
  let data: SocialPublishedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [
      {
        rule: "social-published-parseable",
        message: `06-social-published.json não parseável: ${(e as Error).message}`,
        source_issue: "#272",
        severity: "error",
        file: path,
      },
    ];
  }
  const posts = Array.isArray(data.posts) ? data.posts : [];
  const violations: InvariantViolation[] = [];
  if (posts.length === 0) {
    violations.push({
      rule: "social-published-non-empty",
      message: `06-social-published.json com posts[] vazio — nenhum dispatch teve sucesso`,
      source_issue: "#272",
      severity: "error",
      file: path,
    });
  }
  const failed = posts.filter((p) => p.status === "failed");
  if (failed.length > 0) {
    violations.push({
      rule: "social-published-no-failed",
      message: `06-social-published.json tem ${failed.length} post(s) com status=failed`,
      source_issue: "#272",
      severity: "warning",
      file: path,
    });
  }
  return violations;
}

/**
 * #1410: enforcement do loop verify→fix do Stage 4 §4f.
 *
 * Se `05-published.json.review_status === "issues_unfixable"`, então o
 * orchestrator declarou que o test email tem issues e foi tentado fix-mode
 * pelo menos 1×. Pra essa declaração ser válida:
 *   - `review_attempts >= 2` (1 review + ao menos 1 fix-mode dispatch)
 *
 * Sem esse guard, orchestrator pode pular fix-mode silenciosamente quando
 * agent retorna issues que ele acha falso-positivo. Caso 260520: review_status
 * marcado `issues_unfixable` com `review_attempts: 1` — fix-mode nunca rodou,
 * issues foram só descartadas por julgamento.
 *
 * Em 260520, após #1421 (filter de falso-positivos no orchestrator), issues
 * legítimas chegam até fix-mode automaticamente. Esse guard serve de safety
 * net pra caso filter falhe ou novo tipo de issue apareça.
 */
/**
 * #1577: garante que review-test-email loop de fato rodou antes do stage 4 fechar.
 * Distinto de checkStage4ReviewLoop (#1410) — aquele cobre o caso
 * "issues_unfixable + review_attempts < 2". Este aqui cobre o caso mais
 * simples: review_completed=false + review_status=pending = loop pulado.
 *
 * Caso 260529: orchestrator marcou stage 4 done com:
 *   review_completed: false
 *   review_status: pending
 * Sentinel + auto-reporter rodaram, edition-report gerado, MAS o loop
 * verify→fix nunca foi disparado.
 */
function checkStage4ReviewCompleted(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "05-published.json");
  if (!existsSync(path)) return [];
  let data: { review_completed?: boolean; review_status?: string };
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return []; // outro rule pega
  }
  const explicitTerminal =
    data.review_status === "issues_unfixable" ||
    data.review_status === "inconclusive";
  if (data.review_completed || explicitTerminal) return [];
  return [
    {
      rule: "stage-5-review-completed",
      message:
        `05-published.json marca review_completed=${data.review_completed ?? "missing"} ` +
        `+ review_status=${data.review_status ?? "missing"}. ` +
        `Loop verify→fix do test email não rodou (ou não terminou). ` +
        `Run Agent(review-test-email) ANTES de fechar stage 5 (Publicação) / escrever sentinel.`,
      source_issue: "#1577",
      severity: "error",
      file: path,
    },
  ];
}

function checkStage4ReviewLoop(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "05-published.json");
  if (!existsSync(path)) {
    // Outro check (#272/#780) já reporta ausência do file — não dup.
    return [];
  }
  let data: {
    review_status?: string;
    review_attempts?: number;
  };
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // 05-published.json corrupted é raro mas precisa ser reportado — nenhum
    // outro rule lê esse arquivo (checkSocialPublishedComplete lê
    // 06-social-published.json, file diferente).
    return [
      {
        rule: "stage-5-review-loop-parseable",
        message: `05-published.json não parseável: ${(e as Error).message}`,
        source_issue: "#1410",
        severity: "error",
        file: path,
      },
    ];
  }
  if (data.review_status !== "issues_unfixable") return [];

  const attempts = typeof data.review_attempts === "number" ? data.review_attempts : 0;
  if (attempts < 2) {
    return [
      {
        rule: "stage-5-review-loop-enforced",
        message:
          `05-published.json marca review_status="issues_unfixable" mas review_attempts=${attempts} ` +
          `(esperado >= 2 — 1 review + ao menos 1 fix-mode dispatch). ` +
          `Orchestrator pulou o loop verify→fix silenciosamente. ` +
          `Re-rode publish-newsletter em modo fix antes de declarar unfixable.`,
        source_issue: "#1410",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * #1367: `_internal/.close-poll-done.json` deve existir após Stage 4 §4h.
 * Marker é escrito por close-poll.ts apenas se: (a) /admin/correct retornou
 * ok, (b) sanity check /stats confirmou correct_answer registrado.
 *
 * Sem esse marker, a próxima edição não consegue mostrar "Resultado da última
 * edição: X% acertaram" porque worker retorna correct_pct=null.
 *
 * Caso real 260518: close-poll falhou silently (Node fetch broken), pipeline
 * marcou Stage 4 done, 260519 renderizou sem a linha de stats.
 */
function checkClosePollMarker(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", ".close-poll-done.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "close-poll-marker-exists",
        message:
          `_internal/.close-poll-done.json ausente — close-poll.ts não rodou ou falhou. ` +
          `Próxima edição não vai conseguir exibir % de acertos. ` +
          `Rode manualmente: \`npx tsx scripts/close-poll.ts --edition {AAMMDD}\`.`,
        source_issue: "#1367",
        severity: "error",
        file: path,
      },
    ];
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as {
      answer?: string;
      sanity_check?: { correct_answer?: string };
    };
    if (!data.answer || !data.sanity_check?.correct_answer) {
      return [
        {
          rule: "close-poll-marker-valid",
          message: `close-poll marker existe mas sem answer/sanity_check válidos: ${JSON.stringify(data)}`,
          source_issue: "#1367",
          severity: "error",
          file: path,
        },
      ];
    }
    if (data.answer !== data.sanity_check.correct_answer) {
      return [
        {
          rule: "close-poll-marker-consistency",
          message:
            `close-poll marker answer="${data.answer}" diverge do sanity check correct_answer=` +
            `"${data.sanity_check.correct_answer}". Worker pode estar com state errado.`,
          source_issue: "#1367",
          severity: "error",
          file: path,
        },
      ];
    }
  } catch (e) {
    return [
      {
        rule: "close-poll-marker-parseable",
        message: `close-poll marker não parseável: ${(e as Error).message}`,
        source_issue: "#1367",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * `_internal/.step-5-done.json` deve existir após Stage 5 completo. Sem isso,
 * orchestrator Stage 0 resume não detecta Stage 5 como concluído e
 * stage-status.md fica em `running` indefinidamente.
 *
 * §5j promete validar esse sentinel — este check é o guard que sustenta
 * essa promessa (#1694).
 */
function checkStep5Sentinel(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", ".step-5-done.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "step-5-sentinel-exists",
        message:
          `_internal/.step-5-done.json ausente — pipeline-sentinel.ts não foi chamado. ` +
          `Stage-status.md fica em 'running' e resume futuro pode re-publicar.`,
        source_issue: "#1694",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * #1575: garante que canais com consent=auto realmente dispatcharam (não
 * foram silenciosamente skipados pra manual paste). Caso 260529: editor
 * respondeu "Tudo automático" no consent gate, mas orchestrator bypassou
 * Chrome MCP do Beehiiv e apresentou instruções de paste manual.
 *
 * Roda apenas se 05-publish-consent.json existe. Compara cada canal
 * (newsletter, linkedin, facebook) contra evidência de dispatch:
 *   - newsletter consent=auto → 05-published.json deve ter draft_url ou
 *     post_id (status != pending_manual)
 *   - linkedin consent=auto → 06-social-published.json deve ter posts[]
 *     da plataforma linkedin com url ou status != pending_manual
 *   - facebook consent=auto → idem para facebook
 */
function checkConsentBinding(editionDir: string): InvariantViolation[] {
  const consentPath = resolve(editionDir, "_internal", "05-publish-consent.json");
  if (!existsSync(consentPath)) return [];
  let consent: { newsletter?: string; linkedin?: string; facebook?: string };
  try {
    consent = JSON.parse(readFileSync(consentPath, "utf8"));
  } catch (e) {
    return [
      {
        rule: "consent-binding-parseable",
        message: `05-publish-consent.json não parseável: ${(e as Error).message}`,
        source_issue: "#1575",
        severity: "error",
        file: consentPath,
      },
    ];
  }
  const violations: InvariantViolation[] = [];

  // Newsletter check
  if (consent.newsletter === "auto") {
    const publishedPath = resolve(editionDir, "_internal", "05-published.json");
    if (!existsSync(publishedPath)) {
      violations.push({
        rule: "consent-binding-newsletter",
        message:
          `consent.newsletter="auto" mas 05-published.json ausente — dispatch ` +
          `Beehiiv (Chrome MCP) não rodou. Editor escolheu auto; bypass pra manual paste viola contrato.`,
        source_issue: "#1575",
        severity: "error",
        file: publishedPath,
      });
    } else {
      try {
        const pub = JSON.parse(readFileSync(publishedPath, "utf8")) as {
          status?: string;
          draft_url?: string;
          post_id?: string;
        };
        if (pub.status === "pending_manual" || (!pub.draft_url && !pub.post_id)) {
          violations.push({
            rule: "consent-binding-newsletter",
            message:
              `consent.newsletter="auto" mas 05-published.json tem status="${pub.status ?? "?"}" ` +
              `sem draft_url/post_id — dispatch automático não aconteceu.`,
            source_issue: "#1575",
            severity: "error",
            file: publishedPath,
          });
        }
      } catch (e) {
        violations.push({
          rule: "consent-binding-newsletter",
          message: `05-published.json não parseável: ${(e as Error).message}`,
          source_issue: "#1575",
          severity: "error",
          file: publishedPath,
        });
      }
    }
  }

  // Social check (linkedin + facebook)
  const socialPath = resolve(editionDir, "_internal", "06-social-published.json");
  if (consent.linkedin === "auto" || consent.facebook === "auto") {
    if (!existsSync(socialPath)) {
      const channels = [
        consent.linkedin === "auto" ? "linkedin" : null,
        consent.facebook === "auto" ? "facebook" : null,
      ].filter(Boolean);
      violations.push({
        rule: "consent-binding-social",
        message:
          `consent.{${channels.join(",")}}=auto mas 06-social-published.json ausente — dispatch social não rodou.`,
        source_issue: "#1575",
        severity: "error",
        file: socialPath,
      });
    } else {
      try {
        const social = JSON.parse(readFileSync(socialPath, "utf8")) as {
          posts?: Array<{ platform?: string; status?: string; url?: string }>;
        };
        const posts = social.posts ?? [];
        for (const platform of ["linkedin", "facebook"] as const) {
          if (consent[platform] !== "auto") continue;
          const platformPosts = posts.filter(
            (p) => p.platform === platform,
          );
          if (platformPosts.length === 0) {
            violations.push({
              rule: `consent-binding-${platform}`,
              message:
                `consent.${platform}="auto" mas posts[platform="${platform}"] ` +
                `vazio em 06-social-published.json.`,
              source_issue: "#1575",
              severity: "error",
              file: socialPath,
            });
            continue;
          }
          // #1664/#1682: existir não basta — dispatch real exige um status de
          // dispatch RECONHECIDO. NÃO usar url como sinal: o LinkedIn auto-dispatch
          // (route worker_queue) grava url=null no write — a URL só existe depois
          // que o Worker dispara o agendado, então !url dava false-positive em
          // TODA edição real (260525-260601).
          //
          // #1682: ALLOWLIST (não blacklist). O blacklist anterior
          // (`every(p => !p.status || p.status === "pending_manual")`) tinha 2
          // frestas: (a) bypass PARCIAL passava — dispatcha 1 de 3 e deixa 2
          // pending_manual → `.every` false → nenhuma violation (o exato
          // silent-bypass que o #1575 pega); (b) status off-enum ("skipped") é
          // truthy != pending_manual → tratado como dispatched. Agora: viola se
          // QUALQUER post não tem status de dispatch reconhecido. `failed` fica no
          // allowlist (foi tentado; o sibling social-published-no-failed em stage-5
          // cobre a falha).
          const DISPATCH_STATUSES = new Set(["scheduled", "draft", "published", "failed"]);
          const notFullyDispatched = !platformPosts.every(
            (p) => p.status != null && DISPATCH_STATUSES.has(p.status),
          );
          if (notFullyDispatched) {
            violations.push({
              rule: `consent-binding-${platform}`,
              message:
                `consent.${platform}="auto" mas nem todos os posts[platform="${platform}"] ` +
                `têm status de dispatch (scheduled/draft/published/failed) — ` +
                `dispatch automático parcial ou ausente (status: ${platformPosts.map((p) => p.status ?? "ausente").join(", ")}).`,
              source_issue: "#1575",
              severity: "error",
              file: socialPath,
            });
          }
        }
      } catch (e) {
        violations.push({
          rule: "consent-binding-social",
          message: `06-social-published.json não parseável: ${(e as Error).message}`,
          source_issue: "#1575",
          severity: "error",
          file: socialPath,
        });
      }
    }
  }
  return violations;
}


export const STAGE_5_RULES: InvariantRule[] = [
  {
    id: "step-4-sentinel-exists",
    description: "_internal/.step-4-done.json escrito (#780)",
    source_issue: "#780",
    stage: 5,
    run: checkStep4Sentinel,
  },
  {
    id: "social-published-complete",
    description: "06-social-published.json não-vazio, sem failed (#272)",
    source_issue: "#272",
    stage: 5,
    run: checkSocialPublishedComplete,
  },
  {
    id: "stage-5-review-loop-enforced",
    description:
      "review_status=issues_unfixable exige review_attempts>=2 (#1410)",
    source_issue: "#1410",
    stage: 5,
    run: checkStage4ReviewLoop,
  },
  {
    id: "stage-5-review-completed",
    description: "review-test-email loop rodou + terminou (#1577)",
    source_issue: "#1577",
    stage: 5,
    run: checkStage4ReviewCompleted,
  },
  {
    id: "close-poll-marker-exists",
    description: "_internal/.close-poll-done.json escrito (#1367)",
    source_issue: "#1367",
    stage: 5,
    run: checkClosePollMarker,
  },
  {
    id: "facebook-page-id-set",
    description: "FACEBOOK_PAGE_ID env var presente (necessário para Stage 5 dispatch)",
    source_issue: "#facebook",
    stage: 5,
    run: () => checkFbPageIdSet(),
  },
  {
    id: "facebook-token-set",
    description: "FACEBOOK_PAGE_ACCESS_TOKEN env var presente (necessário para Stage 5 dispatch)",
    source_issue: "#facebook",
    stage: 5,
    run: () => checkFbTokenSet(),
  },
  {
    // #2172: checkLinkedinWorkerUrlSet agora checa APENAS PRESENÇA (split de
    // responsabilidade). A verificação de esquema HTTP/HTTPS foi extraída para
    // checkLinkedinWorkerUrlHttps + entry separada abaixo. Antes do fix, ambas
    // as entries chamavam checkLinkedinWorkerUrlSet, que emitia linkedin-worker-url-https
    // no ramo não-HTTPS — resultando em double-report (2 violations com o mesmo id).
    id: "linkedin-worker-url-set",
    description: "DIARIA_LINKEDIN_CRON_URL env var presente — ausente degrada pra Make webhook (#971)",
    source_issue: "#971",
    stage: 5,
    run: () => checkLinkedinWorkerUrlSet(),
  },
  {
    // #2172: checkLinkedinWorkerUrlHttps checa APENAS O ESQUEMA (HTTPS vs HTTP).
    // Quando URL ausente retorna [] — checkLinkedinWorkerUrlSet cuida do ausente.
    // Cada entry agora emite exatamente 1 rule id pro seu caso (zero sobreposição).
    id: "linkedin-worker-url-https",
    description: "DIARIA_LINKEDIN_CRON_URL deve ser HTTPS quando presente (#971)",
    source_issue: "#971",
    stage: 5,
    run: () => checkLinkedinWorkerUrlHttps(),
  },
  {
    id: "linkedin-worker-token-set",
    description: "DIARIA_LINKEDIN_CRON_TOKEN env var presente (#971)",
    source_issue: "#971",
    stage: 5,
    run: () => checkCloudflareTokenSet(),
  },
  {
    id: "step-5-sentinel-exists",
    description: "_internal/.step-5-done.json escrito pelo pipeline-sentinel (#1694)",
    source_issue: "#1694",
    stage: 5,
    run: checkStep5Sentinel,
  },
  {
    id: "consent-binding",
    description: "canais com consent=auto devem ter dispatch real (#1575)",
    source_issue: "#1575",
    stage: 5,
    run: checkConsentBinding,
  },
];

export {
  checkStep4Sentinel,
  checkSocialPublishedComplete,
  checkStage4ReviewLoop,
  checkStage4ReviewCompleted,
  checkClosePollMarker,
  checkFbPageIdSet,
  checkFbTokenSet,
  checkLinkedinWorkerUrlSet,
  checkLinkedinWorkerUrlHttps,
  checkCloudflareTokenSet,
  // #2154 pass-2: checkConsentBinding agora vive exclusivamente aqui (stage-5).
  // A cópia órfã de stage-4 foi removida; testes redirecionados pra cá.
  checkConsentBinding,
};
