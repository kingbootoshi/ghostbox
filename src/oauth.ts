import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile, unlink, rename, chmod } from 'node:fs/promises';
import type {
  AuthProvider,
  AuthProviderStatus,
  AuthStatus,
  AuthTokenStore,
  OAuthTokenRecord,
} from './types';

const CALLBACK_HOST = '127.0.0.1';
const EXPIRY_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_CALLBACK_URL = 'http://localhost:53692/callback';
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CALLBACK_URL = 'http://localhost:1455/auth/callback';

export interface OAuthProviderDefinition {
  id: AuthProvider;
  name: string;
  authUrl: string;
  tokenUrl: string;
  callbackUrl: string;
  callbackPath: string;
  callbackPort: number;
  scopes: string;
  buildAuthUrl: (verifier: string, state: string) => string;
  exchangeCode: (code: string, verifier: string, state: string) => Promise<OAuthTokenRecord>;
  refreshToken: (refreshToken: string) => Promise<OAuthTokenRecord>;
  getApiKey: (tokens: OAuthTokenRecord) => string;
}

type CallbackServerHandle = {
  close: () => Promise<void>;
  waitForCode: () => Promise<string>;
};

// ---------- PKCE helpers ----------

function base64UrlEncode(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
}

function generateState(): string {
  return randomBytes(16).toString('hex');
}

// ---------- HTTP helpers ----------

function toExpiryTimestamp(expiresInSeconds: number): number {
  return Date.now() + expiresInSeconds * 1000;
}

function buildHtmlPage(input: { title: string; message: string; details?: string }): string {
  const details = input.details
    ? `<p style="color:#666;font-size:14px;">${input.details}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${input.title}</title>
  </head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;line-height:1.5;">
    <h1 style="margin:0 0 12px;">${input.title}</h1>
    <p style="margin:0;">${input.message}</p>
    ${details}
  </body>
</html>`;
}

async function readJsonResponse<T>(response: Response, context: string): Promise<T> {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${context} failed with status ${response.status}: ${text || '<empty response>'}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `${context} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function postJson<T>(url: string, body: Record<string, string>, context: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return readJsonResponse<T>(response, context);
}

async function postForm<T>(url: string, body: Record<string, string>, context: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return readJsonResponse<T>(response, context);
}

// ---------- Token exchange ----------

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

function validateTokenResponse(response: TokenResponse, context: string): OAuthTokenRecord {
  if (!response.access_token || !response.refresh_token || typeof response.expires_in !== 'number') {
    throw new Error(`${context} returned missing fields.`);
  }
  return {
    type: 'oauth',
    access: response.access_token,
    refresh: response.refresh_token,
    expires: toExpiryTimestamp(response.expires_in),
  };
}

async function exchangeAnthropicCode(
  code: string,
  verifier: string,
  state: string,
): Promise<OAuthTokenRecord> {
  const response = await postJson<TokenResponse>(
    anthropicProvider.tokenUrl,
    {
      grant_type: 'authorization_code',
      client_id: ANTHROPIC_CLIENT_ID,
      code,
      state,
      redirect_uri: anthropicProvider.callbackUrl,
      code_verifier: verifier,
    },
    'Anthropic token exchange',
  );
  return validateTokenResponse(response, 'Anthropic token exchange');
}

async function exchangeOpenAICode(code: string, verifier: string): Promise<OAuthTokenRecord> {
  const response = await postForm<TokenResponse>(
    openaiProvider.tokenUrl,
    {
      grant_type: 'authorization_code',
      client_id: OPENAI_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: openaiProvider.callbackUrl,
    },
    'OpenAI token exchange',
  );
  return validateTokenResponse(response, 'OpenAI token exchange');
}

export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthTokenRecord> {
  const response = await postJson<TokenResponse>(
    'https://platform.claude.com/v1/oauth/token',
    {
      grant_type: 'refresh_token',
      client_id: ANTHROPIC_CLIENT_ID,
      refresh_token: refreshToken,
    },
    'Anthropic token refresh',
  );
  return validateTokenResponse(response, 'Anthropic token refresh');
}

export async function refreshOpenAIToken(refreshToken: string): Promise<OAuthTokenRecord> {
  const response = await postForm<TokenResponse>(
    'https://auth.openai.com/oauth/token',
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_CLIENT_ID,
    },
    'OpenAI token refresh',
  );
  return validateTokenResponse(response, 'OpenAI token refresh');
}

// ---------- Provider definitions ----------

export const anthropicProvider: OAuthProviderDefinition = {
  id: 'anthropic',
  name: 'Anthropic',
  authUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  callbackUrl: ANTHROPIC_CALLBACK_URL,
  callbackPath: '/callback',
  callbackPort: 53692,
  scopes:
    'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  buildAuthUrl(verifier, state) {
    const url = new URL(this.authUrl);
    url.searchParams.set('code', 'true');
    url.searchParams.set('client_id', ANTHROPIC_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.callbackUrl);
    url.searchParams.set('scope', this.scopes);
    url.searchParams.set('code_challenge', generateCodeChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    return url.toString();
  },
  exchangeCode: exchangeAnthropicCode,
  refreshToken: refreshAnthropicToken,
  getApiKey(tokens) {
    return tokens.access;
  },
};

export const openaiProvider: OAuthProviderDefinition = {
  id: 'openai-codex',
  name: 'OpenAI',
  authUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  callbackUrl: OPENAI_CALLBACK_URL,
  callbackPath: '/auth/callback',
  callbackPort: 1455,
  scopes: 'openid profile email offline_access',
  buildAuthUrl(verifier, state) {
    const url = new URL(this.authUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', OPENAI_CLIENT_ID);
    url.searchParams.set('redirect_uri', this.callbackUrl);
    url.searchParams.set('scope', this.scopes);
    url.searchParams.set('code_challenge', generateCodeChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    return url.toString();
  },
  exchangeCode: async (code, verifier) => exchangeOpenAICode(code, verifier),
  refreshToken: refreshOpenAIToken,
  getApiKey(tokens) {
    return tokens.access;
  },
};

const providers: Record<AuthProvider, OAuthProviderDefinition> = {
  anthropic: anthropicProvider,
  'openai-codex': openaiProvider,
};

function resolveProvider(provider: AuthProvider | OAuthProviderDefinition): OAuthProviderDefinition {
  if (typeof provider !== 'string') return provider;
  const resolved = providers[provider];
  if (!resolved) throw new Error(`Unknown OAuth provider: ${provider}`);
  return resolved;
}

// ---------- Callback server ----------

async function startCallbackServer(
  provider: OAuthProviderDefinition,
  expectedState: string,
): Promise<CallbackServerHandle> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let closeStarted = false;
    let resolveCode: ((code: string) => void) | null = null;
    let rejectCode: ((error: Error) => void) | null = null;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '', provider.callbackUrl);
        if (url.pathname !== provider.callbackPath) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildHtmlPage({ title: 'Authentication Failed', message: 'Callback route not found.' }));
          return;
        }

        const error = url.searchParams.get('error');
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            buildHtmlPage({
              title: 'Authentication Failed',
              message: `${provider.name} did not complete authentication.`,
              details: `Error: ${error}`,
            }),
          );
          finish(() => rejectCode?.(new Error(`${provider.name} OAuth failed: ${error}`)));
          return;
        }

        const state = url.searchParams.get('state');
        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildHtmlPage({ title: 'Authentication Failed', message: 'State mismatch.' }));
          finish(() => rejectCode?.(new Error(`${provider.name} OAuth callback state mismatch.`)));
          return;
        }

        const code = url.searchParams.get('code');
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildHtmlPage({ title: 'Authentication Failed', message: 'Missing authorization code.' }));
          finish(() => rejectCode?.(new Error(`${provider.name} OAuth callback was missing a code.`)));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          buildHtmlPage({
            title: 'Authentication Complete',
            message: `${provider.name} authentication completed. You can close this window.`,
          }),
        );
        finish(() => resolveCode?.(code));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildHtmlPage({ title: 'Authentication Failed', message: 'Internal error.' }));
        finish(() => rejectCode?.(err instanceof Error ? err : new Error(String(err))));
      }
    });

    const close = async (): Promise<void> => {
      if (closeStarted) return;
      closeStarted = true;
      await new Promise<void>((res, rej) => {
        server.close((err) => (err ? rej(err) : res()));
      }).catch((err) => {
        if (!/not running/i.test(err instanceof Error ? err.message : String(err))) throw err;
      });
    };

    server.once('error', (err) => {
      finish(() => rejectCode?.(err instanceof Error ? err : new Error(String(err))));
      reject(err);
    });

    server.listen(provider.callbackPort, CALLBACK_HOST, () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        reject(new Error(`Failed to bind ${provider.callbackUrl}.`));
        return;
      }
      resolve({ close, waitForCode: () => codePromise });
    });
  });
}

// ---------- Browser ----------

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!command) {
    console.log(`Open this URL manually: ${url}`);
    return;
  }

  try {
    const exitCode = await new Promise<number>((resolve) => {
      const proc = nodeSpawn(command, [url], { stdio: 'ignore' });
      proc.on('error', () => resolve(1));
      proc.on('close', (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) {
      console.log(`Browser launch failed. Open this URL manually: ${url}`);
    }
  } catch {
    console.log(`Browser launch failed. Open this URL manually: ${url}`);
  }
}

// ---------- Token storage ----------

function getGhostboxHome(): string {
  return join(process.env.HOME ?? homedir(), '.ghostbox');
}

function authFile(): string {
  return join(getGhostboxHome(), 'auth.json');
}

async function writeProtectedJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = join(filePath, '..');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

export async function readAuthTokens(): Promise<AuthTokenStore> {
  try {
    const raw = await readFile(authFile(), 'utf8');
    const parsed = JSON.parse(raw) as AuthTokenStore;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export async function readAuthToken(provider: AuthProvider): Promise<OAuthTokenRecord | null> {
  const store = await readAuthTokens();
  return store[provider] ?? null;
}

export async function saveAuthToken(provider: AuthProvider, tokens: OAuthTokenRecord): Promise<void> {
  const nextStore = {
    ...(await readAuthTokens()),
    [provider]: tokens,
  } satisfies AuthTokenStore;
  await writeProtectedJsonAtomic(authFile(), nextStore);
}

export async function deleteAuthToken(provider: AuthProvider): Promise<void> {
  const nextStore = { ...(await readAuthTokens()) };
  delete nextStore[provider];

  if (Object.keys(nextStore).length === 0) {
    await unlink(authFile()).catch(() => {});
    return;
  }

  await writeProtectedJsonAtomic(authFile(), nextStore);
}

// ---------- Public API ----------

export async function loginProvider(
  providerInput: AuthProvider | OAuthProviderDefinition,
): Promise<OAuthTokenRecord> {
  const provider = resolveProvider(providerInput);
  const verifier = generateCodeVerifier();
  const state = provider.id === 'anthropic' ? verifier : generateState();
  const callbackServer = await startCallbackServer(provider, state);
  const authUrl = provider.buildAuthUrl(verifier, state);

  try {
    await openBrowser(authUrl);
    const code = await callbackServer.waitForCode();
    const tokens = await provider.exchangeCode(code, verifier, state);
    await saveAuthToken(provider.id, tokens);
    return tokens;
  } finally {
    await callbackServer.close();
  }
}

export async function ensureFreshOAuthToken(
  providerId: AuthProvider,
): Promise<{ token: string; expiresAt: number } | null> {
  const provider = resolveProvider(providerId);
  let tokens = await readAuthToken(provider.id);
  if (!tokens) return null;

  if (Date.now() + EXPIRY_REFRESH_BUFFER_MS >= tokens.expires) {
    tokens = await provider.refreshToken(tokens.refresh);
    await saveAuthToken(provider.id, tokens);
  }

  return { token: provider.getApiKey(tokens), expiresAt: tokens.expires };
}

function toProviderStatus(tokens: OAuthTokenRecord | null): AuthProviderStatus {
  return {
    authenticated: tokens !== null,
    expiresAt: tokens?.expires ?? null,
  };
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const tokens = await readAuthTokens();
  return {
    providers: {
      anthropic: toProviderStatus(tokens.anthropic ?? null),
      'openai-codex': toProviderStatus(tokens['openai-codex'] ?? null),
    },
  };
}

export async function logoutProvider(providerId: AuthProvider): Promise<void> {
  await deleteAuthToken(providerId);
}

export { providers, resolveProvider };
