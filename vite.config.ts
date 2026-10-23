import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	ssr: {
		// Kept external so the server bundle requires them at runtime instead of
		// inlining: native prebuilds (sodium-native, rabin-native), packages with
		// their own conditional exports, and `ghost-picker` whose android/default
		// export the host resolves.
		external: [
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
			'rabin-native',
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
