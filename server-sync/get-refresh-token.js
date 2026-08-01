/**
 * Passo único e manual: gera o refresh token do Google Agenda que o workflow
 * do GitHub Actions vai usar para sempre, sem precisar de navegador aberto.
 *
 * Como rodar:
 *   1. cd server-sync
 *   2. npm install
 *   3. GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node get-refresh-token.js
 *      (Client ID/Secret de um OAuth Client tipo "Desktop app" no Google Cloud Console —
 *      não é o mesmo Client ID "Web/browser" usado no controle-visitas.html)
 *   4. Abra a URL impressa no terminal, faça login com a conta Google da agenda e aceite.
 *   5. O token NÃO é impresso no terminal — é gravado direto em ".refresh-token.secret"
 *      (arquivo local, já no .gitignore) para não ficar exposto em logs/histórico.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const OUTPUT_FILE = path.join(__dirname, '.refresh-token.secret');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET como variáveis de ambiente antes de rodar este script.');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Autorização negada.</h1>Pode fechar esta aba.');
    console.error('Google retornou erro:', error);
    server.close();
    return;
  }

  try {
    const port = server.address().port;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(JSON.stringify(tokenData));

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Pronto!</h1>Pode fechar esta aba e voltar ao terminal.');

    if (!tokenData.refresh_token) {
      console.error('\nNão veio refresh_token. Revogue o acesso em https://myaccount.google.com/permissions e rode de novo.\n');
    } else {
      fs.writeFileSync(OUTPUT_FILE, tokenData.refresh_token, { mode: 0o600 });
      console.log('\nToken salvo em: ' + OUTPUT_FILE);
      console.log('Próximo passo: gh secret set GOOGLE_REFRESH_TOKEN < "' + OUTPUT_FILE + '"');
      console.log('Depois, apague o arquivo.\n');
    }
  } catch (e) {
    res.writeHead(500); res.end('Erro ao trocar o código por tokens — veja o terminal.');
    console.error(e);
  } finally {
    server.close();
  }
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', `http://127.0.0.1:${port}/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline'); // exige refresh_token
  authUrl.searchParams.set('prompt', 'consent');       // força reemitir o refresh_token mesmo se já autorizou antes

  console.log('\nAbra esta URL no navegador (com a conta Google da agenda a sincronizar):\n');
  console.log(authUrl.toString());
  console.log('\nAguardando você autorizar...\n');
});
