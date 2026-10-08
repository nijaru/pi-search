import { open } from "node:fs/promises";
import type { ModelExecution } from "./model-selection";
import { hasExplicitHeader, modelAuthHeaders } from "./model-selection";
import { createProviderError } from "./errors";
import { readBoundedResponseText } from "./http";
import type { SearchHttpFetch } from "./provider-http";

export const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";
const MAX_IDENTITY_BYTES = 16 * 1024;

async function identityToken(path: string, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(MAX_IDENTITY_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			signal.throwIfAborted();
			const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
			if (bytesRead === 0) break;
			size += bytesRead;
		}
		const token = buffer.subarray(0, size).toString("utf8").trim();
		if (size > MAX_IDENTITY_BYTES || token.length === 0) throw new Error("Invalid identity token file");
		return token;
	} finally {
		await file.close();
	}
}

/** Adapter-owned cache; auth configuration and credentials come only from Pi. */
export class AnthropicSearchAuth {
	private cached?: { key: string; token: string; expiresAt: number | null };

	constructor(private readonly fetchImpl: SearchHttpFetch) {}

	invalidate(): void {
		this.cached = undefined;
	}

	async headers(execution: ModelExecution, endpoint: string, signal: AbortSignal): Promise<Readonly<Record<string, string>>> {
		const headers = modelAuthHeaders(execution, { bearerApiKey: false });
		const sources = [execution.model.headers, execution.auth.headers];
		const apiKey = execution.auth.apiKey;
		// Pro/Max OAuth requires Pi's Claude Code request identity, not just
		// a bearer header. Do not dispatch an incomplete subscription request.
		if ((apiKey?.startsWith("sk-ant-oat") && !headers.has("authorization") && !headers.has("x-api-key"))
			|| /^Bearer\s+sk-ant-oat/i.test(headers.get("authorization") ?? "")) {
			throw createProviderError({ provider: "anthropic", kind: "unsupported", message: "Anthropic subscription search is not supported; use an API key, API bearer credential, or workload identity", retryable: false });
		}
		if (apiKey?.trim() && !hasExplicitHeader(sources, "x-api-key") && !headers.has("authorization")) {
			headers.set("x-api-key", apiKey);
		}

		if (!headers.has("x-api-key") && !headers.has("authorization")) {
			// A null authorization is an explicit deletion, not permission to
			// replace it with a separately exchanged credential.
			if (hasExplicitHeader(sources, "authorization")) throw this.missingAuth();
			const env = execution.auth.env;
			const federationRuleId = env?.ANTHROPIC_FEDERATION_RULE_ID;
			const organizationId = env?.ANTHROPIC_ORGANIZATION_ID;
			const path = env?.ANTHROPIC_IDENTITY_TOKEN_FILE;
			if (!federationRuleId || !organizationId || !path) throw this.missingAuth();
			// The SDK token endpoint is /v1/oauth/token, relative to the API root.
			const tokenBase = new URL(endpoint);
			tokenBase.pathname = tokenBase.pathname.replace(/\/(?:v1\/)?messages\/?$/, "");
			tokenBase.search = "";
			tokenBase.hash = "";
			const baseURL = tokenBase.toString().replace(/\/$/, "");
			const key = JSON.stringify([baseURL, federationRuleId, organizationId, path, env?.ANTHROPIC_SERVICE_ACCOUNT_ID, env?.ANTHROPIC_WORKSPACE_ID]);
			let cached = this.cached;
			if (cached?.key !== key || (cached.expiresAt !== null && cached.expiresAt <= Date.now() / 1_000 + 60)) {
				try {
					// Reuse the official exchange protocol without its ambient
					// credential chain, background refresh, or hidden request retries.
					const { oidcFederationProvider } = await import("@anthropic-ai/sdk/lib/credentials/oidc-federation");
					const exchange = oidcFederationProvider({
						baseURL,
						federationRuleId,
						organizationId,
						serviceAccountId: env?.ANTHROPIC_SERVICE_ACCOUNT_ID ?? undefined,
						workspaceId: env?.ANTHROPIC_WORKSPACE_ID ?? undefined,
						identityTokenProvider: () => identityToken(path, signal),
						fetch: async (input, init) => {
							const response = await this.fetchImpl(input, { ...init, signal, redirect: "error" });
							const body = await readBoundedResponseText(response, 64 * 1024, signal);
							return new Response(body, { status: response.status, headers: response.headers });
						},
					});
					const token = await exchange();
					signal.throwIfAborted();
					cached = this.cached = { key, ...token };
				} catch (error) {
					throw createProviderError({ provider: "anthropic", kind: signal.aborted ? "canceled" : "auth", message: signal.aborted ? "Search canceled" : "Anthropic workload identity token exchange failed", retryable: false, cause: error });
				}
			}
			headers.set("authorization", `Bearer ${cached.token}`);
			headers.set("anthropic-beta", [headers.get("anthropic-beta"), OAUTH_BETA].filter(Boolean).join(","));
		}
		headers.set("anthropic-version", ANTHROPIC_VERSION);
		return Object.fromEntries(headers.entries());
	}

	private missingAuth(): Error {
		return createProviderError({ provider: "anthropic", kind: "auth", fallbackSafe: true, message: "Anthropic authentication returned no API key, bearer header, or workload identity configuration", retryable: false });
	}
}
