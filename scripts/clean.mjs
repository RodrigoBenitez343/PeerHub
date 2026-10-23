import { rm } from 'node:fs/promises';

const targets = ['build', 'dist', '.svelte-kit'];
await Promise.all(targets.map((dir) => rm(dir, { recursive: true, force: true })));
console.log(`[clean] removed ${targets.join(', ')}`);
