#!/usr/bin/env node
/**
 * clarice-cta-ab-setup.ts (one-off — Experimento CTA-01, ciclo 2606-07)
 *
 * Converte os envios 8 (campanha 95 / lista 78, qui 23/07) e 9 (campanha 96 /
 * lista 79, sex 24/07) do ramp-warm em teste A/B da copy do CTA do topo.
 * Protocolo pré-registrado: docs/experiments/cta-ab-mensal-2606-07.md.
 *
 * Por envio:
 *   1. Gera 2 variantes de HTML a partir do render canônico
 *      (`_internal/cloudflare-preview.html` — que tem os UTMs CORRETOS; o HTML
 *      nas campanhas 95/96 está corrompido com `utm_source=sendinblue&utm_campaign=`
 *      vazio, ver log do protocolo):
 *        A = copy atual;  B = copy aprovada pelo editor (B1, 260722).
 *      UTMs por braço: `utm_campaign=clarice-2606-07-cta-{a|b}` (chega ao
 *      Beehiiv) + `utm_term={posição}` (leitura por URL na Brevo).
 *   2. Split 50/50 da lista original (amostragem alternada sobre a ordem da
 *      lista — mesma lógica de célula estratificada do clarice-split-cells) em
 *      2 listas novas; cópia QA do editor entra nas DUAS.
 *   3. suspend campanha A → PUT html/recipients/name → re-agenda (re-snapshot,
 *      memória brevo-recipients-snapshot). Suspender PRIMEIRO é o fail-safe:
 *      se qualquer passo seguinte falhar, o envio fica suspenso (recuperável)
 *      em vez de sair dobrado ou com lista errada.
 *   4. Cria campanha B (rascunho → PUT scheduledAt, payload proven do
 *      clarice-schedule-ramp) no MESMO horário.
 *   5. GET-verify tudo (status queued, scheduledAt intacto, listas certas,
 *      UTMs no HTML) — #573: validar estado externo deterministicamente.
 *
 * ATENÇÃO (mesma regra do clarice-reapply-scheduled-html): nunca rodar
 * `--apply` sem supervisão direta do editor.
 *
 * Uso:
 *   npx tsx scripts/clarice-cta-ab-setup.ts                 # dry-run (default)
 *   npx tsx scripts/clarice-cta-ab-setup.ts --apply         # executa
 *   npx tsx scripts/clarice-cta-ab-setup.ts --apply --envio 8
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { brevoGet, brevoPost, brevoPut, brevoListAllLists } from "./lib/brevo-client.ts";
import { monthlyDir as resolveMonthlyDir } from "./lib/mensal/monthly-paths.ts";
import { assertHtmlHasUnsubscribeLink, pollUntilCount } from "./clarice-schedule-ramp.ts";
import { EDITOR_COPY_EMAIL } from "./lib/editor-copy.ts";
import { isMainModule } from "./lib/cli-args.ts";

loadProjectEnv();

const CYCLE = "2606-07";
const YYMM = "2606";

interface EnvioCfg {
  envio: number;
  campaignId: number;
  srcListId: number;
  day: string; // rótulo humano, entra no nome das listas/campanhas novas
}

const ENVIOS: EnvioCfg[] = [
  { envio: 8, campaignId: 95, srcListId: 78, day: "qui 23/07" },
  { envio: 9, campaignId: 96, srcListId: 79, day: "sex 24/07" },
];

// Posições dos 7 links `diaria.beehiiv.com` no render canônico, em ordem de
// documento (verificado em 260722): wordmarks intercalados com os 3 CTAs.
const UTM_TERM_LABELS = [
  "topo-marca", // apresentação: wordmark "em parceria com a diar.ia.br"
  "topo",       // apresentação: CTA (o link do experimento)
  "corpo-marca",// bloco dedicado: wordmark "a diar.ia.br, que produz..."
  "corpo",      // bloco dedicado: botão "Assinar a edição diária"
  "fim-marca",  // encerramento: wordmark "nasce da diar.ia.br"
  "fim",        // encerramento: CTA "aqui"
  "fim-marca2", // encerramento: wordmark do parágrafo social
] as const;

const BASE_UTM = "https://diaria.beehiiv.com/?utm_source=clarice";
const CAMPAIGN_TOKEN = `clarice-${CYCLE}`;

// Frase do topo no braço A (exata no render canônico, com &amp; nos hrefs).
const TOPO_A =
  `Se quiser receber tutoriais e notícias de IA todos os dias, se cadastre gratuitamente ` +
  `<a href="https://diaria.beehiiv.com/?utm_source=clarice&amp;utm_medium=email&amp;utm_campaign=clarice-2606-07" ` +
  `style="color:#171411;text-decoration:underline;text-decoration-color:#00A0A0;">aqui</a>.`;

// Copy B1 aprovada pelo editor (260722). Wordmark em bold SEM link — os dois
// braços ficam com o MESMO conjunto de links (só o anchor/copy do `topo` varia).
const WORDMARK_PLAIN =
  `<strong>diar<span style="color:#00A0A0">.</span>ia<span style="color:#00A0A0">.</span>br</strong>`;
const TOPO_B =
  `E pra não esperar um mês: a ${WORDMARK_PLAIN} entrega isso todo dia — 5 minutos pra se manter ` +
  `atualizado e usar melhor as IAs. ` +
  `<a href="https://diaria.beehiiv.com/?utm_source=clarice&amp;utm_medium=email&amp;utm_campaign=clarice-2606-07" ` +
  `style="color:#171411;text-decoration:underline;text-decoration-color:#00A0A0;">Assine grátis a edição diária →</a>`;

/**
 * Reescreve os 7 links do Beehiiv: sufixo de braço no utm_campaign + utm_term
 * posicional. Preserva o estilo de escape de cada ocorrência (`&amp;` vs `&`)
 * pra não mexer em nada além da query string.
 */
export function tagVariantUtms(html: string, arm: "a" | "b"): string {
  let idx = 0;
  const out = html.replace(
    // casa `utm_campaign=clarice-2606-07"` imediatamente após um href do Beehiiv
    new RegExp(`(${BASE_UTM.replace(/[.?]/g, "\\$&")}(?:&(?:amp;)?utm_medium=email)(&(?:amp;)?)utm_campaign=${CAMPAIGN_TOKEN}")`, "g"),
    (_m, full: string, sep: string) => {
      const label = UTM_TERM_LABELS[idx];
      if (!label) throw new Error(`Mais links Beehiiv que o esperado (${UTM_TERM_LABELS.length}) — render mudou, revisar UTM_TERM_LABELS.`);
      idx++;
      return full.replace(
        `utm_campaign=${CAMPAIGN_TOKEN}"`,
        `utm_campaign=${CAMPAIGN_TOKEN}-cta-${arm}${sep}utm_term=${label}"`,
      );
    },
  );
  if (idx !== UTM_TERM_LABELS.length) {
    throw new Error(`Esperava ${UTM_TERM_LABELS.length} links Beehiiv, achei ${idx} — render mudou, abortando.`);
  }
  return out;
}

export function buildVariantHtml(canonical: string, arm: "a" | "b"): string {
  let html = canonical;
  if (arm === "b") {
    if (!html.includes(TOPO_A)) throw new Error("Frase do CTA topo (braço A) não encontrada no render canônico — abortando.");
    html = html.replace(TOPO_A, TOPO_B);
  }
  html = tagVariantUtms(html, arm);
  // Invariantes pós-transform
  assertHtmlHasUnsubscribeLink(html);
  const armCount = (html.match(new RegExp(`-cta-${arm}(&|&amp;)utm_term=`, "g")) ?? []).length;
  if (armCount !== UTM_TERM_LABELS.length) throw new Error(`Braço ${arm}: ${armCount} links tagueados (esperava ${UTM_TERM_LABELS.length}).`);
  if (html.includes("utm_source=sendinblue")) throw new Error("HTML ainda contém utm_source=sendinblue — abortando.");
  const hasB = html.includes("Assine grátis a edição diária");
  if (arm === "b" && !hasB) throw new Error("Braço B sem a copy nova — abortando.");
  if (arm === "a" && hasB) throw new Error("Braço A contaminado com a copy B — abortando.");
  return html;
}

/** Split alternado (célula estratificada pela ordem da lista) + QA nos dois braços. */
export function splitAlternate(emails: string[], qaEmail: string): { a: string[]; b: string[] } {
  const rest = emails.filter((e) => e !== qaEmail);
  const a: string[] = [];
  const b: string[] = [];
  rest.forEach((e, i) => (i % 2 === 0 ? a : b).push(e));
  a.push(qaEmail);
  b.push(qaEmail);
  return { a, b };
}

// ---------------------------------------------------------------------------

const API_KEY = process.env.BREVO_CLARICE_API_KEY;

interface CampaignDetail {
  id: number;
  name: string;
  subject?: string;
  previewText?: string;
  status: string;
  scheduledAt?: string;
  sender?: { name?: string; email?: string };
  replyTo?: string;
  htmlContent?: string;
  recipients?: { lists?: number[] };
}

async function getCampaign(id: number): Promise<CampaignDetail> {
  const r = (await brevoGet(API_KEY!, `/emailCampaigns/${id}`)) as { status: number; body: CampaignDetail };
  if (r.status !== 200) throw new Error(`GET /emailCampaigns/${id} → ${r.status}`);
  return r.body;
}

async function fetchListEmails(listId: number, expected: number): Promise<string[]> {
  const emails: string[] = [];
  for (let offset = 0; ; offset += 500) {
    const r = (await brevoGet(API_KEY!, `/contacts/lists/${listId}/contacts?limit=500&offset=${offset}`)) as {
      status: number;
      body: { contacts?: Array<{ email?: string }>; count?: number };
    };
    if (r.status !== 200) throw new Error(`GET contacts of list ${listId} → ${r.status}`);
    const page = r.body.contacts ?? [];
    for (const c of page) if (c.email) emails.push(c.email.toLowerCase());
    if (page.length < 500) break;
  }
  const uniq = [...new Set(emails)];
  if (uniq.length < expected * 0.95) {
    throw new Error(`Lista ${listId}: só ${uniq.length} emails paginados (esperava ~${expected}) — abortando.`);
  }
  return uniq;
}

async function ensureList(name: string, folderId: number | undefined): Promise<number> {
  const all = (await brevoListAllLists(API_KEY!)) as Array<{ id: number; name: string }>;
  const existing = all.find((l) => l.name === name);
  if (existing) {
    console.error(`  ↷ lista já existe: "${name}" (#${existing.id}) — reusando`);
    return existing.id;
  }
  const resp = (await brevoPost(API_KEY!, "/contacts/lists", {
    name,
    ...(folderId !== undefined ? { folderId } : {}),
  })) as { id?: number };
  if (typeof resp?.id !== "number") throw new Error(`POST /contacts/lists shape inesperado: ${JSON.stringify(resp)}`);
  return resp.id;
}

async function importEmails(listId: number, emails: string[]): Promise<void> {
  await brevoPost(API_KEY!, "/contacts/import", {
    fileBody: "EMAIL\n" + emails.join("\n"),
    listIds: [listId],
    updateExistingContacts: true,
    emptyContactsAttributes: false,
  });
  const poll = await pollUntilCount(
    async () => {
      const r = (await brevoGet(API_KEY!, `/contacts/lists/${listId}`)) as { status: number; body: { totalSubscribers?: number } };
      return r.body?.totalSubscribers ?? 0;
    },
    emails.length,
  );
  if (!poll.matched) {
    throw new Error(`Import lista #${listId}: contagem ${poll.finalCount}/${emails.length} após ${poll.attempts} tentativas — abortando (não agendar sem lista completa).`);
  }
  console.error(`  ✓ lista #${listId}: ${poll.finalCount} contatos confirmados`);
}

async function setStatus(campaignId: number, status: string): Promise<void> {
  await brevoPut(API_KEY!, `/emailCampaigns/${campaignId}/status`, { status });
}

async function processEnvio(cfg: EnvioCfg, apply: boolean, outDir: string): Promise<void> {
  console.error(`\n=== Envio ${cfg.envio} (campanha #${cfg.campaignId}, lista #${cfg.srcListId}, ${cfg.day}) ===`);

  // 1. Estado ao vivo (#573)
  const camp = await getCampaign(cfg.campaignId);
  if (camp.status !== "queued") throw new Error(`Campanha #${cfg.campaignId} status="${camp.status}" (esperava queued) — abortando envio ${cfg.envio}.`);
  if (!camp.scheduledAt) throw new Error(`Campanha #${cfg.campaignId} sem scheduledAt — abortando.`);
  const srcList = (await brevoGet(API_KEY!, `/contacts/lists/${cfg.srcListId}`)) as {
    status: number;
    body: { totalSubscribers?: number; folderId?: number };
  };
  const total = srcList.body?.totalSubscribers ?? 0;
  console.error(`  campanha "${camp.name}" | ${camp.scheduledAt} | lista com ${total} contatos`);

  // 2. Variantes de HTML (sempre — dry-run escreve pra inspeção)
  const canonical = readFileSync(resolve(resolveMonthlyDir(CYCLE), "_internal", "cloudflare-preview.html"), "utf8");
  const htmlA = buildVariantHtml(canonical, "a");
  const htmlB = buildVariantHtml(canonical, "b");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, `envio${cfg.envio}-a.html`), htmlA, "utf8");
  writeFileSync(resolve(outDir, `envio${cfg.envio}-b.html`), htmlB, "utf8");
  console.error(`  ✓ variantes geradas em _internal/cta-ab/envio${cfg.envio}-{a,b}.html`);

  if (!apply) {
    console.error(`  [dry-run] split ~${Math.ceil(total / 2)}/${Math.floor(total / 2)}, listas "envio ${cfg.envio}A/B", suspend→edita→re-agenda #${cfg.campaignId}, cria campanha B às ${camp.scheduledAt}`);
    return;
  }

  // 3. Split + listas novas + import (não-destrutivo; lista original fica intacta)
  const emails = await fetchListEmails(cfg.srcListId, total);
  const { a, b } = splitAlternate(emails, EDITOR_COPY_EMAIL);
  console.error(`  split: ${a.length} (A) / ${b.length} (B), QA ${EDITOR_COPY_EMAIL} nos dois`);
  const listA = await ensureList(`Diar.ia Mensal ${YYMM} — envio ${cfg.envio}A (cta-a ${cfg.day})`, srcList.body?.folderId);
  const listB = await ensureList(`Diar.ia Mensal ${YYMM} — envio ${cfg.envio}B (cta-b ${cfg.day})`, srcList.body?.folderId);
  await importEmails(listA, a);
  await importEmails(listB, b);

  // 4. Campanha A: suspend PRIMEIRO (fail-safe), edita, re-agenda
  await setStatus(cfg.campaignId, "suspended");
  console.error(`  ✓ #${cfg.campaignId} suspensa`);
  await brevoPut(API_KEY!, `/emailCampaigns/${cfg.campaignId}`, {
    name: `Diar.ia Mensal ${YYMM} — envio ${cfg.envio}A (cta-a ${cfg.day})`,
    htmlContent: htmlA,
    recipients: { listIds: [listA] },
  });
  await brevoPut(API_KEY!, `/emailCampaigns/${cfg.campaignId}`, { scheduledAt: camp.scheduledAt });
  let after = await getCampaign(cfg.campaignId);
  if (after.status !== "queued") {
    await setStatus(cfg.campaignId, "queued");
    after = await getCampaign(cfg.campaignId);
  }
  if (after.status !== "queued" || after.scheduledAt !== camp.scheduledAt) {
    throw new Error(`Campanha A #${cfg.campaignId} pós-edição: status=${after.status} scheduledAt=${after.scheduledAt} (esperava queued @ ${camp.scheduledAt}) — INTERVENÇÃO MANUAL.`);
  }
  console.error(`  ✓ A re-agendada: #${cfg.campaignId} → lista #${listA} @ ${after.scheduledAt}`);

  // 5. Campanha B (rascunho → PUT scheduledAt, payload proven do ramp)
  const bName = `Diar.ia Mensal ${YYMM} — envio ${cfg.envio}B (cta-b ${cfg.day})`;
  const respB = (await brevoPost(API_KEY!, "/emailCampaigns", {
    name: bName,
    subject: camp.subject,
    ...(camp.previewText ? { previewText: camp.previewText } : {}),
    sender: { name: camp.sender?.name, email: camp.sender?.email },
    // GET devolve o placeholder "[DEFAULT_REPLY_TO]" quando a campanha usa o
    // reply-to padrão da conta — só repassar se for um e-mail de verdade.
    ...(camp.replyTo?.includes("@") ? { replyTo: camp.replyTo } : {}),
    recipients: { listIds: [listB] },
    htmlContent: htmlB,
  })) as { id?: number };
  if (typeof respB?.id !== "number") throw new Error(`POST campanha B shape inesperado: ${JSON.stringify(respB)}`);
  await brevoPut(API_KEY!, `/emailCampaigns/${respB.id}`, { scheduledAt: camp.scheduledAt });
  const bAfter = await getCampaign(respB.id);
  if (bAfter.status !== "queued" || bAfter.scheduledAt !== camp.scheduledAt) {
    throw new Error(`Campanha B #${respB.id}: status=${bAfter.status} scheduledAt=${bAfter.scheduledAt} (esperava queued @ ${camp.scheduledAt}) — INTERVENÇÃO MANUAL.`);
  }
  console.error(`  ✓ B criada e agendada: #${respB.id} → lista #${listB} @ ${bAfter.scheduledAt}`);

  // 6. Test emails pros dois braços (QA visual do editor)
  for (const [label, id] of [["A", cfg.campaignId], ["B", respB.id]] as const) {
    await brevoPost(API_KEY!, `/emailCampaigns/${id}/sendTest`, { emailTo: [EDITOR_COPY_EMAIL] });
    console.error(`  ✓ test email ${label} → ${EDITOR_COPY_EMAIL}`);
  }
}

async function main(): Promise<void> {
  if (!API_KEY) { console.error("BREVO_CLARICE_API_KEY missing"); process.exit(2); }
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const envioArg = argv.includes("--envio") ? Number(argv[argv.indexOf("--envio") + 1]) : undefined;
  const targets = ENVIOS.filter((e) => envioArg === undefined || e.envio === envioArg);
  if (targets.length === 0) throw new Error(`--envio ${envioArg} não existe (válidos: ${ENVIOS.map((e) => e.envio).join(", ")})`);
  const outDir = resolve(resolveMonthlyDir(CYCLE), "_internal", "cta-ab");
  console.error(apply ? "MODO APPLY — escrevendo na Brevo." : "Dry-run (use --apply para executar).");
  for (const cfg of targets) await processEnvio(cfg, apply, outDir);
  console.error("\nLembrete manual (UI da Brevo): conferir que 'Activate Google Analytics tracking' está DESLIGADO nas 4 campanhas antes do envio — senão a Brevo reescreve os UTMs.");
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
}
