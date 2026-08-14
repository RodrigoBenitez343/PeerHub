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
	}
}

declare module 'hyperbee2' {
	export default class Hyperbee {
		constructor(store: unknown, opts?: { name?: string });
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
	}
	const HyperDB: {
		bee2(bee: unknown, def: unknown): HyperDB;
	};
	export default HyperDB;
}

declare module 'localdrive' {
	export default class Localdrive {
		constructor(path: string);
		ready(): Promise<void>;
		close(): Promise<void>;
		get(path: string, opts?: object): Promise<any>;
		list(prefix?: string, opts?: object): AsyncIterable<any>;
		readdir(prefix: string): AsyncIterable<string>;
		entry(path: string): Promise<any>;
		batch(): { del(key: string): Promise<void>; flush(): Promise<void> };
		mirror(dest: unknown, opts?: object): { done(): Promise<void> };
	}
}

declare module 'hyperdrive' {
	export default class Hyperdrive {
		constructor(store: unknown, key?: Buffer);
		readonly key: Buffer;
		ready(): Promise<void>;
		close(): Promise<void>;
		get(path: string, opts?: object): Promise<any>;
		list(prefix?: string, opts?: object): AsyncIterable<any>;
		entry(path: string): Promise<any>;
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
		on(event: 'connected' | 'disconnected', listener: () => void): this;
		on(event: string, listener: (...args: unknown[]) => void): this;
	}
}

declare module 'sodium-native' {
	export function randombytes_buf(buf: Buffer): void;
}

declare module 'b4a' {
	export function alloc(size: number): Buffer;
	export function allocUnsafe(size: number): Buffer;
	export function from(data: string | Buffer | Uint8Array, encoding?: string): Buffer;
	export function toString(buf: Buffer | Uint8Array, encoding?: string): string;
	export function equals(a: Buffer | Uint8Array, b: Buffer | Uint8Array): boolean;
}

declare module 'bare-storage' {
	const storage: { persistent(): string; ephemeral(): string };
	export default storage;
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
