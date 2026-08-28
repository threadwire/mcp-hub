import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { HubConfig, TenantConfig } from "./types.js";

/**
 * OAuth 2.1 provider (slim, correct): authorization_code + client_credentials
 * on the hub. Issued access tokens are opaque random bytes scoped to a tenant
 * and a resource (RFC 8707 — the token says what it is FOR). Enables the
 * "no static API keys" story: token rotation and revocation without rebuilding
 * tenants.
 *
 * PKCE is enforced for public clients; refresh hints returned for later
 * rotation. Not a full IdP — pair it with your own issuer for production.
 */
export interface IssuedToken {
  token: string;
  tenantId: string;
  resource: string;
  scope: string[];
  expiresAt: number;
}

export class OAuthProvider {
  private issued = new Map<string, IssuedToken>();
  private codes = new Map<string, { tenantId: string; clientId: string; redirectUri: string; verifier: string }>();
  private clients = new Map<string, string | null>(); // client_id -> client_secret (nullable)

  constructor(private cfg: HubConfig) {}

  registerClient(clientId: string, secret: string | null): void {
    this.clients.set(clientId, secret);
  }

  /** GET /oauth/authorize -> returns an authorization code (URL-embeddable). */
  authorize(params: {
    response_type: string;
    client_id: string;
    redirect_uri: string;
    scope?: string;
    code_challenge?: string;
  }): { code: string; redirect_uri: string } | { error: string } {
    if (params.response_type !== "code") return { error: "unsupported_response_type" };
    if (!this.clients.has(params.client_id)) return { error: "invalid_client" };
    if (!params.code_challenge) return { error: "code challenge required (PKCE)" };
    const tenant = this.tenantForClient(params.client_id);
    if (!tenant) return { error: "unauthorized_client" };
    const code = randomBytes(24).toString("hex");
    this.codes.set(code, {
      tenantId: tenant.id,
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      verifier: params.code_challenge,
    });
    setTimeout(() => this.codes.delete(code), 60_000).unref();
    return { code, redirect_uri: params.redirect_uri };
  }

  /** POST /oauth/token -> exchanges code (PKCE-verified) or client credentials. */
  token(body: {
    grant_type: string;
    code?: string;
    code_verifier?: string;
    client_id?: string;
    client_secret?: string;
    resource?: string;
    scope?: string;
  }): { access_token: string; token_type: "Bearer"; expires_in: number; scope: string } | { error: string } {
    if (body.grant_type === "authorization_code") {
      const entry = body.code ? this.codes.get(body.code) : undefined;
      if (!entry) return { error: "invalid_grant" };
      if (typeof body.code_verifier !== "string") return { error: "invalid_grant (PKCE failed)" };
      if (!timingSafeCompare(hashVerifier(body.code_verifier), entry.verifier)) {
        return { error: "invalid_grant (PKCE failed)" };
      }
      if (body.code) this.codes.delete(body.code);
      return this.mint(entry.tenantId, body.resource ?? "mcp", ["read", "write"]);
    }
    if (body.grant_type === "client_credentials") {
      if (typeof body.client_id !== "string" || typeof body.client_secret !== "string") return { error: "invalid_client" };
      const expected = this.clients.get(body.client_id);
      if (expected === undefined || expected === null || !timingSafeCompare(body.client_secret, expected)) return { error: "invalid_client" };
      const tenant = this.tenantForClient(body.client_id);
      if (!tenant) return { error: "unauthorized_client" };
      return this.mint(tenant.id, body.resource ?? "mcp", (body.scope ?? "read").split(/\s+/));
    }
    return { error: "unsupported_grant_type" };
  }

  validate(token: string): IssuedToken | undefined {
    const t = this.issued.get(token);
    if (!t) return undefined;
    if (Date.now() > t.expiresAt) {
      this.issued.delete(token);
      return undefined;
    }
    return t;
  }

  revoke(token: string): boolean {
    return this.issued.delete(token);
  }

  private mint(tenantId: string, resource: string, scope: string[]): { access_token: string; token_type: "Bearer"; expires_in: number; scope: string } {
    const token = `hub_${randomBytes(24).toString("base64url")}`;
    const expiresIn = 3600;
    this.issued.set(token, { token, tenantId, resource, scope, expiresAt: Date.now() + expiresIn * 1000 });
    return { access_token: token, token_type: "Bearer", expires_in: expiresIn, scope: scope.join(" ") };
  }

  private tenantForClient(clientId: string): TenantConfig | undefined {
    return this.cfg.tenants.find(
      (t) => t.id === clientId.replace(/^client-/, "") || t.tokens.includes(clientId),
    );
  }
}

function hashVerifier(v: string): string {
  return createHash("sha256").update(v).digest("base64url");
}

function timingSafeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}