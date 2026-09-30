#!/usr/bin/env node
/**
 * totp-setup.js
 * Generates a secret for two-factor login and prints what to do with it:
 *   npm run 2fa            (local)
 *   docker compose exec dumbterm node scripts/totp-setup.js   (Docker)
 */
require('dotenv').config({ quiet: true });
const { generateSecret, codeAt, currentStep, base32Decode } = require('./totp');

const secret = generateSecret();
const account = (process.env.AUTH_EMAIL || 'admin').trim();
const issuer = (process.env.SITE_TITLE || 'MeuTerminal').trim();
const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}`
    + `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
const grouped = secret.match(/.{1,4}/g).join(' ');

console.log(`
Verificação em duas etapas (TOTP) - ${issuer}

1) No app autenticador (Google Authenticator, Microsoft Authenticator, Authy...):
   "Adicionar conta" > "Inserir chave de configuração" e digite:

   Conta: ${account}
   Chave: ${grouped}
   Tipo:  baseado em tempo

2) Confira: o app deve mostrar agora o código ${codeAt(base32Decode(secret), currentStep())}
   (ele muda a cada 30 segundos).

3) Coloque no .env e reinicie o servidor:

   AUTH_TOTP_SECRET=${secret}

Link para apps que aceitam (não compartilhe, contém a chave):
${uri}

Guarde a chave num lugar seguro: sem ela (e sem o celular) só dá para entrar
removendo AUTH_TOTP_SECRET do .env.
`);
