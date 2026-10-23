// The rule lives in shared/data-dir.js so the Electron shell and the CLI use
// the exact same path without importing server code. Re-exported here so the
// app keeps importing from `$lib/server/data-dir.js`.
export { dataDir } from '../../../shared/data-dir.js';
