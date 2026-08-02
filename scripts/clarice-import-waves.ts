#!/usr/bin/env node
/**
 * clarice-import-waves.ts
 *
 * Importa pro Brevo as waves geradas por clarice-build-waves-store.ts: cria uma
 * lista por wave e sobe os contatos do CSV correspondente. Terça-feira vira 1
 * comando em vez de import manual na UI.
 *
 * SEGURANÇA: dry-run por padrão (só imprime o plano). `--execute` é que de fato
 * cria listas e importa contatos na conta de PRODUÇÃO da Clarice.
 *
 * Uso:
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2605-06 --label "Mai→Jun/2026"            # dry-run
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2605-06 --label "Mai→Jun/2026" --execute  # cria + importa
 *   --cycle {conteúdo}-{envio}   OBRIGATÓRIO — ciclo do envio (casa com clarice-build-waves-store --cycle)
 *   [--folder-id N]              folder Brevo onde criar as listas (default 1)
 *   [--group NOME]               #2916 — importa um GRUPO NOMEADO (#2885,
 *                                 `clarice-build-segment.ts --group NOME`) em vez
 *                                 da rampa: lê `{ciclo}/segments/{NOME}-manifest.json`
 *                                 (via `clariceSegmentsDir`) no lugar de
 *                                 `{ciclo}/waves/waves-manifest.json`. Sem a flag,
 *                                 comportamento inalterado (rampa via waves/).
 *
 * Uso (grupo nomeado):
 *   npx tsx scripts/clarice-build-segment.ts --group engajados --cycle 2605-06 --budget 500
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2605-06 --group engajados --label "Retenção Jun/2026"            # dry-run
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2605-06 --group engajados --label "Retenção Jun/2026" --execute  # cria + importa
 *
 * Env:
 *   BREVO_CLARICE_API_KEY   obrigatório (só usado em --execute)
 *
 * Inputs:
 *   sem --group (rampa, em data/clarice-subscribers/{conteúdo}-{envio}/waves/):
 *     waves-manifest.json (gerado por clarice-build-waves-store.ts) + os
 *     w*-store.csv correspondentes — único caminho suportado (#2656 cutover;
 *     o fallback pro cohort legado T1/T2 foi removido em #2844/260702).
 *   com --group NOME (grupo nomeado, em .../{conteúdo}-{envio}/segments/):
 *     {NOME}-manifest.json + {NOME}.csv (gerados por clarice-build-segment.ts,
 *     #2885/#2916 — mesmo shape do manifest da rampa: key/file/desc).
 *
 * Output adicional com --group + --execute (#3228): cada lista Brevo criada é
 * REGISTRADA (append) em `{ciclo}/segments/{group}-lists.json` — sem isso, o
 * `listId` retornado pela API só existia no stdout desta invocação, e o script
 * de agendamento de campanha (`clarice-schedule-group.ts`, #3228) não tinha
 * como resolver "qual lista Brevo pertence a este grupo neste ciclo" sem o
 * editor copiar o ID manualmente. `resolveGroupListId` (em
 * clarice-schedule-group.ts) lê este arquivo via `--group` em vez de exigir
 * `--list-id` explícito.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { brevoPost, brevoListAllLists } from "./lib/brevo-client.ts"; // #2018: brevoListAllLists
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { clariceWavesDir, clariceSegmentsDir, parseCycleArg } from "./lib/clarice-paths.ts"; // #1961 / #2916
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { ensureEditorCopyRow } from "./lib/editor-copy.ts"; // #3455

loadProjectEnv();

// ---------------------------------------------------------------------------
// Definição das waves (ordem de envio = ordem do warm-up)
// ---------------------------------------------------------------------------

export interface WaveDef {
  key: string;
  file: string;
  /** Rótulo curto pro nome da lista. */
  desc: string;
  /** Opcional: pula sem erro se o arquivo não existir. O manifest store-driven
   *  nunca marca entradas como opcionais (só lista o que de fato gerou) — o
   *  campo existe pra buildPlan tratar ausência de arquivo defensivamente. */
  optional?: boolean;
}

/**
 * #2656: o builder store-driven (clarice-build-waves-store.ts) escreve um
 * `waves-manifest.json` no dir de waves listando as waves daquele ciclo — é a
 * ÚNICA fonte de verdade (#2844/260702: fallback pro cohort legado T1/T2
 * removido junto com clarice-build-waves.ts). Sem manifest, erro claro em vez
 * de silenciosamente montar um plano com CSVs que não existem mais.
 *
 * #2916: generalizado pra também ler o manifest de um GRUPO NOMEADO (#2885,
 * `clarice-build-segment.ts`) — `manifestFileName` default preserva o
 * comportamento da rampa (`waves-manifest.json`); `buildPlan` passa
 * `{group}-manifest.json` quando `--group` é usado. Mesmo shape (array de
 * `{key, file, desc, ...}` — campos extras como `count` são ignorados aqui).
 */
export function loadWaveDefs(dir: string, manifestFileName = "waves-manifest.json"): WaveDef[] {
  const manifestPath = resolve(dir, manifestFileName);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${manifestFileName} ausente em ${dir} — gere com ` +
        (manifestFileName === "waves-manifest.json"
          ? `'clarice-build-waves-store.ts --cycle ...'.`
          : `'clarice-build-segment.ts --cycle ... --group ...'.`),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    throw new Error(`${manifestFileName} inválido (${manifestPath}): ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${manifestFileName} deve ser um array de waves (${manifestPath}).`);
  }
  return parsed.map((e, i) => {
    const entry = e as Record<string, unknown>;
    if (
      !entry ||
      typeof entry.key !== "string" ||
      typeof entry.file !== "string" ||
      typeof entry.desc !== "string"
    ) {
      throw new Error(
        `${manifestFileName}: entrada ${i} inválida (precisa key/file/desc string): ${JSON.stringify(e)}`,
      );
    }
    return { key: entry.key, file: entry.file, desc: entry.desc };
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Nome determinístico da lista Brevo. Ex: "Clarice Jun/2026 W1 — T1 abriu". */
export function listNameFor(wave: WaveDef, label: string): string {
  return `Clarice ${label} ${wave.key} — ${wave.desc}`;
}

/**
 * #4449 item 3 / #4471: gerador determinístico do nome de LISTA pro braço COM
 * CÉLULA do fluxo `--group` (teste A/B/C mensal) — irmão de `campaignNameFor`
 * (`clarice-schedule-group.ts`), mas pro lado da LISTA de destinatários, que é
 * a ÚNICA fonte de ciclo+célula que `parseAbcAudienceCampaign`
 * (workers/brevo-dashboard/src/sections-core.ts) consegue ler pra esse fluxo
 * (#4447) — o nome da CAMPANHA não carrega nem ciclo mensal "AAMM-MM" nem
 * célula reconhecível.
 *
 * Até o #4449 esse formato de nome de lista era digitado à mão pro ciclo
 * 2607-08 — a MESMA classe de fragilidade que já causou 3 incidentes
 * (#3081 → #3128 → #4447): uma variação de digitação (typo, acento, ordem)
 * quebra o parser em silêncio. Este helper elimina a digitação manual da
 * PARTE que decide célula: `key` precisa terminar em `-A`/`-B`/`-C` (mesmo
 * sufixo que a CAMPANHA já carrega via `campaignNameFor` — a célula da lista
 * é sempre DERIVADA desse sufixo, nunca um valor digitado à parte), então o
 * mismatch que o cross-check de `parseAbcAudienceCampaign` existe pra pegar
 * fica estruturalmente impossível quando o nome vem daqui.
 *
 * O #4449 introduziu este helper mas nunca o LIGOU ao ponto real de criação
 * da lista (`buildPlan`/`main()` abaixo, que sempre chamava `listNameFor`,
 * mesmo pro braço com célula) — a fragilidade continuava intacta na prática
 * (#4471). Mora AQUI (não em `clarice-schedule-group.ts`, onde nasceu) porque
 * é `clarice-import-waves.ts` quem de fato cria a lista Brevo do fluxo
 * `--group` (ver `resolveListName`/`buildPlan`/`main` abaixo);
 * `clarice-schedule-group.ts` só cria CAMPANHAS apontando pra uma lista já
 * existente, e reimporta este helper daqui pra manter compatibilidade com
 * quem já usava esse caminho.
 *
 * Formato gerado (round-trip testado contra `parseAbcAudienceCampaign` em
 * test/clarice-import-waves.test.ts): "Clarice {cycle} {key} — célula {X}"
 * — `cycle` aqui é o ciclo MENSAL completo "AAMM-MM" (ex: "2607-08"), não o
 * `cycleToYymm` que `campaignNameFor` usa pro nome da campanha (a lista
 * carrega o ciclo completo — é dela que o parser extrai `cycle`).
 *
 * Lança se `key` não terminar em -A/-B/-C — uso incorreto (grupos SEM célula,
 * ex: sufixo "-interno", não usam este helper; nomeie a lista via `listNameFor`).
 */
export function groupCellListNameFor(cycle: string, key: string): string {
  const m = /-([ABC])$/i.exec(key);
  if (!m) {
    throw new Error(
      `groupCellListNameFor: key "${key}" não termina em -A/-B/-C — não é uma célula de teste A/B/C ` +
        `(grupos sem célula não usam este helper).`,
    );
  }
  const cell = m[1].toUpperCase();
  return `Clarice ${cycle} ${key} — célula ${cell}`;
}

/**
 * #4471: resolve o nome de lista REAL usado por `buildPlan` — ponto único de
 * decisão entre os dois formatos coexistentes. Grupos nomeados sem célula
 * (rampa `W1`/`W2`/..., ou grupos como `engajados`/`ramp-warm`) sempre usam
 * o formato genérico `listNameFor`. O braço COM CÉLULA do fluxo `--group`
 * (`wave.key` termina em -A/-B/-C — só alcançável quando `group` está ativo,
 * já que nenhuma wave/grupo nomeado hoje produz esse sufixo) usa
 * `groupCellListNameFor`, que é o formato que `parseAbcAudienceCampaign`
 * exige (ver docstring dela acima). Gate em `group` (não só no sufixo) é
 * defensivo — mesmo que uma wave da rampa um dia termine coincidentemente em
 * "-A", ela só entraria neste branch se também estivesse rodando via
 * `--group`, o que não acontece hoje.
 */
export function resolveListName(wave: WaveDef, label: string, cycle: string, group: string | null): string {
  if (group && /-[ABC]$/i.test(wave.key)) {
    return groupCellListNameFor(cycle, wave.key);
  }
  return listNameFor(wave, label);
}

/** Conta as linhas de dados (sem header) de um CSV. Usa Papa pra não quebrar
 *  em campos quotados com newline/vírgula embutidos (split ingênuo inflava). */
export function countRows(csv: string): number {
  return Papa.parse(csv, { header: true, skipEmptyLines: true }).data.length;
}

/**
 * Normaliza o CSV pro import Brevo: o header da coluna de email vira `EMAIL`
 * (Brevo identifica o contato por esse header). Demais colunas (NOME →
 * firstname, OPEN_PROBABILITY, RECENCY_QUARTIL…) já batem com os atributos.
 */
export function normalizeImportCsv(csv: string): string {
  const nl = csv.indexOf("\n");
  if (nl < 0) return csv;
  const header = csv.slice(0, nl);
  const rest = csv.slice(nl);
  const newHeader = header
    .split(",")
    .map((h) => (/^\s*e-?mail\s*$/i.test(h) ? "EMAIL" : h.trim()))
    .join(",");
  return newHeader + rest;
}

/**
 * Idempotência: nomes planejados que JÁ existem no Brevo. Re-rodar --execute
 * sem isso criaria listas duplicadas (Brevo permite nomes iguais), e o editor
 * poderia mandar pra lista errada / em dobro.
 */
export function findExistingConflicts(
  plannedNames: string[],
  existing: { id: number; name: string }[],
): { name: string; id: number }[] {
  const byName = new Map(existing.map((l) => [l.name, l.id]));
  const out: { name: string; id: number }[] = [];
  for (const n of plannedNames) {
    const id = byName.get(n);
    if (id !== undefined) out.push({ name: n, id });
  }
  return out;
}

// #2018: fetchExistingLists triplicada → lib/brevo-client.brevoListAllLists.
// Alias local pra manter a chamada interna legível sem renomear os call-sites.
const fetchExistingLists = brevoListAllLists;

// ---------------------------------------------------------------------------
// Registro de listas Brevo criadas por grupo nomeado (#3228)
// ---------------------------------------------------------------------------
//
// Único por {ciclo}/{group}: acumula UMA entrada por lista criada com sucesso
// (uma invocação --execute normalmente cria 1 lista — o manifest do grupo tem
// só 1 entrada, ver clarice-build-segment.ts — mas o mesmo grupo pode ser
// re-rodado com budgets diferentes, criando VÁRIAS listas ao longo do ciclo;
// por isso é array, não valor único). Consumido por
// `clarice-schedule-group.ts` (`resolveGroupListId`) pra casar campanha↔lista
// sem exigir que o editor copie o listId manualmente do stdout.

export interface GroupListEntry {
  listId: number;
  listName: string;
  count: number;
  importedAt: string;
}

export interface GroupListsRegistry {
  cycle: string;
  group: string;
  lists: GroupListEntry[];
}

/** Caminho do registro (`{ciclo}/segments/{group}-lists.json`). */
export function groupListsRegistryPath(segmentsDir: string, group: string): string {
  return resolve(segmentsDir, `${group}-lists.json`);
}

/**
 * Acrescenta `newEntries` ao registro do grupo (união — nunca remove/edita
 * entradas anteriores), escreve atomicamente. Tolerante a arquivo ausente
 * (1ª vez) ou corrompido (recomeça do zero em vez de travar — mesma postura
 * de `clarice-build-segment.ts`'s `appendSentOrQueuedEmails`). `segmentsDir`
 * já existe neste ponto (pré-condição: `{group}-manifest.json` precisa
 * existir pra `main()` ter chegado até aqui).
 */
export function appendGroupListsRegistry(
  segmentsDir: string,
  cycle: string,
  group: string,
  newEntries: GroupListEntry[],
): void {
  const file = groupListsRegistryPath(segmentsDir, group);
  let existing: GroupListEntry[] = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<GroupListsRegistry>;
      if (Array.isArray(parsed.lists)) existing = parsed.lists;
    } catch {
      // JSON corrompido — recomeça do zero em vez de travar o import.
    }
  }
  const merged: GroupListsRegistry = { cycle, group, lists: [...existing, ...newEntries] };
  writeFileAtomic(file, JSON.stringify(merged, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  execute: boolean;
  label: string;
  folderId: number;
  cycle: string;
  /** #2916 — grupo nomeado (#2885) a importar; null = rampa (waves/), default. */
  group: string | null;
}

export function parseArgs(argv: string[]): Args {
  // Não engole a flag seguinte: `--label --execute` não pode virar label="--execute"
  // (criaria listas "Clarice --execute …" em produção e ainda executaria).
  const { values } = parseCliArgs(argv);
  const folder = parseInt(values["folder-id"] ?? "1", 10);
  // #1961: lê as waves do ciclo em {conteúdo}-{envio}/waves/. OBRIGATÓRIO (sem
  // default): parseCycleArg devolve "" quando ausente/inválido; main aborta.
  const cycle = parseCycleArg(argv);
  return {
    execute: argv.includes("--execute"),
    label: values["label"] ?? "edição atual",
    folderId: Number.isFinite(folder) && folder > 0 ? folder : 1,
    cycle,
    group: values["group"] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Plan {
  wave: WaveDef;
  listName: string;
  count: number;
  csv: string;
  columns: string[];
}

/**
 * `dir` é injetável pra teste (default = dir do ciclo — waves/ sem `group`,
 * segments/ com `group`, #2916). #provenance
 *
 * @param group #2916 — grupo nomeado (#2885); quando informado, lê
 *              `{group}-manifest.json` do dir de segments em vez de
 *              `waves-manifest.json` do dir de waves.
 */
export function buildPlan(
  label: string,
  cycle: string,
  dir?: string,
  group: string | null = null,
): Plan[] {
  const resolvedDir = dir ?? (group ? clariceSegmentsDir(cycle) : clariceWavesDir(cycle));
  const manifestFileName = group ? `${group}-manifest.json` : "waves-manifest.json";
  const plans: Plan[] = [];
  for (const wave of loadWaveDefs(resolvedDir, manifestFileName)) { // #2656/#2844/#2916: manifest é a única fonte
    const path = resolve(resolvedDir, wave.file);
    if (!existsSync(path)) {
      // Opcional ausente → pula com aviso (defensivo — o manifest store-driven
      // nunca marca entradas opcionais hoje). Obrigatória ausente → erro (build
      // interrompido; não importar parcial sem o editor saber).
      if (wave.optional) {
        console.error(`ℹ️  wave opcional ausente, pulando: ${wave.key} (${wave.file})`);
        continue;
      }
      throw new Error(
        group
          ? `arquivo do grupo faltando: ${path} — rode 'clarice-build-segment.ts --cycle ${cycle} --group ${group}' antes.`
          : `wave faltando: ${path} — rode 'clarice-build-waves-store.ts --cycle ${cycle}' antes.`,
      );
    }
    const raw = readFileSync(path, "utf-8");
    // #3455: injeta o editor como destinatário determinístico de TODA wave/grupo
    // criado — count reflete só os contatos reais (não conta a linha do editor).
    const csv = ensureEditorCopyRow(normalizeImportCsv(raw));
    const columns = (csv.split(/\r?\n/)[0] ?? "").split(",");
    // #4471: braço com célula do --group usa groupCellListNameFor (formato
    // exigido por parseAbcAudienceCampaign); tudo mais usa listNameFor — ver
    // resolveListName acima.
    plans.push({ wave, listName: resolveListName(wave, label, cycle, group), count: countRows(raw), csv, columns });
  }
  return plans;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (!args.cycle) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2605-06).");
    process.exit(1);
  }
  const plans = buildPlan(args.label, args.cycle, undefined, args.group);

  // --- Plano (sempre imprime) ---
  console.error(
    `\n📋 Plano de import ${args.group ? `— grupo '${args.group}' (#2885/#2916)` : "— rampa (waves/)"} — folder ${args.folderId} — modo ${args.execute ? "EXECUTE 🔴" : "DRY-RUN"}`,
  );
  let total = 0;
  for (const p of plans) {
    console.error(`  ${p.wave.key}: "${p.listName}"  ←  ${p.wave.file}  (${p.count} contatos)`);
    console.error(`       colunas: ${p.columns.join(", ")}`);
    total += p.count;
  }
  console.error(`  TOTAL: ${total} contatos em ${plans.length} listas`);

  if (!args.execute) {
    console.error(`\nℹ️  dry-run — nada foi criado. Re-rode com --execute pra criar listas + importar.`);
    console.log(JSON.stringify({ mode: "dry-run", folder_id: args.folderId, label: args.label, waves: plans.map((p) => ({ wave: p.wave.key, list: p.listName, count: p.count })), total }, null, 2));
    return;
  }

  // --- Execute ---
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida (necessária pra --execute).");
    process.exit(1);
  }

  // Pré-flight de idempotência: recusa se alguma lista planejada já existe.
  const conflicts = findExistingConflicts(
    plans.map((p) => p.listName),
    await fetchExistingLists(apiKey),
  );
  if (conflicts.length) {
    console.error(`\n❌ ${conflicts.length} lista(s) com esses nomes JÁ existem no Brevo:`);
    for (const c of conflicts) console.error(`   #${c.id} "${c.name}"`);
    console.error(
      `Re-importar criaria duplicatas (Brevo permite nomes iguais). Delete-as no Brevo, ` +
        `ou use --label diferente.`,
    );
    process.exit(1);
  }

  const results: { wave: string; listId: number; processId: unknown; count: number }[] = [];
  try {
    for (const p of plans) {
      console.error(`\n→ ${p.wave.key}: criando lista "${p.listName}"…`);
      const list = (await brevoPost(apiKey, "/contacts/lists", {
        name: p.listName,
        folderId: args.folderId,
      })) as { id?: number };
      if (typeof list?.id !== "number") {
        throw new Error(`Brevo /contacts/lists retornou shape inesperado: ${JSON.stringify(list)}`);
      }
      console.error(`   list #${list.id} criada · importando ${p.count} contatos…`);
      const imp = (await brevoPost(apiKey, "/contacts/import", {
        fileBody: p.csv,
        listIds: [list.id],
        updateExistingContacts: true,
        emptyContactsAttributes: false,
      })) as { processId?: unknown };
      console.error(`   import disparado (processId=${imp.processId ?? "?"})`);
      results.push({ wave: p.wave.key, listId: list.id, processId: imp.processId, count: p.count });
    }
  } catch (e) {
    // Falha parcial: reporta as listas JÁ criadas pro editor limpar antes de re-rodar
    // (senão o pré-flight de idempotência barra o retry).
    if (results.length) {
      console.error(`\n⚠️  erro no meio — ${results.length} lista(s) JÁ criada(s), limpe antes de re-rodar:`);
      for (const r of results) console.error(`   #${r.listId} (${r.wave})`);
    }
    throw e;
  }

  console.error(`\n✅ ${results.length} listas criadas + imports disparados (assíncronos na Brevo).`);

  // #3228: registra as listas criadas pra este GRUPO (não pra rampa — waves/
  // não tem o conceito de "campanha ad-hoc por lista", só dNN do plano de
  // blocos) — sem isso, clarice-schedule-group.ts não teria como resolver
  // --group NOME pra um listId sem o editor copiar do stdout.
  if (args.group && results.length > 0) {
    const now = new Date().toISOString();
    appendGroupListsRegistry(
      clariceSegmentsDir(args.cycle),
      args.cycle,
      args.group,
      results.map((r, i) => ({ listId: r.listId, listName: plans[i].listName, count: r.count, importedAt: now })),
    );
    console.error(
      `📝 registrado em ${groupListsRegistryPath(clariceSegmentsDir(args.cycle), args.group)} — ${results.length} lista(s) do grupo '${args.group}'.`,
    );
  }

  console.log(JSON.stringify({ mode: "execute", folder_id: args.folderId, label: args.label, results }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
