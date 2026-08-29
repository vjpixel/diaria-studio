#!/usr/bin/env node
/**
 * clarice-import-waves.ts
 *
 * Importa pro Brevo waves/grupos já segmentados localmente: cria uma lista
 * por wave/grupo e sobe os contatos do CSV correspondente. Terça-feira vira 1
 * comando em vez de import manual na UI.
 *
 * #4759: o modo "rampa" (sem `--group`, lendo `waves/waves-manifest.json`)
 * ficou ÓRFÃO — seu único produtor, `clarice-build-waves-store.ts`, foi
 * aposentado (não tinha o guard cycle-wide `sent-or-queued.json` do #3227 e
 * causou ~18k envios duplicados no ciclo 2606). O código deste modo continua
 * aqui (nenhum caminho ativo escreve `waves/` hoje, mas remover o branch é
 * fora de escopo desta aposentadoria) — o caminho vivo é sempre `--group`,
 * alimentado por `clarice-build-segment.ts`.
 *
 * SEGURANÇA: dry-run por padrão (só imprime o plano). `--execute` é que de fato
 * cria listas e importa contatos na conta de PRODUÇÃO da Clarice.
 *
 * #4577: `--execute` AGUARDA o processo assíncrono de `/contacts/import`
 * terminar (`GET /processes/{id}` até status terminal) e RECONCILIA a
 * contagem confirmada da lista (`GET /contacts/lists/{id}`) contra as linhas
 * de fato enviadas — antes desta correção, o script declarava sucesso assim
 * que a Brevo aceitava o POST, sem nunca confirmar nem o término do processo
 * nem se todos os contatos entraram (um contato foi perdido em silêncio dessa
 * forma — `a15276@aecampo.pt`, 04/08/2026). Processo `failed`/timeout, ou
 * contagem confirmada menor que a enviada, abortam a invocação inteira
 * (exit ≠ 0) antes de registrar a lista como importada.
 *
 * #4720: quando a reconciliação de contagem detecta divergência, o erro
 * agora NOMEIA o(s) contato(s) perdido(s) (paginando a lista recém-criada e
 * diffando contra o CSV enviado — `listContactEmails`/`findMissingContacts`
 * abaixo) e imprime o comando `curl DELETE` exato pra limpar a lista órfã —
 * ver `importOneWave` pro racional completo, inclusive por que a lista NÃO é
 * apagada automaticamente.
 *
 * Uso:
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2605-06 --label "Mai→Jun/2026"            # dry-run
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2605-06 --label "Mai→Jun/2026" --execute  # cria + importa
 *   --cycle {conteúdo}-{envio}   OBRIGATÓRIO — ciclo do envio
 *   [--folder-id N]              folder Brevo onde criar as listas (default 1)
 *   [--group NOME]               #2916 — importa um GRUPO NOMEADO (#2885,
 *                                 `clarice-build-segment.ts --group NOME`) em vez
 *                                 da rampa: lê `{ciclo}/segments/{NOME}-manifest.json`
 *                                 (via `clariceSegmentsDir`) no lugar de
 *                                 `{ciclo}/waves/waves-manifest.json`. Sem a flag,
 *                                 comportamento inalterado — mas ÓRFÃO desde o
 *                                 #4759 (nenhum produtor ativo escreve mais
 *                                 `waves/`; ver nota no topo do arquivo). Use
 *                                 sempre `--group` (ex: `ramp-warm` no lugar
 *                                 da rampa).
 *   [--key CAMPAIGN_KEY]         #4753 — só relevante com --group + --execute, pra
 *                                 grupos SEM célula (-A/-B/-C). Sobrescreve o `key`
 *                                 gravado em `{group}-lists.json` (default: nome
 *                                 estático do grupo) pela key de CAMPANHA que
 *                                 `clarice-schedule-group.ts --key` vai receber
 *                                 depois (ex: `novos-260807`, resolvida por
 *                                 `clarice-novos-resolve-key.ts`) — sem isso, a 2ª+
 *                                 importação do mesmo grupo/ciclo grava outra
 *                                 entrada com a MESMA key estática, e `--key` do
 *                                 script de agendamento nunca bate com nada
 *                                 (issue #4753). Sem a flag, comportamento
 *                                 inalterado. Ver `resolveRegistryKey` abaixo.
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
 *     waves-manifest.json + os w*-store.csv correspondentes — ÓRFÃO desde o
 *     #4759 (produtor original, clarice-build-waves-store.ts, aposentado).
 *     Nenhum fluxo ativo escreve mais esse diretório.
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
import { brevoPost, brevoGet, brevoGetList, brevoListAllLists } from "./lib/brevo-client.ts"; // #2018: brevoListAllLists
import { pollProcessUntilTerminal, type PollOptions } from "./lib/brevo-process-poll.ts"; // #4577
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
 * #2656: o builder store-driven escrevia um `waves-manifest.json` no dir de
 * waves listando as waves daquele ciclo — era a ÚNICA fonte de verdade
 * (#2844/260702: fallback pro cohort legado T1/T2 removido junto com
 * clarice-build-waves.ts). #4759: esse produtor (clarice-build-waves-store.ts)
 * foi aposentado — o modo sem `--group` não tem mais nenhum gerador ativo de
 * `waves-manifest.json`; o caminho vivo é sempre `--group`. Sem manifest,
 * erro claro em vez de silenciosamente montar um plano com CSVs que não
 * existem mais.
 *
 * #2916: generalizado pra também ler o manifest de um GRUPO NOMEADO (#2885,
 * `clarice-build-segment.ts`) — recebe `group` (o mesmo `string | null` já
 * tipado no escopo de quem chama, `buildPlan`) em vez de um filename
 * pré-formatado; `manifestFileName` é computado uma única vez AQUI DENTRO
 * (#4766 — antes, `buildPlan` computava o filename duas linhas antes de
 * chamar esta função, que então re-derivava a mesma distinção fazendo
 * string-match no nome já formatado, um round-trip através de uma
 * codificação em string de um booleano que já existia como valor tipado um
 * frame acima). `group` ausente/null preserva o comportamento da rampa
 * (`waves-manifest.json`); `--group NOME` lê `{NOME}-manifest.json`.
 *
 * O branch `group === null` abaixo é código morto-exceto-pela-mensagem-de-
 * erro — todo call site real hoje passa `--group` (#4759) — mas removê-lo
 * de vez é fora de escopo desta limpeza (ver nota no topo do arquivo).
 */
export function loadWaveDefs(dir: string, group: string | null = null): WaveDef[] {
  const manifestFileName = group ? `${group}-manifest.json` : "waves-manifest.json";
  const manifestPath = resolve(dir, manifestFileName);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${manifestFileName} ausente em ${dir} — gere com ` +
        (group === null
          ? `'clarice-build-segment.ts --cycle ... --group ramp-warm' seguido de 'clarice-import-waves.ts ` +
            `--group ramp-warm ...' (#4759: o modo sem --group não tem mais produtor — clarice-build-waves-store.ts ` +
            `foi aposentado; use sempre --group daqui pra frente).`
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

/**
 * #4976: limite seguro de comprimento pro nome de uma lista Brevo
 * (`POST /contacts/lists` → `name`). A Brevo NÃO documenta um `maxLength`
 * explícito no schema público (`developers.brevo.com/reference/create-list`,
 * checado 260811) — quando o nome excede o limite real, ela responde
 * `400 {"code":"invalid_parameter","message":"List name is invalid"}`, sem
 * dizer o número. Valor aqui é uma estimativa CONSERVADORA calibrada por
 * evidência conhecida, não o limite exato documentado:
 *   - ~130 caracteres FALHOU (#4976, o incidente que originou esta issue).
 *   - ~48 caracteres FUNCIONOU (medição citada na própria issue).
 *   - "Clarice Retenção Jun/2026 engajados — Engajados (retenção)" (58
 *     chars) é o exemplo CANÔNICO de uso documentado no header deste arquivo
 *     (`--group engajados --label "Retenção Jun/2026"`) — precisa continuar
 *     válido, então o limite não pode ficar abaixo disso.
 * 100 fica bem acima do maior nome real conhecido (58) e com folga
 * confortável abaixo do menor valor confirmado ruim (130) — se a Brevo
 * revelar o número exato no futuro, ajustar esta constante (e o comentário)
 * em vez de inventar precisão que não temos.
 */
export const MAX_BREVO_LIST_NAME_LENGTH = 100;

/**
 * Valida `name` contra `MAX_BREVO_LIST_NAME_LENGTH` ANTES de qualquer POST —
 * sem isso, um nome longo demais só falha depois do `createList` já ter ido
 * pra rede, com o 400 opaco da Brevo (#4976). Lança com o comprimento real +
 * o limite + uma ação concreta (a mensagem de erro do 400 da Brevo não diz
 * nem uma coisa nem outra).
 */
function assertListNameLength(name: string): string {
  if (name.length > MAX_BREVO_LIST_NAME_LENGTH) {
    throw new Error(
      `nome de lista excede ${MAX_BREVO_LIST_NAME_LENGTH} caracteres (Brevo) — encurte --label ou o desc do ` +
        `manifest. Tamanho atual: ${name.length}. Nome: "${name}"`,
    );
  }
  return name;
}

/** Nome determinístico da lista Brevo. Ex: "Clarice Jun/2026 W1 — T1 abriu". */
export function listNameFor(wave: WaveDef, label: string): string {
  return assertListNameLength(`Clarice ${label} ${wave.key} — ${wave.desc}`);
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
  const abc = /-([ABC])$/i.exec(key);
  if (abc) {
    const cell = abc[1].toUpperCase();
    return assertListNameLength(`Clarice ${cycle} ${key} — célula ${cell}`);
  }
  // #5140: célula de HORÁRIO. Rótulo "hora HH:00" e não "célula H06" de
  // propósito — `parseAbcAudienceCampaign` casa `([ABC])\b` e portanto já
  // ignoraria `H06`, mas um humano lendo a lista no painel da Brevo precisa
  // ver o que distingue os dois braços sem decorar o código do sufixo.
  const hour = /-H(\d{2})$/.exec(key);
  if (hour) {
    return assertListNameLength(`Clarice ${cycle} ${key} — hora ${hour[1]}:00 BRT`);
  }
  throw new Error(
    `groupCellListNameFor: key "${key}" não termina em -A/-B/-C (assunto) nem -H{00-23} (horário) — ` +
      `não é uma célula de teste (grupos sem célula não usam este helper).`,
  );
}

/**
 * #4762: único ponto que decide "esta wave é uma célula A/B/C do fluxo
 * `--group`?" — extraído de dentro de `resolveListName` (onde nasceu, #4471)
 * pra ser reusado por `buildPlan`, que grava o resultado em `Plan.hasCell` e
 * propaga esse sinal explícito até `resolveRegistryKey`. Antes,
 * `resolveRegistryKey` (introduzida no #4753) re-derivava a MESMA
 * distinção fazendo regex direto em `waveKey`, sem o gate em `group` que
 * esta função já carregava — achado do fleet review da PR #4758 (dívida de
 * consistência: a heurística de sufixo sozinha já era conhecida como
 * frágil aqui, mas essa disciplina não foi carregada adiante). Gate em
 * `group` (não só no sufixo) é defensivo — mesmo que uma wave da rampa um
 * dia termine coincidentemente em "-A", ela só entraria neste branch se
 * também estivesse rodando via `--group`, o que não acontece hoje.
 */
export function isGroupCellWave(group: string | null, waveKey: string): boolean {
  // #5140: células de HORÁRIO (`-H06`/`-H10`) entram no MESMO ramo que as de
  // assunto. Não é conveniência — é o que garante que cada braço vire uma
  // lista Brevo distinta via `groupCellListNameFor`. Se caíssem no ramo "sem
  // célula", `resolveListName` daria o mesmo nome aos dois e `resolveRegistryKey`
  // sobrescreveria `wave.key` com a key de campanha, colapsando os dois braços
  // — o teste sairia com as duas metades na mesma lista, e o defeito só
  // apareceria na leitura dos resultados, depois do disparo.
  return Boolean(group) && (/-[ABC]$/i.test(waveKey) || /-H\d{2}$/.test(waveKey));
}

/**
 * #4471: resolve o nome de lista REAL usado por `buildPlan` — ponto único de
 * decisão entre os dois formatos coexistentes. Grupos nomeados sem célula
 * (rampa `W1`/`W2`/..., ou grupos como `engajados`/`ramp-warm`) sempre usam
 * o formato genérico `listNameFor`. O braço COM CÉLULA do fluxo `--group`
 * (`wave.key` termina em -A/-B/-C — só alcançável quando `group` está ativo,
 * já que nenhuma wave/grupo nomeado hoje produz esse sufixo) usa
 * `groupCellListNameFor`, que é o formato que `parseAbcAudienceCampaign`
 * exige (ver docstring dela acima).
 */
export function resolveListName(wave: WaveDef, label: string, cycle: string, group: string | null): string {
  if (isGroupCellWave(group, wave.key)) {
    return groupCellListNameFor(cycle, wave.key);
  }
  // #4660: onda de DIA sem célula (`d6-qui06`, assunto travado — ver
  // `buildSingleWave`). `listNameFor` embute `label`, NUNCA o ciclo, e
  // `summarizeCycleSends` (clarice-wave-plan.ts) atribui campanha a ciclo por
  // `listName.includes(cycle)`. Sem este branch, a atribuição dependia de o
  // operador lembrar de digitar o ciclo no `--label` — convenção não
  // documentada e não forçada por nada; esquecer jogava a campanha em
  // `unscopedCount` silenciosamente. Só alcança chave com formato de dia:
  // grupos nomeados (`engajados`, `ramp-warm`) não casam `^d\d+-` e seguem
  // com o naming de sempre, sem blast radius.
  if (group && /^d\d+-/.test(wave.key)) {
    return assertListNameLength(`Clarice ${cycle} ${wave.key} — ${wave.desc}`);
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
 * #4720: extrai os e-mails de um CSV já normalizado (`normalizeImportCsv`,
 * coluna `EMAIL`) — normalizados trim+lowercase. Usado só no caminho de erro
 * da reconciliação de import (`importOneWave` abaixo), pra diffar contra os
 * membros reais da lista e nomear quem faltou.
 */
export function extractCsvEmails(csv: string): string[] {
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const rows = parsed.data as Array<Record<string, unknown>>;
  const out: string[] = [];
  for (const r of rows) {
    const raw = r.EMAIL ?? r.email;
    if (typeof raw === "string" && raw.trim()) out.push(raw.trim().toLowerCase());
  }
  return out;
}

/**
 * #4720: diff puro — quais `expected` (e-mails do CSV enviado) NÃO aparecem
 * em `actual` (e-mails de fato na lista, via `listContactEmails`). Só chamado
 * quando a reconciliação de CONTAGEM já detectou divergência (`importOneWave`)
 * — transforma "1 contato perdido" em "1 contato perdido: x@y.z". Normalizado
 * trim+lowercase nos dois lados (mesmo padrão de `excludeSentOrQueued`).
 * Preserva a ordem de `expected` e não repete um e-mail já reportado.
 */
export function findMissingContacts(expected: string[], actual: string[]): string[] {
  const actualSet = new Set(actual.map((e) => e.trim().toLowerCase()));
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const raw of expected) {
    const email = raw.trim().toLowerCase();
    if (email && !actualSet.has(email) && !seen.has(email)) {
      seen.add(email);
      missing.push(email);
    }
  }
  return missing;
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
// Import + confirmação (#4577)
// ---------------------------------------------------------------------------
//
// Até aqui (#4577), `main()` disparava `POST /contacts/import`, imprimia o
// `processId` e declarava sucesso — sem NUNCA confirmar que o processo
// assíncrono da Brevo tinha terminado, nem que tinha terminado com sucesso.
// Um contato (`a15276@aecampo.pt`) foi descartado pela Brevo em silêncio no
// meio do processamento: o processo terminou `completed`, mas a lista ficou
// com menos contatos que o CSV enviado — nada no script pegava isso.
//
// `ImportRunClient` é a interface injetável (mesmo padrão de
// `CampaignExportClient` em clarice-engagement-cohorts-v2.ts) que separa a
// ORQUESTRAÇÃO (`importOneWave`, testável com um fake client, sem rede) do
// TRANSPORTE real (`makeRealImportRunClient`, usado só por `main()`).

/** Contrato mínimo que `importOneWave` precisa da Brevo — injetável pra teste. */
export interface ImportRunClient {
  createList(name: string, folderId: number): Promise<{ id: number }>;
  importCsv(listId: number, csv: string): Promise<{ processId: number | string }>;
  pollProcess(processId: number | string): Promise<{ status?: string }>;
  /**
   * #4764: `totalBlacklisted` vem na MESMA resposta da Brevo (`GET
   * /contacts/lists/{id}`) — usado por `importOneWave` pra distinguir
   * blacklist administrativo (contato nunca receberia o e-mail de qualquer
   * forma, independente da lista) de perda real por drop silencioso
   * (#4577/#4720). Opcional: ausência (fake de teste antigo, ou resposta sem
   * o campo) preserva o comportamento anterior — toda divergência de
   * contagem é tratada como perda.
   */
  getListInfo(listId: number): Promise<{ totalSubscribers: number; totalBlacklisted?: number }>;
  /**
   * #4720: pagina TODOS os e-mails de fato membros da lista — chamado só
   * quando a reconciliação de CONTAGEM (`getListInfo`) já detectou
   * divergência, pra nomear o(s) contato(s) perdido(s) em vez de só reportar
   * quantos. Barato nesse ponto (1 chamada por página de 50), porque só roda
   * no caminho de erro, não em toda invocação.
   */
  listContactEmails(listId: number): Promise<string[]>;
}

/**
 * #4577 item 1: `processId` vinha tipado `unknown` e nunca era validado — uma
 * resposta sem `processId` (ou com um valor não-usável) seguia como se nada
 * tivesse acontecido, porque nada no código de fato LIA o valor depois de
 * imprimi-lo. Falha alto aqui em vez de deixar `pollProcess` receber
 * `undefined`/`NaN` e falhar mais tarde com um erro menos claro.
 */
export function validateProcessId(raw: unknown): number | string {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim().length > 0) return raw;
  throw new Error(
    `Brevo POST /contacts/import retornou processId ausente/inválido: ${JSON.stringify(raw)}.`,
  );
}

/** Cliente real, fino sobre `brevoPost`/`brevoGet`/`brevoGetList` (retry-on-429/5xx
 *  já embutido nelas — ver brevo-client.ts). Só usado por `main()` — testes
 *  injetam um fake que implementa o mesmo `ImportRunClient`. */
export function makeRealImportRunClient(apiKey: string): ImportRunClient {
  return {
    async createList(name, folderId) {
      const list = (await brevoPost(apiKey, "/contacts/lists", { name, folderId })) as { id?: number };
      if (typeof list?.id !== "number") {
        throw new Error(`Brevo /contacts/lists retornou shape inesperado: ${JSON.stringify(list)}`);
      }
      return { id: list.id };
    },
    async importCsv(listId, csv) {
      const imp = (await brevoPost(apiKey, "/contacts/import", {
        fileBody: csv,
        listIds: [listId],
        updateExistingContacts: true,
        emptyContactsAttributes: false,
      })) as { processId?: unknown };
      return { processId: validateProcessId(imp.processId) };
    },
    async pollProcess(processId) {
      const { status, body } = await brevoGet(apiKey, `/processes/${processId}`);
      if (status === 404) {
        throw new Error(`GET /processes/${processId} retornou 404 (processo desconhecido).`);
      }
      return { status: body?.status };
    },
    async getListInfo(listId) {
      const info = await brevoGetList(apiKey, listId);
      return { totalSubscribers: info.totalSubscribers, totalBlacklisted: info.totalBlacklisted }; // #4764
    },
    // #4720: mesmo endpoint/paginação já validados ao vivo em
    // `sync-apoio-nivel-brevo.ts::fetchCurrentBrevoApoiadoresState` e
    // `inject-poll-token-brevo.ts::iterateListContacts` — `brevoGet` já falha
    // alto em não-200 (nunca trata resposta ruim como "lista vazia").
    async listContactEmails(listId) {
      const out: string[] = [];
      // #4720 self-review: 500 (não 50) — este diagnóstico roda sobre listas
      // de rampa que podem ter milhares de contatos (a issue original tinha
      // ~800); limit=500 é o mesmo já usado pro mesmo endpoint em
      // clarice-cta-ab-setup.ts/clarice-engagement-cohorts.ts, sem risco novo.
      const limit = 500;
      let offset = 0;
      for (;;) {
        const { status, body } = await brevoGet(
          apiKey,
          `/contacts/lists/${listId}/contacts?limit=${limit}&offset=${offset}`,
        );
        if (status !== 200) {
          throw new Error(
            `GET /contacts/lists/${listId}/contacts (offset=${offset}) retornou status ${status} — ` +
              "não é seguro tratar como lista vazia (diagnóstico de contato perdido abortado).",
          );
        }
        const contacts = (body as { contacts?: Array<{ email?: unknown }> })?.contacts ?? [];
        for (const c of contacts) {
          if (typeof c.email === "string") out.push(c.email);
        }
        if (contacts.length < limit) break;
        offset += limit;
      }
      return out;
    },
  };
}

export interface ImportOneResult {
  wave: string;
  listId: number;
  listName: string;
  /** #4577 item 4: contagem CONFIRMADA pela Brevo pós-import (`totalSubscribers`
   *  da lista recém-criada), não a contagem de linhas enviadas — é essa
   *  distinção que o `a15276@aecampo.pt` real teria exposto. */
  count: number;
  /** Linhas de fato enviadas no CSV (reais + cópias do editor) — referência
   *  pra auditoria; `count` acima é a fonte de verdade pós-reconciliação. */
  sentCount: number;
  importedAt: string;
}

/**
 * Cria a lista, dispara o import, aguarda o processo assíncrono terminar
 * (`pollProcessUntilTerminal`, scripts/lib/brevo-process-poll.ts — mesmo
 * poller que `clarice-engagement-cohorts-v2.ts` usa pra export, extraído em
 * #4577 pra ser reusado aqui em vez de duplicado) e RECONCILIA a contagem
 * antes de declarar sucesso.
 *
 * #4577 item 2: `status` terminal `failed`/`error`, ou timeout de poll, já
 * lança dentro de `pollProcessUntilTerminal` — propaga daqui sem tratamento
 * extra.
 *
 * #4577 item 3: processo `completed` NÃO garante que toda linha entrou — é
 * exatamente o caso real (`a15276@aecampo.pt`: processo completou, contagem
 * ficou menor) que só a reconciliação contra `getListInfo` pega. Divergência
 * (`totalSubscribers < sentCount`) lança nomeando a lista e o delta.
 *
 * #4720: a divergência de contagem sozinha só diz "N perdido(s)" — o operador
 * tinha que paginar a lista à mão e diffar contra o CSV pra saber QUEM (caso
 * real: `aluno225370@epad.edu.pt`, 2 listas descartadas antes do diagnóstico
 * manual). `listContactEmails` (barato aqui — só roda no caminho de erro)
 * pagina os membros de fato e `findMissingContacts` nomeia o(s) contato(s).
 * Diagnóstico é best-effort: se a própria paginação falhar, a mensagem de
 * erro original ainda sai (nunca troca "diagnóstico falhou" por "sem erro
 * nenhum"). A lista órfã NÃO é apagada automaticamente aqui — decisão
 * registrada na issue: apagar é uma escrita destrutiva ADICIONAL no próprio
 * caminho de erro (que já está numa reconciliação que falhou), e o projeto
 * prefere sempre uma ação explícita do operador a uma automação nova
 * escrevendo na Brevo dentro de um catch. Em vez disso, a mensagem imprime o
 * comando `curl DELETE` exato — copiar/colar, nada memorizado.
 *
 * O comando cobre bash E PowerShell (`$VAR` só expande em bash — em
 * PowerShell vira uma variável local vazia, e o header `api-key` sairia em
 * branco, silenciosamente. O ambiente principal deste projeto é Windows +
 * PowerShell, ver CLAUDE.md) — nunca assume um shell só.
 *
 * #4764: nem toda divergência de contagem é perda. `getListInfo` também traz
 * `totalBlacklisted` (contatos com blacklist GLOBAL na conta Brevo — nunca
 * receberiam o e-mail de qualquer forma, independente da lista). Se
 * `delta === totalBlacklisted`, a divergência inteira é explicada por
 * supressão esperada, não por drop silencioso — reportar como informação
 * (best-effort, nomeando quem foi suprimido via o mesmo diagnóstico do
 * #4720) e seguir normalmente, sem abortar nem pedir pra apagar a lista
 * (recriar a lista não resolveria nada: o mesmo contato blacklistado
 * reapareceria "perdido" pra sempre). Caso real: `m.afonso1208@gmail.com`,
 * ciclo 2607-08 — a lista #112 foi apagada por engano achando que era o
 * bug do #4577/#4720; só na 2ª tentativa, idêntica, ficou claro que era
 * blacklist, não drop. `totalBlacklisted` ausente (fake de teste antigo,
 * ou resposta sem o campo) preserva o comportamento anterior — toda
 * divergência é tratada como perda.
 */
export async function importOneWave(
  client: ImportRunClient,
  plan: Pick<Plan, "wave" | "listName" | "csv" | "sentCount">,
  opts: { folderId: number; poll?: PollOptions; now?: () => string; log?: (msg: string) => void },
): Promise<ImportOneResult> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const now = opts.now ?? (() => new Date().toISOString());

  log(`\n→ ${plan.wave.key}: criando lista "${plan.listName}"…`);
  const list = await client.createList(plan.listName, opts.folderId);
  log(`   list #${list.id} criada · importando ${plan.sentCount} linha(s)…`);
  const { processId } = await client.importCsv(list.id, plan.csv);
  log(`   import disparado (processId=${processId}) · aguardando confirmação da Brevo…`);

  await pollProcessUntilTerminal((pid) => client.pollProcess(pid), processId, opts.poll);

  const info = await client.getListInfo(list.id);
  if (info.totalSubscribers < plan.sentCount) {
    const delta = plan.sentCount - info.totalSubscribers;
    // #4764: delta inteiro explicado por blacklist administrativo (contato
    // nunca receberia o e-mail de qualquer forma) → não é o drop silencioso
    // que #4577/#4720 existem pra pegar. `totalBlacklisted` ausente (fake
    // de teste antigo / campo faltando na resposta) preserva o comportamento
    // anterior — sempre trata a divergência como perda.
    const isExpectedSuppression =
      info.totalBlacklisted !== undefined && delta === info.totalBlacklisted;

    let missingDetail = "";
    try {
      const actualEmails = await client.listContactEmails(list.id);
      const expectedEmails = extractCsvEmails(plan.csv);
      const missing = findMissingContacts(expectedEmails, actualEmails);
      missingDetail =
        missing.length > 0
          ? ` Contato(s) identificado(s): ${missing.join(", ")}.`
          : " Diff não identificou o e-mail exato (todo e-mail do CSV apareceu na lista — investigar manualmente).";
    } catch (diffErr) {
      missingDetail = ` (diagnóstico automático do contato falhou: ${diffErr instanceof Error ? diffErr.message : diffErr} — nomeie manualmente.)`;
    }

    if (!isExpectedSuppression) {
      throw new Error(
        `${plan.wave.key}: lista #${list.id} ("${plan.listName}") — Brevo confirma ${info.totalSubscribers} ` +
          `contato(s), mas o CSV enviado tinha ${plan.sentCount} linha(s). ${delta} contato(s) perdido(s) em ` +
          `silêncio pela Brevo (o processo terminou 'completed', a contagem não bate).${missingDetail} ` +
          `Abortando — apague a lista #${list.id} antes de re-rodar. bash: ` +
          `curl -X DELETE "https://api.brevo.com/v3/contacts/lists/${list.id}" -H "api-key: $BREVO_CLARICE_API_KEY"` +
          ` | PowerShell: curl.exe -X DELETE "https://api.brevo.com/v3/contacts/lists/${list.id}" -H "api-key: $env:BREVO_CLARICE_API_KEY"`,
      );
    }

    // #4764: supressão esperada — informa em vez de abortar. Recriar a lista
    // não resolveria nada aqui (o mesmo contato blacklistado reapareceria
    // "perdido" pra sempre); segue pro caminho de sucesso normal abaixo.
    log(
      `   ℹ️  ${delta} contato(s) suprimido(s) por blacklist administrativo da Brevo (nunca receberiam o ` +
        `e-mail de qualquer forma) — não é perda.${missingDetail}`,
    );
  }
  log(`   ✓ confirmado: ${info.totalSubscribers} contato(s) na lista (${plan.sentCount} enviados).`);

  return {
    wave: plan.wave.key,
    listId: list.id,
    listName: plan.listName,
    count: info.totalSubscribers,
    sentCount: plan.sentCount,
    importedAt: now(),
  };
}

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
  /**
   * #4576 — chave da campanha/wave que gerou esta lista (`wave.key`, o mesmo
   * valor que resolve `listName` via `groupCellListNameFor`/`listNameFor`).
   * Sem isso, `resolveGroupListId` (clarice-schedule-group.ts) não tinha
   * como distinguir MÚLTIPLAS listas do mesmo grupo/ciclo — um teste A/B/C
   * com 3 listas resolvia sempre a ÚLTIMA, ignorando `--key`. OPCIONAL na
   * leitura: registros gravados ANTES desta correção não têm este campo, e
   * `resolveGroupListId` preserva o comportamento antigo (default = última)
   * quando NENHUMA entrada do registro o carrega — compatibilidade
   * retroativa de formato de dado, não removível. Toda entrada NOVA
   * (`appendGroupListsRegistry`, chamada por `main()` abaixo) sempre grava.
   */
  key?: string;
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

/**
 * #4753: qual `key` gravar no registro `{group}-lists.json` pra uma entrada
 * recém-importada. Grupos SEM célula (sem sufixo -A/-B/-C) recebem
 * `wave.key === group` ESTÁTICO em TODA importação (`clarice-build-segment.ts`
 * não varia esse campo — só o A/B/C varia, via sufixo) — então uma 2ª+
 * importação do mesmo grupo/ciclo (ex: `/diaria-clarice-novos` rodando de
 * novo no mesmo mês-envio) grava outra entrada com a MESMA `key` estática, e
 * `clarice-schedule-group.ts --key` (que recebe a key de CAMPANHA,
 * `novos-{AAMMDD}`, resolvida por `clarice-novos-resolve-key.ts`) nunca bate
 * com nada — o defeito relatado na issue #4753.
 *
 * `campaignKey` (passado via `--key` a este script — opcional) é o mesmo
 * valor que `clarice-schedule-group.ts --key` vai receber depois: gravá-lo
 * no lugar de `wave.key` faz `--key` bastar sozinho de novo, sem exigir
 * `--list-index` manual a partir da 2ª importação.
 *
 * Grupos COM célula (-A/-B/-C) sempre mantêm `wave.key` mesmo que
 * `campaignKey` tenha sido passado — cada célula já é uma key distinta por
 * construção (é o que `groupCellListNameFor`/`resolveGroupListId` esperam),
 * e sobrescrever colapsaria as 3 entradas na mesma key.
 *
 * Sem `campaignKey` (chamadores que nunca tiveram este problema — rampa,
 * ramp-warm, engajados, grupos de dia com célula própria nunca passam
 * `--key` a este script) o comportamento é o ORIGINAL, inalterado: grava
 * `wave.key`.
 *
 * #4762: `hasCell` é um sinal EXPLÍCITO passado pelo chamador (`main()`, via
 * `Plan.hasCell` — computado em `buildPlan` com `isGroupCellWave`, a mesma
 * função que `resolveListName` usa) em vez de esta função re-derivar a
 * mesma distinção fazendo regex direto em `waveKey`, sem gate em `group`.
 * A re-derivação por string sozinha era uma heurística: um grupo nomeado
 * que legitimamente terminasse em "-a"/"-b"/"-c" sem ser célula de teste
 * A/B/C seria tratado como célula e NÃO receberia a key de campanha,
 * reintroduzindo o bug da #4753 só pra ele, em silêncio (achado do fleet
 * review da PR #4758) — gatear no sinal já computado por `isGroupCellWave`
 * (que por sua vez já é gateado em `group`) elimina essa classe de erro.
 */
export function resolveRegistryKey(waveKey: string, hasCell: boolean, campaignKey?: string): string {
  if (campaignKey && !hasCell) return campaignKey;
  return waveKey;
}

/**
 * #6721 — decide se o aviso "--key não informado" (main(), logo abaixo do
 * `appendGroupListsRegistry`) deve disparar. Extraído como função PURA (em
 * vez de checar `!args.campaignKey` sozinho, como o código fazia até aqui)
 * porque o aviso só é verdadeiro para entradas SEM célula: `resolveRegistryKey`
 * só cai no nome ESTÁTICO do grupo (`wave.key === group`, típico de grupos
 * nomeados como "novos"/"ramp-warm") quando `hasCell` é falso — pra células
 * A/B/C ou de HORÁRIO (`-A`/`-B`/`-C`/`-H{00-23}`), `wave.key` já carrega o
 * sufixo distintivo e é preservado tal qual, então a entrada JÁ é resolvível
 * por esse mesmo valor como `--key` depois, sem `--list-index`.
 *
 * Achado ao vivo #6721: `clarice-envio-run.ts` importa ondas de célula de
 * HORÁRIO (`--hour-cells`) sem nunca passar `--key`, e o aviso antigo
 * disparava incondicionalmente em `!campaignKey` — afirmando que as entradas
 * "foram gravadas com a key estática do grupo" quando, na verdade, cada
 * célula já tinha sua própria key (`d33-dom30-H06`/`d33-dom30-H10`), o oposto
 * do que o aviso dizia.
 */
export function shouldWarnMissingCampaignKey(hasCellFlags: boolean[], campaignKey?: string): boolean {
  return !campaignKey && hasCellFlags.some((hasCell) => !hasCell);
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
  /**
   * #4753 — key de CAMPANHA (ex: `novos-260807`, resolvida por
   * clarice-novos-resolve-key.ts) opcional. Sem célula (-A/-B/-C), sobrescreve
   * `wave.key` no registro `{group}-lists.json` — ver `resolveRegistryKey`.
   * Caminhos que nunca passam esta flag (rampa, ramp-warm, engajados, grupos
   * de dia com célula própria) mantêm o comportamento ORIGINAL inalterado.
   */
  campaignKey?: string;
  /**
   * #5922 item 7 ("clarice-novos deve rodar sempre") — quando a lista do dia
   * já existe no Brevo, REUSA em vez de abortar: pula create+import das waves
   * conflitantes e registra o listId existente no `{group}-lists.json` pra os
   * passos de campanha downstream resolverem normalmente. Default OFF — os
   * demais fluxos (rampa/ramp-warm manual) continuam recusando duplicata.
   */
  reuseExisting: boolean;
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
    campaignKey: values["key"] || undefined,
    reuseExisting: argv.includes("--reuse-existing"), // #5922 item 7
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Plan {
  wave: WaveDef;
  listName: string;
  /** Contatos REAIS do CSV de origem — não conta a(s) linha(s) do editor (#3455). */
  count: number;
  csv: string;
  columns: string[];
  /**
   * #4577: linhas de fato enviadas no `fileBody` do POST /contacts/import —
   * `count` (contatos reais) + as cópias do editor (`ensureEditorCopyRow`,
   * até 5 endereços-seed, #4045). É ESTA contagem que a reconciliação pós-
   * import (`importOneWave`) compara contra `totalSubscribers` da lista —
   * usar `count` aqui inflaria falso-positivo de "tudo bateu" quando faltam
   * só os contatos reais (as cópias do editor mascarariam o delta).
   */
  sentCount: number;
  /**
   * #4762: esta wave é uma célula A/B/C do fluxo `--group`? Computado uma
   * única vez aqui via `isGroupCellWave` (mesma função que `resolveListName`
   * usa pra decidir o formato de nome de lista) e propagado como sinal
   * EXPLÍCITO até `resolveRegistryKey` (em `main()`) — em vez de cada ponto
   * re-derivar a mesma heurística de string por conta própria.
   */
  hasCell: boolean;
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
  const plans: Plan[] = [];
  for (const wave of loadWaveDefs(resolvedDir, group)) { // #2656/#2844/#2916/#4766: manifest é a única fonte
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
          : `wave faltando: ${path} — modo sem --group não tem mais produtor (#4759: clarice-build-waves-store.ts ` +
            `foi aposentado); use 'clarice-build-segment.ts --cycle ${cycle} --group ramp-warm' + --group nesta invocação.`,
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
    plans.push({
      wave,
      listName: resolveListName(wave, label, cycle, group),
      count: countRows(raw),
      csv,
      columns,
      sentCount: countRows(csv), // #4577: reais + cópias do editor — o que de fato vai no POST
      hasCell: isGroupCellWave(group, wave.key), // #4762
    });
  }
  return plans;
}

/**
 * #5922 item 7 — separa o plano entre waves a IMPORTAR e waves a REUSAR
 * (lista já existente com `--reuse-existing`). Puro/testável: o loop de
 * execução em `main()` só consome a decisão daqui.
 */
export interface ReuseDecision {
  /** Waves sem conflito — caminho normal (`importOneWave`). */
  toImport: Plan[];
  /** Waves conflitantes — lista existente é reusada, import pulado. */
  reused: Array<{ plan: Plan; existingId: number }>;
}

export function splitReuse(
  plans: readonly Plan[],
  conflicts: readonly { name: string; id: number }[],
): ReuseDecision {
  const idByName = new Map(conflicts.map((c) => [c.name, c.id]));
  const out: ReuseDecision = { toImport: [], reused: [] };
  for (const p of plans) {
    const existingId = idByName.get(p.listName);
    if (existingId === undefined) out.toImport.push(p);
    else out.reused.push({ plan: p, existingId });
  }
  return out;
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

  // Pré-flight de idempotência: recusa se alguma lista planejada já existe —
  // a menos que `--reuse-existing` (#5922 item 7) esteja ativo, caso em que a
  // lista existente é REUSADA (pula create+import; registro do grupo aponta
  // pra ela, então os passos de campanha downstream prosseguem). É o que
  // torna o "clarice-novos roda sempre" verdadeiro na prática: um retry no
  // mesmo dia (key determinística `novos-{AAMMDD}`) depois de uma falha
  // ESTRUTURAL tardia (ex: campanha/agendamento) reusa em vez de abortar.
  const conflicts = findExistingConflicts(
    plans.map((p) => p.listName),
    await fetchExistingLists(apiKey),
  );
  if (conflicts.length && !args.reuseExisting) {
    console.error(`\n❌ ${conflicts.length} lista(s) com esses nomes JÁ existem no Brevo:`);
    for (const c of conflicts) console.error(`   #${c.id} "${c.name}"`);
    console.error(
      `Re-importar criaria duplicatas (Brevo permite nomes iguais). Delete-as no Brevo, ` +
        `ou use --label diferente. No fluxo 'novos', o orquestrador passa --reuse-existing ` +
        `(roda sempre, #5922); passe a flag se quer o mesmo aqui.`,
    );
    process.exit(1);
  }
  if (conflicts.length && args.reuseExisting) {
    console.error(`\n♻️  #5922: ${conflicts.length} lista(s) já existente(s) serão REUSADAS (sem re-import):`);
    for (const c of conflicts) console.error(`   #${c.id} "${c.name}"`);
    console.error(
      `   Premissa: o import anterior completou. Se ele tinha morrido NO MEIO do import,` +
        ` a contagem da lista pode estar menor que o CSV — confira no resumo da campanha.`,
    );
  }

  // #4577: cria + importa + AGUARDA o processo assíncrono terminar +
  // RECONCILIA a contagem final contra a Brevo — antes, o loop disparava o
  // import e seguia pra próxima wave assim que a Brevo aceitava o POST, sem
  // nunca confirmar que o processo tinha de fato terminado (nem com sucesso,
  // nem com a contagem esperada). `importOneWave` (acima) encapsula essa
  // sequência inteira; `client` é injetável — testes usam um fake, aqui é
  // sempre o transporte real da Brevo.
  const client = makeRealImportRunClient(apiKey);
  const results: ImportOneResult[] = [];
  const reuse = splitReuse(plans, conflicts);
  try {
    for (const p of reuse.toImport) {
      const r = await importOneWave(client, p, { folderId: args.folderId });
      results.push(r);
    }
    // #5922 item 7: lista já existente com --reuse-existing → REUSA (nada de
    // re-import; contatos já estão lá da tentativa anterior). Entra em
    // `results` com o listId existente pra que o registro do grupo e o
    // stdout sigam o mesmo caminho de um import normal.
    for (const { plan, existingId } of reuse.reused) {
      console.error(`   ♻️  (${plan.wave.key}) reusando lista #${existingId} "${plan.listName}" — import pulado.`);
      results.push({
        wave: plan.wave.key,
        listId: existingId,
        listName: plan.listName,
        count: plan.count,
        sentCount: plan.sentCount,
        importedAt: new Date().toISOString(),
      });
    }
  } catch (e) {
    // Falha parcial: reporta as listas JÁ criadas pro editor limpar antes de re-rodar
    // (senão o pré-flight de idempotência barra o retry).
    if (results.length) {
      console.error(`\n⚠️  erro no meio — ${results.length} lista(s) JÁ criada(s) e confirmada(s), limpe antes de re-rodar:`);
      for (const r of results) console.error(`   #${r.listId} (${r.wave})`);
    }
    throw e;
  }

  console.error(`\n✅ ${results.length} listas criadas + imports CONFIRMADOS (contagem reconciliada contra a Brevo).`);

  // #3228: registra as listas criadas pra este GRUPO (não pra rampa — waves/
  // não tem o conceito de "campanha ad-hoc por lista", só dNN do plano de
  // blocos) — sem isso, clarice-schedule-group.ts não teria como resolver
  // --group NOME pra um listId sem o editor copiar do stdout.
  if (args.group && results.length > 0) {
    appendGroupListsRegistry(
      clariceSegmentsDir(args.cycle),
      args.cycle,
      args.group,
      // #4576: `key: r.wave` — `importOneWave` já grava o `wave.key` original
      // em `r.wave`; propagar pro registro é o que permite `resolveGroupListId`
      // casar `--key` contra a lista certa quando o grupo tem múltiplas (ex:
      // teste A/B/C com 3 keys/3 listas). #4577 item 4: `r.count` agora é a
      // contagem CONFIRMADA pela Brevo pós-reconciliação, não a enviada.
      // #4753: `resolveRegistryKey` sobrescreve pra `args.campaignKey` (--key
      // desta invocação) quando o grupo NÃO tem célula — ver docstring dela.
      // #4762: `plans[i].hasCell` (não uma re-derivação por regex em `r.wave`)
      // — `results` só chega até aqui depois do loop `for (const p of plans)`
      // ter terminado sem lançar, então `results[i]` corresponde exatamente
      // a `plans[i]` (mesma ordem, mesmo tamanho — nenhum filtro/reordenação
      // entre os dois).
      results.map((r, i) => ({
        key: resolveRegistryKey(r.wave, plans[i].hasCell, args.campaignKey),
        listId: r.listId,
        listName: r.listName,
        count: r.count,
        importedAt: r.importedAt,
      })),
    );
    console.error(
      `📝 registrado em ${groupListsRegistryPath(clariceSegmentsDir(args.cycle), args.group)} — ${results.length} lista(s) do grupo '${args.group}'.`,
    );

    // Achado do fleet review da PR #4758: sem `--key`, `resolveRegistryKey`
    // cai no nome ESTÁTICO do grupo e a entrada só será resolvível por
    // `--list-index` depois — que é exatamente o bug da #4753, reintroduzido
    // em silêncio. O banner de sucesso acima não distinguia os dois casos, e a
    // omissão só aparecia 2 passos adiante. Avisa no ponto da falha.
    //
    // #6721: `shouldWarnMissingCampaignKey` — ver docstring dela — só é true
    // quando existe entrada SEM célula no lote (a única afetada pelo bug da
    // #4753); ondas de célula A/B/C ou de horário já são resolvíveis pela
    // própria key gravada, sem `--list-index`.
    if (shouldWarnMissingCampaignKey(plans.map((p) => p.hasCell), args.campaignKey)) {
      console.error(
        `⚠️  --key não informado: as entradas acima foram gravadas com a key estática '${args.group}'. ` +
          `Uma resolução posterior por --key de campanha NÃO vai encontrá-las (bug da #4753) — ` +
          `use --list-index, ou re-rode o import passando --key.`,
      );
    }
  }

  console.log(JSON.stringify({ mode: "execute", folder_id: args.folderId, label: args.label, results }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
