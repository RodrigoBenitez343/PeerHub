import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePlugin as bareExternals } from 'sveltekit-adapter-bare';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), bareExternals()],
	ssr: {
		external: [
			// Platform-conditional file picker: kept external so its android/default
			// export condition is resolved by bare-build per host, not inlined here.
			'ghost-picker',
			'distributed-drive',
			'hyperbee2',
			'protomux',
			'localdrive',
			'hyperdrive',
			'corestore',
			'hyperswarm',
			'hyperdb',
			'sodium-native',
			'ready-resource',
			'b4a',
			'mirror-drive',
			'compact-encoding',
			'protomux-rpc',
			'safety-catch',
			'record-cache',
			'streamx'
		]
	}
});
