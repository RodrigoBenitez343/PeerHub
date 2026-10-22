declare global {
	namespace App {
		interface Locals {
			app: any; // PeerHubApp from $lib/server/app.cjs (CJS, untyped)
		}
	}
}

export {};
