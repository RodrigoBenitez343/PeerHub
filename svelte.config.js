import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// The desktop shell (desktop/main.js) imports `build/handler.js` and owns
		// the HTTP server, so no adapter-specific window/runtime is involved here.
		adapter: adapter({ out: 'build', precompress: false })
	}
};

export default config;
