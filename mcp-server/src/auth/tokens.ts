/**
 * Token acquisition.
 *
 * Two identity paths exist, matching ADR-0001:
 *
 *  1. **User-delegated (on-behalf-of).** Copilot Studio is configured with "Authenticate
 *     manually" against Microsoft Entra ID v2, which makes `User.AccessToken` available. That
 *     token is forwarded to this server as a bearer credential and exchanged on-behalf-of for
 *     Azure DevOps and Azure Resource Manager scopes. Every query then runs with the calling
 *     user's own permissions — no shared service account, and Azure DevOps project security
 *     continues to apply.
 *
 *  2. **Workload identity.** Scheduled aggregation and the dashboard's unattended refresh use a
 *     federated credential or managed identity. No client secret is ever stored by this service.
 *
 * The demo path uses neither: it has no tokens because it makes no network calls.
 */

export type TokenResource = 'devops' | 'azure' | 'graph';

/** Azure DevOps resource application ID. Constant and public. */
export const AZURE_DEVOPS_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';
export const AZURE_MANAGEMENT_SCOPE = 'https://management.azure.com/.default';
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

export function scopeFor(resource: TokenResource): string {
  switch (resource) {
    case 'devops':
      return AZURE_DEVOPS_SCOPE;
    case 'azure':
      return AZURE_MANAGEMENT_SCOPE;
    case 'graph':
      return GRAPH_SCOPE;
  }
}

export interface TokenProvider {
  getToken(resource: TokenResource): Promise<string>;
}

interface CacheEntry {
  token: string;
  expiresAt: number;
}

/** Refresh a little before actual expiry so a long-running query cannot expire mid-flight. */
const EXPIRY_SKEW_MS = 120_000;

/**
 * Exchanges an incoming user assertion for a downstream token using the OAuth 2.0
 * on-behalf-of flow with a federated client assertion (no client secret).
 */
export class OnBehalfOfTokenProvider implements TokenProvider {
  private readonly cache = new Map<TokenResource, CacheEntry>();

  constructor(
    private readonly options: {
      tenantId: string;
      clientId: string;
      /** The end user's access token, forwarded by Copilot Studio. */
      userAssertion: string;
      /** Returns a signed client assertion (workload identity federation). */
      getClientAssertion: () => Promise<string>;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async getToken(resource: TokenResource): Promise<string> {
    const cached = this.cache.get(resource);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached.token;

    const http = this.options.fetchImpl ?? fetch;
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      client_id: this.options.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await this.options.getClientAssertion(),
      assertion: this.options.userAssertion,
      scope: scopeFor(resource),
      requested_token_use: 'on_behalf_of',
    });

    const response = await http(
      `https://login.microsoftonline.com/${this.options.tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      },
    );

    if (!response.ok) {
      // The error body can contain the assertion; never log it verbatim.
      throw new Error(
        `On-behalf-of token exchange failed for resource "${resource}" (HTTP ${response.status}).`,
      );
    }

    const payload = (await response.json()) as { access_token: string; expires_in: number };
    this.cache.set(resource, {
      token: payload.access_token,
      expiresAt: Date.now() + payload.expires_in * 1000,
    });
    return payload.access_token;
  }
}

/**
 * Managed identity / workload identity token provider for unattended operation.
 * Reads from the standard IMDS or federated-token endpoints exposed by the host.
 */
export class WorkloadIdentityTokenProvider implements TokenProvider {
  private readonly cache = new Map<TokenResource, CacheEntry>();

  constructor(private readonly options: { fetchImpl?: typeof fetch } = {}) {}

  async getToken(resource: TokenResource): Promise<string> {
    const cached = this.cache.get(resource);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached.token;

    const endpoint = process.env.IDENTITY_ENDPOINT;
    const header = process.env.IDENTITY_HEADER;
    if (!endpoint || !header) {
      throw new Error(
        'No managed identity endpoint is available. Set IDENTITY_ENDPOINT and IDENTITY_HEADER, ' +
          'or run the server with AUTH_MODE=demo.',
      );
    }

    const http = this.options.fetchImpl ?? fetch;
    const url = `${endpoint}?resource=${encodeURIComponent(
      scopeFor(resource).replace('/.default', ''),
    )}&api-version=2019-08-01`;

    const response = await http(url, { headers: { 'X-IDENTITY-HEADER': header } });
    if (!response.ok) {
      throw new Error(`Managed identity token request failed (HTTP ${response.status}).`);
    }

    const payload = (await response.json()) as { access_token: string; expires_on: string };
    this.cache.set(resource, {
      token: payload.access_token,
      expiresAt: Number(payload.expires_on) * 1000,
    });
    return payload.access_token;
  }
}

/** Used only by the offline demo. Fails loudly if anything actually tries to call out. */
export class NoNetworkTokenProvider implements TokenProvider {
  async getToken(): Promise<string> {
    throw new Error(
      'The demo provider must not make network calls. A live request was attempted while ' +
        'running in demo mode — this is a bug.',
    );
  }
}
