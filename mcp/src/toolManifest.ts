/**
 * Machine-readable capability manifest for the MindVault MCP tool surface.
 *
 * MCP's standard ListTools response gives an agent a tool's name, description,
 * and input schema, but not whether calling it needs a funded wallet or a
 * publisher API key, what network(s) it talks to, whether it triggers an x402
 * payment, or whether it mutates state / spends funds on mainnet. Agents that
 * want to plan a call sequence (e.g. "do I need to run mindvault_setup_wallet
 * first?") have to infer that from prose descriptions. This module is the
 * single, explicit source of truth for that metadata; `mindvault_capabilities`
 * in index.ts serves it as JSON.
 *
 * Pure and side-effect free (no I/O) so it is deterministic and unit-testable.
 */

import { isMainnetGatedTool } from "./mainnetGuardrails.js";

/** Remote systems a tool call may reach. Empty array = local-only (no network I/O). */
export type NetworkTarget =
  | "mindvault-api"
  | "stellar-horizon"
  | "soroban-rpc"
  | "sponsored-account-service";

/**
 * x402 payment triggered by the tool:
 * - "none": no payment
 * - "x402-fixed-fee": pays the platform's fixed verification fee (mindvault_publish)
 * - "x402-resource-price": pays the resource's listed price (mindvault_buy)
 */
export type PaymentBehavior = "none" | "x402-fixed-fee" | "x402-resource-price";

export interface ToolCapability {
  name: string;
  /** Requires an active wallet in the current profile (throws otherwise). */
  requiresWallet: boolean;
  /** Requires an active publisher API key in the current profile (throws otherwise). */
  requiresApiKey: boolean;
  /** Remote systems this tool call reaches. Empty = local state only. */
  network: NetworkTarget[];
  payment: PaymentBehavior;
  /** Changes persisted local state, the MindVault catalog, or the on-chain registry. */
  mutating: boolean;
  /** Blocked on mainnet without confirmMainnet:true or MINDVAULT_ALLOW_MAINNET=1. */
  mainnetGated: boolean;
  /** Additional caveats not captured by the other fields. */
  notes?: string[];
}

export interface ToolCapabilityManifest {
  /** Bump when the shape of ToolCapability changes in a breaking way. */
  version: number;
  tools: ToolCapability[];
}

const MANIFEST_VERSION = 1;

function capability(
  name: string,
  opts: {
    requiresWallet?: boolean;
    requiresApiKey?: boolean;
    network?: NetworkTarget[];
    payment?: PaymentBehavior;
    mutating?: boolean;
    notes?: string[];
  },
): ToolCapability {
  return {
    name,
    requiresWallet: opts.requiresWallet ?? false,
    requiresApiKey: opts.requiresApiKey ?? false,
    network: opts.network ?? [],
    payment: opts.payment ?? "none",
    mutating: opts.mutating ?? false,
    mainnetGated: isMainnetGatedTool(name),
    ...(opts.notes ? { notes: opts.notes } : {}),
  };
}

/** One entry per tool registered in index.ts's ListTools handler, in the same order. */
export const TOOL_CAPABILITIES: readonly ToolCapability[] = [
  capability("mindvault_setup_wallet", {
    network: ["sponsored-account-service"],
    mutating: true,
  }),
  capability("mindvault_wallet_info", {
    requiresWallet: true,
    network: ["stellar-horizon"],
  }),
  capability("mindvault_use_profile", { mutating: true }),
  capability("mindvault_list_profiles", {}),
  capability("mindvault_browse", { network: ["mindvault-api"] }),
  capability("mindvault_search", { network: ["mindvault-api"] }),
  capability("mindvault_preview", { network: ["mindvault-api"] }),
  capability("mindvault_register", {
    requiresWallet: true,
    network: ["mindvault-api"],
    mutating: true,
  }),
  capability("mindvault_publish", {
    requiresWallet: true,
    requiresApiKey: true,
    network: ["mindvault-api"],
    payment: "x402-fixed-fee",
    mutating: true,
    notes: ["Pays the platform's content-verification fee (~$0.10 USDC) regardless of outcome."],
  }),
  capability("mindvault_buy", {
    requiresWallet: true,
    network: ["mindvault-api"],
    payment: "x402-resource-price",
    mutating: true,
  }),
  capability("mindvault_register_onchain", {
    requiresWallet: true,
    requiresApiKey: true,
    network: ["mindvault-api"],
    mutating: true,
  }),
  capability("mindvault_agent_status", { network: ["mindvault-api"] }),
  capability("mindvault_registry_info", {}),
  capability("mindvault_network_profile", {}),
  capability("mindvault_check_bindings", { network: ["soroban-rpc"] }),
  capability("mindvault_check_consistency", { network: ["mindvault-api", "soroban-rpc"] }),
  capability("mindvault_registry_lookup", { network: ["soroban-rpc"] }),
  capability("mindvault_tx_status", { network: ["soroban-rpc"] }),
  capability("mindvault_reset", { mutating: true }),
  capability("mindvault_backup_state", {
    notes: ["Reads and encrypts local state; does not change it."],
  }),
  capability("mindvault_restore_state", { mutating: true }),
  capability("mindvault_metrics", {
    notes: ["reset:true clears in-memory counters; never touches wallet or vault state."],
  }),
  capability("mindvault_capabilities", {
    notes: ["Returns this manifest."],
  }),
];

/** Build the manifest served by the mindvault_capabilities tool. */
export function buildToolCapabilityManifest(): ToolCapabilityManifest {
  return { version: MANIFEST_VERSION, tools: TOOL_CAPABILITIES.slice() };
}
