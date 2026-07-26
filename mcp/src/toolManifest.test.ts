import { describe, it, expect } from "vitest";
import { MAINNET_GATED_TOOLS } from "./mainnetGuardrails.js";
import { buildToolCapabilityManifest, TOOL_CAPABILITIES } from "./toolManifest.js";

/** Every tool name currently registered in index.ts's ListTools handler. */
const EXPECTED_TOOL_NAMES = [
  "mindvault_setup_wallet",
  "mindvault_wallet_info",
  "mindvault_use_profile",
  "mindvault_list_profiles",
  "mindvault_browse",
  "mindvault_search",
  "mindvault_preview",
  "mindvault_register",
  "mindvault_publish",
  "mindvault_buy",
  "mindvault_register_onchain",
  "mindvault_agent_status",
  "mindvault_registry_info",
  "mindvault_network_profile",
  "mindvault_check_bindings",
  "mindvault_check_consistency",
  "mindvault_registry_lookup",
  "mindvault_tx_status",
  "mindvault_reset",
  "mindvault_backup_state",
  "mindvault_restore_state",
  "mindvault_metrics",
  "mindvault_capabilities",
];

describe("TOOL_CAPABILITIES", () => {
  it("covers every registered tool exactly once, with no unknown entries", () => {
    const names = TOOL_CAPABILITIES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("every entry has the required fields with the right shape", () => {
    for (const tool of TOOL_CAPABILITIES) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.startsWith("mindvault_")).toBe(true);
      expect(typeof tool.requiresWallet).toBe("boolean");
      expect(typeof tool.requiresApiKey).toBe("boolean");
      expect(Array.isArray(tool.network)).toBe(true);
      expect(["none", "x402-fixed-fee", "x402-resource-price"]).toContain(tool.payment);
      expect(typeof tool.mutating).toBe("boolean");
      expect(typeof tool.mainnetGated).toBe("boolean");
    }
  });

  it("derives mainnetGated from the same source mainnetGuardrails uses to enforce it", () => {
    const gated = new Set(MAINNET_GATED_TOOLS as readonly string[]);
    for (const tool of TOOL_CAPABILITIES) {
      expect(tool.mainnetGated).toBe(gated.has(tool.name));
    }
  });

  it("every tool requiring an API key also requires a wallet (a resource's creator is its wallet)", () => {
    for (const tool of TOOL_CAPABILITIES) {
      if (tool.requiresApiKey) expect(tool.requiresWallet).toBe(true);
    }
  });

  it("every tool with an x402 payment requires a wallet to sign it", () => {
    for (const tool of TOOL_CAPABILITIES) {
      if (tool.payment !== "none") expect(tool.requiresWallet).toBe(true);
    }
  });

  it("mainnet-gated tools mutate state or spend funds", () => {
    for (const tool of TOOL_CAPABILITIES) {
      if (tool.mainnetGated) expect(tool.mutating).toBe(true);
    }
  });

  it("flags the well-known wallet/payment tools correctly", () => {
    const byName = new Map(TOOL_CAPABILITIES.map((t) => [t.name, t]));

    expect(byName.get("mindvault_publish")).toMatchObject({
      requiresWallet: true,
      requiresApiKey: true,
      payment: "x402-fixed-fee",
      mutating: true,
      mainnetGated: true,
    });

    expect(byName.get("mindvault_buy")).toMatchObject({
      requiresWallet: true,
      requiresApiKey: false,
      payment: "x402-resource-price",
      mutating: true,
      mainnetGated: true,
    });

    expect(byName.get("mindvault_browse")).toMatchObject({
      requiresWallet: false,
      requiresApiKey: false,
      payment: "none",
      mutating: false,
      mainnetGated: false,
      network: ["mindvault-api"],
    });

    expect(byName.get("mindvault_registry_lookup")).toMatchObject({
      network: ["soroban-rpc"],
      mutating: false,
    });

    expect(byName.get("mindvault_check_consistency")).toMatchObject({
      network: ["mindvault-api", "soroban-rpc"],
    });

    expect(byName.get("mindvault_reset")).toMatchObject({
      mutating: true,
      mainnetGated: true,
      network: [],
    });
  });
});

describe("buildToolCapabilityManifest", () => {
  it("returns a versioned, JSON-serializable manifest containing every tool", () => {
    const manifest = buildToolCapabilityManifest();
    expect(manifest.version).toBe(1);
    expect(manifest.tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(() => JSON.stringify(manifest)).not.toThrow();
  });

  it("returns a fresh copy each call so callers can't mutate the shared source of truth", () => {
    const first = buildToolCapabilityManifest();
    first.tools.push({
      name: "not-real",
      requiresWallet: false,
      requiresApiKey: false,
      network: [],
      payment: "none",
      mutating: false,
      mainnetGated: false,
    });
    const second = buildToolCapabilityManifest();
    expect(second.tools.map((t) => t.name)).not.toContain("not-real");
  });
});
