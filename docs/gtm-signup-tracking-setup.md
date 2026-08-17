# GTM — material de importação: gatilho único de cadastro (#5546)

Preparado para a **#5500** ("gatilho único de cadastro no GTM"), que carrega a
label `windows` e exige interface logada — a importação, publicação e
verificação em painel ficam com o editor. Esta issue (#5546) entrega só o
material: o export do container pronto pra importar, a decisão de qual
gatilho e qual evento usar em cada plataforma, e o checklist de verificação.
Nada aqui foi importado nem publicado — nenhuma ação real rodou contra o GTM,
Meta, Google Ads ou Microsoft Advertising nesta sessão (`develop`, label
`windows`, fora do alcance do overnight).

Arquivo companheiro: **`docs/gtm-signup-container-export.json`** — é esse
arquivo que se sobe no importador do GTM (o JSON abaixo, neste documento, é a
mesma coisa, só que embutida pra leitura; não precisa copiar/colar, o `.json`
já está pronto pra upload).

---

## ⚠️ O aviso mais importante deste documento: importar em **Merge**, nunca **Overwrite**

O container `GTM-TC8C65ZN` já tem em produção:

- `Google Tag AW-17790097065` + `Google Ads Conversion Tracking` (trigger
  `Newsletter Form Submit`) — conversão de cadastro do Google Ads, ativa
  desde o fix do #4348.
- Duas tags do LinkedIn (`window.lintrk('track', {conversion_id: 29163954})`,
  conversion "Newsletter Signup", conta `550020065`).
- `Conversion Linker`.

**Admin → Import Container** no GTM oferece dois modos:

| Modo | Efeito |
|---|---|
| **Merge** (usar este) | Adiciona as tags/triggers do arquivo às que já existem no workspace. É aditivo. |
| **Overwrite** | Substitui o **workspace inteiro** pelo conteúdo do arquivo — tudo que não está neste JSON (as duas tags do LinkedIn, o Conversion Linker, o Google Ads) **desaparece**. |

Este arquivo contém **só** as 2 tags e o 1 trigger novos (Meta + Microsoft
UET) — de propósito não inclui Google Ads nem LinkedIn, exatamente para que
Merge os deixe intocados. Se importado em Overwrite, o resultado é apagar a
instrumentação do LinkedIn e o Conversion Linker que já funcionam — dano
real, silencioso até alguém notar a conversão do LinkedIn zerar.

**Passo a passo:**

1. GTM → Admin → **Import Container**.
2. Escolher `docs/gtm-signup-container-export.json`.
3. Workspace: **criar um workspace novo** (ex: "5546 — cadastro Meta+UET"),
   não o workspace `Default`, para poder revisar o diff antes de publicar.
4. Modo de importação: **Merge**.
5. Opção de conflito ("Rename conflicting tags/triggers/variables"): não deve
   haver conflito de nome — os 2 tags e o trigger deste arquivo têm nomes
   novos, sem homônimo no container atual. Se o GTM acusar conflito, **parar
   e não seguir** — investigar antes (sinal de que algo já existe com esse
   nome, possivelmente de uma tentativa anterior).
6. Confirmar. O GTM abre o workspace com o diff — revisar visualmente que
   **só** apareceram os 2 tags + 1 trigger novos, nada a mais e nada a menos.

---

## O JSON completo (idêntico a `docs/gtm-signup-container-export.json`)

Embutido aqui para este documento ser autossuficiente; o `.json` ao lado é a
mesma coisa como arquivo pronto pra upload, sem precisar copiar/colar.

```json
{
  "exportFormatVersion": 2,
  "exportTime": "2026-08-17T00:00:00Z",
  "containerVersion": {
    "path": "accounts/000000000/containers/00000000/versions/0",
    "accountId": "000000000",
    "containerId": "00000000",
    "containerVersionId": "0",
    "container": {
      "path": "accounts/000000000/containers/00000000",
      "accountId": "000000000",
      "containerId": "00000000",
      "name": "diar.ia.br — Cadastro (import parcial, #5546)",
      "publicId": "GTM-TC8C65ZN",
      "usageContext": ["WEB"],
      "fingerprint": "0",
      "tagManagerUrl": "https://tagmanager.google.com/#/container/accounts/000000000/containers/00000000/workspaces?apiLink=container"
    },
    "tag": [
      {
        "accountId": "000000000",
        "containerId": "00000000",
        "tagId": "1",
        "name": "Meta Pixel - CompleteRegistration (Cadastro)",
        "type": "html",
        "parameter": [
          {
            "type": "template",
            "key": "html",
            "value": "<script>\n(function () {\n  if (typeof fbq === 'function') {\n    fbq('track', 'CompleteRegistration', { content_name: 'newsletter_signup', status: true });\n  } else if (!window.__diaria_fbq_missing_warned) {\n    window.__diaria_fbq_missing_warned = true;\n    console.warn('[diar.ia.br GTM] fbq nao encontrado ao tentar disparar CompleteRegistration - o Meta Pixel base carrega fora do GTM (injecao nativa da Beehiiv); confirme no Preview que ele ja esta presente quando o gatilho de cadastro dispara.');\n  }\n})();\n</script>"
          },
          { "type": "boolean", "key": "supportDocumentWrite", "value": "false" }
        ],
        "firingTriggerId": ["1"],
        "tagFiringOption": "ONCE_PER_EVENT",
        "monitoringMetadata": { "type": "map" },
        "consentSettings": { "consentStatus": "notSet" },
        "notes": "#5546 — evento de cadastro para o dataset Meta 1285191740325112. Hoje o dataset so recebe PageView; este tag adiciona um evento padrao real. Nao cria a Custom Conversion no Events Manager (acao fora do GTM, ver doc)."
      },
      {
        "accountId": "000000000",
        "containerId": "00000000",
        "tagId": "2",
        "name": "Microsoft UET - Base + Cadastro (Newsletter Signup)",
        "type": "html",
        "parameter": [
          {
            "type": "template",
            "key": "html",
            "value": "<script>\n(function(w,d,t,r,u){\n  var f,n,i;\n  w[u]=w[u]||[],f=function(){\n    var o={ti:\"REPLACE_COM_UET_TAG_ID\", enableAutoSpaTracking:true};\n    o.q=w[u],w[u]=new UET(o),w[u].push(\"pageLoad\")\n  },\n  n=d.createElement(t),n.src=r,n.async=1,n.onload=n.onreadystatechange=function(){\n    var s=this.readyState;\n    s&&s!==\"loaded\"&&s!==\"complete\"||(f(),n.onload=n.onreadystatechange=null)\n  },\n  i=d.getElementsByTagName(t)[0],i.parentNode.insertBefore(n,i)\n})(window,document,\"script\",\"//bat.bing.com/bat.js\",\"uetq\");\nwindow.uetq = window.uetq || [];\nwindow.uetq.push('event', 'newsletter_signup', { event_category: 'signup', event_label: 'newsletter', event_value: 1 });\n</script>"
          },
          { "type": "boolean", "key": "supportDocumentWrite", "value": "false" }
        ],
        "firingTriggerId": ["1"],
        "tagFiringOption": "ONCE_PER_EVENT",
        "monitoringMetadata": { "type": "map" },
        "consentSettings": { "consentStatus": "notSet" },
        "notes": "#5546 — UET nao existe hoje no container. SUBSTITUIR 'REPLACE_COM_UET_TAG_ID' pelo Tag ID real (Microsoft Advertising -> Tools -> UET Tags) ANTES de publicar. Tag combina base UET + push do evento no mesmo disparo (nao ha tag UET 'All Pages' separada nesta entrega - ver doc, secao Fora de escopo)."
      }
    ],
    "trigger": [
      {
        "accountId": "000000000",
        "containerId": "00000000",
        "triggerId": "1",
        "name": "CE - Cadastro Concluido (signedUp)",
        "type": "customEvent",
        "customEventFilter": [
          {
            "type": "equals",
            "parameter": [
              { "type": "template", "key": "arg0", "value": "{{_event}}" },
              { "type": "template", "key": "arg1", "value": "signedUp" }
            ]
          }
        ],
        "notes": "#5546 — gatilho unico proposto para substituir o 'Newsletter Form Submit' (Form Submission fragil por RegEx de Form ID). Contrato oficial documentado pela Beehiiv (Website Builder legado): evento de dataLayer 'signedUp', variavel eventProps.email. NAO CONFIRMADO no Website Builder v2 (#5500 item 1 do checklist ainda aberto) - testar no Preview antes de publicar. Se nao disparar, repontar os tags 'Meta Pixel - CompleteRegistration' e 'Microsoft UET - Base + Cadastro' para o trigger existente 'Newsletter Form Submit' (ver doc, Plano B) em vez de reimportar este arquivo."
      }
    ],
    "variable": [],
    "builtInVariable": [
      { "accountId": "000000000", "containerId": "00000000", "type": "EVENT_NAME", "name": "Event" }
    ],
    "fingerprint": "0",
    "tagManagerUrl": "https://tagmanager.google.com/#/container/accounts/000000000/containers/00000000/workspaces?apiLink=container"
  }
}
```

**Sobre os campos `accountId`/`containerId` com placeholder `000000000` /
`00000000`:** GTM's Import Container é executado sempre dentro do container
que o editor já tem aberto (Admin do `GTM-TC8C65ZN`) — o alvo da importação é
determinado pela sessão logada, não pelo cabeçalho do arquivo. É um fluxo
padrão do GTM (construir num container-rascunho, exportar, importar noutro
container de produção) — este arquivo nunca foi de fato exportado do
`GTM-TC8C65ZN` real, porque esta sessão não tem acesso logado a ele. Se o
importador recusar por validação do cabeçalho, os valores reais de
`accountId`/`containerId` do `GTM-TC8C65ZN` aparecem em **Admin → Container
Settings** — substituir os dois placeholders (6 ocorrências cada, busca e
substitui) antes de subir de novo.

---

## Decisões tomadas nesta issue (para não reabrir debate no #5500)

A parte cara do #5500 é decidir os nomes de evento e a estrutura do gatilho —
é isso que esta issue resolve, para o #5500 virar só "importar e publicar":

- **Gatilho único**: evento de `dataLayer` `signedUp` — contrato documentado
  oficialmente pela Beehiiv para o Website Builder legado (variável
  `eventProps.email`). **Não confirmado no Website Builder v2** — o item 1 do
  checklist do #5500 (testar no Preview) segue em aberto. Se não disparar, ver
  "Plano B" abaixo — não é motivo para não publicar o resto.
- **Google Ads e LinkedIn: intocados.** Nenhum dos dois entra neste arquivo.
  A tag do Google Ads continua no trigger `Newsletter Form Submit` como está
  hoje — o objetivo é igualar Meta e Microsoft a ela, não mexer no que já
  funciona.
- **Evento Meta: `CompleteRegistration`** (evento padrão da Meta), não
  `Subscribe` (sugestão da doc da Beehiiv, mas evento custom sem suporte de
  otimização) nem `Lead` (mais genérico — geralmente associado a formulário
  de vendas). `CompleteRegistration` é o evento padrão da Meta com semântica
  mais próxima de "cadastro concluído" e tem suporte completo de
  otimização/relatório no Events Manager.
- **Goal Microsoft UET: "Newsletter Signup"** (custom event, categoria
  `signup`, ação `newsletter_signup`) — mesmo rótulo humano já usado pela
  conversão do LinkedIn, para manter os 3 painéis legíveis lado a lado.
- **Tag UET é base + evento combinados num único Custom HTML**, disparando só
  no gatilho de cadastro — não uma tag UET "All Pages" separada. Cadastro é
  raro (~22 pageviews/dia, #5500) então uma tag "All Pages" adicional traria
  custo de manutenção sem ganho para o que este teste mede (conversão, não
  remarketing geral). Ver "Fora de escopo" para o que isso deixa de fora.

---

## Se `signedUp` não disparar no Preview — Plano B

Não é motivo para travar a publicação das outras duas plataformas. O ajuste é
feito **direto no GTM**, sem reimportar nada:

1. No workspace criado pela importação, abrir a tag **"Meta Pixel -
   CompleteRegistration (Cadastro)"**.
2. Trocar o gatilho de disparo de `CE - Cadastro Concluido (signedUp)` para o
   trigger já existente no container, `Newsletter Form Submit`.
3. Repetir o passo 2 para a tag **"Microsoft UET - Base + Cadastro (Newsletter
   Signup)"**.
4. Publicar normalmente. O trigger novo (`CE - Cadastro Concluido`) pode ficar
   no container sem uso — não causa dano ficar órfão — ou ser removido numa
   limpeza posterior, à critério do editor.

Registrar no #5500 qual dos dois caminhos foi usado — é a informação que a
issue já lista como pendente de registro.

---

## Ações complementares fora do GTM (não fazem parte do arquivo de import)

Duas configurações vivem nos painéis das próprias plataformas, não no GTM —
o import não cria isso sozinho:

1. **Meta — Custom Conversion (opcional, mas necessária para o checklist do
   item 4 abaixo dar `total_count > 0`).** Events Manager → conta
   `10151064543294811` → dataset `1285191740325112` → Custom Conversions →
   criar uma em cima do evento `CompleteRegistration` (sem filtro adicional,
   ou filtrando por `content_name = newsletter_signup` se quiser diferenciar
   de outros `CompleteRegistration` que venham a existir no futuro). Nome
   sugerido: "Cadastro diar.ia.br". Sem esta etapa, o evento padrão já dispara
   e já é usável como conversão em campanhas — a Custom Conversion só serve
   pra ele aparecer também em `ads_get_customconversions` e ter um objeto
   nomeado e filtrável no Ads Manager.
2. **Microsoft UET — conta e Tag ID.** Hoje não existe conta de anúncios
   Microsoft com UET Tag configurado (#5500). Criar a conta (Microsoft
   Advertising) → Tools → UET Tags → criar uma tag → copiar o **Tag ID**
   (formato numérico, ex: `12345678`) → substituir
   `REPLACE_COM_UET_TAG_ID` dentro da tag `Microsoft UET - Base + Cadastro`
   no GTM (editar o Custom HTML direto na UI do GTM, sem precisar reimportar
   o arquivo) → depois criar o **Conversion Goal** do tipo "Custom Event"
   casando `event_category = signup` (ou `event_label = newsletter`) para que
   o evento vire uma conversão contável no Microsoft Advertising.

---

## Tabela de alinhamento — plataforma → evento → onde aparece no painel

| Plataforma | Nome técnico do evento/conversão | Onde aparece no painel |
|---|---|---|
| **dataLayer (gatilho)** | `signedUp` (Custom Event, contrato Beehiiv) — fallback `Newsletter Form Submit` (Form Submission) | GTM → Preview → aba Summary/dataLayer, no momento do disparo |
| **Meta** | `CompleteRegistration` (evento padrão) | Events Manager → Data Sources → dataset "Diar.ia" (`1285191740325112`) → Overview/Test Events, listado ao lado de `PageView`. Custom Conversion "Cadastro diar.ia.br" (se criada) → Events Manager → Custom Conversions |
| **Google Ads** *(intocado, referência)* | Conversão ligada a `AW-17790097065`, tag `Google Ads Conversion Tracking` | Google Ads → Goals → Summary → Conversion actions |
| **LinkedIn** *(intocado, referência)* | "Newsletter Signup" (`conversion_id: 29163954`) | Campaign Manager → conta `550020065` → Conversion Tracking |
| **Microsoft UET** | Custom Event `newsletter_signup` (categoria `signup`) → Conversion Goal "Newsletter Signup" | Microsoft Advertising → Tools → Conversion Goals → "Newsletter Signup"; validação crua via extensão UET Tag Helper |

O nome humano ("Newsletter Signup") é deliberadamente o mesmo em LinkedIn e
Microsoft — é o que permite ler os 3 painéis lado a lado sem tradução mental
durante os 14 dias da #5524. O Meta usa vocabulário fixo da própria
plataforma (`CompleteRegistration`) porque eventos padrão não são
renomeáveis — a Custom Conversion complementar é onde o nome "Cadastro
diar.ia.br" aparece para quem olha o painel Meta.

---

## Checklist de verificação pós-publicação

Rodar depois que o editor publicar o container e, no caso do Microsoft, criar
a conta/tag/goal. Preferir API sempre que disponível — "olhei no painel" é o
fallback, não o primeiro passo.

### Meta — via MCP `claude_ai_Meta_Ads`

```
ads_get_dataset_quality(dataset_id: "1285191740325112")
```
Esperado: o array `web` passa a listar `CompleteRegistration` **ao lado de**
`PageView` (não no lugar — `PageView` continua existindo). Hoje é
`[{"event_name":"PageView"}]`; o critério de sucesso é o evento novo
aparecer.

```
ads_get_customconversions(ad_account_id: "10151064543294811")
```
Esperado: `total_count` sai de `0` — só se a Custom Conversion do passo
complementar acima foi criada. Sem ela, este endpoint continua `0` mesmo com
o evento padrão disparando (esperado, não é regressão).

### Google Ads — via MCP oficial (#5237, já validado)

GAQL contra a conversion action ligada a `AW-17790097065` (ajustar o
`customer_id` para o real, conta `236-921-9639`):

```
search(customer_id: "2369219639", query: "
  SELECT conversion_action.name, conversion_action.id, metrics.conversions
  FROM conversion_action
  WHERE conversion_action.id = 17790097065
")
```
Esperado: `metrics.conversions` > 0 numa janela recente — este canal já
funciona hoje, então serve como controle de que a query está certa antes de
usar o mesmo padrão de verificação para os outros dois.

### Microsoft UET — sem MCP disponível neste ambiente

Nenhum servidor MCP de Microsoft Advertising está listado nas ferramentas
desta sessão (conferido contra a lista de MCPs disponíveis) — diferente de
Meta e Google Ads, não há chamada de API pronta para colar aqui. Verificação
é manual, na ordem que a própria plataforma expõe:

1. **UET Tag Helper** (extensão de browser da Microsoft) na página de
   `diar.ia.br` após um cadastro de teste — confirma que a base UET carregou
   e que o evento `newsletter_signup` foi disparado, com o Tag ID correto.
2. **Microsoft Advertising → Tools → Conversion Goals → "Newsletter
   Signup"** — status deixa de exibir o aviso "não está recebendo
   conversões" (leva algumas horas para o primeiro dado aparecer, mesmo com
   o tag correto).
3. Programático, fora do escopo desta issue: a Reporting API (mesmo padrão
   assíncrono documentado em `docs/microsoft-ads-api-setup.md`,
   `GoalConversionPerformanceReport` em vez de `CampaignPerformanceReport`)
   poderia expor isso via `scripts/lib/microsoft-ads-ingest.ts` — mas hoje
   esse módulo só está testado contra fixture, sem credencial real (mesmo
   estado documentado nesse doc), e implementar o goal report é trabalho
   adicional não coberto aqui.

---

## Fora de escopo

- **Meta CAPI (server-side)** é a **#5504**, já resolvida/mergeada
  separadamente. O que este documento entrega é client-side (Pixel via
  GTM), complementar — não substitui a CAPI. `server_last_fired_time` do
  dataset seguia na epoch na última checagem (16/08/2026), confirmando que a
  CAPI segue sem uso; isso é contexto para a #5504, não algo que este
  entregável resolve.
- **UET "All Pages" (remarketing geral)** — esta entrega cobre só o evento de
  conversão de cadastro, no molde do "gatilho único" do #5500. Uma tag UET de
  base rodando em todas as páginas (para remarketing amplo, não só
  conversão) é extensão futura, não pedida aqui.
- **Advanced Matching / Enhanced Conversions** (hashing de e-mail para
  melhorar correspondência de eventos) — a variável de dataLayer
  `eventProps.email` documentada pela Beehiiv existe e poderia alimentar
  isso, mas exige lógica de hashing (SHA-256) client-side e reconfigurar a
  inicialização do pixel/UET, escopo maior do que "gatilho único de
  cadastro". Não incluído no arquivo de import para manter o material simples
  e de baixo risco de erro na primeira publicação.
- **Reponte de Google Ads/LinkedIn para o novo trigger `signedUp`** — mesmo
  que o Plano B (acima) valide que `signedUp` dispara corretamente, este
  entregável não propõe migrar as tags já funcionando para o novo trigger.
  Elas continuam em `Newsletter Form Submit` por decisão explícita do #5500
  ("a tag do Google Ads fica intocada"). Se o editor decidir unificar tudo no
  evento de dataLayer depois de validado, é uma issue separada — mexer numa
  série histórica de conversão que já funciona é decisão editorial, não
  técnica.

---

## Relacionadas

#5500 (issue-mãe, gatilho único de cadastro), #5524 (protocolo do teste de 3
canais — R$ 1.000/braço, 14 dias, D2 depende desta publicação), #5545
(roteiro de verificação client-side via navegador, complementar a este
checklist server/API-side), #5504 (Meta CAPI, fora de escopo aqui), #5237
(MCP Google Ads, já validado — base da verificação acima), #4348 (origem do
trigger `Newsletter Form Submit` e do bug histórico de `All Pages`).
