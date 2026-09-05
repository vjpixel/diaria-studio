/**
 * audit-engagement-manifest.ts (#7197)
 *
 * Reconcilia `data/beehiiv-backup/subscriber-engagement/manifest.json`
 * contra a única fonte que não pode mentir sobre si mesma: as linhas de
 * fato gravadas em cada `{post_id}.jsonl`. Medido ao vivo (#7197): 255 de
 * 256 posts vinham marcados `status: "ok"`, sendo que 7 tinham `count: 0` e
 * 16 tinham `count` menor do que o disco realmente carrega — o manifest
 * "declarava íntegro" um acervo 33% incompleto.
 *
 * Por que isso é possível mesmo com `apply-mcp-subscriber-engagement.ts`
 * sempre escrevendo `count: records.length` no mesmo golpe que grava o
 * JSONL (#7197 não achou um bug de escrita simultânea): o manifest pode
 * divergir do disco por qualquer evento POSTERIOR à escrita original —
 * manifest restaurado de um snapshot OneDrive mais antigo (achado
 * documentado: `onedrive-conflict-backup-durante-edit.md`), ou entries
 * escritas por uma versão do script anterior ao guard de #6496/#7197. Este
 * script fecha o loop pro que já está em disco; o guard write-time em
 * `apply-mcp-subscriber-engagement.ts` (`--confirmed-empty`, #7197) evita
 * que o padrão volte a acontecer daqui pra frente.
 *
 * Regra de reconciliação (pura, `reconcileManifestWithDisk` em
 * `scripts/lib/beehiiv-engagement-manifest.ts` — só entries `status: "ok"`
 * são candidatas):
 *   1. 0 linhas reais em disco → rebaixa pra `pending` (redrenar do zero) —
 *      exceto entry com `confirmed_empty: true` (checagem 0, #7418: vazio
 *      confirmado de propósito via `--confirmed-empty` fica `ok`).
 *   2. `manifest.count` != linhas reais → rebaixa pra `partial` e corrige
 *      `count` pro valor real (disco tem ALGUM dado, só precisa completar).
 *   3. Bate → mantém `ok`, intocado.
 *
 * #7417: checagem 4 (shape por linha, `reconcileShapeViolations`) — a contagem
 *   não é suficiente. O acervo levou 100 linhas placeholder
 *   (`{"subscriber_id":"sub1"}` ... `sub100`, sem `email`/`status`/`timestamp`)
 *   e `manifest.count` == 100 == linhas reais, então as checagens 1-3
 *   concordavam perfeitamente com o dado fabricado; só a leitura do CONTEÚDO
 *   de cada linha pega isso. `validateEngagementLine` exige `subscriber_id`
 *   UUID real, `email` válido, `status` no conjunto da MCP
 *   (`delivered`/`opened`/`clicked`/`unsubscribed`) e `timestamp` ISO 8601.
 *
 * O que este script NÃO faz (fora de escopo, exige sessão com MCP Beehiiv
 * ao vivo — guard de publicação do overnight/develop não deixa um
 * subagente de dispatch tocar Beehiiv/qualquer API externa "ao vivo"):
 * comparar contra `total_received` que a própria Beehiiv reporta pro post
 * (3ª contagem do checklist da #7197), e re-drenar os posts rebaixados.
 * Rodar `list-posts-for-engagement-backup.ts` depois deste script já
 * reoferece automaticamente tudo que foi rebaixado (não é mais `ok`).
 *
 * Uso:
 *   npx tsx scripts/audit-engagement-manifest.ts                 # aplica e grava
 *   npx tsx scripts/audit-engagement-manifest.ts --dry-run        # só reporta
 *   npx tsx scripts/audit-engagement-manifest.ts --out-dir DIR    # override do diretório
 *   npx tsx scripts/audit-engagement-manifest.ts --json           # relatório em JSON no stdout
 *
 * Output (stdout): por padrão, resumo human-readable com contagem de
 * rebaixamentos + cobertura antes/depois. Com `--json`, emite
 * `{ downgraded: [...], coverage_before: {...}, coverage_after: {...} }`.
 * Stderr: progresso.
 * Exit codes: 0=sucesso (mesmo com 0 rebaixamentos), 1=erro de IO,
 * 2=manifest inexistente.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { countExistingLines } from "./apply-mcp-subscriber-engagement.ts";
import {
  reconcileManifestWithDisk,
  reconcileShapeViolations,
  validateEngagementLines,
  coverageSummary,
  type EngagementManifest,
  type LineShapeReport,
  type LineShapeViolation,
} from "./lib/beehiiv-engagement-manifest.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = resolve(ROOT, "data/beehiiv-backup/subscriber-engagement");

function loadManifest(manifestPath: string): EngagementManifest | null {
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, "utf8")) as EngagementManifest;
}

function saveManifestAtomic(manifestPath: string, manifest: EngagementManifest): void {
  const tmp = `${manifestPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(tmp, manifestPath);
}

/** Lê, pro `outDir` dado, o nº real de linhas de cada post_id do manifest — a fonte da reconciliação. */
export function readActualCounts(manifest: EngagementManifest, outDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of manifest.posts) {
    counts.set(entry.post_id, countExistingLines(resolve(outDir, `${entry.post_id}.jsonl`)));
  }
  return counts;
}

/**
 * Lê, pro `outDir` dado, o shape de cada linha de cada post_id do manifest —
 * a fonte da checagem de #7417. Post sem `.jsonl` em disco é pulado (não
 * entra no mapa): o `reconcileShapeViolations` ignora entradas sem relatório,
 * e o post já foi rebaixado a `pending` pela checagem 1 de
 * `reconcileManifestWithDisk` (0 linhas reais).
 *
 * Linhas com JSON.parse falhando são registradas como violações de shape
 * (mensagem "JSON parse falhou"), não propagadas como exceção — um arquivo
 * truncado por escrita interrompida não deve derrubar a auditoria inteira.
 */
export function readLineShapeReports(manifest: EngagementManifest, outDir: string): Map<string, LineShapeReport> {
  const reports = new Map<string, LineShapeReport>();
  for (const entry of manifest.posts) {
    const path = resolve(outDir, `${entry.post_id}.jsonl`);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    const records: unknown[] = [];
    const violations: LineShapeViolation[] = [];
    lines.forEach((line, i) => {
      try {
        records.push(JSON.parse(line) as unknown);
      } catch {
        violations.push({ line: i + 1, error: "JSON parse falhou (linha não é JSON válido)" });
      }
    });
    const lineViolations = validateEngagementLines(records);
    reports.set(entry.post_id, { total: lines.length, violations: [...violations, ...lineViolations] });
  }
  return reports;
}

/**
 * I/O: `email.recipients` por post, via REST (`GET /posts/{id}?expand[]=stats`)
 * — a ÂNCORA EXTERNA da reconciliação (#7197).
 *
 * Sem ela, a auditoria compara o manifest só com o disco, e esse par bate em
 * 256 de 256 posts do acervo real: o drenador é honesto sobre o que gravou,
 * ele só não sabe que gravou uma fração. Medido em 03/09/2026, as checagens
 * locais sozinhas rebaixam 6 posts; com `recipients`, 191.
 *
 * Post que falhar (404, stats ausente, rede) simplesmente NÃO entra no mapa
 * — `reconcileManifestWithDisk` deixa esses como estão, em vez de rebaixar
 * o acervo inteiro por indisponibilidade de rede. A contagem de ausentes é
 * devolvida pro chamador reportar, nunca engolida.
 */
/** As entradas cuja completude a âncora externa consegue julgar — só `ok` (#7197). */
export function postsNeedingAnchor(manifest: EngagementManifest): EngagementManifest["posts"] {
  return manifest.posts.filter((e) => e.status === "ok");
}

export async function fetchRecipientsByPost(
  manifest: EngagementManifest,
  cfg: { apiKey: string; publicationId: string },
): Promise<{ recipients: Map<string, number>; delivered: Map<string, number>; unavailable: string[] }> {
  const recipients = new Map<string, number>();
  const delivered = new Map<string, number>();
  const unavailable: string[] = [];
  // Só entrada `ok` é candidata a rebaixamento — `reconcileManifestWithDisk`
  // nem consulta o mapa pras outras. Buscar `recipients`/`delivered` pra
  // elas gastaria quota à toa e, pior, um 404 numa entrada já sabidamente
  // `pending` cairia em `unavailable` e degradaria o VEREDITO da auditoria
  // por um post que não muda nenhum resultado.
  for (const entry of postsNeedingAnchor(manifest)) {
    const url = `${beehiivApiBase()}/publications/${cfg.publicationId}/posts/${entry.post_id}?expand[]=stats`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
      if (!res.ok) {
        unavailable.push(entry.post_id);
        continue;
      }
      const j = (await res.json()) as {
        data?: { stats?: { email?: { recipients?: number; delivered?: number } } };
      };
      const r = j?.data?.stats?.email?.recipients;
      const d = j?.data?.stats?.email?.delivered;
      // `delivered` é a âncora preferida (#7268 — ver docstring de
      // `reconcileManifestWithDisk`): um post sem ela ainda entra em
      // `unavailable` se `recipients` também faltar, mas nunca se só
      // `delivered` faltar (fallback puro pra `recipients`).
      if (typeof r === "number") recipients.set(entry.post_id, r);
      if (typeof d === "number") delivered.set(entry.post_id, d);
      if (typeof r !== "number" && typeof d !== "number") unavailable.push(entry.post_id);
    } catch {
      unavailable.push(entry.post_id);
    }
  }
  return { recipients, delivered, unavailable };
}

export type AuditVerdict = "completo" | "parcial-sem-ancora" | "parcial-ancora-incompleta";

/**
 * Puro: o veredito NUNCA é "completo" quando a âncora externa não cobriu todos
 * os posts (#7197). Sem `recipients`, esta auditoria compara só manifest × disco
 * — par que bate em 256/256 posts do acervo real, inclusive nos 191 drenados
 * pela metade. Chamar isso de "acervo íntegro" foi exatamente o erro que a
 * issue documenta, então o modo degradado se anuncia em vez de se calar.
 */
export function auditVerdict(skipRecipients: boolean, unavailableCount: number): AuditVerdict {
  if (skipRecipients) return "parcial-sem-ancora";
  if (unavailableCount > 0) return "parcial-ancora-incompleta";
  return "completo";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outDirIdx = argv.indexOf("--out-dir");
  const outDir = outDirIdx !== -1 ? resolve(argv[outDirIdx + 1]) : DEFAULT_OUT_DIR;
  const dryRun = argv.includes("--dry-run");
  const asJson = argv.includes("--json");

  const manifestPath = resolve(outDir, "manifest.json");
  const manifest = loadManifest(manifestPath);
  if (!manifest) {
    console.error(`[audit-engagement-manifest] manifest não encontrado: ${manifestPath}`);
    process.exit(2);
  }

  const coverageBefore = coverageSummary(manifest);
  const actualCounts = readActualCounts(manifest, outDir);

  // #7417: shape de cada linha. Contagem não é suficiente — o acervo
  // levou 100 linhas placeholder (`{"subscriber_id":"sub1"}`) sem email/status/
  // timestamp e `reconcileManifestWithDisk` via `manifest.count` == 100 ==
  // linhas reais, portanto concordava perfeitamente. Ler o CONTEÚDO de cada
  // linha é o único jeito de pegar isso. Só posts com .jsonl em disco são
  // candidatos; ausência de arquivo → Map vazio → nenhuma violação (o post
  // já foi rebaixado a `pending` pela checagem 1 de `reconcileManifestWithDisk`).
  const lineShapeReports = readLineShapeReports(manifest, outDir);

  // #7197: sem a âncora externa (`recipients`), esta auditoria só compara o
  // manifest com o disco — par que bate em 256/256 no acervo real, porque o
  // drenador é honesto sobre o que gravou. `--skip-recipients` existe pra
  // rodar offline/em teste, e o relatório diz alto quando foi usado: nesse
  // modo o veredito é PARCIAL, não "acervo íntegro".
  const skipRecipients = argv.includes("--skip-recipients");
  let recipients: Map<string, number> | undefined;
  let delivered: Map<string, number> | undefined;
  let unavailable: string[] = [];
  if (!skipRecipients) {
    loadProjectEnv(ROOT);
    const cfg = loadBeehiivConfig("[audit-engagement-manifest]");
    const fetched = await fetchRecipientsByPost(manifest, cfg);
    recipients = fetched.recipients;
    delivered = fetched.delivered;
    unavailable = fetched.unavailable;
  }

  const { manifest: countReconciled, downgraded: countDowngrades } = reconcileManifestWithDisk(
    manifest,
    actualCounts,
    recipients,
    delivered,
  );
  // #7417: shape por linha rode DEPOIS da contagem — um post cujo count já
  // divergiu do disco foi rebaixado a `partial`/`pending` e `reconcileShapeViolations`
  // ignora entradas não-ok, então não rebaixa de novo o mesmo post.
  const { manifest: reconciled, downgraded: shapeDowngrades } = reconcileShapeViolations(
    countReconciled,
    lineShapeReports,
  );
  const downgraded = [...countDowngrades, ...shapeDowngrades];
  const coverageAfter = coverageSummary(reconciled);

  if (!dryRun && downgraded.length > 0) {
    saveManifestAtomic(manifestPath, reconciled);
  }

  if (asJson) {
    const shapeViolations: Record<string, LineShapeReport> = {};
    for (const [postId, report] of lineShapeReports) {
      if (report.violations.length > 0) shapeViolations[postId] = report;
    }
    console.log(
      JSON.stringify(
        {
          downgraded,
          coverage_before: coverageBefore,
          coverage_after: coverageAfter,
          dry_run: dryRun,
          recipients_checked: recipients ? recipients.size : 0,
          recipients_unavailable: unavailable,
          verdict: auditVerdict(skipRecipients, unavailable.length),
          shape_violations: shapeViolations,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (skipRecipients) {
    process.stderr.write(
      "[audit-engagement-manifest] VEREDITO PARCIAL: --skip-recipients — sem a âncora externa (email.recipients),\n" +
        "  esta auditoria só compara manifest × disco, par que bate mesmo em post drenado pela metade (#7197).\n",
    );
  } else if (unavailable.length > 0) {
    process.stderr.write(
      `[audit-engagement-manifest] VEREDITO PARCIAL: ${unavailable.length} post(s) sem recipients — ` +
        `não checados contra a âncora: ${unavailable.join(", ")}\n`,
    );
  }

  process.stderr.write(
    `[audit-engagement-manifest] cobertura ANTES: ${coverageBefore.ok}/${coverageBefore.total} ok\n` +
      `[audit-engagement-manifest] ${downgraded.length} post(s) rebaixado(s) de ok:\n`,
  );
  for (const d of downgraded) {
    process.stderr.write(`  ${d.post_id}: ok → ${d.to} — ${d.reason}\n`);
  }
  // #7417: shape violations são reportadas separado do rebaixamento (o post
  // pode ter dados reais + contaminação → `partial`; ou 100% inválido →
  // `pending`). O relatório mostra o shape mesmo quando não houve
  // rebaixamento, pra que o editor veja que o guard rodou.
  let shapeReported = 0;
  for (const [postId, report] of lineShapeReports) {
    if (report.violations.length === 0) continue;
    shapeReported++;
    process.stderr.write(
      `[audit-engagement-manifest] shape #7417 ${postId}: ${report.violations.length}/${report.total} linha(s) inválida(s)\n`,
    );
    for (const v of report.violations) {
      process.stderr.write(`    linha ${v.line}: ${v.error}\n`);
    }
  }
  process.stderr.write(
    `[audit-engagement-manifest] cobertura DEPOIS: ${coverageAfter.ok}/${coverageAfter.total} ok` +
      `${dryRun ? " (--dry-run, manifest NÃO gravado)" : ""}\n` +
      (shapeReported === 0
        ? `[audit-engagement-manifest] shape #7417: nenhuma linha inválida no acervo\n`
        : ""),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
