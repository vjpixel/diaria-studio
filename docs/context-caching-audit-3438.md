# Auditoria de context caching — `context/` (#3438)

**Status:** levantamento concluído. Ferramenta reutilizável adicionada
(`scripts/audit-context-tokens.ts`); nenhum corte de conteúdo foi aplicado —
ver seção 4 pra justificativa.

**Método:** contagem por byte (determinística) + estimativa de tokens via
heurística chars/4. Este ambiente não tinha `ANTHROPIC_API_KEY` nem o CLI
`ant` disponíveis para rodar `messages.count_tokens` (o método recomendado
pela skill `claude-api` — nunca `tiktoken`, que subconta ~15-20% em Claude).
A estimativa aqui deve ser tratada como **piso aproximado**, não número
exato — re-rodar `ant messages count-tokens --message "@<arquivo>"` por
arquivo quando o CLI estiver disponível pra números exatos.

**Atualizado em #3438 (260716):** refresh dos números (drift natural desde
o levantamento original de 260714, #3440) — sem mudança de veredito. Ver
nota de drift ao fim da seção 1.

---

## 1. Tamanho por arquivo

Rodar `npx tsx scripts/audit-context-tokens.ts` regenera esta tabela.

| Arquivo | Bytes | ~Tokens (estimado) |
|---|---:|---:|
| `context/publishers/beehiiv-playbook.md` | 83435 | ~20410 |
| `context/editorial-rules.md` | 19909 | ~4815 |
| `context/publishers/linkedin.md` | 14211 | ~3472 |
| `context/snippets/README.md` | 12092 | ~2921 |
| `context/sources.md` (gerado) | 12018 | ~2999 |
| `context/templates/newsletter-monthly.md` | 9903 | ~2391 |
| `context/templates/newsletter.md` | 9306 | ~2227 |
| `context/audience-profile.md` (gerado) | 7420 | ~1782 |
| `context/templates/social-linkedin.md` | 5454 | ~1316 |
| `context/overnight-dispatch-rules.md` | 5135 | ~1252 |
| `context/publishers/facebook.md` | 3768 | ~917 |
| `context/agents-known-issues.md` | 2629 | ~645 |
| `context/publishers/humanizador-rubric.md` | 2289 | ~551 |
| `context/templates/social-instagram.md` | 1974 | ~476 |
| `context/invariants.md` (gerado) | 1778 | ~432 |
| `context/snippets/*.md` (8 arquivos de conteúdo) | ~12337 total | ~2963 total |

**Total: 24 arquivos, 204.888 bytes, ~49.866 tokens estimados** (era 21
arquivos / 187.231 bytes / ~45.600 tokens em 260714, #3440 — +9% em 2 dias,
crescimento orgânico, não um outlier isolado).

`beehiiv-playbook.md` sozinho é **41% do total de bytes** de `context/` —
segue de longe o maior contribuinte, isolado (era 42% — proporção estável
apesar do arquivo também ter crescido, de 78653 para 83435 bytes).

**Drift desde 260714:** 3 arquivos novos entraram em `context/` por features
legítimas, não por acidente — `context/overnight-dispatch-rules.md` (#3453/
#3454, checklist canônico de dispatch overnight/develop, citado em vez de
reproduzido em cada prompt — ver header do próprio arquivo), `context/
templates/social-instagram.md` e `context/snippets/indicacao-ferramenta.md`
(#3486/#3212, seção Instagram + box de divulgação). Nenhum é candidato a
corte — cada um resolve uma duplicação de prompt maior do que o próprio
tamanho (ex: `overnight-dispatch-rules.md` existe justamente pra encolher o
prompt de dispatch do coordenador, trocando N reproduções por 1 leitura).

---

## 2. `beehiiv-playbook.md` — o outlier

83KB / ~20k tokens estimados é um script passo-a-passo de automação
Claude in Chrome (seletores, fallbacks de retry, snippets JS de
`javascript_tool`) pro fluxo de publicação Beehiiv. Achados:

- **Não é lido por toda chamada de agente.** Por design (`publish-newsletter`
  migrou pra playbook lido pelo top-level em #1054, movido pra
  `context/publishers/` em #1114), só o orchestrator top-level o lê, e só
  durante a Etapa 5 (publicação). Os outros ~20 agentes/stages nunca tocam
  nele. O custo de tokens é real mas **localizado** — 1x por edição, não
  amplificado por stage.
- **Verboso por necessidade, não por acidente.** O conteúdo é
  majoritariamente exemplos de código JS pra `javascript_tool` (seletores
  TipTap, retry de upload de cover, validação de merge tags) — este é o
  tipo de detalhe que, se cortado, quebra a automação em produção (fluxo
  frágil, já documentado como tal no arquivo: "#2495 — fetch() ficou
  pendurado", "#1500 retornou applied:false"). Cortar sem entender cada
  seletor tem alto risco de regressão silenciosa num fluxo sem teste de
  regressão automatizado (é Claude in Chrome — não há suíte que pegue um
  seletor quebrado antes de rodar em produção).
- **Recomendação:** não cortar às cegas. Se o editor quiser reduzir esse
  arquivo, o caminho seguro é revisão manual seção-a-seção (qual passo
  ainda é necessário vs. qual incidente já foi permanentemente resolvido
  no código e virou só narrativa histórica) — isso é **decisão editorial**,
  sinalizada aqui, não uma decisão que este script deveria tomar sozinho.

---

## 3. Invalidadores de cache

Busquei por 3 padrões que indicariam conteúdo volátil embutido *fora* de
um cabeçalho estático de metadata (o tipo de coisa que muda a cada
render/chamada e invalida o prefixo cacheado a partir dali): `new Date()`/
`Date.now()` literal, UUID literal, timestamp ISO 8601 completo.

**2 arquivos flagados — todos os matches são falsos-positivos, confirmados
manualmente (atualizado 260716 — `beehiiv-playbook.md` acumulou um 2º
padrão desde 260714):**

1. `beehiiv-playbook.md` — 2 padrões, ambos texto estático em blocos de
   código de exemplo, nunca avaliado em runtime:
   - `new Date()` (linha ~926) dentro de um bash de exemplo (`node -e
     "process.stdout.write(new Date().toISOString())"`), instrução de como
     o operador captura um timestamp durante a Etapa 5.
   - Timestamp ISO 8601 completo (3 ocorrências: `test_email_sent_at`,
     `scheduled_at`, `published_at`) dentro de blocos ```json``` que
     documentam o *shape* esperado da saída de scripts (`05-published.json`,
     output de `verify-scheduled-post.ts`) — valores de exemplo fixos
     (`"2026-04-18T12:34:56.789Z"` etc.), não interpolação.
2. `context/invariants.md` — `Última atualização: 2026-05-08T04:01:49...`
   é um cabeçalho de metadata em arquivo **gerado**
   (`scripts/regen-invariants.ts`, a partir de issues GitHub com label
   `convention`). Só muda quando o script roda de novo (gatilho: issue
   nova com essa label), não a cada chamada de agente — mesmo padrão já
   usado em `context/audience-profile.md` (`updated_at`) e
   `context/sources.md` ("Gerado de..."). Placement correto: no topo,
   antes do conteúdo estável, e a cadência de mudança é baixa o
   suficiente pra não ser um invalidador prático.

**Conclusão: nenhum invalidador de cache real encontrado** — mesmo veredito
de 260714, revalidado após o crescimento de `beehiiv-playbook.md`. Os 3
arquivos gerados (`sources.md`, `audience-profile.md`, `invariants.md`) já
seguem a convenção correta — timestamp de geração isolado num cabeçalho,
regenerado com baixa frequência (não por request), análogo à decisão já
tomada em #1847 de mover `data/past-editions.md` pra fora de `context/`
justamente por regenerar a cada Stage 0 (esse sim seria um invalidador
reintroduzido se voltasse pra `context/`).

---

## 4. Cortes aplicados

**Nenhum.** Revisão de conteúdo (redundância, desatualização, verbosidade)
em `context/agents-known-issues.md` (menor arquivo com estrutura de
"issues + mitigation") não achou entradas mortas — toda entrada documenta
uma mitigation ativamente aplicada pelo orchestrator (`filterAgentIssues()`,
tratamento de `inconclusive`). Os arquivos `context/sources.md` e
`context/audience-profile.md` são gerados por script
(`npm run sync-sources`, Stage 0) — editar à mão seria sobrescrito no
próximo run; qualquer redundância neles (ex: o topic-filter string repetido
por fonte em `sources.md`) precisa ser resolvida no gerador, não no
arquivo, e está fora do escopo desta issue (nenhuma medição indicou que
isso seja um problema prático de tamanho — `sources.md` está entre os 5
maiores arquivos, ~3k tokens estimados, não um outlier).

`beehiiv-playbook.md` (seção 2) é o único candidato de tamanho real, e a
recomendação é revisão editorial manual, não corte automatizado.

---

## 5. Ferramenta

`scripts/audit-context-tokens.ts` (+ `test/audit-context-tokens.test.ts`)
fica no repo pra re-rodar esta auditoria sob demanda:

```
npx tsx scripts/audit-context-tokens.ts [--dir context] [--out <path>]
```

Produz a tabela da seção 1 + a lista de invalidadores da seção 3. Não
requer rede nem API key (estimativa local); troque por `count_tokens` real
quando precisar de número exato pra uma decisão de corte específica.
