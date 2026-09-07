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
import { findOrphanSlugs, listPageSlugs, slugsInSitemap } from "../site-sitemap-orphans.ts";

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
 * publicada (branch pushada + PR aberto).
 *
 * ## `severity: "error"` desde #7578 — era `"warning"` (decisão do editor, 07/09/2026)
 *
 * O `warning` original vinha do fail-soft do #6202: publicar no site é
 * acessório ao ENVIO, e nenhuma falha ali podia derrubar a edição. A premissa
 * mudou duas vezes desde então:
 *
 *   1. o site virou destino de campanha PAGA (#7575) e a superfície mais
 *      indexável do domínio (#7576) — não é mais acessório;
 *   2. o próprio mecanismo provou que `warning` não é lido. A docstring desta
 *      função já registrava que a lacuna tinha deixado "4 edições consecutivas
 *      (31/08–03/09) sem página no acervo em silêncio absoluto" — e o #7578
 *      mediu que **continuou acontecendo depois disso**, somando 12 dias de
 *      acervo parado. Um aviso que ninguém lê pela segunda vez não é aviso.
 *
 * Bloquear no Stage 6 é barato: o gate já é humano, e a correção é re-rodar
 * uma linha. O fail-soft do SCRIPT (#6202) continua intacto — ele segue
 * saindo com `code != 0` sem lançar, e o envio da edição não depende dele.
 * O que mudou é só quem decide seguir: agora é o editor, no gate, com a falha
 * na frente — não o silêncio.
 *
 * `code: 2` ("nada a publicar ainda" — insumos ausentes) é tratado como
 * benigno, não gera violação: não é falha de publish, e não deveria
 * acontecer no Stage 6 normal (Stage 4/5 já rodaram), mas se acontecer não
 * é isto que deve acusar.
 *
 * Arquivo ausente também bloqueia: cobre "o passo nunca rodou", que é
 * indistinguível de "rodou e falhou" do ponto de vista do acervo — nos dois
 * casos a edição não tem página. (Antes do #7578 era `warning`, para tolerar
 * uma versão do script anterior ao #7283; esse período já passou.)
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
          `edição (link de hub cairia no fallback do Kit e daria 404, ver #7266). GATE-BLOCKING desde ` +
          `#7578. Rodar manualmente: \`npx tsx scripts/publish-edition-site-page.ts --edition-dir ` +
          `{EDITION_DIR} --slug {slug} --sitemap workers/site/public/sitemap.xml\`.`,
        source_issue: "#7578",
        severity: "error",
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
        // Estado DESCONHECIDO: não dá pra afirmar que a página foi publicada.
        // Bloqueia junto com os demais (#7578) — a direção segura de um
        // artefato ilegível é a mesma de um artefato ausente.
        message: `site-page-published.json não parseável: ${(e as Error).message}`,
        source_issue: "#7578",
        severity: "error",
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
          `aberto/reusado). Motivo: ${data.reason ?? "não registrado"}. GATE-BLOCKING desde #7578 (era ` +
          `warning, e o silêncio deixou 12 dias de acervo parado): re-rodar \`publish-edition-site-page.ts\` ` +
          `com \`--sitemap workers/site/public/sitemap.xml\` e mergear o PR, ou aprovar o gate ciente de que ` +
          `a página fica 404 (ver #7266/#7280).`,
        source_issue: "#7578",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * Toda página em `workers/site/public/p/` precisa ter `<loc>` no
 * `sitemap.xml` do mesmo Worker (#7578).
 *
 * Por que é invariante de Stage 6, e não só um script de manutenção: uma
 * página fora do sitemap fica invisível em DUAS superfícies ao mesmo tempo —
 * no buscador (que segue o sitemap) e em `arquivo.diar.ia.br`, cujo acervo é
 * DERIVADO do sitemap do apex em request-time (`fetchSitemapXml`/
 * `parseSitemap`, `workers/arquivo/src/index.ts`), sem fonte própria. A
 * página responde 200 e mesmo assim ninguém chega nela.
 *
 * Foi assim que 5 edições ficaram órfãs entre 28/08 e 03/09/2026 sem nenhum
 * sinal: o `publish-edition-site-page.ts` gravou `/p/{slug}` e o sitemap não
 * acompanhou (a flag `--sitemap` só passou a escrever de verdade no #6454).
 *
 * Independente da edição em curso — varre o repo inteiro. É de propósito:
 * o custo é o mesmo e pega órfã de QUALQUER edição, inclusive as que uma
 * execução anterior deixou para trás.
 *
 * Ausência do diretório inteiro não viola nada (checkout parcial, fixture de
 * teste): o invariante é sobre página órfã, não sobre o site existir. Mas
 * diretório PRESENTE e VAZIO enquanto o sitemap declara URLs é outra coisa —
 * é perda de conteúdo, e sai como violação. Sem essa distinção o pior caso
 * possível (o acervo inteiro sumir do disco) passaria como "0 órfãs", que é
 * o mesmo silêncio que o #7578 existe para acabar, só que maior.
 *
 * `paths` é injetável só para teste (mesmo padrão de `backendOverride` em
 * `checkScheduledAt`): sem isso o único teste possível seria contra o repo
 * real, que este próprio PR deixa limpo — ou seja, um teste cujo corpo nunca
 * executa e que passa sem verificar nada.
 */
function checkSiteSitemapNoOrphans(
  _editionDir: string,
  paths?: { pagesDir: string; sitemapPath: string },
): InvariantViolation[] {
  const pagesDir = paths?.pagesDir ?? resolve(ROOT, "workers", "site", "public", "p");
  const sitemapPath = paths?.sitemapPath ?? resolve(ROOT, "workers", "site", "public", "sitemap.xml");
  if (!existsSync(pagesDir) || !existsSync(sitemapPath)) return [];

  const xml = readFileSync(sitemapPath, "utf8");
  const pageSlugs = listPageSlugs(pagesDir);
  const declarados = slugsInSitemap(xml).size;
  if (pageSlugs.length === 0 && declarados > 0) {
    return [
      {
        rule: "site-sitemap-no-orphans",
        message:
          `${pagesDir} existe mas não tem NENHUMA página, enquanto o sitemap declara ${declarados} URL(s) ` +
          `sob /p/. Isso é perda de conteúdo, não ausência de acervo — provável apagamento acidental ` +
          `(ver o guard \`--allow-prune\` de gen-archive-pages.ts, #7578) ou checkout corrompido. ` +
          `Restaurar as páginas antes de seguir; \`reconcile-site-sitemap.ts\` NÃO recupera página apagada.`,
        source_issue: "#7578",
        severity: "error",
        file: pagesDir,
      },
    ];
  }

  const orphans = findOrphanSlugs(pageSlugs, xml);
  if (orphans.length === 0) return [];

  return [
    {
      rule: "site-sitemap-no-orphans",
      message:
        `${orphans.length} página(s) em workers/site/public/p/ sem entrada no sitemap.xml: ` +
        `${orphans.slice(0, 5).join(", ")}${orphans.length > 5 ? ", …" : ""}. ` +
        `Página fora do sitemap é invisível no buscador E em arquivo.diar.ia.br (que deriva o acervo ` +
        `do sitemap do apex). Corrigir: \`npx tsx scripts/reconcile-site-sitemap.ts\`.`,
      source_issue: "#7578",
      severity: "error",
      file: sitemapPath,
    },
  ];
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
      "_internal/site-page-published.json registra published:true — GATE-BLOCKING desde #7578 (era warning, #7283)",
    source_issue: "#7578",
    stage: 6,
    run: checkSitePagePublished,
  },
  {
    id: "site-sitemap-no-orphans",
    description:
      "toda página em workers/site/public/p/ tem entrada no sitemap.xml — sem isso a página é invisível no buscador E no arquivo (#7578)",
    source_issue: "#7578",
    stage: 6,
    run: checkSiteSitemapNoOrphans,
  },
];

export {
  checkStep5Sentinel,
  checkScheduledAt,
  checkEditionReport,
  checkWhatsappSlugGuard,
  checkStep6Sentinel,
  checkSitePagePublished,
  // #7578: exportada pra teste com paths injetados — sem isso o unico teste
  // possivel seria contra o repo real, que fica limpo e nunca exercita o caminho.
  checkSiteSitemapNoOrphans,
};
