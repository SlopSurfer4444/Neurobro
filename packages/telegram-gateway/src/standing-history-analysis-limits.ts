/** Host-owned bounds for large durable-history analysis. Legacy projection
 * defaults remain explicit so already reserved material hashes stay stable. */
export const LEGACY_MATERIAL_BYTES = 48 * 1024;
export const MATERIAL_BYTES = 1024 * 1024;
export const MAX_FRAGMENTS = 128;
/** Existing total ledger capacity, not a merge packing threshold. */
export const MAX_ANALYSIS_NODES = 1024;
export const MAX_SUPPORTS = 16384;
export const SUMMARY_BYTES = 32 * 1024;
export const MAX_CLAIMS = 128;
export const NODE_PLAIN_BYTES = 2 * 1024 * 1024;
export const NODE_CIPHER_BYTES = 3 * 1024 * 1024;

export const READ_AHEAD_PAGES = 64;
