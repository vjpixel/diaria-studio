// Página pública de Política de Privacidade da diar.ia.br, servida em
// https://arquivo.diar.ia.br/privacidade (#5262).
//
// Por que ela existe e por que MORA AQUI: a verificação de marca da tela de
// consentimento OAuth do Google (pré-requisito do Basic Access da Google Ads
// API — ver docs/google-ads-api-setup.md) mantém o botão "Verificar marca"
// DESABILITADO enquanto o app não declarar uma página inicial e um link de
// Política de Privacidade públicos num domínio autorizado. O apex
// `diar.ia.br` é custom hostname da Beehiiv e não aceita Worker Route
// (memória do projeto), então a página vive num subdomínio que já é nosso —
// o domínio autorizado registrado no Google é `diar.ia.br`, que cobre os
// subdomínios.
//
// Conteúdo deliberadamente descritivo do que o pipeline REALMENTE faz: cada
// terceiro citado abaixo corresponde a uma credencial em `.env.example` que
// toca dado de leitor. Ao ligar/desligar um canal, atualizar esta lista —
// política que descreve serviço que não usamos mais é pior que política
// curta.

import { renderAnalyticsHead } from "../../../scripts/lib/shared/seo-meta.ts"; // #5498: container GTM

const UPDATED_AT = "3 de setembro de 2026";

const CONTACT_EMAIL = "diariaeditor@gmail.com";

export function renderPrivacyPage(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de Privacidade — diar.ia.br</title>
<meta name="description" content="Como a newsletter diar.ia.br coleta, usa e protege os dados de quem assina e de quem visita as páginas do projeto.">
<link rel="canonical" href="https://arquivo.diar.ia.br/privacidade">
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
footer { margin-top: 3rem; font-size: .9rem; }
</style>
${renderAnalyticsHead()}
</head>
<body>
<h1>Política de Privacidade</h1>
<p class="updated">diar.ia.br — atualizada em ${UPDATED_AT}</p>

<p>A <strong>diar.ia.br</strong> é uma newsletter diária sobre inteligência artificial, publicada em português. Esta política descreve, em linguagem direta, quais dados o projeto coleta, por que coleta e com quem compartilha.</p>

<h2>Quais dados coletamos</h2>
<ul>
  <li><strong>Seu e-mail</strong>, quando você assina a newsletter. É o único dado obrigatório.</li>
  <li><strong>Nome</strong>, quando você escolhe informá-lo no cadastro ou ele acompanha um cadastro importado.</li>
  <li><strong>Interações com os e-mails</strong>: se a edição foi aberta e quais links foram clicados.</li>
  <li><strong>Respostas voluntárias</strong>: enquetes (como o "É IA?"), pesquisas e mensagens que você nos envia.</li>
  <li><strong>Dados de acesso às páginas</strong> do projeto: endereço de origem da visita, tipo de navegador e páginas vistas, em forma agregada.</li>
</ul>

<h2>Para que usamos</h2>
<ul>
  <li>Enviar a edição diária e a edição mensal a quem pediu para recebê-las.</li>
  <li>Entender quais assuntos interessam, para decidir a pauta — é por isso que medimos abertura e clique.</li>
  <li>Manter a entregabilidade: e-mails inválidos são identificados e removidos para que a newsletter não caia em spam de quem quer lê-la.</li>
  <li>Medir de onde vêm os novos leitores, inclusive de anúncios, para saber onde vale investir.</li>
</ul>
<p>Não vendemos, alugamos nem cedemos sua lista de contato a terceiros, e não usamos seus dados para publicidade de outras empresas.</p>

<h2>Com quem compartilhamos</h2>
<p>Usamos serviços de terceiros para operar o projeto. Cada um recebe apenas o necessário para a função que exerce:</p>
<ul>
  <li><strong>Beehiiv</strong> — hospeda a newsletter, o cadastro e o envio das edições.</li>
  <li><strong>Kit</strong> — hospeda o cadastro e o envio das edições para quem assina pelas páginas mais recentes do projeto.</li>
  <li><strong>Brevo</strong> — envio de campanhas de e-mail específicas, incluindo a edição mensal.</li>
  <li><strong>MillionVerifier</strong> — verifica se um endereço de e-mail existe, antes do envio.</li>
  <li><strong>Cloudflare</strong> — hospeda as páginas do projeto (arquivo, hubs temáticos, enquetes) e registra dados de acesso.</li>
  <li><strong>Google, Meta e Microsoft</strong> — anúncios de divulgação da newsletter e medição de sua eficácia (incluindo confirmar que um cadastro feito depois de um anúncio realmente aconteceu).</li>
  <li><strong>apoia.se</strong> e <strong>Stripe</strong> — processam contribuições de quem apoia o projeto financeiramente. Não temos acesso aos dados do seu cartão.</li>
</ul>

<h2>Por quanto tempo guardamos</h2>
<p>Mantemos seu e-mail enquanto você for assinante. Ao cancelar, o endereço é mantido em uma lista de supressão — não para continuar contatando você, mas justamente para garantir que não voltemos a enviar mensagens. Métricas de abertura e clique são conservadas em forma histórica para análise editorial.</p>

<h2>Seus direitos</h2>
<p>Pela Lei Geral de Proteção de Dados (LGPD), você pode a qualquer momento pedir acesso aos seus dados, correção, portabilidade ou exclusão, e revogar o consentimento.</p>
<ul>
  <li><strong>Para parar de receber</strong>: o link de cancelamento no rodapé de qualquer edição resolve, imediatamente e sem justificativa.</li>
  <li><strong>Para os demais pedidos</strong>: escreva para <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</li>
</ul>

<h2>Cookies</h2>
<p>As páginas próprias do projeto não usam cookies de rastreamento publicitário. O site principal e os serviços de terceiros listados acima podem usar cookies próprios, sujeitos às políticas de cada um.</p>

<h2>Crianças</h2>
<p>O projeto não é dirigido a menores de 13 anos e não coleta dados dessa faixa etária de forma consciente.</p>

<h2>Mudanças</h2>
<p>Se esta política mudar de forma relevante, a data de atualização no topo muda junto e avisamos na newsletter.</p>

<h2>Contato</h2>
<p>Dúvidas sobre privacidade ou sobre esta política: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>

<footer><p><a href="https://diar.ia.br">← diar.ia.br</a> · <a href="https://arquivo.diar.ia.br/">Arquivo de edições</a></p></footer>
</body>
</html>`;
}
