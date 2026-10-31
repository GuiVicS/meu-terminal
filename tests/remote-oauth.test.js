const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { RemoteOAuth, OAuthError, CODE_TTL_MS, ACCESS_TTL_MS } = require('../scripts/remote/oauth');

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const verifier = crypto.randomBytes(40).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

function setup(opts = {}) {
    let now = 1_700_000_000_000;
    const db = new DatabaseSync(':memory:');
    const oauth = new RemoteOAuth({
        db, issuer: 'https://t.exemplo.com', fingerprint: 'fp1',
        envClient: { id: 'fixo', secret: 'segredo-fixo' }, now: () => now, ...opts,
    });
    return { oauth, db, advance: ms => { now += ms; }, setFp: fp => { oauth.fingerprint = fp; } };
}

const authQuery = (extra = {}) => ({
    client_id: 'fixo', redirect_uri: CALLBACK, response_type: 'code', code_challenge: challenge,
    code_challenge_method: 'S256', state: 'xyz', ...extra,
});

/** Full happy path: authorize -> code -> tokens. */
function login(oauth, clientId = 'fixo', secret = 'segredo-fixo') {
    const req = oauth.validateAuthorizeRequest(authQuery({ client_id: clientId }));
    const url = new URL(oauth.issueCode(req));
    const client = oauth.authenticateClient({ clientId, clientSecret: secret });
    return oauth.exchange(client, { grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: CALLBACK, code_verifier: verifier });
}

test('metadata: endpoints, S256 only, resource under the issuer', () => {
    const { oauth } = setup();
    const as = oauth.authorizationServerMetadata();
    assert.equal(as.issuer, 'https://t.exemplo.com');
    assert.equal(as.token_endpoint, 'https://t.exemplo.com/oauth/token');
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.ok(as.registration_endpoint);
    assert.equal(oauth.protectedResourceMetadata().resource, 'https://t.exemplo.com/mcp/remote');
    assert.equal(setup({ dcr: false }).oauth.authorizationServerMetadata().registration_endpoint, undefined);
});

test('authorize: code comes back on the redirect with state and iss', () => {
    const { oauth } = setup();
    const url = new URL(oauth.issueCode(oauth.validateAuthorizeRequest(authQuery())));
    assert.equal(url.origin + url.pathname, CALLBACK);
    assert.equal(url.searchParams.get('state'), 'xyz');
    assert.equal(url.searchParams.get('iss'), 'https://t.exemplo.com');
    assert.match(url.searchParams.get('code'), /^mtk_/);
});

test('authorize: unknown client or foreign redirect_uri are never redirected', () => {
    const { oauth } = setup();
    for (const q of [authQuery({ client_id: 'nao-existe' }), authQuery({ redirect_uri: 'https://evil.example/cb' }), authQuery({ redirect_uri: undefined })]) {
        assert.throws(() => oauth.validateAuthorizeRequest(q), e => e instanceof OAuthError && !e.redirectUri);
    }
});

test('authorize: missing PKCE, plain PKCE or wrong response_type go back as redirectable errors', () => {
    const { oauth } = setup();
    for (const q of [authQuery({ code_challenge_method: 'plain' }), authQuery({ code_challenge: undefined }), authQuery({ response_type: 'token' }), authQuery({ resource: 'https://outro.com/mcp' })]) {
        assert.throws(() => oauth.validateAuthorizeRequest(q), e => e.redirectUri === CALLBACK);
    }
    assert.doesNotThrow(() => oauth.validateAuthorizeRequest(authQuery({ resource: 'https://t.exemplo.com/mcp/remote' })));
});

test('token: happy path gives a working access token', () => {
    const { oauth } = setup();
    const t = login(oauth);
    assert.equal(t.token_type, 'Bearer');
    assert.equal(t.expires_in, ACCESS_TTL_MS / 1000);
    assert.deepEqual(oauth.verifyAccessToken(t.access_token).clientId, 'fixo');
    assert.equal(oauth.verifyAccessToken(t.refresh_token), null, 'a refresh token is not an access token');
});

test('token: code is single-use, expires in 60 s, needs the right verifier, client and redirect', () => {
    const { oauth, advance } = setup();
    const client = oauth.authenticateClient({ clientId: 'fixo', clientSecret: 'segredo-fixo' });
    const newCode = () => new URL(oauth.issueCode(oauth.validateAuthorizeRequest(authQuery()))).searchParams.get('code');
    const body = code => ({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, code_verifier: verifier });

    const c1 = newCode();
    oauth.exchange(client, body(c1));
    assert.throws(() => oauth.exchange(client, body(c1)), /inválido/);

    const c2 = newCode();
    advance(CODE_TTL_MS + 1);
    assert.throws(() => oauth.exchange(client, body(c2)), /expirado/);

    const c3 = newCode();
    assert.throws(() => oauth.exchange(client, { ...body(c3), code_verifier: crypto.randomBytes(40).toString('base64url') }), /PKCE/);
    assert.throws(() => oauth.exchange(client, body(c3)), /inválido/, 'a failed attempt burns the code');

    const c4 = newCode();
    assert.throws(() => oauth.exchange(client, { ...body(c4), redirect_uri: 'https://claude.com/api/mcp/auth_callback' }), /redirect_uri/);
});

test('client auth: fixed client needs its secret', () => {
    const { oauth } = setup();
    assert.throws(() => oauth.authenticateClient({ clientId: 'fixo', clientSecret: 'errado' }), e => e.code === 'invalid_client' && e.status === 401);
    assert.throws(() => oauth.authenticateClient({ clientId: 'fixo' }), e => e.code === 'invalid_client');
    assert.throws(() => oauth.authenticateClient({ clientId: 'outro', clientSecret: 'x' }), e => e.code === 'invalid_client');
});

test('refresh: rotates, and reusing an old refresh token kills the whole grant', () => {
    const { oauth } = setup();
    const client = oauth.authenticateClient({ clientId: 'fixo', clientSecret: 'segredo-fixo' });
    const t1 = login(oauth);
    const t2 = oauth.exchange(client, { grant_type: 'refresh_token', refresh_token: t1.refresh_token });
    assert.notEqual(t2.refresh_token, t1.refresh_token);
    assert.ok(oauth.verifyAccessToken(t2.access_token));
    assert.throws(() => oauth.exchange(client, { grant_type: 'refresh_token', refresh_token: t1.refresh_token }), /já usado/);
    assert.equal(oauth.verifyAccessToken(t2.access_token), null, 'stolen-token reuse revokes the newer tokens too');
    assert.throws(() => oauth.exchange(client, { grant_type: 'refresh_token', refresh_token: t2.refresh_token }), /já usado/);
});

test('tokens die with time, with new login credentials, and on revocation', () => {
    const { oauth, advance, setFp } = setup();
    const t = login(oauth);
    advance(ACCESS_TTL_MS + 1);
    assert.equal(oauth.verifyAccessToken(t.access_token), null);

    const t2 = login(oauth);
    setFp('fp2'); // password or 2FA changed
    assert.equal(oauth.verifyAccessToken(t2.access_token), null);
    const client = oauth.authenticateClient({ clientId: 'fixo', clientSecret: 'segredo-fixo' });
    assert.throws(() => oauth.exchange(client, { grant_type: 'refresh_token', refresh_token: t2.refresh_token }), /expirada/);

    const t3 = login(oauth);
    assert.equal(oauth.revokeToken(client, t3.refresh_token), true);
    assert.equal(oauth.verifyAccessToken(t3.access_token), null, 'revoking the refresh token ends the grant');

    const t4 = login(oauth);
    oauth.revokeClient('fixo');
    assert.equal(oauth.verifyAccessToken(t4.access_token), null);
});

test('only hashes are stored', () => {
    const { oauth, db } = setup();
    const t = login(oauth);
    const dump = JSON.stringify(db.prepare('SELECT * FROM remote_tokens').all());
    assert.ok(!dump.includes(t.access_token) && !dump.includes(t.refresh_token));
});

test('DCR: allowlisted redirects only; public client works with PKCE alone; revoke deletes it', () => {
    const { oauth, db } = setup();
    assert.throws(() => oauth.registerClient({ redirect_uris: ['https://evil.example/cb'] }), e => e.code === 'invalid_redirect_uri');
    assert.throws(() => oauth.registerClient({}), e => e.code === 'invalid_redirect_uri');

    const pub = oauth.registerClient({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    assert.equal(pub.client_secret, undefined);
    const t = login(oauth, pub.client_id, undefined);
    assert.ok(oauth.verifyAccessToken(t.access_token));

    const conf = oauth.registerClient({ client_name: 'Outro', redirect_uris: [CALLBACK] });
    assert.match(conf.client_secret, /^mts_/);
    assert.throws(() => oauth.authenticateClient({ clientId: conf.client_id, clientSecret: 'x' }), e => e.code === 'invalid_client');
    assert.ok(oauth.authenticateClient({ clientId: conf.client_id, clientSecret: conf.client_secret }));
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM remote_clients').all()).includes(conf.client_secret));

    assert.equal(oauth.listClients().length, 3); // fixed + 2 registered
    oauth.revokeClient(pub.client_id);
    assert.equal(oauth.verifyAccessToken(t.access_token), null);
    assert.equal(oauth.getClient(pub.client_id), null);
    assert.throws(() => setup({ dcr: false }).oauth.registerClient({ redirect_uris: [CALLBACK] }), /desligado/);
});

test('code for one client cannot be redeemed by another', () => {
    const { oauth } = setup();
    const other = oauth.registerClient({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    const code = new URL(oauth.issueCode(oauth.validateAuthorizeRequest(authQuery()))).searchParams.get('code');
    const client = oauth.authenticateClient({ clientId: other.client_id });
    assert.throws(() => oauth.exchange(client, { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, code_verifier: verifier }), /outro cliente/);
});
