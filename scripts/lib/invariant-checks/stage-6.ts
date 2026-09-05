/**
 * Invariants pós-agendamento — Stage 6 (#1694).
 *
 * Rodam após Stage 6 (Agendamento) completar (Schedule Beehiiv confirmado +
 * auto-reporter rodou). Detectam falhas silenciosas:
 *   - sentinel .step-5-done.json ausente (Stage 5 não completou)
 *   - 05-published.json sem scheduled_at (Schedule não rodou)
 *   - edition-report.html ausente (auto-reporter não rodou)
 *   - guard de slug do bloco WhatsApp (#4570) não rodou, ou rodou e falhou (#4574)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { InvariantRule, InvariantViolation } from "./types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * #464 (achado do review, PR #6096) — mesmo helper de
 * `invariant-checks/stage-5.ts::loadNewsletterBackend`, duplicado aqui (não
 * extraído pra um módulo compartilhado só por 2 call sites de 4 linhas cada
 * — extrair se um 3º aparecer).
 */
function loadNewsletterBackend(): string {
  const configPath = resolve(ROOT, "platform.config.json");
  if (!existsSync(configPath)) return "beehiiv";
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      publishing?: { newsletter?: { backend?: string } };
    };
    return cfg.publishing?.newsletter?.backend ?? "beehiiv";
  } catch {
    return "beehiiv";
  }
}

/**
 * `.step-5-done.json` deve existir — Stage 5 completou o dispatch.
 */
function checkStep5Sentinel(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", ".step-5-done.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "step-5-sentinel-exists",
        message:
          `_internal/.step-5-done.json ausente — Stage 5 (Publicação) não completou. ` +
          `Stage 6 requer que o dispatch de newsletter + social tenha ocorrido.`,
        source_issue: "#1694",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * `05-published.json` (Beehiiv) ou `newsletter-kit-published.json` (Kit —
 * #464, achado do review PR #6096: hardcoded só em Beehiiv originalmente,
 * fazia este invariant bloquear TODA edição com `publishing.newsletter.backend:
 * "kit"`, mesmo com o Schedule do Kit tendo funcionado normalmente) deve ter
 * `scheduled_at` (ou `status: "published"`/`"scheduled"` conforme o backend
 * — envio imediato detectado e reconciliado no caso Beehiiv). Sem isso,
 * Stage 6 completou sem agendar.
 */
// #464 (achado do review, PR #6096): `backendOverride` opcional, só pra
// teste — mesma justificativa de `checkConsentBinding` em invariant-checks/stage-5.ts.
function checkScheduledAt(editionDir: string, backendOverride?: string): InvariantViolation[] {
  const isKit = (backendOverride ?? loadNewsletterBackend()) === "kit";
  const filename = isKit ? "newsletter-kit-published.json" : "05-published.json";
  const path = resolve(editionDir, "_internal", filename);
  if (!existsSync(path)) {
    return [
      {
        rule: "scheduled-at-present",
        message: `_internal/${filename} ausente — Stage 5 (Publicação) não completou o dispatch de newsletter.`,
        source_issue: "#1694",
        severity: "error",
        file: path,
      },
    ];
  }
  let data: { scheduled_at?: string; status?: string };
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [
      {
        rule: "scheduled-at-parseable",
        message: `${filename} não parseável: ${(e as Error).message}`,
        source_issue: "#1694",
        severity: "error",
        file: path,
      },
    ];
  }
  // #464: `KitNewsletterPublished.status` usa "scheduled" (não "published")
  // pro caso feliz — Kit não tem o conceito de "envio imediato detectado e
  // reconciliado" do Beehiiv (schedule-newsletter-kit.ts só grava `status:
  // "scheduled"` depois de um GET confirmando `send_at`, nunca antes).
  const okStatuses = isKit ? ["scheduled"] : ["published"];
  if (!data.scheduled_at && !okStatuses.includes(data.status ?? "")) {
    return [
      {
        rule: "scheduled-at-present",
        message:
          `${filename} não tem scheduled_at (status=${data.status ?? "missing"}). ` +
          `Stage 6 (Agendamento) não concluiu o Schedule ${isKit ? "do Kit" : "do Beehiiv"}. ` +
          `Re-rodar \`/diaria-6-agendamento {AAMMDD}\`.`,
        source_issue: "#1694",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * `edition-report.html` deve existir — auto-reporter + relatório por email rodaram.
 */
function checkEditionReport(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "edition-report.html");
  if (!existsSync(path)) {
    return [
      {
        rule: "edition-report-exists",
        message:
          `_internal/edition-report.html ausente — auto-reporter ou send-edition-report.ts não rodaram. ` +
          `Rodar manualmente: \`npx tsx scripts/send-edition-report.ts --edition {AAMMDD} --edition-dir data/editions/{AAMMDD}/\`.`,
        source_issue: "#1510",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * `.step-6-done.json` deve existir após Stage 6 completo.
 */
function checkStep6Sentinel(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", ".step-6-done.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "step-6-sentinel-exists",
        message:
          `_internal/.step-6-done.json ausente — pipeline-sentinel.ts não foi chamado. ` +
          `Stage 6 não ficou marcado como concluído.`,
        source_issue: "#1694",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * `_internal/whatsapp-slug-check.json` deve existir com `ok: true` — o guard
 * determinístico de slug do bloco WhatsApp (#4570) precisa ter RODADO e
 * PASSADO antes do Stage 6 ser aceito como íntegro (#4574).
 *
 * Sem esta regra, o mecanismo GATE-BLOCKING documentado em
 * `.claude/agents/orchestrator-stage-6.md` §6d dependia 100% de um agente
 * LLM ler e seguir a prosa — nada em código verificava que o guard rodou,
 * rodou corretamente, ou passou antes do Stage 6 avançar. Achado do review
 * consolidado da PR #4574 (pr-test-analyzer + silent-failure-hunter,
 * convergentes): exatamente o anti-padrão que este módulo (`check-invariants.ts`)
 * existe pra eliminar.
 *
 * O arquivo é escrito por `scripts/check-whatsapp-slug-guard.ts --out` — o
 * orchestrator passa `{EDITION_DIR}/_internal/whatsapp-slug-check.json` como
 * `--out` na chamada de §6d.
 *
 * Backend `"kit"` (#7388, achado ao vivo na edição 260904): §6d do
 * orchestrator-stage-6.md instrui pular a seção INTEIRA (incluindo esta
 * checagem) quando o backend é Kit — o problema de slug da UI da Beehiiv
 * não tem equivalente lá (`public_url` do broadcast já é a URL final, sem
 * etapa manual de slug que possa divergir dela). Sem este guard de backend,
 * `whatsapp-slug-check.json` nunca é escrito por uma edição Kit e este check
 * bloqueava o Stage 6 incondicionalmente todo dia desde a migração de
 * backend em #7388 — falso positivo estrutural, não uma falha real.
 * `backendOverride` opcional, só pra teste (mesmo padrão de `checkScheduledAt`
 * acima) — produção sempre lê `platform.config.json` de verdade.
 */
function checkWhatsappSlugGuard(
  editionDir: string,
  backendOverride?: string,
): InvariantViolation[] {
  if ((backendOverride ?? loadNewsletterBackend()) === "kit") return [];
  const path = resolve(editionDir, "_internal", "whatsapp-slug-check.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "whatsapp-slug-guard-ok",
        message:
          `_internal/whatsapp-slug-check.json ausente — o guard de slug do bloco WhatsApp ` +
          `(#4570) não rodou (ou rodou sem \`--out\`). GATE-BLOCKING: o link do bloco WhatsApp ` +
          `(dentro do D1, #5152) já está BAKED IN no corpo do e-mail — sem essa checagem, um slug ` +
          `divergente 404 pra quem abrir o e-mail. Rodar \`npx tsx scripts/check-whatsapp-slug-guard.ts\` ` +
          `(ver \`.claude/agents/orchestrator-stage-6.md\` §6d) antes de aceitar o Stage 6.`,
        source_issue: "#4574",
        severity: "error",
        file: path,
      },
    ];
  }
  let data: { ok?: boolean; expectedSlug?: string; actualSlug?: string | null };
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [
      {
        rule: "whatsapp-slug-guard-parseable",
        message: `whatsapp-slug-check.json não parseável: ${(e as Error).message}`,
        source_issue: "#4574",
        severity: "error",
        file: path,
      },
    ];
  }
  if (data.ok !== true) {
    return [
      {
        rule: "whatsapp-slug-guard-ok",
        message:
          `whatsapp-slug-check.json registra ok=${String(data.ok)} — o slug do post diverge ` +
          `do previsto pelo bloco WhatsApp (esperado "${data.expectedSlug ?? "?"}", atual ` +
          `"${data.actualSlug ?? "(ausente)"}"). GATE-BLOCKING (#4570): corrigir o slug manualmente ` +
          `(Settings → SEO/URL slug) e re-rodar \`scripts/check-whatsapp-slug-guard.ts\` até \`ok: true\`.`,
        source_issue: "#4574",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * `_internal/site-page-published.json` (escrito por
 * `publish-edition-site-page.ts`, #7283) deve existir e registrar
 * `published: true` — senão a página `/p/{slug}` do acervo não foi
 * publicada (branch pushada + PR aberto). `severity: "warning"` de
 * propósito: o fail-soft do #6202 é intencional (site é acessório ao
 * envio) — este check não bloqueia Stage 6, só torna a falha VISÍVEL no
 * relatório de invariantes em vez de depender de um agente LLM lembrar de
 * logar via `log-event.ts` (prosa em `orchestrator-stage-6.md` §6d-site,
 * não reforçada em código — foi exatamente essa lacuna que deixou 4
 * edições consecutivas (31/08–03/09) sem página no acervo em silêncio
 * absoluto, ver #7283/#7266).
 *
 * `code: 2` ("nada a publicar ainda" — insumos ausentes) é tratado como
 * benigno, não gera violação: não é falha de publish, e não deveria
 * acontecer no Stage 6 normal (Stage 4/5 já rodaram), mas se acontecer não
 * é isto que deve acusar.
 *
 * Arquivo ausente também vira warning (não error) — cobre tanto "o passo
 * nunca rodou" quanto "versão antiga do script, sem este mecanismo ainda".
 */
function checkSitePagePublished(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "site-page-published.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "site-page-published",
        message:
          `_internal/site-page-published.json ausente — §6d-site (publish-edition-site-page.ts) não ` +
          `rodou, ou rodou numa versão anterior ao #7283. Acervo do site pode estar sem a página desta ` +
          `edição (link de hub cairia no fallback do Kit e daria 404, ver #7266). Rodar manualmente: ` +
          `\`npx tsx scripts/publish-edition-site-page.ts --edition-dir {EDITION_DIR} --slug {slug}\`.`,
        source_issue: "#7283",
        severity: "warning",
        file: path,
      },
    ];
  }
  let data: { code?: number; slug?: string; published?: boolean; reason?: string; prUrl?: string };
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [
      {
        rule: "site-page-published-parseable",
        message: `site-page-published.json não parseável: ${(e as Error).message}`,
        source_issue: "#7283",
        severity: "warning",
        file: path,
      },
    ];
  }
  if (data.code === 2) return [];
  if (data.published !== true) {
    return [
      {
        rule: "site-page-published",
        message:
          `site-page-published.json registra published=${String(data.published)} (code=${data.code ?? "?"}) ` +
          `— a página /p/${data.slug ?? "?"} do acervo do site NÃO foi publicada (branch pushada + PR ` +
          `aberto/reusado). Motivo: ${data.reason ?? "não registrado"}. Fail-soft intencional (#6202) — não ` +
          `bloqueia a edição, mas o link fica 404 até alguém publicar manualmente (ver #7266/#7280).`,
        source_issue: "#7283",
        severity: "warning",
        file: path,
      },
    ];
  }
  return [];
}

export const STAGE_6_RULES: InvariantRule[] = [
  {
    id: "step-5-sentinel-exists",
    description: "_internal/.step-5-done.json escrito pelo Stage 5 (#1694)",
    source_issue: "#1694",
    stage: 6,
    run: checkStep5Sentinel,
  },
  {
    id: "scheduled-at-present",
    description: "05-published.json tem scheduled_at ou status=published (#1694)",
    source_issue: "#1694",
    stage: 6,
    run: checkScheduledAt,
  },
  {
    id: "edition-report-exists",
    description: "_internal/edition-report.html escrito pelo send-edition-report.ts (#1510)",
    source_issue: "#1510",
    stage: 6,
    run: checkEditionReport,
  },
  {
    id: "whatsapp-slug-guard-ok",
    description: "_internal/whatsapp-slug-check.json presente com ok:true (#4570, backstop #4574)",
    source_issue: "#4574",
    stage: 6,
    run: checkWhatsappSlugGuard,
  },
  {
    id: "step-6-sentinel-exists",
    description: "_internal/.step-6-done.json escrito pelo pipeline-sentinel (#1694)",
    source_issue: "#1694",
    stage: 6,
    run: checkStep6Sentinel,
  },
  {
    id: "site-page-published",
    description:
      "_internal/site-page-published.json registra published:true — torna visível o fail-soft do §6d-site (#7283)",
    source_issue: "#7283",
    stage: 6,
    run: checkSitePagePublished,
  },
];

export {
  checkStep5Sentinel,
  checkScheduledAt,
  checkEditionReport,
  checkWhatsappSlugGuard,
  checkStep6Sentinel,
  checkSitePagePublished,
};
