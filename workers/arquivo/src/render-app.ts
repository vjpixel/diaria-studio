// Página pública que descreve a ferramenta interna de relatório de aquisição,
// servida em https://arquivo.diar.ia.br/app (#5262).
//
// Por que ela existe: a verificação de marca da tela de consentimento OAuth
// REPROVOU a primeira tentativa com um único problema —
//
//   "A página inicial não explica a finalidade do app.
//    Atualize a página inicial para destacar a finalidade do seu aplicativo."
//
// A "página inicial do aplicativo" apontava para https://diar.ia.br, que é a
// home da NEWSLETTER e não menciona a ferramenta que pede o acesso OAuth. O
// Google quer uma página que descreva o app. Esta é essa página, e é ela que
// vai no campo "Página inicial do aplicativo" do console — não a home.
//
// Precisa ficar sob `diar.ia.br` (domínio autorizado registrado), por isso
// mora no mesmo Worker de `/privacidade`, com o mesmo racional de manutenção:
// o Google revalida enquanto a marca estiver verificada, então um 404 aqui
// derruba a verificação. Ver docs/google-ads-api-setup.md.

const UPDATED_AT = "14 de agosto de 2026";

export function renderAppPage(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatório de aquisição — diar.ia.br</title>
<meta name="description" content="Ferramenta interna da newsletter diar.ia.br que calcula quanto custa conquistar um leitor engajado, por canal de aquisição.">
<link rel="canonical" href="https://arquivo.diar.ia.br/app">
<style>
:root { color-scheme: light dark; }
body {
  margin: 0 auto; padding: 2.5rem 1.25rem 4rem; max-width: 44rem;
  font: 1rem/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #1a1a1a; background: #fff;
}
@media (prefers-color-scheme: dark) {
  body { color: #e8e8e8; background: #16161a; }
  a { color: #8ab4f8; }
}
h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .4rem; }
h2 { font-size: 1.2rem; margin: 2.4rem 0 .6rem; }
.updated { color: #6b6b6b; font-size: .9rem; margin: 0 0 2rem; }
@media (prefers-color-scheme: dark) { .updated { color: #9a9a9a; } }
ul { padding-left: 1.2rem; }
li { margin: .35rem 0; }
a { color: #1a56db; }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em;
  background: rgba(127,127,127,.15); padding: .1em .35em; border-radius: 3px;
}
footer { margin-top: 3rem; font-size: .9rem; }
</style>
</head>
<body>
<h1>Relatório de aquisição</h1>
<p class="updated">Ferramenta interna da newsletter diar.ia.br — atualizada em ${UPDATED_AT}</p>

<p>Esta página descreve a finalidade do aplicativo que solicita acesso à API do Google Ads em nome da <a href="https://diar.ia.br">diar.ia.br</a>, uma newsletter diária brasileira sobre inteligência artificial.</p>

<h2>O que o aplicativo faz</h2>
<p>Ele responde a uma única pergunta: <strong>quanto custa conquistar um leitor que de fato lê a newsletter</strong>, separado por canal de aquisição.</p>
<p>Anunciamos a newsletter no Google Ads com orçamento próprio. O painel de anúncios informa quanto foi gasto e quantas pessoas se cadastraram — mas não sabe quais desses cadastros viraram leitores reais. Esse cruzamento só existe do nosso lado, na base de assinantes. A ferramenta junta as duas metades e calcula o custo por cadastro e o custo por leitor engajado.</p>

<h2>Como funciona</h2>
<ul>
  <li>Roda uma vez por dia, de forma automática, num servidor sob nosso controle.</li>
  <li>Consulta a API do Google Ads em <strong>modo somente leitura</strong>, pedindo custo, cliques e conversões por campanha e por data.</li>
  <li>Cruza esses números com nossa própria base de assinantes, que já registra quem abre as edições.</li>
  <li>Publica um relatório interno com o custo por canal.</li>
</ul>
<p>Hoje esse trabalho é feito à mão, exportando planilhas do painel do Google Ads. O acesso à API substitui apenas essa etapa manual de exportação.</p>

<h2>O que ele não faz</h2>
<ul>
  <li>Não cria, altera nem pausa campanhas, anúncios, palavras-chave ou orçamentos — <strong>nenhuma operação de escrita</strong> está implementada.</li>
  <li>Não acessa contas de terceiros. Opera somente sobre a conta de anunciante da própria publicação (<code>236-921-9639</code>), sob nossa conta de administrador (<code>623-609-4249</code>).</li>
  <li>Não é distribuído, vendido nem oferecido a outras pessoas ou empresas.</li>
  <li>Não lê dados pessoais de usuários do Google. As métricas consultadas são agregadas por campanha.</li>
</ul>

<h2>Quem usa</h2>
<p>Uso interno, uma pessoa: o editor da publicação. Não há usuários externos, clientes ou terceiros com acesso à ferramenta ou ao relatório que ela gera.</p>

<h2>Privacidade</h2>
<p>O tratamento de dados de leitores da newsletter está descrito na <a href="https://arquivo.diar.ia.br/privacidade">Política de Privacidade</a>.</p>

<footer><p><a href="https://diar.ia.br">← diar.ia.br</a> · <a href="https://arquivo.diar.ia.br/">Arquivo de edições</a> · <a href="https://arquivo.diar.ia.br/privacidade">Política de Privacidade</a></p></footer>
</body>
</html>`;
}
