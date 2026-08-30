/**
 * Token -> USD conversion.
 *
 * Hard rule: an unknown model yields `null`, never a guess. A fabricated
 * cost is worse than a blank one - a user who spots one wrong number stops
 * trusting every number, and cost accuracy is the product's core claim.
 * Unknown models are surfaced in the dashboard as "-" with a hint to add
 * them to pricing.json.
 *
 * Prices are per million tokens, matching how vendors publish them, and live
 * in an editable ~/.agentobs/pricing.json so a price change never requires a
 * new release.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { paths } from './paths.js';

export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
  /** Optional; falls back to input price when a vendor doesn't break it out. */
  cache_read_per_mtok?: number;
  cache_write_per_mtok?: number;
}

export interface PricingTable {
  /** Free-text note carried into the generated file for the humans editing it. */
  _comment?: string;
  updated?: string;
  models: Record<string, ModelPrice>;
}

/**
 * Seed table written by `agentobs init`. Verify against current vendor
 * pricing pages before a release - these are a starting point the user is
 * expected to edit, not an authoritative source.
 */
export const DEFAULT_PRICING: PricingTable = {
  _comment:
    'Prices in USD per 1,000,000 tokens. Edit freely - AgentObs reads this file at runtime. A model missing here shows cost as blank rather than a guess.',
  updated: '2026-08-29',
  models: {
    'claude-opus-5': { input_per_mtok: 15, output_per_mtok: 75 },
    'claude-sonnet-5': { input_per_mtok: 3, output_per_mtok: 15 },
    'claude-fable-5': { input_per_mtok: 3, output_per_mtok: 15 },
    'claude-opus-4': { input_per_mtok: 15, output_per_mtok: 75 },
    'claude-sonnet-4': { input_per_mtok: 3, output_per_mtok: 15 },
    'claude-haiku-4-5': { input_per_mtok: 1, output_per_mtok: 5 },
    'claude-3-5-haiku': { input_per_mtok: 0.8, output_per_mtok: 4 },
    'gpt-4o': { input_per_mtok: 2.5, output_per_mtok: 10 },
    'gpt-4o-mini': { input_per_mtok: 0.15, output_per_mtok: 0.6 },
  },
};

let cache: PricingTable | null = null;

export function loadPricing(force = false): PricingTable {
  if (cache && !force) return cache;
  const file = paths.pricing();
  if (!existsSync(file)) {
    cache = DEFAULT_PRICING;
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PricingTable;
    // A malformed hand-edited file must not take the whole CLI down; fall
    // back to defaults and let cost show blank rather than crashing a hook.
    cache = parsed?.models ? parsed : DEFAULT_PRICING;
  } catch {
    cache = DEFAULT_PRICING;
  }
  return cache;
}

export function writeDefaultPricing(): string {
  const file = paths.pricing();
  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(DEFAULT_PRICING, null, 2)}\n`, 'utf8');
  }
  return file;
}

/**
 * Resolves a reported model id to a price entry.
 *
 * Vendors append dated suffixes (`claude-sonnet-4-20250514`) and platforms
 * add prefixes (`us.anthropic.claude-...`), so an exact-match-only lookup
 * would blank out cost for nearly every real session. Matching the longest
 * configured key contained in the id handles both, and longest-first avoids
 * a short key shadowing a more specific one.
 */
export function findModelPrice(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const table = loadPricing();
  const id = model.toLowerCase();
  if (table.models[model]) return table.models[model];

  const keys = Object.keys(table.models).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (id.includes(key.toLowerCase())) return table.models[key];
  }
  return null;
}

/**
 * Cost for a call, or `null` when the model is unknown - never a guess.
 */
export function computeCost(
  model: string | null | undefined,
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
): number | null {
  const price = findModelPrice(model);
  if (!price) return null;
  const inTok = tokensIn ?? 0;
  const outTok = tokensOut ?? 0;
  if (inTok === 0 && outTok === 0) return 0;
  return (inTok / 1_000_000) * price.input_per_mtok + (outTok / 1_000_000) * price.output_per_mtok;
}

/** Test seam: drops the memoised table so a rewritten file is picked up. */
export function __resetPricingCache(): void {
  cache = null;
}
