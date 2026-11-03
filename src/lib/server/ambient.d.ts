// Minimal type declarations for bare/holepunch packages that ship no types.

declare module 'ready-resource' {
	export default class ReadyResource {
		readonly opened: boolean;
		readonly closed: boolean;
		ready(): Promise<void>;
		close(): Promise<void>;
		emit(event: string, ...args: unknown[]): boolean;
		on(event: string, listener: (...args: unknown[]) => void): this;
		protected _open(): Promise<void>;
		protected _close(): Promise<void>;
	}
}

declare module 'hyperswarm' {
	import type { EventEmitter } from 'node:events';
	interface HyperswarmOptions {
		bootstrap?: unknown;
		keyPair?: { publicKey: Buffer; secretKey: Buffer };
	}
	export default class Hyperswarm extends EventEmitter {
		constructor(opts?: HyperswarmOptions);
		join(topic: Buffer | Uint8Array, opts?: { server?: boolean; limit?: number }): unknown;
		leave(topic: Buffer | Uint8Array, opts?: { server?: boolean }): unknown;
		destroy(): Promise<void>;
		on(event: 'connection', listener: (conn: any) => void): this;
		on(event: string, listener: (...args: unknown[]) => void): this;
	}
}

declare module 'corestore' {
	export default class Corestore {
		constructor(path: string);
		ready(): Promise<void>;
		close(): Promise<void>;
		createKeyPair(name: string): Promise<{ publicKey: Buffer; secretKey: Buffer }>;
		replicate(conn: unknown): unknown;
		session(): Corestore;
		namespace(name: string, opts?: { namespace?: Buffer }): Corestore;
		get(opts: { name?: string; key?: Buffer | Uint8Array | string }): any;
	}
}

declare module 'hyperbee2' {
	export default class Hyperbee {
		constructor(store: unknown, opts?: { name?: string; core?: unknown });
		ready(): Promise<void>;
		close(): Promise<void>;
	}
}

declare module 'hyperdb' {
	interface HyperDB {
		ready(): Promise<void>;
		close(): Promise<void>;
		find(collection: string, range: object): { toArray(): Promise<unknown[]> };
		get(collection: string, key: object): Promise<unknown>;
		insert(collection: string, value: object): Promise<void>;
		update(collection: string, value: object): Promise<void>;
		delete(collection: string, key: object): Promise<void>;
		flush(): Promise<void>;
		update(): Promise<void>;
	}
	const HyperDB: {
		// No `autoUpdate` here on purpose: hyperdb's bee2 path calls bee.on('update'),
		// and hyperbee2 is not an EventEmitter, so passing it throws at boot.
		bee2(bee: unknown, def: unknown): HyperDB;
	};
	export default HyperDB;
}

declare module 'localdrive' {
	export default class Localdrive {
		constructor(path: string, opts?: { atomic?: boolean; followLinks?: boolean });
		readonly root: string;
		ready(): Promise<void>;
		close(): Promise<void>;
		get(path: string, opts?: object): Promise<any>;
		put(path: string, buffer: Buffer | Uint8Array, opts?: object): Promise<void>;
		del(path: string): Promise<void>;
		list(prefix?: string, opts?: object): AsyncIterable<any>;
		readdir(prefix: string): AsyncIterable<string>;
		entry(path: string, opts?: object): Promise<any>;
		createReadStream(path: string, opts?: object): AsyncIterable<Buffer>;
		createWriteStream(path: string, opts?: object): any;
		batch(): { del(key: string): Promise<void>; flush(): Promise<void> };
		mirror(dest: unknown, opts?: object): { done(): Promise<void> };
	}
}

declare module 'hyperdrive' {
	interface HyperdriveOptions {
		name?: string;
		key?: Buffer | Uint8Array | string;
	}
	export default class Hyperdrive {
		constructor(store: unknown, keyOrOpts?: Buffer | Uint8Array | string | HyperdriveOptions);
		readonly key: Buffer;
		readonly writable: boolean;
		/** Entry metadata (mtime, content hash) is kept when this is true. */
		readonly supportsMetadata: boolean;
		ready(): Promise<void>;
		close(): Promise<void>;
		get(path: string, opts?: object): Promise<any>;
		put(path: string, buffer: Buffer | Uint8Array, opts?: object): Promise<any>;
		del(path: string): Promise<any>;
		list(prefix?: string, opts?: object): AsyncIterable<any>;
		entry(path: string, opts?: object): Promise<any>;
		createReadStream(path: string, opts?: object): AsyncIterable<Buffer>;
		createWriteStream(path: string, opts?: object): any;
		mirror(out: unknown, opts?: object): { done(): Promise<void> };
	}
}

declare module 'distributed-drive' {
	import type { EventEmitter } from 'node:events';
	interface DistributedDriveOptions {
		drives?: unknown[];
		key?: Buffer | Uint8Array | string;
		name?: string;
	}
	export default class DistributedDrive extends EventEmitter {
		constructor(store: unknown, opts?: DistributedDriveOptions);
		readonly store: any;
		readonly key: Buffer;
		readonly peers: number;
		readonly drives: unknown[];
		ready(): Promise<void>;
		close(): Promise<void>;
		readdir(path: string): AsyncIterable<unknown>;
		entry(path: string): Promise<unknown>;
		createReadStream(path: string, opts?: object): AsyncIterable<Buffer>;
		getPeerKeys(): AsyncIterable<Buffer>;
		register(drive: unknown): void;
		unregister(drive: unknown): void;
		mirror(dest: unknown, opts?: object): { done(): Promise<void> };
		readonly server: any;
		on(event: 'connected' | 'disconnected', listener: () => void): this;
		on(event: string, listener: (...args: unknown[]) => void): this;
		protected _open(): Promise<void>;
		protected _close(): Promise<void>;
	}
}

declare module 'protomux-rpc' {
	export default class ProtomuxRPC {
		constructor(stream: unknown, opts?: { protocol?: string; id?: unknown });
		readonly opened: boolean;
		readonly closed: boolean;
		readonly stream: any;
		request(
			method: string,
			value: unknown,
			opts?: { requestEncoding?: any; responseEncoding?: any; timeout?: number }
		): Promise<any>;
		respond(
			method: string,
			opts: { requestEncoding?: any; responseEncoding?: any },
			handler: (req: any) => any
		): void;
		destroy(err?: Error): void;
		once(event: string, listener: (...args: any[]) => void): this;
		on(event: string, listener: (...args: any[]) => void): this;
	}
}

declare module 'compact-encoding' {
	const c: any;
	export default c;
}

declare module 'protomux' {
	export default class Protomux {
		static from(stream: unknown, opts?: object): any;
		static isProtomux(mux: unknown): boolean;
	}
}

declare module 'sodium-native' {
	export function randombytes_buf(buf: Buffer): void;
	export function crypto_generichash(output: Buffer, input: Buffer): void;
	// ed25519, as used by corestore's keypair derivation and the release signing.
	export function crypto_sign_keypair(publicKey: Buffer, secretKey: Buffer, seed?: Buffer): void;
	export function crypto_sign_detached(signature: Buffer, message: Buffer, secretKey: Buffer): void;
	export function crypto_sign_verify_detached(
		signature: Buffer,
		message: Buffer,
		publicKey: Buffer
	): boolean;
	export const crypto_sign_PUBLICKEYBYTES: number;
	export const crypto_sign_SECRETKEYBYTES: number;
	export const crypto_sign_BYTES: number;
}

declare module 'b4a' {
	export function alloc(size: number): Buffer;
	export function allocUnsafe(size: number): Buffer;
	export function from(data: string | Buffer | Uint8Array, encoding?: string): Buffer;
	export function toString(buf: Buffer | Uint8Array, encoding?: string): string;
	export function equals(a: Buffer | Uint8Array, b: Buffer | Uint8Array): boolean;
	export function concat(buffers: Array<Buffer | Uint8Array>, length?: number): Buffer;
}

declare module 'ghost-picker' {
	export function pickerAvailable(): boolean;
	export function downloadToDocument(
		session: unknown,
		filePath: string,
		onProgress?: (written: number, total: number) => void
	): Promise<{ saved: boolean; cancelled?: boolean }>;
	export function pickDirectory(): Promise<{ uri: string; path: string | null } | null>;
}
