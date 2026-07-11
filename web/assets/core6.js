// kaspa-safe/web/assets/core6.js — single shared instance of the v6 wasm core (crypto + wallet-send + keygen).
import init, * as core from './vault-core-v6/kaspa_safe_core.js';
export const ready = init();
export { core };
