#!/usr/bin/env node
/**
 * MindVault MCP Server
 * Exposes vault tools to AI agents via the Model Context Protocol.
 */

import {
  checkContractBindings,
  createRegistryClient,
  Errors as RegistryErrors,
  networks as registryNetworks,
  normalizeX402Network,
  resolveStellarNetwork,
  X402_NETWORK_IDS,
  type Resource,
} from "@mindvault/registry-client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createMetricsRecorder, measureTool, metricsEnabledFromEnv } from "./metrics.js";
import { cacheStalenessNotice } from "./cacheStaleness.js";
import {
  collectStartupDiagnostics,
  formatDiagnostics,
  hasBlockingDiagnostics,
} from "./diagnostics.js";
import {
  assertMainnetMutationAllowed,
  formatMainnetDiagnostics,
  mainnetAllowedFromEnv,
} from "./mainnetGuardrails.js";
import { createMockFetch, mockEnabledFromEnv, mockRegistryLookup } from "./mock.js";
import {
  DEFAULT_PROFILE,
  isValidProfileName,
  migrateState,
  STATE_VERSION,
  type AgentWallet,
  type ProfileState,
  type WalletProfile,
} from "./profiles.js";
import { signMutatingHeaders } from "./requestSignature.js";
import { exportState, restoreState } from "./stateBackup.js";
import { safeErrorMessage, safeLog } from "./redaction.js";
import { buildToolCapabilityManifest } from "./toolManifest.js";

// ── Config ────────────────────────────────────────────────────────────────────

const STELLAR_NETWORK = resolveStellarNetwork(process.env.STELLAR_NETWORK);
const networkPreset = registryNetworks[STELLAR_NETWORK];

// Startup diagnostics: collect every configuration problem in one pass so the
// operator sees the full list (with exact variable names and expected values)
// instead of fixing them one failed launch at a time. Warnings are printed but
// non-fatal; any error stops the server. Skipped under tests and in mock mode
// so unit runs and offline local development never exit the process.
if (!process.env.VITEST && !mockEnabledFromEnv(process.env)) {
  const diagnostics = collectStartupDiagnostics(process.env);
  if (diagnostics.length > 0) console.error(formatDiagnostics(diagnostics));
  if (hasBlockingDiagnostics(diagnostics)) process.exit(1);
}

const BASE_URL = process.env.MINDVAULT_URL ?? "https://mindvault-hyr3.onrender.com";
const REGISTRY_CONTRACT_ID =
  process.env.VAULT_REGISTRY_CONTRACT_ID ?? networkPreset.defaultRegistryContractId ?? "";
const REGISTRY_NETWORK_PASSPHRASE = networkPreset.networkPassphrase;
const SPONSORED_ACCOUNT_URL =
  process.env.SPONSORED_ACCOUNT_URL ?? "https://stellar-sponsored-agent-account.onrender.com";
const HORIZON_URL = process.env.HORIZON_URL ?? networkPreset.horizonUrl;
const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL ?? networkPreset.sorobanRpcUrl;
type X402Network = (typeof X402_NETWORK_IDS)[keyof typeof X402_NETWORK_IDS];
const NETWORK: X402Network = normalizeX402Network(
  process.env.NETWORK ?? networkPreset.x402Network,
) as X402Network;

// Opt-in tool-level metrics (set MINDVAULT_METRICS=1). Disabled by default so
// there is zero bookkeeping unless an operator turns it on.
const metrics = createMetricsRecorder(metricsEnabledFromEnv(process.env));

// Contributor-friendly mock mode (set MINDVAULT_MOCK=1). When on, every HTTP
// call and the on-chain registry lookup are served from deterministic in-memory
// fixtures — no live backend, funded wallet, or network access required. All
// outbound requests go through `httpFetch`, which is the mock shim in this mode
// and the global fetch otherwise.
const MOCK = mockEnabledFromEnv(process.env);
// In real mode, defer to the global `fetch` at call time (not a captured
// reference) so a test-stubbed global is still honoured.
const httpFetch: typeof fetch = MOCK
  ? createMockFetch()
  : (input, init) => fetch(input as RequestInfo | URL, init);

// ── State persistence ─────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), ".mindvault");
const STATE_FILE = join(STATE_DIR, "state.json");

// Named wallet profiles (testnet/mainnet/publisher/buyer/…) with one active at a
// time. `agentWallet`/`agentApiKey` from earlier versions map onto the active
// profile; legacy single-wallet state is migrated on load (see profiles.ts).
let profiles: Record<string, WalletProfile> = {};
let activeProfileName: string = DEFAULT_PROFILE;

/** The active profile object, created lazily on first write. */
function activeProfile(): WalletProfile {
  return (profiles[activeProfileName] ??= {});
}

function currentWallet(): AgentWallet | null {
  return profiles[activeProfileName]?.wallet ?? null;
}

function currentApiKey(): string | null {
  return profiles[activeProfileName]?.apiKey ?? null;
}

/**
 * Test-only helpers — not part of the public tool surface.
 * Seed/clear the active profile's wallet and API key without touching the filesystem.
 */
export function _setAgentWallet(w: AgentWallet | null): void {
  if (w) activeProfile().wallet = w;
  else delete activeProfile().wallet;
}
export function _setAgentApiKey(k: string | null): void {
  if (k) activeProfile().apiKey = k;
  else delete activeProfile().apiKey;
}
/** Test-only: reset the whole profile store to a clean default. */
export function _resetProfiles(): void {
  profiles = {};
  activeProfileName = DEFAULT_PROFILE;
}

/** Apply a restored ProfileState into memory and re-persist (mode 0600). */
function applyRestoredState(state: ProfileState): void {
  profiles = state.profiles;
  activeProfileName = state.activeProfile;
  saveState();
}

/** Export encrypted state backup (passphrase-gated). No plaintext secrets in output. */
export function backupState(passphrase: string): string {
  const blob = exportState(passphrase);
  return [
    "Encrypted state backup ready. Copy the blob below to the new environment.",
    "Restore with mindvault_restore_state using the same passphrase.",
    "The blob does not contain plaintext secrets.",
    "",
    blob,
  ].join("\n");
}

/** Restore state from an encrypted backup. Integrity-checked before any write. */
export function restoreStateTool(blob: string, passphrase: string): string {
  return restoreState(blob, passphrase, applyRestoredState);
}

function loadState(): void {
  if (!existsSync(STATE_FILE)) return;
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const { state, migrated } = migrateState(JSON.parse(raw));
    profiles = state.profiles;
    activeProfileName = state.activeProfile;
    if (migrated) saveState(); // re-persist legacy state in the current format
  } catch {
    // Corrupted state — ignore and start fresh
  }
}

/** Profiles worth persisting: any with credentials, plus the active one. */
function persistableProfiles(): Record<string, WalletProfile> {
  const out: Record<string, WalletProfile> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.wallet || profile.apiKey || name === activeProfileName) out[name] = profile;
  }
  return out;
}

function saveState(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const state: ProfileState = {
      version: STATE_VERSION,
      activeProfile: activeProfileName,
      profiles: persistableProfiles(),
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("MindVault MCP: failed to persist state:", safeErrorMessage(err));
  }
}

/**
 * Clear credentials. By default only the active profile is cleared; pass
 * `all: true` to wipe every profile and delete the state file.
 */
function resetState(all: boolean): string {
  if (all) {
    profiles = {};
    activeProfileName = DEFAULT_PROFILE;
    try {
      if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    } catch (err) {
      return `All profiles cleared from memory. Warning: could not delete state file (${STATE_FILE}): ${err}`;
    }
    return `Reset complete. All profiles removed from memory and disk.\nState file: ${STATE_FILE}`;
  }

  const name = activeProfileName;
  delete profiles[name];
  saveState();
  return [
    `Profile "${name}" cleared (wallet and publisher API key removed).`,
    `Remaining profiles: ${Object.keys(profiles).length}.`,
    `State file: ${STATE_FILE}`,
  ].join("\n");
}

/** Resolve/validate a profile name argument, defaulting to the active profile. */
function resolveProfileName(name: unknown): string {
  if (name === undefined || name === null || name === "") return activeProfileName;
  if (!isValidProfileName(name)) {
    throw new Error(
      `Invalid profile name. Use 1–64 characters from letters, digits, dot, dash, or underscore.`,
    );
  }
  return name;
}

loadState();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function jsonFetch(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: any; headers: Record<string, string> }> {
  const method = (init?.method ?? "GET").toUpperCase();
  const body =
    typeof init?.body === "string" ? init.body : init?.body ? JSON.stringify(init.body) : undefined;
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  const headers = signMutatingHeaders(url, method, baseHeaders, body);

  const res = await httpFetch(url, {
    ...init,
    method,
    body: body ?? init?.body,
    headers,
  });
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text), headers: responseHeaders };
  } catch {
    return { ok: res.ok, status: res.status, data: text, headers: responseHeaders };
  }
}

function requireWallet(): AgentWallet {
  const wallet = currentWallet();
  if (!wallet) {
    throw new Error(
      `No wallet in profile "${activeProfileName}". Run mindvault_setup_wallet first.`,
    );
  }
  return wallet;
}

function requireApiKey(): string {
  const apiKey = currentApiKey();
  if (!apiKey) {
    throw new Error(
      `Not registered in profile "${activeProfileName}". Run mindvault_register first.`,
    );
  }
  return apiKey;
}

function makePaidFetch(wallet: AgentWallet) {
  const signer = createEd25519Signer(wallet.secretKey, NETWORK);
  const scheme = new ExactStellarScheme(signer);
  const client = new x402Client().register(NETWORK, scheme);
  return wrapFetchWithPayment(httpFetch, client);
}

/**
 * Account/balance states the tool can distinguish for agent-facing output:
 * - missing: account does not exist on Stellar (never funded)
 * - no-trustline: account exists but has no USDC trustline
 * - zero: USDC trustline exists with 0 balance
 * - funded: USDC trustline exists with a positive balance
 */
interface BalanceDetails {
  status: "missing" | "no-trustline" | "zero" | "funded";
  xlmBalance: string;
  xlmReserve: string;
  xlmAvailable: string;
  usdcBalance: string;
  /** Human-readable diagnostic when the account/trustline is not usable. */
  message?: string;
}

/**
 * Query Horizon for the agent wallet's XLM and USDC balances, distinguishing
 * missing account, missing trustline, and zero balance states for deterministic
 * agent-facing output.
 */
async function getBalanceDetails(publicKey: string): Promise<BalanceDetails> {
  const res = await fetch(`${HORIZON_URL}/accounts/${publicKey}`);

  // Account does not exist (never funded with XLM).
  if (res.status === 404) {
    return {
      status: "missing",
      xlmBalance: "0",
      xlmReserve: "0",
      xlmAvailable: "0",
      usdcBalance: "0",
      message: `Account ${publicKey} does not exist. Fund it with at least 1 XLM to activate.`,
    };
  }

  if (!res.ok) {
    throw new Error(`Horizon error ${res.status}: ${await res.text()}`);
  }

  const data: any = await res.json();
  const balances: any[] = data.balances ?? [];

  // Find native XLM balance.
  const xlmBalance = balances.find((b: any) => b.asset_type === "native");
  const xlm = xlmBalance?.balance ?? "0";

  // Stellar reserves 0.5 XLM base + 0.5 XLM per entry (trustlines, offers, signers, data).
  // Compute available = balance - reserve so agents know how much XLM they can spend.
  const subentryCount = data.subentry_count ?? 0;
  const baseReserve = 0.5; // Stellar base reserve per account
  const entryReserve = 0.5; // Reserve per subentry
  const reserve = baseReserve + subentryCount * entryReserve;
  const available = Math.max(0, parseFloat(xlm) - reserve);

  // Find USDC trustline.
  const usdcBalance = balances.find(
    (b: any) => b.asset_type === "credit_alphanum4" && b.asset_code === "USDC",
  );

  if (!usdcBalance) {
    return {
      status: "no-trustline",
      xlmBalance: xlm,
      xlmReserve: reserve.toFixed(1),
      xlmAvailable: available.toFixed(7),
      usdcBalance: "0",
      message: `USDC trustline not found. Add a USDC trustline to receive payments.`,
    };
  }

  const usdc = usdcBalance.balance ?? "0";
  const usdcFloat = parseFloat(usdc);

  if (usdcFloat === 0) {
    return {
      status: "zero",
      xlmBalance: xlm,
      xlmReserve: reserve.toFixed(1),
      xlmAvailable: available.toFixed(7),
      usdcBalance: usdc,
      message: `USDC balance is zero. Fund the account to use x402 payments.`,
    };
  }

  return {
    status: "funded",
    xlmBalance: xlm,
    xlmReserve: reserve.toFixed(1),
    xlmAvailable: available.toFixed(7),
    usdcBalance: usdc,
  };
}

/**
 * Legacy helper — returns USDC balance as a string, defaulting to "0" for
 * missing account or trustline. Preserved for backward compatibility with
 * insufficientFundsMessage() and other call sites. New code should use
 * getBalanceDetails() for richer diagnostics.
 */
async function getUsdcBalance(publicKey: string): Promise<string> {
  try {
    const details = await getBalanceDetails(publicKey);
    return details.usdcBalance;
  } catch {
    return "0";
  }
}

function formatResource(r: any): string {
  return `[${r.id}] ${r.title} — $${r.price} USDC\n  ${r.description ?? ""}\n  ${r.accessUrl}`;
}

interface SearchFilters {
  query: string;
  minPrice?: string;
  maxPrice?: string;
  verificationStatus?: "pending" | "verified" | "rejected" | "skipped";
  resourceType?: "file" | "link";
}

function normalizeSearchFilters(args: any): SearchFilters | null {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) return null;

  const minPrice = typeof args?.minPrice === "string" ? args.minPrice.trim() : "";
  const maxPrice = typeof args?.maxPrice === "string" ? args.maxPrice.trim() : "";
  const verificationStatus =
    args?.verificationStatus === "pending" ||
    args?.verificationStatus === "verified" ||
    args?.verificationStatus === "rejected" ||
    args?.verificationStatus === "skipped"
      ? args.verificationStatus
      : undefined;
  const resourceType =
    args?.resourceType === "file" || args?.resourceType === "link" ? args.resourceType : undefined;

  return {
    query,
    minPrice: minPrice || undefined,
    maxPrice: maxPrice || undefined,
    verificationStatus,
    resourceType,
  };
}

function describeFilters(filters: SearchFilters): string {
  const hasExtra =
    filters.minPrice || filters.maxPrice || filters.verificationStatus || filters.resourceType;
  if (!hasExtra) {
    return `"${filters.query}"`;
  }
  const parts = [`query "${filters.query}"`];
  if (filters.minPrice) parts.push(`min $${filters.minPrice}`);
  if (filters.maxPrice) parts.push(`max $${filters.maxPrice}`);
  if (filters.verificationStatus) parts.push(`status ${filters.verificationStatus}`);
  if (filters.resourceType) parts.push(`type ${filters.resourceType}`);
  return parts.join(", ");
}

/**
 * Compares the agent wallet's USDC balance against an amount it is about to
 * spend. Returns an actionable insufficient-funds message (balance, amount
 * needed, and the shortfall) when the wallet can't cover the cost, or null
 * when the balance is sufficient.
 */
async function insufficientFundsMessage(
  wallet: AgentWallet,
  amountNeeded: string | number,
  action: string,
): Promise<string | null> {
  const need = typeof amountNeeded === "number" ? amountNeeded : parseFloat(amountNeeded);
  if (!Number.isFinite(need)) return null;
  const balance = await getUsdcBalance(wallet.publicKey);
  const have = parseFloat(balance);
  if (!Number.isFinite(have) || have >= need) return null;
  const shortfall = need - have;
  return [
    `Insufficient USDC to ${action}.`,
    `Amount needed: ${need} USDC`,
    `Current balance: ${have} USDC`,
    `Shortfall: ${shortfall.toFixed(7).replace(/\.?0+$/, "")} USDC`,
    `Fund ${wallet.publicKey} with the shortfall and retry.`,
  ].join("\n");
}

export async function txStatus(txHash: string): Promise<string> {
  const hash = (txHash ?? "").trim();
  if (!hash) return "Provide a transaction hash to look up.";
  const res = await httpFetch(SOROBAN_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: { hash },
    }),
  });
  if (!res.ok) throw new Error(`Soroban RPC error: ${res.status}`);
  const data: any = await res.json();
  if (data.error) throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  const tx = data.result;
  if (tx.status === "NOT_FOUND") {
    return JSON.stringify(
      {
        status: "NOT_FOUND",
        hash,
        message:
          "Transaction not found on the configured Soroban RPC. It may be unconfirmed, on a different network, or outside the RPC's retention window.",
        oldestLedger: tx.oldestLedger,
        latestLedger: tx.latestLedger,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      status: tx.status,
      hash,
      ledger: tx.ledger,
      ledgerCloseTime: tx.createdAt ? new Date(tx.createdAt * 1000).toISOString() : null,
      applicationOrder: tx.applicationOrder,
      feeBump: tx.feeBump,
      envelopeXdr: tx.envelopeXdr,
      resultXdr: tx.resultXdr,
      resultMetaXdr: tx.resultMetaXdr,
    },
    null,
    2,
  );
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function setupWallet(profileArg?: string): Promise<string> {
  const target = resolveProfileName(profileArg);
  const res = await jsonFetch(`${SPONSORED_ACCOUNT_URL}/create`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to create wallet: ${JSON.stringify(res.data)}`);
  activeProfileName = target;
  activeProfile().wallet = { publicKey: res.data.publicKey, secretKey: res.data.secretKey };
  saveState();
  return [
    `Wallet created.`,
    `Profile: ${target}`,
    `Address: ${res.data.publicKey}`,
    `Wallet persisted to ${STATE_FILE} (mode 0600).`,
  ].join("\n");
}

export async function walletInfo(): Promise<string> {
  const wallet = requireWallet();
  const details = await getBalanceDetails(wallet.publicKey);

  const lines = [
    `Profile: ${activeProfileName}`,
    `Address: ${wallet.publicKey}`,
    `XLM Balance: ${details.xlmBalance}`,
    `XLM Reserved: ${details.xlmReserve} (base + subentries)`,
    `XLM Available: ${details.xlmAvailable}`,
    `USDC Balance: ${details.usdcBalance}`,
    `USDC Status: ${details.status}`,
    `Publisher registered: ${currentApiKey() ? "yes" : "no"}`,
  ];

  if (details.message) {
    lines.push(`Note: ${details.message}`);
  }

  return lines.join("\n");
}

/** Switch the active profile, creating it if new. */
export function useProfile(nameArg: string): string {
  if (!isValidProfileName(nameArg)) {
    throw new Error(
      `Invalid profile name. Use 1–64 characters from letters, digits, dot, dash, or underscore.`,
    );
  }
  activeProfileName = nameArg;
  const profile = activeProfile();
  saveState();
  if (profile.wallet) {
    return [
      `Active profile: ${nameArg}`,
      `Address: ${profile.wallet.publicKey}`,
      `Publisher registered: ${profile.apiKey ? "yes" : "no"}`,
    ].join("\n");
  }
  return `Active profile: ${nameArg}\nNo wallet in this profile yet. Run mindvault_setup_wallet to create one.`;
}

/** List every named profile, marking the active one. Secrets are never shown. */
export function listProfiles(): string {
  const names = Object.keys(profiles).sort();
  if (names.length === 0) {
    return `No profiles yet. Run mindvault_setup_wallet to create one (default profile: "${DEFAULT_PROFILE}").`;
  }
  const lines = names.map((name) => {
    const profile = profiles[name];
    const marker = name === activeProfileName ? "*" : " ";
    const address = profile.wallet ? profile.wallet.publicKey : "(no wallet)";
    const registered = profile.apiKey ? ", registered" : "";
    return `${marker} ${name} — ${address}${registered}`;
  });
  return [`Profiles (* = active):`, ...lines].join("\n");
}

export async function browse(): Promise<string> {
  const res = await jsonFetch(`${BASE_URL}/resources`);
  if (!res.ok) throw new Error(`Browse failed: ${JSON.stringify(res.data)}`);
  const items: any[] = res.data;
  const body =
    items.length === 0 ? "No resources listed yet." : items.map(formatResource).join("\n\n");
  // Warn when the catalog may be stale relative to the on-chain registry, based
  // on the server's cache headers. Silent when there is no cache metadata.
  const notice = cacheStalenessNotice(res.headers);
  return notice ? `${body}\n\n${notice}` : body;
}

export async function search(filtersOrQuery: string | SearchFilters): Promise<string> {
  const filters: SearchFilters =
    typeof filtersOrQuery === "string" ? { query: filtersOrQuery } : filtersOrQuery;

  if (!filters.query.trim()) return "Provide a non-empty search query.";
  const queryParams = new URLSearchParams();
  queryParams.set("search", filters.query);
  if (filters.minPrice) queryParams.set("minPrice", filters.minPrice);
  if (filters.maxPrice) queryParams.set("maxPrice", filters.maxPrice);
  if (filters.verificationStatus) queryParams.set("verificationStatus", filters.verificationStatus);
  if (filters.resourceType) queryParams.set("resourceType", filters.resourceType);

  const res = await jsonFetch(`${BASE_URL}/resources?${queryParams.toString()}`);
  if (!res.ok) throw new Error(`Search failed: ${JSON.stringify(res.data)}`);
  let items: any[] = res.data;

  // Filter client-side as well for unit tests compatibility
  const q = filters.query.trim().toLowerCase();
  items = items.filter((r) => `${r.title ?? ""} ${r.description ?? ""}`.toLowerCase().includes(q));

  if (items.length === 0) return `No resources match ${describeFilters(filters)}.`;
  return items.map(formatResource).join("\n\n");
}

export async function preview(resourceId: string): Promise<string> {
  const res = await jsonFetch(`${BASE_URL}/resources/${resourceId}/meta`);
  if (!res.ok) throw new Error(`Preview failed: ${JSON.stringify(res.data)}`);
  const r = res.data;
  return JSON.stringify(
    {
      id: r.id,
      title: r.title,
      description: r.description,
      price: `$${r.price} USDC`,
      type: r.resourceType,
      verificationStatus: r.verificationStatus,
      accessUrl: r.accessUrl,
    },
    null,
    2,
  );
}

async function register(name: string, email: string, walletAddress?: string): Promise<string> {
  const wallet = requireWallet();
  const res = await jsonFetch(`${BASE_URL}/publishers`, {
    method: "POST",
    body: JSON.stringify({ name, email, walletAddress: walletAddress ?? wallet.publicKey }),
  });
  if (!res.ok) throw new Error(`Register failed: ${JSON.stringify(res.data)}`);
  activeProfile().apiKey = res.data.apiKey;
  saveState();
  return `Registered as publisher.\nProfile: ${activeProfileName}\nID: ${res.data.id}\nAPI key persisted to ${STATE_FILE} (not shown). Run mindvault_reset to revoke.`;
}

async function publish(args: {
  title: string;
  description?: string;
  price: string;
  externalUrl: string;
}): Promise<string> {
  const wallet = requireWallet();
  const apiKey = requireApiKey();

  // Step 1: Create the resource record
  const createRes = await jsonFetch(`${BASE_URL}/resources`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: JSON.stringify({
      title: args.title,
      description: args.description,
      price: args.price,
      externalUrl: args.externalUrl,
    }),
  });
  if (!createRes.ok) throw new Error(`Publish failed: ${JSON.stringify(createRes.data)}`);
  const resource = createRes.data;

  // Step 2: Agent wallet signs the x402 payment for verification. Check funds
  // first so a shortfall returns an actionable message rather than a created-
  // but-unverifiable resource with an opaque payment error.
  const statusRes = await jsonFetch(`${BASE_URL}/agent/status`);
  const verificationPrice = statusRes.ok ? statusRes.data?.agent?.pricePerVerification : null;
  if (verificationPrice != null) {
    const shortMsg = await insufficientFundsMessage(
      wallet,
      verificationPrice,
      "pay the content verification fee",
    );
    if (shortMsg) {
      return `${shortMsg}\n(Resource created with id ${resource.id}; verify it later once funded.)`;
    }
  }

  const paidFetch = makePaidFetch(wallet);

  const verifyRes = await paidFetch(`${BASE_URL}/verify-content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `Title: ${args.title}\nDescription: ${args.description ?? ""}\nURL: ${args.externalUrl}`,
      resourceId: resource.id,
    }),
  });
  metrics.recordPayment(verifyRes.ok);

  const verifyData = await verifyRes.json().catch(() => null);

  if (!verifyRes.ok) {
    return (
      `Resource created (id: ${resource.id}) but verification payment failed.\n` +
      `Status: ${verifyRes.status}\n${JSON.stringify(verifyData)}`
    );
  }

  const isOriginal: boolean = verifyData?.isOriginal ?? false;
  const flags: string[] = verifyData?.flags ?? [];

  if (!isOriginal) {
    return [
      `Resource created but rejected by verification.`,
      `ID: ${resource.id}`,
      `Verification: rejected ✗`,
      flags.length ? `Flags: ${flags.join("; ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Step 3: Trigger on-chain registration (best-effort — failure doesn't block listing)
  const registerRes = await jsonFetch(`${BASE_URL}/resources/${resource.id}/register`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
  });

  const onchainStatus: string = registerRes.ok
    ? (registerRes.data.onchainStatus ?? "registered")
    : "failed";
  const onchainTxHash: string | null = registerRes.ok
    ? (registerRes.data.onchainTxHash ?? null)
    : ((registerRes.data?.txHash as string | undefined) ?? null);

  // On failure the server returns actionable guidance (next steps, the retry
  // endpoint, and a tx-status link when a hash exists). Surface it verbatim so
  // the agent knows exactly how to recover instead of getting an opaque error.
  const failureGuidance: string[] = [];
  if (!registerRes.ok) {
    const data = registerRes.data ?? {};
    const retryEndpoint =
      typeof data.retryEndpoint === "string"
        ? data.retryEndpoint
        : `POST ${BASE_URL}/resources/${resource.id}/register`;
    failureGuidance.push(
      `Registration failed — the resource is still listed and purchasable.`,
      typeof data.message === "string" ? data.message : `Detail: ${data.detail ?? "unknown error"}`,
      `Retry endpoint: ${retryEndpoint} (send your x-api-key; no body re-runs server-side registration).`,
    );
    if (typeof data.txStatusUrl === "string") {
      failureGuidance.push(`Transaction status: ${data.txStatusUrl}`);
    } else if (onchainTxHash) {
      failureGuidance.push(`Check transaction ${onchainTxHash} with mindvault_tx_status.`);
    }
    if (Array.isArray(data.nextSteps)) {
      failureGuidance.push("Next steps:", ...data.nextSteps.map((s: string) => `  - ${s}`));
    }
  }

  const summary = {
    before: {
      id: null,
      title: null,
      price: null,
      accessUrl: null,
      verificationStatus: null,
      onchainStatus: null,
    },
    after: {
      id: resource.id,
      title: resource.title,
      price: resource.price,
      accessUrl: resource.accessUrl,
      verificationStatus: "approved",
      onchainStatus,
    },
    changedFields: ["id", "title", "price", "accessUrl", "verificationStatus", "onchainStatus"],
    txHash: onchainTxHash,
    failureGuidance: failureGuidance.length > 0 ? failureGuidance : null,
  };

  return JSON.stringify(summary, null, 2);
}

export async function buy(resourceId: string): Promise<string> {
  const wallet = requireWallet();

  // Check the wallet can cover the price before attempting payment so a
  // shortfall returns an actionable message instead of an opaque payment error.
  const meta = await jsonFetch(`${BASE_URL}/resources/${resourceId}/meta`);
  if (meta.ok && meta.data?.price != null) {
    const shortMsg = await insufficientFundsMessage(
      wallet,
      meta.data.price,
      `buy "${meta.data.title ?? resourceId}"`,
    );
    if (shortMsg) return shortMsg;
  }

  const beforeState = meta.ok
    ? {
        id: meta.data.id,
        title: meta.data.title,
        price: meta.data.price,
        accessUrl: meta.data.accessUrl,
        purchased: false,
      }
    : null;

  const paidFetch = makePaidFetch(wallet);
  const res = await paidFetch(`${BASE_URL}/resources/${resourceId}`);
  metrics.recordPayment(res.ok);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Buy failed [${res.status}]: ${text}`);
  }
  const afterData = await res.json();

  const summary = {
    before: beforeState,
    after: {
      ...afterData,
      purchased: true,
    },
    changedFields: beforeState ? ["purchased"] : ["id", "title", "price", "accessUrl", "purchased"],
    txHash: afterData.txHash || null,
  };

  return JSON.stringify(summary, null, 2);
}

/**
 * Register a verified resource on the vault registry contract.
 *
 * mindvault_publish triggers on-chain registration automatically, but the chain
 * call can fail (RPC outage, unfunded fees) while the resource stays listed and
 * purchasable. This tool is the advertised retry path: it prepares the unsigned
 * register transaction (owner-only), signs it with the agent wallet — which is
 * the resource creator for agent-published resources — and submits it.
 */
export async function registerOnchain(resourceId: string): Promise<string> {
  const wallet = requireWallet();
  const apiKey = requireApiKey();
  if (!resourceId) throw new Error("resourceId is required.");

  // Step 1: prepare the unsigned register transaction (owner-only).
  const prep = await jsonFetch(`${BASE_URL}/resources/${resourceId}/register/prepare`, {
    headers: { "x-api-key": apiKey },
  });
  if (!prep.ok) {
    const detail =
      prep.data && typeof prep.data === "object"
        ? (prep.data.error ?? JSON.stringify(prep.data))
        : prep.data;
    // Surface the server's actionable reasons (not verified / already registered).
    throw new Error(
      [
        `Could not prepare on-chain registration for "${resourceId}" [${prep.status}].`,
        `Reason: ${detail}`,
        prep.status === 400 ? "The resource must be verified before it can be registered." : null,
        prep.status === 409
          ? "The resource is already registered on-chain — no action needed."
          : null,
        prep.status === 403 ? "This resource is owned by a different publisher." : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const { unsignedXdr, networkPassphrase } = prep.data ?? {};
  if (!unsignedXdr) {
    throw new Error(
      `register/prepare did not return an unsigned transaction: ${JSON.stringify(prep.data)}`,
    );
  }

  // Step 2: sign with the agent wallet (the resource creator).
  const { Keypair, Transaction } = await import("@stellar/stellar-sdk");
  const passphrase = networkPassphrase ?? REGISTRY_NETWORK_PASSPHRASE;
  const tx = new Transaction(unsignedXdr, passphrase);
  tx.sign(Keypair.fromSecret(wallet.secretKey));
  const signedXdr = tx.toXDR();

  // Step 3: submit the signed transaction.
  const submit = await jsonFetch(`${BASE_URL}/resources/${resourceId}/register`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: JSON.stringify({ signedXdr }),
  });
  if (!submit.ok) {
    const detail =
      submit.data && typeof submit.data === "object"
        ? (submit.data.detail ?? submit.data.error ?? JSON.stringify(submit.data))
        : submit.data;
    const txHash = submit.data && typeof submit.data === "object" ? submit.data.txHash : undefined;
    throw new Error(
      [
        `On-chain registration failed for "${resourceId}" [${submit.status}].`,
        `Reason: ${detail}`,
        txHash ? `Tx hash: ${txHash} (check with mindvault_tx_status)` : null,
        "The resource remains listed and purchasable. Ensure the agent wallet is funded for fees and retry.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const summary = {
    before: {
      id: resourceId,
      onchainStatus: null,
      txHash: null,
    },
    after: {
      id: resourceId,
      onchainStatus: submit.data.onchainStatus ?? "registered",
      txHash: submit.data.txHash ?? null,
    },
    changedFields: ["onchainStatus", "txHash"],
    txHash: submit.data.txHash ?? null,
  };

  return JSON.stringify(summary, null, 2);
}

async function agentStatus(): Promise<string> {
  const res = await jsonFetch(`${BASE_URL}/agent/status`);
  if (!res.ok) throw new Error(`Agent status failed: ${JSON.stringify(res.data)}`);
  return JSON.stringify(res.data, null, 2);
}

function stroopsToUsdc(stroops: bigint): string {
  const STROOPS_PER_USDC = 10_000_000n;
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_USDC;
  const frac = abs % STROOPS_PER_USDC;
  return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(7, "0")}`;
}

async function registryLookup(resourceId: string): Promise<string> {
  if (MOCK) return mockRegistryLookup(resourceId, REGISTRY_CONTRACT_ID);
  const client = createRegistryClient({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
  });

  let tx: Awaited<ReturnType<typeof client.get>>;
  try {
    tx = await client.get({ id: resourceId });
  } catch (err: any) {
    throw new Error(
      [
        `On-chain lookup failed for resource "${resourceId}".`,
        `Contract: ${REGISTRY_CONTRACT_ID}`,
        `Network: ${REGISTRY_NETWORK_PASSPHRASE}`,
        `RPC: ${SOROBAN_RPC_URL}`,
        `Details: ${err.message}`,
      ].join("\n"),
    );
  }

  const result = tx.result;
  if (result.isErr()) {
    const err = result.unwrapErr();
    if (err.message === RegistryErrors[2].message) {
      return JSON.stringify(
        {
          source: "on-chain",
          found: false,
          resourceId,
          message: `Resource "${resourceId}" is not registered on-chain. It may not have been listed yet or the ID may be incorrect.`,
          contract: REGISTRY_CONTRACT_ID,
          network: REGISTRY_NETWORK_PASSPHRASE,
          rpc: SOROBAN_RPC_URL,
        },
        null,
        2,
      );
    }
    throw new Error(
      [
        `Contract error for resource "${resourceId}": ${err.message}`,
        `Contract: ${REGISTRY_CONTRACT_ID}`,
        `Network: ${REGISTRY_NETWORK_PASSPHRASE}`,
      ].join("\n"),
    );
  }

  const resource = result.unwrap();
  const priceUsdc = stroopsToUsdc(BigInt(resource.price as unknown as bigint));

  return JSON.stringify(
    {
      source: "on-chain",
      found: true,
      id: resource.id,
      creator: resource.creator,
      price: `${priceUsdc} USDC`,
      metadata: resource.metadata,
      listed: resource.listed,
      tags: resource.tags,
      contract: REGISTRY_CONTRACT_ID,
      network: REGISTRY_NETWORK_PASSPHRASE,
      rpc: SOROBAN_RPC_URL,
    },
    null,
    2,
  );
}

function registryInfo(): string {
  const info: {
    contractId: string;
    networkPassphrase: string;
    rpcUrl: string;
    network: string;
    x402Network: string;
    resourceFields: (keyof Resource)[];
    mainnetDiagnostics: string;
  } = {
    contractId: REGISTRY_CONTRACT_ID,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    rpcUrl: SOROBAN_RPC_URL,
    network: STELLAR_NETWORK,
    x402Network: NETWORK,
    resourceFields: ["id", "creator", "price", "metadata", "listed"],
    mainnetDiagnostics: formatMainnetDiagnostics({
      stellarNetwork: STELLAR_NETWORK,
      x402Network: NETWORK,
      registryContractId: REGISTRY_CONTRACT_ID,
      allowMainnetEnv: mainnetAllowedFromEnv(),
    }),
  };
  return JSON.stringify(info, null, 2);
}

/**
 * Compare a resource from the API catalog with the same resource in the vault-registry contract.
 * Reports matching fields, mismatches, missing API records, and missing on-chain records.
 */
async function checkConsistency(resourceId: string): Promise<string> {
  if (!resourceId) throw new Error("resourceId is required.");

  // Fetch from API
  const apiRes = await jsonFetch(`${BASE_URL}/resources/${resourceId}/meta`);
  const apiData = apiRes.ok ? apiRes.data : null;

  // Fetch from on-chain registry
  let onchainData: any = null;
  let onchainError: string | null = null;
  try {
    const client = createRegistryClient({
      contractId: REGISTRY_CONTRACT_ID,
      rpcUrl: SOROBAN_RPC_URL,
      networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    });
    const tx = await client.get({ id: resourceId });
    if (tx.result.isOk()) {
      onchainData = tx.result.unwrap();
    } else {
      onchainError = tx.result.unwrapErr().message;
    }
  } catch (err: any) {
    onchainError = err.message;
  }

  // Build comparison report
  const report: {
    resourceId: string;
    apiFound: boolean;
    onchainFound: boolean;
    onchainError: string | null;
    matches: Record<string, { api: any; onchain: any }>;
    mismatches: Record<string, { api: any; onchain: any }>;
    missingInApi: string[];
    missingInOnchain: string[];
  } = {
    resourceId,
    apiFound: !!apiData,
    onchainFound: !!onchainData,
    onchainError,
    matches: {},
    mismatches: {},
    missingInApi: [],
    missingInOnchain: [],
  };

  if (!apiData && !onchainData) {
    return JSON.stringify(
      {
        ...report,
        summary: "Resource not found in API catalog or on-chain registry.",
      },
      null,
      2,
    );
  }

  if (!apiData) {
    report.missingInApi = ["id", "title", "price", "metadata", "listed"];
    return JSON.stringify(
      {
        ...report,
        summary: "Resource exists on-chain but not in API catalog.",
      },
      null,
      2,
    );
  }

  if (!onchainData) {
    report.missingInOnchain = ["id", "creator", "price", "metadata", "listed"];
    return JSON.stringify(
      {
        ...report,
        summary: "Resource exists in API catalog but not on-chain registry.",
      },
      null,
      2,
    );
  }

  // Compare fields
  const priceUsdc = stroopsToUsdc(BigInt(onchainData.price as unknown as bigint));

  // Compare price (API uses USDC string, on-chain uses stroops)
  const apiPrice = parseFloat(apiData.price || "0");
  const onchainPrice = parseFloat(priceUsdc);
  if (Math.abs(apiPrice - onchainPrice) < 0.0000001) {
    report.matches.price = { api: apiData.price, onchain: priceUsdc };
  } else {
    report.mismatches.price = { api: apiData.price, onchain: priceUsdc };
  }

  // Compare listed status
  if (apiData.verificationStatus === "verified" && onchainData.listed === true) {
    report.matches.listed = { api: "verified", onchain: true };
  } else if (apiData.verificationStatus !== "verified" && onchainData.listed === false) {
    report.matches.listed = { api: apiData.verificationStatus, onchain: false };
  } else {
    report.mismatches.listed = { api: apiData.verificationStatus, onchain: onchainData.listed };
  }

  // Compare metadata
  if (apiData.accessUrl === onchainData.metadata) {
    report.matches.metadata = { api: apiData.accessUrl, onchain: onchainData.metadata };
  } else {
    report.mismatches.metadata = { api: apiData.accessUrl, onchain: onchainData.metadata };
  }

  // ID should always match
  report.matches.id = { api: apiData.id, onchain: onchainData.id };

  const summary =
    Object.keys(report.mismatches).length === 0
      ? "All compared fields match between API and on-chain registry."
      : `Found ${Object.keys(report.mismatches).length} mismatched field(s).`;

  return JSON.stringify({ ...report, summary }, null, 2);
}

/**
 * Report the current Stellar and x402 network configuration in use by this MCP
 * instance. Includes testnet/mainnet selection, RPC/Horizon URLs, registry and
 * USDC contract IDs, and warnings for environment variable overrides that
 * diverge from presets.
 */
export function networkProfile(): string {
  const warnings: string[] = [];

  // Detect custom overrides that differ from the preset
  const usdcContractId = process.env.USDC_CONTRACT_ID ?? networkPreset.usdcSacContractId;
  if (
    process.env.USDC_CONTRACT_ID &&
    process.env.USDC_CONTRACT_ID !== networkPreset.usdcSacContractId
  ) {
    warnings.push(
      `USDC_CONTRACT_ID overrides preset (${networkPreset.usdcSacContractId} → ${process.env.USDC_CONTRACT_ID})`,
    );
  }
  if (process.env.SOROBAN_RPC_URL && process.env.SOROBAN_RPC_URL !== networkPreset.sorobanRpcUrl) {
    warnings.push(
      `SOROBAN_RPC_URL overrides preset (${networkPreset.sorobanRpcUrl} → ${process.env.SOROBAN_RPC_URL})`,
    );
  }
  if (process.env.HORIZON_URL && process.env.HORIZON_URL !== networkPreset.horizonUrl) {
    warnings.push(
      `HORIZON_URL overrides preset (${networkPreset.horizonUrl} → ${process.env.HORIZON_URL})`,
    );
  }
  if (
    process.env.VAULT_REGISTRY_CONTRACT_ID &&
    networkPreset.defaultRegistryContractId &&
    process.env.VAULT_REGISTRY_CONTRACT_ID !== networkPreset.defaultRegistryContractId
  ) {
    warnings.push(
      `VAULT_REGISTRY_CONTRACT_ID overrides preset (${networkPreset.defaultRegistryContractId} → ${process.env.VAULT_REGISTRY_CONTRACT_ID})`,
    );
  }
  if (process.env.NETWORK && process.env.NETWORK !== networkPreset.x402Network) {
    warnings.push(
      `NETWORK overrides preset (${networkPreset.x402Network} → ${process.env.NETWORK})`,
    );
  }

  const profile = {
    stellarNetwork: STELLAR_NETWORK,
    x402Network: NETWORK,
    sorobanRpcUrl: SOROBAN_RPC_URL,
    horizonUrl: HORIZON_URL,
    registryContractId: REGISTRY_CONTRACT_ID,
    usdcContractId,
    warnings,
  };

  return JSON.stringify(profile, null, 2);
}

/**
 * Verify the installed registry-client bindings match the deployed contract's
 * interface. Returns the check's deterministic, agent-safe message (a match
 * summary, a mismatch warning with a recommended fix, or a "could not verify"
 * note when the contract/RPC is unreachable).
 */
async function checkBindings(): Promise<string> {
  if (MOCK) return "Mock mode: contract binding check skipped (no live RPC).";
  const result = await checkContractBindings({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    network: STELLAR_NETWORK,
  });
  return result.message;
}

/**
 * Return the machine-readable tool capability manifest as JSON: for every tool,
 * whether it requires a wallet or publisher API key, which network(s) it talks
 * to, its x402 payment behavior, and whether it mutates state / spends funds
 * (and is therefore mainnet-gated). Pure and deterministic — no I/O.
 */
export function capabilities(): string {
  return JSON.stringify(buildToolCapabilityManifest(), null, 2);
}

/**
 * Return the current metrics snapshot as JSON. Only counts, durations, and tool
 * names are included — never arguments, wallets, or API keys. When metrics are
 * disabled, returns an actionable note instead of counters. Pass reset=true to
 * clear counters after reading.
 */
function toolMetrics(reset: boolean): string {
  const snapshot = metrics.snapshot();
  if (reset) metrics.reset();
  if (!snapshot.enabled) {
    return JSON.stringify(
      {
        enabled: false,
        message:
          "Metrics are disabled. Set MINDVAULT_METRICS=1 (or true/yes/on) and restart the server to collect tool-level metrics.",
      },
      null,
      2,
    );
  }
  return JSON.stringify(snapshot, null, 2);
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server({ name: "mindvault", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "mindvault_setup_wallet",
      description:
        "Create a Stellar wallet using the sponsored account protocol. Optionally pass a profile name to create the wallet under a named profile (e.g. testnet, mainnet, publisher, buyer) and make it active; defaults to the active profile. The wallet (public key + secret key) is persisted to ~/.mindvault/state.json (mode 0600) and reloaded automatically on restart.",
      inputSchema: {
        type: "object",
        properties: {
          profile: {
            type: "string",
            description:
              "Optional profile name to create/switch to. Use letters, digits, dot, dash, or underscore (1–64 chars). Examples: 'testnet', 'mainnet-publisher', 'buyer.alice'",
            examples: ["testnet", "mainnet-publisher", "buyer.alice"],
          },
          confirmMainnet: {
            type: "boolean",
            description:
              "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
          },
        },
        required: [],
      },
    },
    {
      name: "mindvault_wallet_info",
      description:
        "Check the active profile name, its agent wallet address, USDC balance, and whether it is registered as a publisher.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_use_profile",
      description:
        "Switch the active wallet profile, creating it if it does not exist. Profiles let one agent keep separate identities (e.g. testnet vs mainnet, publisher vs buyer); each has its own wallet and publisher API key. Subsequent tools operate on the active profile.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Profile name to make active. Use letters, digits, dot, dash, or underscore (1–64 chars). Examples: 'mainnet', 'testnet-buyer', 'publisher.bob'",
            examples: ["mainnet", "testnet-buyer", "publisher.bob"],
          },
        },
        required: ["name"],
      },
    },
    {
      name: "mindvault_list_profiles",
      description:
        "List all named wallet profiles, marking the active one and showing each profile's wallet address and whether it is registered as a publisher. Secret keys are never shown.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_browse",
      description: "List all available resources in the MindVault catalog.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_search",
      description:
        "Search the MindVault catalog by keyword and optional filters for price, resource type, and verification status. Uses server-side filtering and returns compact resource summaries.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keyword(s) to match against resource title or description. Examples: 'Stellar tutorial', 'Soroban smart contracts', 'DeFi guide'",
            examples: ["Stellar tutorial", "Soroban smart contracts", "DeFi guide"],
          },
          minPrice: {
            type: "string",
            description:
              "Minimum USDC price to include (decimal string). Example: '5.00' includes resources priced 5 USDC and above.",
            examples: ["5.00", "10.50", "0.50"],
          },
          maxPrice: {
            type: "string",
            description:
              "Maximum USDC price to include (decimal string). Example: '20.00' excludes resources priced above 20 USDC.",
            examples: ["20.00", "15.99", "100.00"],
          },
          verificationStatus: {
            type: "string",
            enum: ["pending", "verified", "rejected", "skipped"],
            description:
              "Filter by verification status. 'verified' = passed AI originality check, 'pending' = awaiting verification, 'rejected' = failed check, 'skipped' = verification skipped.",
            examples: ["verified"],
          },
          resourceType: {
            type: "string",
            enum: ["file", "link"],
            description:
              "Filter by resource type. 'file' = downloadable file (PDF, ebook, etc.), 'link' = external URL to web content.",
            examples: ["link", "file"],
          },
        },
        required: ["query"],
      },
    },
    {
      name: "mindvault_preview",
      description:
        "Get details and price for a specific resource before purchasing. Returns title, description, price, type, verification status, and access URL.",
      inputSchema: {
        type: "object",
        properties: {
          resourceId: {
            type: "string",
            description:
              "The unique resource identifier from mindvault_browse or mindvault_search. Example: 'cm7x8y9z'",
            examples: ["cm7x8y9z", "res-001", "ckx9j2h3f"],
          },
        },
        required: ["resourceId"],
      },
    },
    {
      name: "mindvault_register",
      description:
        "Register as a publisher using the agent wallet. The API key is persisted to ~/.mindvault/state.json (mode 0600, key not shown in output) and reloaded on restart so mindvault_publish works across sessions.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          walletAddress: { type: "string" },
          confirmMainnet: {
            type: "boolean",
            description:
              "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
          },
        },
        required: ["name", "email"],
      },
    },
    {
      name: "mindvault_publish",
      description:
        "Publish a link resource to the MindVault catalog. The resource undergoes AI verification (agent wallet pays ~$0.10 USDC via x402) and is automatically registered on-chain if verified. Returns resource ID, access URL, verification result, and on-chain registration status.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          price: { type: "string" },
          externalUrl: { type: "string" },
          confirmMainnet: {
            type: "boolean",
            description:
              "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
          },
        },
        required: ["title", "price", "externalUrl"],
      },
    },
    {
      name: "mindvault_buy",
      description:
        "Pay USDC via x402 and access a resource. On mainnet, pass confirmMainnet: true (or set MINDVAULT_ALLOW_MAINNET=1).",
      inputSchema: {
        type: "object",
        properties: {
          resourceId: { type: "string" },
          confirmMainnet: {
            type: "boolean",
            description:
              "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
          },
        },
        required: ["resourceId"],
      },
    },
    {
      name: "mindvault_register_onchain",
      description:
        "Register an already-published, verified resource on the vault registry contract. Use this to retry on-chain registration after mindvault_publish reports the on-chain step failed. Prepares the unsigned transaction, signs it with the agent wallet (which must be the resource creator), submits it, and returns the registry status and on-chain tx hash.",
      inputSchema: {
        type: "object",
        properties: {
          resourceId: {
            type: "string",
            description:
              "The resource ID to register on-chain (from mindvault_publish output). Must be verified and not already registered. Example: 'cm7x8y9z'",
            examples: ["cm7x8y9z", "res-001", "ckx9j2h3f"],
          },
          confirmMainnet: {
            type: "boolean",
            description:
              "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
          },
        },
        required: ["resourceId"],
      },
    },
    {
      name: "mindvault_agent_status",
      description:
        "Check the verification agent's earnings and activity. Returns total verifications, pass/fail counts, total USDC earned, average confidence score, and recent verification history with resource titles.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_registry_info",
      description:
        "Return the on-chain vault-registry contract ID, network passphrase, RPC URL, and the resource fields available for direct Soroban queries. Use this to verify ownership, price, and listing state directly from Stellar without trusting the MindVault API.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_network_profile",
      description:
        "Report current Stellar/x402 network configuration (testnet/mainnet), RPC URLs, registry contract ID, and warnings for custom overrides. Use this to verify which network the MCP is connected to and diagnose configuration issues.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_check_bindings",
      description:
        "Verify the installed registry-client bindings match the deployed vault-registry contract interface. Reports a match, or a warning listing the drifting methods with the contract ID, network, client version, and a recommended fix (redeploy the contract or regenerate bindings). Useful after a contract redeploy or client upgrade.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_check_consistency",
      description:
        "Compare a resource from the API catalog with the same resource in the vault-registry contract. Reports matching fields, mismatches, missing API records, and missing on-chain records. Useful for detecting synchronization issues between the API and on-chain registry.",
      inputSchema: {
        type: "object",
        properties: {
          resourceId: {
            type: "string",
            description: "The resource ID to compare between API and on-chain registry.",
          },
        },
        required: ["resourceId"],
      },
    },
    {
      name: "mindvault_registry_lookup",
      description:
        "Look up a resource directly from the on-chain vault registry by its ID. Returns creator wallet address, price (USDC), metadata (title/description), listed state, tags, contract ID, and network. Data comes from Stellar/Soroban, not the MindVault API. Returns an actionable message when the resource is not registered on-chain.",
      inputSchema: {
        type: "object",
        properties: {
          resourceId: {
            type: "string",
            description:
              "The resource ID to look up on-chain. Must be a registered resource. Example: 'cm7x8y9z'",
            examples: ["cm7x8y9z", "res-001", "ckx9j2h3f"],
          },
        },
        required: ["resourceId"],
      },
    },
    {
      name: "mindvault_tx_status",
      description:
        "Look up the status of a Stellar transaction by hash via Soroban RPC. Returns SUCCESS, FAILED, or NOT_FOUND along with ledger number, close time, application order, and XDR envelopes. Useful for debugging on-chain registration failures.",
      inputSchema: {
        type: "object",
        properties: {
          txHash: {
            type: "string",
            description:
              "The 64-character hex transaction hash from Stellar. Example: 'abc123def456...' (from mindvault_register_onchain or mindvault_publish output).",
            examples: [
              "abc123def456789012345678901234567890123456789012345678901234",
              "f47ac10b58cc4372a5670e02b2c3d479c3e5d0a1b2c3d4e5f6a7b8c9d0e1f2a3",
            ],
          },
        },
        required: ["txHash"],
      },
    },
    {
      name: "mindvault_reset",
      description:
        "Clear credentials from memory and disk (~/.mindvault/state.json). By default only the active profile is cleared; pass all=true to remove every profile and delete the state file. After reset, run mindvault_setup_wallet and mindvault_register again.",
      inputSchema: {
        type: "object",
        properties: {
          all: {
            type: "boolean",
            description:
              "Clear every profile and delete the state file (default: false clears active profile only). Example: true removes all profiles.",
            examples: [true, false],
          },
          confirmMainnet: {
            type: "boolean",
            description:
              "Required on mainnet (or set MINDVAULT_ALLOW_MAINNET=1). Explicitly confirm this mutation/payment on the public Stellar network.",
          },
        },
        required: [],
      },
    },
    {
      name: "mindvault_backup_state",
      description:
        "Export an encrypted backup of ~/.mindvault/state.json for moving agent environments. Requires a passphrase (min 8 chars). Output is a self-contained ciphertext blob — wallet secret keys and API keys never appear in plaintext. Restore with mindvault_restore_state using the same passphrase. Does not change reset behavior.",
      inputSchema: {
        type: "object",
        properties: {
          passphrase: {
            type: "string",
            description:
              "Passphrase used to encrypt the backup (min 8 characters). Keep it offline.",
          },
        },
        required: ["passphrase"],
      },
    },
    {
      name: "mindvault_restore_state",
      description:
        "Restore ~/.mindvault/state.json from an encrypted backup produced by mindvault_backup_state. Validates integrity (wrong passphrase or tampered data fails before any write). Replaces in-memory profiles and re-persists to disk (mode 0600). Existing reset behavior is unchanged.",
      inputSchema: {
        type: "object",
        properties: {
          blob: {
            type: "string",
            description: "Encrypted backup blob from mindvault_backup_state (v1:… format).",
          },
          passphrase: {
            type: "string",
            description: "Passphrase used when the backup was created (min 8 characters).",
          },
        },
        required: ["blob", "passphrase"],
      },
    },
    {
      name: "mindvault_metrics",
      description:
        "Return opt-in tool-level metrics: per-tool call/error counts and durations, plus payment attempt/failure totals. Enable by setting MINDVAULT_METRICS=1 on the server. Output contains only tool names, counts, and durations — never arguments, wallets, or API keys. Pass reset=true to clear counters after reading.",
      inputSchema: {
        type: "object",
        properties: {
          reset: {
            type: "boolean",
            description:
              "Clear all counters after returning the current snapshot (default: false leaves counters intact). Example: true resets metrics after reading.",
            examples: [true, false],
          },
        },
        required: [],
      },
    },
    {
      name: "mindvault_capabilities",
      description:
        "Return a machine-readable capability manifest for every MindVault MCP tool: whether it requires a wallet or publisher API key, which network(s) it talks to (MindVault API, Stellar Horizon, Soroban RPC, sponsored-account service), its x402 payment behavior, and whether it mutates state or spends funds (and is therefore gated on mainnet). Use this to plan a call sequence without inferring requirements from tool descriptions.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
}));

async function dispatchTool(name: string, args: any): Promise<string> {
  assertMainnetMutationAllowed(STELLAR_NETWORK, name, args ?? {});
  switch (name) {
    case "mindvault_setup_wallet":
      return setupWallet(args.profile as string | undefined);
    case "mindvault_wallet_info":
      return walletInfo();
    case "mindvault_use_profile":
      return useProfile(args.name as string);
    case "mindvault_list_profiles":
      return listProfiles();
    case "mindvault_browse":
      return browse();
    case "mindvault_search": {
      const filters = normalizeSearchFilters(args);
      return filters ? search(filters) : "Provide a non-empty search query.";
    }
    case "mindvault_preview":
      return preview(args.resourceId as string);
    case "mindvault_register":
      return register(
        args.name as string,
        args.email as string,
        args.walletAddress as string | undefined,
      );
    case "mindvault_publish":
      return publish({
        title: args.title as string,
        description: args.description as string | undefined,
        price: args.price as string,
        externalUrl: args.externalUrl as string,
      });
    case "mindvault_buy":
      return buy(args.resourceId as string);
    case "mindvault_register_onchain":
      return registerOnchain(args.resourceId as string);
    case "mindvault_agent_status":
      return agentStatus();
    case "mindvault_registry_info":
      return registryInfo();
    case "mindvault_network_profile":
      return networkProfile();
    case "mindvault_check_bindings":
      return checkBindings();
    case "mindvault_check_consistency":
      return checkConsistency(args.resourceId as string);
    case "mindvault_registry_lookup":
      return registryLookup(args.resourceId as string);
    case "mindvault_tx_status":
      return txStatus(args.txHash as string);
    case "mindvault_reset":
      return resetState(args.all === true);
    case "mindvault_backup_state":
      return backupState(args.passphrase as string);
    case "mindvault_restore_state":
      return restoreStateTool(args.blob as string, args.passphrase as string);
    case "mindvault_metrics":
      return toolMetrics(args.reset === true);
    case "mindvault_capabilities":
      return capabilities();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    assertMainnetMutationAllowed(STELLAR_NETWORK, name, args as Record<string, unknown>);
    const result = await measureTool(metrics, name, () => dispatchTool(name, args));
    return { content: [{ type: "text", text: result }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${safeErrorMessage(err)}` }], isError: true };
  }
});

// Best-effort startup check: warn on stderr (never fatal, never blocks) when the
// installed bindings drift from the deployed contract. Skipped under tests and
// mock mode so it never makes a real network call. Errors (e.g. offline) are
// swallowed — the mindvault_check_bindings tool gives operators a detailed report.
if (!process.env.VITEST && !MOCK) {
  void checkContractBindings({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    network: STELLAR_NETWORK,
  })
    .then((result: { status: string; message: string }) => {
      if (result.status === "mismatch") console.error(`MindVault MCP: ${result.message}`);
    })
    .catch(() => {
      /* offline or unreachable — the mindvault_check_bindings tool can report details */
    });
}

const transport = new StdioServerTransport();
await server.connect(transport);
