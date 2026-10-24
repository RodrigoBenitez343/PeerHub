// Entry point for `node --import ./tests/register.mjs --test tests/`.
import { register } from 'node:module';

register('./ts-resolve.mjs', import.meta.url);
