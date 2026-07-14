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

---

## 1. Tamanho por arquivo

Rodar `npx tsx scripts/audit-context-tokens.ts` regenera esta tabela.

| Arquivo | Bytes | ~Tokens (estimado) |
|---|---:|---:|
| `context/publishers/beehiiv-playbook.md` | 78653 | ~19254 |
| `context/editorial-rules.md` | 18182 | ~4395 |
| `context/publishers/linkedin.md` | 14211 | ~3472 |
| `context/sources.md` (gerado) | 12018 | ~2999 |
| `context/snippets/README.md` | 9971 | ~2409 |
| `context/templates/newsletter-monthly.md` | 9903 | ~2391 |
| `context/templates/newsletter.md` | 9306 | ~2227 |
| `context/audience-profile.md` (gerado) | 7420 | ~1782 |
| `context/templates/social-linkedin.md` | 5454 | ~1316 |
| `context/publishers/facebook.md` | 3847 | ~937 |
| `context/agents-known-issues.md` | 2629 | ~645 |
| `context/publishers/humanizador-rubric.md` | 2289 | ~551 |
| `context/snippets/*.md` (7 arquivos) | ~10300 total | ~2478 total |
| `context/invariants.md` (gerado) | 1818 | ~442 |

**Total: 21 arquivos, 187.231 bytes, ~45.600 tokens estimados.**

`beehiiv-playbook.md` sozinho é **42% do total de bytes** de `context/` —
de longe o maior contribuinte, isolado.

---

## 2. `beehiiv-playbook.md` — o outlier

78KB / ~19k tokens estimados é um script passo-a-passo de automação
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

**2 arquivos flagados — ambos falsos-positivos, confirmados manualmente:**

1. `beehiiv-playbook.md:926` — `new Date()` aparece dentro de um bloco de
   código bash **de exemplo** (`node -e "process.stdout.write(new
   Date().toISOString())"`), instrução estática de como o operador deve
   capturar um timestamp durante a execução da Etapa 5. Não é código que
   roda a cada leitura do arquivo — é texto imutável do próprio playbook.
2. `context/invariants.md:5` — `Última atualização: 2026-05-08T04:01:49...`
   é um cabeçalho de metadata em arquivo **gerado**
   (`scripts/regen-invariants.ts`, a partir de issues GitHub com label
   `convention`). Só muda quando o script roda de novo (gatilho: issue
   nova com essa label), não a cada chamada de agente — mesmo padrão já
   usado em `context/audience-profile.md` (`updated_at`) e
   `context/sources.md` ("Gerado de..."). Placement correto: no topo,
   antes do conteúdo estável, e a cadência de mudança é baixa o
   suficiente pra não ser um invalidador prático.

**Conclusão: nenhum invalidador de cache real encontrado.** Os 3 arquivos
gerados (`sources.md`, `audience-profile.md`, `invariants.md`) já seguem a
convenção correta — timestamp de geração isolado num cabeçalho, regenerado
com baixa frequência (não por request), análogo à decisão já tomada em
#1847 de mover `data/past-editions.md` pra fora de `context/` justamente
por regenerar a cada Stage 0 (esse sim seria um invalidador reintroduzido
se voltasse pra `context/`).

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
isso seja um problema prático de tamanho — `sources.md` é o 4º maior
arquivo, ~3k tokens estimados, não um outlier).

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
