import * as cfw from "cloudflare:workers";
import { DurableObject } from "cloudflare:workers";
//#region ../src/symbols.ts
var WORKERS_MODULE_SYMBOL = Symbol("workers-module");
//#endregion
//#region ../src/inject-workers-module.ts
globalThis[WORKERS_MODULE_SYMBOL] = cfw;
//#endregion
//#region ../src/core.ts
if (!Symbol.dispose) Symbol.dispose = Symbol.for("dispose");
if (!Symbol.asyncDispose) Symbol.asyncDispose = Symbol.for("asyncDispose");
if (!Promise.withResolvers) Promise.withResolvers = function() {
	let resolve;
	let reject;
	return {
		promise: new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		}),
		resolve,
		reject
	};
};
var workersModule = globalThis[WORKERS_MODULE_SYMBOL];
var DEBUG_OBJECT_IDS = /* @__PURE__ */ new WeakMap();
var DEBUG_OBJECT_ID_SEQ = 1;
function getDebugObjectId(value) {
	if (typeof value !== "object" && typeof value !== "function" || value === null) return null;
	let existing = DEBUG_OBJECT_IDS.get(value);
	if (existing !== void 0) return existing;
	let next = DEBUG_OBJECT_ID_SEQ++;
	DEBUG_OBJECT_IDS.set(value, next);
	return next;
}
function debugSerializeUnknown(value, depth = 0) {
	if (depth > 2) return {
		kind: typeof value,
		objectId: getDebugObjectId(value),
		truncated: true
	};
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "undefined") return { kind: "undefined" };
	if (typeof value === "bigint") return {
		kind: "bigint",
		value: value.toString()
	};
	if (typeof value === "symbol") return {
		kind: "symbol",
		value: String(value)
	};
	if (typeof value === "function") return {
		kind: "function",
		objectId: getDebugObjectId(value),
		name: value.name || null,
		constructorName: value.constructor?.name ?? null
	};
	if (value instanceof Date) return {
		kind: "date",
		value: value.toISOString()
	};
	if (value instanceof Uint8Array) return {
		kind: "Uint8Array",
		objectId: getDebugObjectId(value),
		byteLength: value.byteLength
	};
	if (Array.isArray(value)) return {
		kind: "array",
		objectId: getDebugObjectId(value),
		length: value.length,
		items: value.slice(0, 10).map((item) => debugSerializeUnknown(item, depth + 1))
	};
	if (typeof value === "object") {
		let obj = value;
		let props = {};
		for (let key of Object.getOwnPropertyNames(obj)) try {
			props[key] = debugSerializeUnknown(obj[key], depth + 1);
		} catch (err) {
			props[key] = {
				kind: "unreadable",
				error: err instanceof Error ? err.message : String(err)
			};
		}
		return {
			kind: "object",
			objectId: getDebugObjectId(obj),
			constructorName: obj.constructor?.name ?? null,
			props
		};
	}
	return {
		kind: typeof value,
		value: String(value)
	};
}
var RpcTarget$1 = workersModule ? workersModule.RpcTarget : class {};
var AsyncFunction = (async function() {}).constructor;
var BUFFER_PROTOTYPE = typeof Buffer !== "undefined" ? Buffer.prototype : void 0;
function typeForRpc(value) {
	switch (typeof value) {
		case "boolean":
		case "number":
		case "string": return "primitive";
		case "undefined": return "undefined";
		case "object":
		case "function": break;
		case "bigint": return "bigint";
		default: return "unsupported";
	}
	if (value === null) return "primitive";
	let prototype = Object.getPrototypeOf(value);
	switch (prototype) {
		case Object.prototype: return "object";
		case Function.prototype:
		case AsyncFunction.prototype: return "function";
		case Array.prototype: return "array";
		case Date.prototype: return "date";
		case Uint8Array.prototype:
		case BUFFER_PROTOTYPE: return "bytes";
		case WritableStream.prototype: return "writable";
		case ReadableStream.prototype: return "readable";
		case Headers.prototype: return "headers";
		case Request.prototype: return "request";
		case Response.prototype: return "response";
		case RpcStub.prototype: return "stub";
		case RpcPromise.prototype: return "rpc-promise";
		default:
			if (workersModule) {
				if (prototype == workersModule.RpcStub.prototype || value instanceof workersModule.ServiceStub) return "rpc-target";
				else if (prototype == workersModule.RpcPromise.prototype || prototype == workersModule.RpcProperty.prototype) return "rpc-thenable";
			}
			if (value instanceof RpcTarget$1) return "rpc-target";
			if (value instanceof Error) return "error";
			return "unsupported";
	}
}
function mapNotLoaded() {
	throw new Error("RPC map() implementation was not loaded.");
}
var mapImpl = {
	applyMap: mapNotLoaded,
	sendMap: mapNotLoaded
};
function streamNotLoaded() {
	throw new Error("Stream implementation was not loaded.");
}
var streamImpl = {
	createWritableStreamHook: streamNotLoaded,
	createWritableStreamFromHook: streamNotLoaded,
	createReadableStreamHook: streamNotLoaded
};
var StubHook = class {
	stream(path, args) {
		let pulled = this.call(path, args).pull();
		let promise;
		if (pulled instanceof Promise) promise = pulled.then((p) => {
			p.dispose();
		});
		else {
			pulled.dispose();
			promise = Promise.resolve();
		}
		return { promise };
	}
};
var ErrorStubHook = class extends StubHook {
	constructor(error) {
		super();
		this.error = error;
	}
	call(path, args) {
		return this;
	}
	map(path, captures, instructions) {
		return this;
	}
	get(path) {
		return this;
	}
	dup() {
		return this;
	}
	pull() {
		return Promise.reject(this.error);
	}
	ignoreUnhandledRejections() {}
	dispose() {}
	onBroken(callback) {
		try {
			callback(this.error);
		} catch (err) {
			Promise.resolve(err);
		}
	}
};
var DISPOSED_HOOK = new ErrorStubHook(/* @__PURE__ */ new Error("Attempted to use RPC stub after it has been disposed."));
var doCall = (hook, path, params) => {
	return hook.call(path, params);
};
function withCallInterceptor(interceptor, callback) {
	let oldValue = doCall;
	doCall = interceptor;
	try {
		return callback();
	} finally {
		doCall = oldValue;
	}
}
var RAW_STUB = Symbol("realStub");
var PROXY_HANDLERS = {
	apply(target, thisArg, argumentsList) {
		let stub = target.raw;
		return new RpcPromise(doCall(stub.hook, stub.pathIfPromise || [], RpcPayload.fromAppParams(argumentsList)), []);
	},
	get(target, prop, receiver) {
		let stub = target.raw;
		if (prop === RAW_STUB) return stub;
		else if (prop in RpcPromise.prototype) return stub[prop];
		else if (typeof prop === "string") return new RpcPromise(stub.hook, stub.pathIfPromise ? [...stub.pathIfPromise, prop] : [prop]);
		else if (prop === Symbol.dispose && (!stub.pathIfPromise || stub.pathIfPromise.length == 0)) return () => {
			stub.hook.dispose();
			stub.hook = DISPOSED_HOOK;
		};
		else return;
	},
	has(target, prop) {
		let stub = target.raw;
		if (prop === RAW_STUB) return true;
		else if (prop in RpcPromise.prototype) return prop in stub;
		else if (typeof prop === "string") return true;
		else if (prop === Symbol.dispose && (!stub.pathIfPromise || stub.pathIfPromise.length == 0)) return true;
		else return false;
	},
	construct(target, args) {
		throw new Error("An RPC stub cannot be used as a constructor.");
	},
	defineProperty(target, property, attributes) {
		throw new Error("Can't define properties on RPC stubs.");
	},
	deleteProperty(target, p) {
		throw new Error("Can't delete properties on RPC stubs.");
	},
	getOwnPropertyDescriptor(target, p) {},
	getPrototypeOf(target) {
		return Object.getPrototypeOf(target.raw);
	},
	isExtensible(target) {
		return false;
	},
	ownKeys(target) {
		return [];
	},
	preventExtensions(target) {
		return true;
	},
	set(target, p, newValue, receiver) {
		throw new Error("Can't assign properties on RPC stubs.");
	},
	setPrototypeOf(target, v) {
		throw new Error("Can't override prototype of RPC stubs.");
	}
};
var RpcStub = class RpcStub extends RpcTarget$1 {
	constructor(hook, pathIfPromise) {
		super();
		if (!(hook instanceof StubHook)) {
			let value = hook;
			if (value instanceof RpcTarget$1 || value instanceof Function) hook = TargetStubHook.create(value, void 0);
			else hook = new PayloadStubHook(RpcPayload.fromAppReturn(value));
			if (pathIfPromise) throw new TypeError("RpcStub constructor expected one argument, received two.");
		}
		this.hook = hook;
		this.pathIfPromise = pathIfPromise;
		let func = () => {};
		func.raw = this;
		return new Proxy(func, PROXY_HANDLERS);
	}
	hook;
	pathIfPromise;
	dup() {
		let target = this[RAW_STUB];
		if (target.pathIfPromise) return new RpcStub(target.hook.get(target.pathIfPromise));
		else return new RpcStub(target.hook.dup());
	}
	onRpcBroken(callback) {
		this[RAW_STUB].hook.onBroken(callback);
	}
	map(func) {
		let { hook, pathIfPromise } = this[RAW_STUB];
		return mapImpl.sendMap(hook, pathIfPromise || [], func);
	}
	toString() {
		return "[object RpcStub]";
	}
};
var RpcPromise = class extends RpcStub {
	constructor(hook, pathIfPromise) {
		super(hook, pathIfPromise);
	}
	then(onfulfilled, onrejected) {
		return pullPromise(this).then(...arguments);
	}
	catch(onrejected) {
		return pullPromise(this).catch(...arguments);
	}
	finally(onfinally) {
		return pullPromise(this).finally(...arguments);
	}
	toString() {
		return "[object RpcPromise]";
	}
};
function unwrapStubTakingOwnership(stub) {
	let { hook, pathIfPromise } = stub[RAW_STUB];
	if (pathIfPromise && pathIfPromise.length > 0) return hook.get(pathIfPromise);
	else return hook;
}
function unwrapStubAndDup(stub) {
	let { hook, pathIfPromise } = stub[RAW_STUB];
	if (pathIfPromise) return hook.get(pathIfPromise);
	else return hook.dup();
}
function unwrapStubNoProperties(stub) {
	let { hook, pathIfPromise } = stub[RAW_STUB];
	if (pathIfPromise && pathIfPromise.length > 0) return;
	return hook;
}
function unwrapStubOrParent(stub) {
	return stub[RAW_STUB].hook;
}
function unwrapStubAndPath(stub) {
	return stub[RAW_STUB];
}
async function pullPromise(promise) {
	let { hook, pathIfPromise } = promise[RAW_STUB];
	if (pathIfPromise.length > 0) hook = hook.get(pathIfPromise);
	return (await hook.pull()).deliverResolve();
}
var RpcPayload = class RpcPayload {
	static fromAppParams(value) {
		return new RpcPayload(value, "params");
	}
	static fromAppReturn(value) {
		return new RpcPayload(value, "return");
	}
	static fromArray(array) {
		let hooks = [];
		let promises = [];
		let resultArray = [];
		for (let payload of array) {
			payload.ensureDeepCopied();
			for (let hook of payload.hooks) hooks.push(hook);
			for (let promise of payload.promises) {
				if (promise.parent === payload) promise = {
					parent: resultArray,
					property: resultArray.length,
					promise: promise.promise
				};
				promises.push(promise);
			}
			resultArray.push(payload.value);
		}
		return new RpcPayload(resultArray, "owned", hooks, promises);
	}
	static forEvaluate(hooks, promises) {
		return new RpcPayload(null, "owned", hooks, promises);
	}
	static deepCopyFrom(value, oldParent, owner) {
		let result = new RpcPayload(null, "owned", [], []);
		result.value = result.deepCopy(value, oldParent, "value", result, true, owner);
		return result;
	}
	constructor(value, source, hooks, promises) {
		this.value = value;
		this.source = source;
		this.hooks = hooks;
		this.promises = promises;
	}
	rpcTargets;
	getHookForRpcTarget(target, parent, dupStubs = true) {
		if (this.source === "params") {
			if (dupStubs) {
				let dupable = target;
				if (typeof dupable.dup === "function") target = dupable.dup();
			}
			return TargetStubHook.create(target, parent);
		} else if (this.source === "return") {
			let hook = this.rpcTargets?.get(target);
			if (hook) if (dupStubs) return hook.dup();
			else {
				this.rpcTargets?.delete(target);
				return hook;
			}
			else {
				hook = TargetStubHook.create(target, parent);
				if (dupStubs) {
					if (!this.rpcTargets) this.rpcTargets = /* @__PURE__ */ new Map();
					this.rpcTargets.set(target, hook);
					return hook.dup();
				} else return hook;
			}
		} else throw new Error("owned payload shouldn't contain raw RpcTargets");
	}
	getHookForWritableStream(stream, parent, dupStubs = true) {
		if (this.source === "params") return streamImpl.createWritableStreamHook(stream);
		else if (this.source === "return") {
			let hook = this.rpcTargets?.get(stream);
			if (hook) if (dupStubs) return hook.dup();
			else {
				this.rpcTargets?.delete(stream);
				return hook;
			}
			else {
				hook = streamImpl.createWritableStreamHook(stream);
				if (dupStubs) {
					if (!this.rpcTargets) this.rpcTargets = /* @__PURE__ */ new Map();
					this.rpcTargets.set(stream, hook);
					return hook.dup();
				} else return hook;
			}
		} else throw new Error("owned payload shouldn't contain raw WritableStreams");
	}
	getHookForReadableStream(stream, parent, dupStubs = true) {
		if (this.source === "params") return streamImpl.createReadableStreamHook(stream);
		else if (this.source === "return") {
			let hook = this.rpcTargets?.get(stream);
			if (hook) if (dupStubs) return hook.dup();
			else {
				this.rpcTargets?.delete(stream);
				return hook;
			}
			else {
				hook = streamImpl.createReadableStreamHook(stream);
				if (dupStubs) {
					if (!this.rpcTargets) this.rpcTargets = /* @__PURE__ */ new Map();
					this.rpcTargets.set(stream, hook);
					return hook.dup();
				} else return hook;
			}
		} else throw new Error("owned payload shouldn't contain raw ReadableStreams");
	}
	deepCopy(value, oldParent, property, parent, dupStubs, owner) {
		switch (typeForRpc(value)) {
			case "unsupported": return value;
			case "primitive":
			case "bigint":
			case "date":
			case "bytes":
			case "error":
			case "undefined": return value;
			case "array": {
				let array = value;
				let len = array.length;
				let result = new Array(len);
				for (let i = 0; i < len; i++) result[i] = this.deepCopy(array[i], array, i, result, dupStubs, owner);
				return result;
			}
			case "object": {
				let result = {};
				let object = value;
				for (let i in object) result[i] = this.deepCopy(object[i], object, i, result, dupStubs, owner);
				return result;
			}
			case "stub":
			case "rpc-promise": {
				let stub = value;
				let hook;
				if (dupStubs) hook = unwrapStubAndDup(stub);
				else hook = unwrapStubTakingOwnership(stub);
				if (stub instanceof RpcPromise) {
					let promise = new RpcPromise(hook, []);
					this.promises.push({
						parent,
						property,
						promise
					});
					return promise;
				} else {
					this.hooks.push(hook);
					return new RpcStub(hook);
				}
			}
			case "function":
			case "rpc-target": {
				let target = value;
				let hook;
				if (owner) hook = owner.getHookForRpcTarget(target, oldParent, dupStubs);
				else hook = TargetStubHook.create(target, oldParent);
				this.hooks.push(hook);
				return new RpcStub(hook);
			}
			case "rpc-thenable": {
				let target = value;
				let promise;
				if (owner) promise = new RpcPromise(owner.getHookForRpcTarget(target, oldParent, dupStubs), []);
				else promise = new RpcPromise(TargetStubHook.create(target, oldParent), []);
				this.promises.push({
					parent,
					property,
					promise
				});
				return promise;
			}
			case "writable": {
				let stream = value;
				let hook;
				if (owner) hook = owner.getHookForWritableStream(stream, oldParent, dupStubs);
				else hook = streamImpl.createWritableStreamHook(stream);
				this.hooks.push(hook);
				return stream;
			}
			case "readable": {
				let stream = value;
				let hook;
				if (owner) hook = owner.getHookForReadableStream(stream, oldParent, dupStubs);
				else hook = streamImpl.createReadableStreamHook(stream);
				this.hooks.push(hook);
				return stream;
			}
			case "headers": return new Headers(value);
			case "request": {
				let req = value;
				if (req.body) this.deepCopy(req.body, req, "body", req, dupStubs, owner);
				return new Request(req);
			}
			case "response": {
				let resp = value;
				if (resp.body) this.deepCopy(resp.body, resp, "body", resp, dupStubs, owner);
				return new Response(resp.body, resp);
			}
			default: throw new Error("unreachable");
		}
	}
	ensureDeepCopied() {
		if (this.source !== "owned") {
			let dupStubs = this.source === "params";
			this.hooks = [];
			this.promises = [];
			try {
				this.value = this.deepCopy(this.value, void 0, "value", this, dupStubs, this);
			} catch (err) {
				this.hooks = void 0;
				this.promises = void 0;
				throw err;
			}
			this.source = "owned";
			if (this.rpcTargets && this.rpcTargets.size > 0) throw new Error("Not all rpcTargets were accounted for in deep-copy?");
			this.rpcTargets = void 0;
		}
	}
	deliverTo(parent, property, promises) {
		this.ensureDeepCopied();
		if (this.value instanceof RpcPromise) RpcPayload.deliverRpcPromiseTo(this.value, parent, property, promises);
		else {
			parent[property] = this.value;
			for (let record of this.promises) RpcPayload.deliverRpcPromiseTo(record.promise, record.parent, record.property, promises);
		}
	}
	static deliverRpcPromiseTo(promise, parent, property, promises) {
		let hook = unwrapStubNoProperties(promise);
		if (!hook) throw new Error("property promises should have been resolved earlier");
		let inner = hook.pull();
		if (inner instanceof RpcPayload) inner.deliverTo(parent, property, promises);
		else promises.push(inner.then((payload) => {
			let subPromises = [];
			payload.deliverTo(parent, property, subPromises);
			if (subPromises.length > 0) return Promise.all(subPromises);
		}));
	}
	async deliverCall(func, thisArg) {
		try {
			let promises = [];
			this.deliverTo(this, "value", promises);
			if (promises.length > 0) await Promise.all(promises);
			let result = Function.prototype.apply.call(func, thisArg, this.value);
			if (result instanceof RpcPromise) return RpcPayload.fromAppReturn(result);
			else return RpcPayload.fromAppReturn(await result);
		} finally {
			this.dispose();
		}
	}
	async deliverResolve() {
		try {
			let promises = [];
			this.deliverTo(this, "value", promises);
			if (promises.length > 0) await Promise.all(promises);
			let result = this.value;
			if (result instanceof Object) {
				if (!(Symbol.dispose in result)) Object.defineProperty(result, Symbol.dispose, {
					value: () => this.dispose(),
					writable: true,
					enumerable: false,
					configurable: true
				});
			}
			return result;
		} catch (err) {
			this.dispose();
			throw err;
		}
	}
	dispose() {
		if (this.source === "owned") {
			this.hooks.forEach((hook) => hook.dispose());
			this.promises.forEach((promise) => promise.promise[Symbol.dispose]());
		} else if (this.source === "return") {
			this.disposeImpl(this.value, void 0);
			if (this.rpcTargets && this.rpcTargets.size > 0) throw new Error("Not all rpcTargets were accounted for in disposeImpl()?");
		}
		this.source = "owned";
		this.hooks = [];
		this.promises = [];
	}
	disposeImpl(value, parent) {
		switch (typeForRpc(value)) {
			case "unsupported":
			case "primitive":
			case "bigint":
			case "bytes":
			case "date":
			case "error":
			case "undefined": return;
			case "array": {
				let array = value;
				let len = array.length;
				for (let i = 0; i < len; i++) this.disposeImpl(array[i], array);
				return;
			}
			case "object": {
				let object = value;
				for (let i in object) this.disposeImpl(object[i], object);
				return;
			}
			case "stub":
			case "rpc-promise": {
				let hook = unwrapStubNoProperties(value);
				if (hook) hook.dispose();
				return;
			}
			case "function":
			case "rpc-target": {
				let target = value;
				let hook = this.rpcTargets?.get(target);
				if (hook) {
					hook.dispose();
					this.rpcTargets.delete(target);
				} else disposeRpcTarget(target);
				return;
			}
			case "rpc-thenable": return;
			case "headers": return;
			case "request": {
				let req = value;
				if (req.body) this.disposeImpl(req.body, req);
				return;
			}
			case "response": {
				let resp = value;
				if (resp.body) this.disposeImpl(resp.body, resp);
				return;
			}
			case "writable": {
				let stream = value;
				let hook = this.rpcTargets?.get(stream);
				if (hook) this.rpcTargets.delete(stream);
				else hook = streamImpl.createWritableStreamHook(stream);
				hook.dispose();
				return;
			}
			case "readable": {
				let stream = value;
				let hook = this.rpcTargets?.get(stream);
				if (hook) this.rpcTargets.delete(stream);
				else hook = streamImpl.createReadableStreamHook(stream);
				hook.dispose();
				return;
			}
			default: return;
		}
	}
	ignoreUnhandledRejections() {
		if (this.hooks) {
			this.hooks.forEach((hook) => {
				hook.ignoreUnhandledRejections();
			});
			this.promises.forEach((promise) => unwrapStubOrParent(promise.promise).ignoreUnhandledRejections());
		} else this.ignoreUnhandledRejectionsImpl(this.value);
	}
	ignoreUnhandledRejectionsImpl(value) {
		switch (typeForRpc(value)) {
			case "unsupported":
			case "primitive":
			case "bigint":
			case "bytes":
			case "date":
			case "error":
			case "undefined":
			case "function":
			case "rpc-target":
			case "writable":
			case "readable":
			case "headers":
			case "request":
			case "response": return;
			case "array": {
				let array = value;
				let len = array.length;
				for (let i = 0; i < len; i++) this.ignoreUnhandledRejectionsImpl(array[i]);
				return;
			}
			case "object": {
				let object = value;
				for (let i in object) this.ignoreUnhandledRejectionsImpl(object[i]);
				return;
			}
			case "stub":
			case "rpc-promise":
				unwrapStubOrParent(value).ignoreUnhandledRejections();
				return;
			case "rpc-thenable":
				value.then((_) => {}, (_) => {});
				return;
			default: return;
		}
	}
};
function followPath(value, parent, path, owner) {
	for (let i = 0; i < path.length; i++) {
		parent = value;
		let part = path[i];
		if (part in Object.prototype) {
			value = void 0;
			continue;
		}
		switch (typeForRpc(value)) {
			case "object":
			case "function":
				if (Object.hasOwn(value, part)) value = value[part];
				else value = void 0;
				break;
			case "array":
				if (Number.isInteger(part) && part >= 0) value = value[part];
				else value = void 0;
				break;
			case "rpc-target":
			case "rpc-thenable":
				if (Object.hasOwn(value, part)) throw new TypeError(`Attempted to access property '${part}', which is an instance property of the RpcTarget. To avoid leaking private internals, instance properties cannot be accessed over RPC. If you want to make this property available over RPC, define it as a method or getter on the class, instead of an instance property.`);
				else value = value[part];
				owner = null;
				break;
			case "stub":
			case "rpc-promise": {
				let { hook, pathIfPromise } = unwrapStubAndPath(value);
				return {
					hook,
					remainingPath: pathIfPromise ? pathIfPromise.concat(path.slice(i)) : path.slice(i)
				};
			}
			case "writable":
				value = void 0;
				break;
			case "readable":
				value = void 0;
				break;
			case "primitive":
			case "bigint":
			case "bytes":
			case "date":
			case "error":
			case "headers":
			case "request":
			case "response":
				value = void 0;
				break;
			case "undefined":
				value = value[part];
				break;
			case "unsupported": if (i === 0) throw new TypeError(`RPC stub points at a non-serializable type.`);
			else {
				let prefix = path.slice(0, i).join(".");
				let remainder = path.slice(0, i).join(".");
				throw new TypeError(`'${prefix}' is not a serializable type, so property ${remainder} cannot be accessed.`);
			}
			default: throw new TypeError("unreachable");
		}
	}
	if (value instanceof RpcPromise) {
		let { hook, pathIfPromise } = unwrapStubAndPath(value);
		return {
			hook,
			remainingPath: pathIfPromise || []
		};
	}
	return {
		value,
		parent,
		owner
	};
}
var ValueStubHook = class extends StubHook {
	call(path, args) {
		try {
			let { value, owner } = this.getValue();
			let followResult = followPath(value, void 0, path, owner);
			if (followResult.hook) return followResult.hook.call(followResult.remainingPath, args);
			if (typeof followResult.value != "function") throw new TypeError(`'${path.join(".")}' is not a function.`);
			return new PromiseStubHook(args.deliverCall(followResult.value, followResult.parent).then((payload) => {
				return new PayloadStubHook(payload);
			}));
		} catch (err) {
			return new ErrorStubHook(err);
		}
	}
	map(path, captures, instructions) {
		try {
			let followResult;
			try {
				let { value, owner } = this.getValue();
				followResult = followPath(value, void 0, path, owner);
			} catch (err) {
				for (let cap of captures) cap.dispose();
				throw err;
			}
			if (followResult.hook) return followResult.hook.map(followResult.remainingPath, captures, instructions);
			return mapImpl.applyMap(followResult.value, followResult.parent, followResult.owner, captures, instructions);
		} catch (err) {
			return new ErrorStubHook(err);
		}
	}
	get(path) {
		try {
			let { value, owner } = this.getValue();
			if (path.length === 0 && owner === null) throw new Error("Can't dup an RpcTarget stub as a promise.");
			let followResult = followPath(value, void 0, path, owner);
			if (followResult.hook) return followResult.hook.get(followResult.remainingPath);
			return new PayloadStubHook(RpcPayload.deepCopyFrom(followResult.value, followResult.parent, followResult.owner));
		} catch (err) {
			return new ErrorStubHook(err);
		}
	}
};
var PayloadStubHook = class PayloadStubHook extends ValueStubHook {
	constructor(payload) {
		super();
		this.payload = payload;
	}
	payload;
	getPayload() {
		if (this.payload) return this.payload;
		else throw new Error("Attempted to use an RPC StubHook after it was disposed.");
	}
	getValue() {
		let payload = this.getPayload();
		return {
			value: payload.value,
			owner: payload
		};
	}
	dup() {
		let thisPayload = this.getPayload();
		return new PayloadStubHook(RpcPayload.deepCopyFrom(thisPayload.value, void 0, thisPayload));
	}
	pull() {
		return this.getPayload();
	}
	ignoreUnhandledRejections() {
		if (this.payload) this.payload.ignoreUnhandledRejections();
	}
	dispose() {
		if (this.payload) {
			this.payload.dispose();
			this.payload = void 0;
		}
	}
	onBroken(callback) {
		if (this.payload) {
			if (this.payload.value instanceof RpcStub) this.payload.value.onRpcBroken(callback);
		}
	}
};
function disposeRpcTarget(target) {
	if (Symbol.dispose in target) try {
		target[Symbol.dispose]();
	} catch (err) {
		Promise.reject(err);
	}
}
var TargetStubHook = class TargetStubHook extends ValueStubHook {
	static create(value, parent) {
		if (typeof value !== "function") parent = void 0;
		return new TargetStubHook(value, parent);
	}
	constructor(target, parent, dupFrom) {
		super();
		this.target = target;
		this.parent = parent;
		if (dupFrom) {
			if (dupFrom.refcount) {
				this.refcount = dupFrom.refcount;
				++this.refcount.count;
			}
		} else if (Symbol.dispose in target) this.refcount = { count: 1 };
	}
	target;
	parent;
	refcount;
	getTarget() {
		if (this.target) return this.target;
		else throw new Error("Attempted to use an RPC StubHook after it was disposed.");
	}
	getValue() {
		return {
			value: this.getTarget(),
			owner: null
		};
	}
	dup() {
		return new TargetStubHook(this.getTarget(), this.parent, this);
	}
	pull() {
		let target = this.getTarget();
		if ("then" in target) return Promise.resolve(target).then((resolution) => {
			return RpcPayload.fromAppReturn(resolution);
		});
		else return Promise.reject(/* @__PURE__ */ new Error("Tried to resolve a non-promise stub."));
	}
	ignoreUnhandledRejections() {}
	dispose() {
		if (this.target) {
			if (this.refcount) {
				if (--this.refcount.count == 0) disposeRpcTarget(this.target);
			}
			this.target = void 0;
		}
	}
	onBroken(callback) {}
	__experimental_debugIdentity() {
		return {
			hookObjectId: getDebugObjectId(this),
			targetObjectId: getDebugObjectId(this.target),
			targetType: this.target?.constructor?.name ?? null,
			parentObjectId: getDebugObjectId(this.parent),
			hasRefcount: !!this.refcount,
			refcountObjectId: getDebugObjectId(this.refcount),
			refcountValue: this.refcount?.count ?? null,
			rawThis: debugSerializeUnknown({
				target: this.target,
				parent: this.parent,
				refcount: this.refcount
			})
		};
	}
};
function __experimental_debugStubHookIdentity(hook) {
	const customDebug = hook.__experimental_debugIdentity?.();
	if (customDebug) return customDebug;
	if (hook instanceof TargetStubHook) return {
		hookType: "TargetStubHook",
		...hook.__experimental_debugIdentity()
	};
	return {
		hookType: hook.constructor?.name ?? null,
		hookObjectId: getDebugObjectId(hook)
	};
}
var PromiseStubHook = class PromiseStubHook extends StubHook {
	promise;
	resolution;
	constructor(promise) {
		super();
		this.promise = promise.then((res) => {
			this.resolution = res;
			return res;
		});
	}
	call(path, args) {
		args.ensureDeepCopied();
		return new PromiseStubHook(this.promise.then((hook) => hook.call(path, args)));
	}
	stream(path, args) {
		args.ensureDeepCopied();
		return { promise: this.promise.then((hook) => {
			return hook.stream(path, args).promise;
		}) };
	}
	map(path, captures, instructions) {
		return new PromiseStubHook(this.promise.then((hook) => hook.map(path, captures, instructions), (err) => {
			for (let cap of captures) cap.dispose();
			throw err;
		}));
	}
	get(path) {
		return new PromiseStubHook(this.promise.then((hook) => hook.get(path)));
	}
	dup() {
		if (this.resolution) return this.resolution.dup();
		else return new PromiseStubHook(this.promise.then((hook) => hook.dup()));
	}
	pull() {
		if (this.resolution) return this.resolution.pull();
		else return this.promise.then((hook) => hook.pull());
	}
	ignoreUnhandledRejections() {
		if (this.resolution) this.resolution.ignoreUnhandledRejections();
		else this.promise.then((res) => {
			res.ignoreUnhandledRejections();
		}, (err) => {});
	}
	dispose() {
		if (this.resolution) this.resolution.dispose();
		else this.promise.then((hook) => {
			hook.dispose();
		}, (err) => {});
	}
	onBroken(callback) {
		if (this.resolution) this.resolution.onBroken(callback);
		else this.promise.then((hook) => {
			hook.onBroken(callback);
		}, callback);
	}
};
//#endregion
//#region ../src/serialize.ts
var NullExporter = class {
	exportStub(stub) {
		throw new Error("Cannot serialize RPC stubs without an RPC session.");
	}
	exportPromise(stub) {
		throw new Error("Cannot serialize RPC stubs without an RPC session.");
	}
	getImport(hook) {}
	unexport(ids) {}
	createPipe(readable) {
		throw new Error("Cannot create pipes without an RPC session.");
	}
	onSendError(error) {}
};
var NULL_EXPORTER = new NullExporter();
var ERROR_TYPES = {
	Error,
	EvalError,
	RangeError,
	ReferenceError,
	SyntaxError,
	TypeError,
	URIError,
	AggregateError
};
var Devaluator = class Devaluator {
	constructor(exporter, source) {
		this.exporter = exporter;
		this.source = source;
	}
	static devaluate(value, parent, exporter = NULL_EXPORTER, source) {
		let devaluator = new Devaluator(exporter, source);
		try {
			return devaluator.devaluateImpl(value, parent, 0, []);
		} catch (err) {
			if (devaluator.exports) try {
				exporter.unexport(devaluator.exports);
			} catch (err) {}
			throw err;
		}
	}
	exports;
	devaluateImpl(value, parent, depth, path) {
		if (depth >= 64) throw new Error("Serialization exceeded maximum allowed depth. (Does the message contain cycles?)");
		switch (typeForRpc(value)) {
			case "unsupported": {
				let msg;
				try {
					msg = `Cannot serialize value: ${value}`;
				} catch (err) {
					msg = "Cannot serialize value: (couldn't stringify value)";
				}
				throw new TypeError(msg);
			}
			case "primitive": if (typeof value === "number" && !isFinite(value)) if (value === Infinity) return ["inf"];
			else if (value === -Infinity) return ["-inf"];
			else return ["nan"];
			else return value;
			case "object": {
				let object = value;
				let result = {};
				for (let key in object) result[key] = this.devaluateImpl(object[key], object, depth + 1, path.concat(key));
				return result;
			}
			case "array": {
				let array = value;
				let len = array.length;
				let result = new Array(len);
				for (let i = 0; i < len; i++) result[i] = this.devaluateImpl(array[i], array, depth + 1, path.concat(i));
				return [result];
			}
			case "bigint": return ["bigint", value.toString()];
			case "date": return ["date", value.getTime()];
			case "bytes": {
				let bytes = value;
				if (bytes.toBase64) return ["bytes", bytes.toBase64({ omitPadding: true })];
				let b64;
				if (typeof Buffer !== "undefined") b64 = (bytes instanceof Buffer ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).toString("base64");
				else {
					let binary = "";
					for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
					b64 = btoa(binary);
				}
				return ["bytes", b64.replace(/=+$/, "")];
			}
			case "headers": return ["headers", [...value]];
			case "request": {
				let req = value;
				let init = {};
				if (req.method !== "GET") init.method = req.method;
				let headers = [...req.headers];
				if (headers.length > 0) init.headers = headers;
				if (req.body) {
					init.body = this.devaluateImpl(req.body, req, depth + 1, path.concat("body"));
					init.duplex = req.duplex || "half";
				} else if (req.body === void 0 && ![
					"GET",
					"HEAD",
					"OPTIONS",
					"TRACE",
					"DELETE"
				].includes(req.method)) {
					let bodyPromise = req.arrayBuffer();
					let readable = new ReadableStream({ async start(controller) {
						try {
							controller.enqueue(new Uint8Array(await bodyPromise));
							controller.close();
						} catch (err) {
							controller.error(err);
						}
					} });
					let hook = streamImpl.createReadableStreamHook(readable);
					init.body = ["readable", this.exporter.createPipe(readable, hook)];
					init.duplex = req.duplex || "half";
				}
				if (req.cache && req.cache !== "default") init.cache = req.cache;
				if (req.redirect !== "follow") init.redirect = req.redirect;
				if (req.integrity) init.integrity = req.integrity;
				if (req.mode && req.mode !== "cors") init.mode = req.mode;
				if (req.credentials && req.credentials !== "same-origin") init.credentials = req.credentials;
				if (req.referrer && req.referrer !== "about:client") init.referrer = req.referrer;
				if (req.referrerPolicy) init.referrerPolicy = req.referrerPolicy;
				if (req.keepalive) init.keepalive = req.keepalive;
				let cfReq = req;
				if (cfReq.cf) init.cf = cfReq.cf;
				if (cfReq.encodeResponseBody && cfReq.encodeResponseBody !== "automatic") init.encodeResponseBody = cfReq.encodeResponseBody;
				return [
					"request",
					req.url,
					init
				];
			}
			case "response": {
				let resp = value;
				let body = this.devaluateImpl(resp.body, resp, depth + 1, path.concat("body"));
				let init = {};
				if (resp.status !== 200) init.status = resp.status;
				if (resp.statusText) init.statusText = resp.statusText;
				let headers = [...resp.headers];
				if (headers.length > 0) init.headers = headers;
				let cfResp = resp;
				if (cfResp.cf) init.cf = cfResp.cf;
				if (cfResp.encodeBody && cfResp.encodeBody !== "automatic") init.encodeBody = cfResp.encodeBody;
				if (cfResp.webSocket) throw new TypeError("Can't serialize a Response containing a webSocket.");
				return [
					"response",
					body,
					init
				];
			}
			case "error": {
				let e = value;
				let rewritten = this.exporter.onSendError(e);
				if (rewritten) e = rewritten;
				let result = [
					"error",
					e.name,
					e.message
				];
				if (rewritten && rewritten.stack) result.push(rewritten.stack);
				return result;
			}
			case "undefined": return ["undefined"];
			case "stub":
			case "rpc-promise": {
				if (!this.source) throw new Error("Can't serialize RPC stubs in this context.");
				let { hook, pathIfPromise } = unwrapStubAndPath(value);
				let importId = this.exporter.getImport(hook);
				if (importId !== void 0) if (pathIfPromise) if (pathIfPromise.length > 0) return [
					"pipeline",
					importId,
					pathIfPromise
				];
				else return ["pipeline", importId];
				else return ["import", importId];
				if (pathIfPromise) hook = hook.get(pathIfPromise);
				else hook = hook.dup();
				return this.devaluateHook(pathIfPromise ? "promise" : "export", hook, path);
			}
			case "function":
			case "rpc-target": {
				if (!this.source) throw new Error("Can't serialize RPC stubs in this context.");
				let hook = this.source.getHookForRpcTarget(value, parent);
				return this.devaluateHook("export", hook, path);
			}
			case "rpc-thenable": {
				if (!this.source) throw new Error("Can't serialize RPC stubs in this context.");
				let hook = this.source.getHookForRpcTarget(value, parent);
				return this.devaluateHook("promise", hook, path);
			}
			case "writable": {
				if (!this.source) throw new Error("Can't serialize WritableStream in this context.");
				let hook = this.source.getHookForWritableStream(value, parent);
				return this.devaluateHook("writable", hook, path);
			}
			case "readable": {
				if (!this.source) throw new Error("Can't serialize ReadableStream in this context.");
				let ws = value;
				let hook = this.source.getHookForReadableStream(ws, parent);
				return ["readable", this.exporter.createPipe(ws, hook)];
			}
			default: throw new Error("unreachable");
		}
	}
	devaluateHook(type, hook, path) {
		if (!this.exports) this.exports = [];
		let exportId = type === "promise" ? this.exporter.exportPromise(hook, path) : this.exporter.exportStub(hook, path);
		this.exports.push(exportId);
		return [type, exportId];
	}
};
var NullImporter = class {
	importStub(idx) {
		throw new Error("Cannot deserialize RPC stubs without an RPC session.");
	}
	importPromise(idx) {
		throw new Error("Cannot deserialize RPC stubs without an RPC session.");
	}
	getExport(idx) {}
	getPipeReadable(exportId) {
		throw new Error("Cannot retrieve pipe readable without an RPC session.");
	}
};
new NullImporter();
function fixBrokenRequestBody(request, body) {
	return new RpcPromise(new PromiseStubHook(new Response(body).arrayBuffer().then((arrayBuffer) => {
		let bytes = new Uint8Array(arrayBuffer);
		let result = new Request(request, { body: bytes });
		return new PayloadStubHook(RpcPayload.fromAppReturn(result));
	})), []);
}
var Evaluator = class Evaluator {
	constructor(importer) {
		this.importer = importer;
	}
	hooks = [];
	promises = [];
	evaluate(value) {
		let payload = RpcPayload.forEvaluate(this.hooks, this.promises);
		try {
			payload.value = this.evaluateImpl(value, payload, "value");
			return payload;
		} catch (err) {
			payload.dispose();
			throw err;
		}
	}
	evaluateCopy(value) {
		return this.evaluate(structuredClone(value));
	}
	evaluateImpl(value, parent, property) {
		if (value instanceof Array) {
			if (value.length == 1 && value[0] instanceof Array) {
				let result = value[0];
				for (let i = 0; i < result.length; i++) result[i] = this.evaluateImpl(result[i], result, i);
				return result;
			} else switch (value[0]) {
				case "bigint":
					if (typeof value[1] == "string") return BigInt(value[1]);
					break;
				case "date":
					if (typeof value[1] == "number") return new Date(value[1]);
					break;
				case "bytes":
					if (typeof value[1] == "string") if (typeof Buffer !== "undefined") return Buffer.from(value[1], "base64");
					else if (Uint8Array.fromBase64) return Uint8Array.fromBase64(value[1]);
					else {
						let bs = atob(value[1]);
						let len = bs.length;
						let bytes = new Uint8Array(len);
						for (let i = 0; i < len; i++) bytes[i] = bs.charCodeAt(i);
						return bytes;
					}
					break;
				case "error":
					if (value.length >= 3 && typeof value[1] === "string" && typeof value[2] === "string") {
						let result = new (ERROR_TYPES[value[1]] || Error)(value[2]);
						if (typeof value[3] === "string") result.stack = value[3];
						return result;
					}
					break;
				case "undefined":
					if (value.length === 1) return;
					break;
				case "inf": return Infinity;
				case "-inf": return -Infinity;
				case "nan": return NaN;
				case "headers":
					if (value.length === 2 && value[1] instanceof Array) return new Headers(value[1]);
					break;
				case "request": {
					if (value.length !== 3 || typeof value[1] !== "string") break;
					let url = value[1];
					let init = value[2];
					if (typeof init !== "object" || init === null) break;
					if (init.body) {
						init.body = this.evaluateImpl(init.body, init, "body");
						if (init.body === null || typeof init.body === "string" || init.body instanceof Uint8Array || init.body instanceof ReadableStream) {} else throw new TypeError("Request body must be of type ReadableStream.");
					}
					if (init.signal) {
						init.signal = this.evaluateImpl(init.signal, init, "signal");
						if (!(init.signal instanceof AbortSignal)) throw new TypeError("Request siganl must be of type AbortSignal.");
					}
					if (init.headers && !(init.headers instanceof Array)) throw new TypeError("Request headers must be serialized as an array of pairs.");
					let result = new Request(url, init);
					if (init.body instanceof ReadableStream && result.body === void 0) {
						let promise = fixBrokenRequestBody(result, init.body);
						this.promises.push({
							promise,
							parent,
							property
						});
						return promise;
					} else return result;
				}
				case "response": {
					if (value.length !== 3) break;
					let body = this.evaluateImpl(value[1], parent, property);
					if (body === null || typeof body === "string" || body instanceof Uint8Array || body instanceof ReadableStream) {} else throw new TypeError("Response body must be of type ReadableStream.");
					let init = value[2];
					if (typeof init !== "object" || init === null) break;
					if (init.webSocket) throw new TypeError("Can't deserialize a Response containing a webSocket.");
					if (init.headers && !(init.headers instanceof Array)) throw new TypeError("Request headers must be serialized as an array of pairs.");
					return new Response(body, init);
				}
				case "import":
				case "pipeline": {
					if (value.length < 2 || value.length > 4) break;
					if (typeof value[1] != "number") break;
					let hook = this.importer.getExport(value[1]);
					if (!hook) throw new Error(`no such entry on exports table: ${value[1]}`);
					let isPromise = value[0] == "pipeline";
					let addStub = (hook) => {
						if (isPromise) {
							let promise = new RpcPromise(hook, []);
							this.promises.push({
								promise,
								parent,
								property
							});
							return promise;
						} else {
							this.hooks.push(hook);
							return new RpcPromise(hook, []);
						}
					};
					if (value.length == 2) if (isPromise) return addStub(hook.get([]));
					else return addStub(hook.dup());
					let path = value[2];
					if (!(path instanceof Array)) break;
					if (!path.every((part) => {
						return typeof part == "string" || typeof part == "number";
					})) break;
					if (value.length == 3) return addStub(hook.get(path));
					let args = value[3];
					if (!(args instanceof Array)) break;
					args = new Evaluator(this.importer).evaluate([args]);
					return addStub(hook.call(path, args));
				}
				case "remap": {
					if (value.length !== 5 || typeof value[1] !== "number" || !(value[2] instanceof Array) || !(value[3] instanceof Array) || !(value[4] instanceof Array)) break;
					let hook = this.importer.getExport(value[1]);
					if (!hook) throw new Error(`no such entry on exports table: ${value[1]}`);
					let path = value[2];
					if (!path.every((part) => {
						return typeof part == "string" || typeof part == "number";
					})) break;
					let captures = value[3].map((cap) => {
						if (!(cap instanceof Array) || cap.length !== 2 || cap[0] !== "import" && cap[0] !== "export" || typeof cap[1] !== "number") throw new TypeError(`unknown map capture: ${JSON.stringify(cap)}`);
						if (cap[0] === "export") return this.importer.importStub(cap[1]);
						else {
							let exp = this.importer.getExport(cap[1]);
							if (!exp) throw new Error(`no such entry on exports table: ${cap[1]}`);
							return exp.dup();
						}
					});
					let instructions = value[4];
					let promise = new RpcPromise(hook.map(path, captures, instructions), []);
					this.promises.push({
						promise,
						parent,
						property
					});
					return promise;
				}
				case "export":
				case "promise":
					if (typeof value[1] == "number") if (value[0] == "promise") {
						let promise = new RpcPromise(this.importer.importPromise(value[1]), []);
						this.promises.push({
							parent,
							property,
							promise
						});
						return promise;
					} else {
						let hook = this.importer.importStub(value[1]);
						this.hooks.push(hook);
						return new RpcStub(hook);
					}
					break;
				case "writable":
					if (typeof value[1] == "number") {
						let hook = this.importer.importStub(value[1]);
						let stream = streamImpl.createWritableStreamFromHook(hook);
						this.hooks.push(hook);
						return stream;
					}
					break;
				case "readable":
					if (typeof value[1] == "number") {
						let stream = this.importer.getPipeReadable(value[1]);
						let hook = streamImpl.createReadableStreamHook(stream);
						this.hooks.push(hook);
						return stream;
					}
					break;
			}
			throw new TypeError(`unknown special value: ${JSON.stringify(value)}`);
		} else if (value instanceof Object) {
			let result = value;
			for (let key in result) if (key in Object.prototype || key === "toJSON") {
				this.evaluateImpl(result[key], result, key);
				delete result[key];
			} else result[key] = this.evaluateImpl(result[key], result, key);
			return result;
		} else return value;
	}
};
//#endregion
//#region ../src/map.ts
var currentMapBuilder;
var MapBuilder = class {
	context;
	captureMap = /* @__PURE__ */ new Map();
	instructions = [];
	constructor(subject, path) {
		if (currentMapBuilder) this.context = {
			parent: currentMapBuilder,
			captures: [],
			subject: currentMapBuilder.capture(subject),
			path
		};
		else this.context = {
			parent: void 0,
			captures: [],
			subject,
			path
		};
		currentMapBuilder = this;
	}
	unregister() {
		currentMapBuilder = this.context.parent;
	}
	makeInput() {
		return new MapVariableHook(this, 0);
	}
	makeOutput(result) {
		let devalued;
		try {
			devalued = Devaluator.devaluate(result.value, void 0, this, result);
		} finally {
			result.dispose();
		}
		this.instructions.push(devalued);
		if (this.context.parent) {
			this.context.parent.instructions.push([
				"remap",
				this.context.subject,
				this.context.path,
				this.context.captures.map((cap) => ["import", cap]),
				this.instructions
			]);
			return new MapVariableHook(this.context.parent, this.context.parent.instructions.length);
		} else return this.context.subject.map(this.context.path, this.context.captures, this.instructions);
	}
	pushCall(hook, path, params) {
		let devalued = Devaluator.devaluate(params.value, void 0, this, params);
		devalued = devalued[0];
		let subject = this.capture(hook.dup());
		this.instructions.push([
			"pipeline",
			subject,
			path,
			devalued
		]);
		return new MapVariableHook(this, this.instructions.length);
	}
	pushGet(hook, path) {
		let subject = this.capture(hook.dup());
		this.instructions.push([
			"pipeline",
			subject,
			path
		]);
		return new MapVariableHook(this, this.instructions.length);
	}
	capture(hook) {
		if (hook instanceof MapVariableHook && hook.mapper === this) return hook.idx;
		let result = this.captureMap.get(hook);
		if (result === void 0) {
			if (this.context.parent) {
				let parentIdx = this.context.parent.capture(hook);
				this.context.captures.push(parentIdx);
			} else this.context.captures.push(hook);
			result = -this.context.captures.length;
			this.captureMap.set(hook, result);
		}
		return result;
	}
	exportStub(hook, _path) {
		throw new Error("Can't construct an RpcTarget or RPC callback inside a mapper function. Try creating a new RpcStub outside the callback first, then using it inside the callback.");
	}
	exportPromise(hook, _path) {
		return this.exportStub(hook);
	}
	getImport(hook) {
		return this.capture(hook);
	}
	unexport(ids) {}
	createPipe(readable) {
		throw new Error("Cannot send ReadableStream inside a mapper function.");
	}
	onSendError(error) {}
};
mapImpl.sendMap = (hook, path, func) => {
	let builder = new MapBuilder(hook, path);
	let result;
	try {
		result = RpcPayload.fromAppReturn(withCallInterceptor(builder.pushCall.bind(builder), () => {
			return func(new RpcPromise(builder.makeInput(), []));
		}));
	} finally {
		builder.unregister();
	}
	if (result instanceof Promise) {
		result.catch((err) => {});
		throw new Error("RPC map() callbacks cannot be async.");
	}
	return new RpcPromise(builder.makeOutput(result), []);
};
function throwMapperBuilderUseError() {
	throw new Error("Attempted to use an abstract placeholder from a mapper function. Please make sure your map function has no side effects.");
}
var MapVariableHook = class extends StubHook {
	constructor(mapper, idx) {
		super();
		this.mapper = mapper;
		this.idx = idx;
	}
	dup() {
		return this;
	}
	dispose() {}
	get(path) {
		if (path.length == 0) return this;
		else if (currentMapBuilder) return currentMapBuilder.pushGet(this, path);
		else throwMapperBuilderUseError();
	}
	call(path, args) {
		throwMapperBuilderUseError();
	}
	map(path, captures, instructions) {
		throwMapperBuilderUseError();
	}
	pull() {
		throwMapperBuilderUseError();
	}
	ignoreUnhandledRejections() {}
	onBroken(callback) {
		throwMapperBuilderUseError();
	}
};
function __experimental_recordInputPath(path) {
	let builder = new MapBuilder(new ErrorStubHook(/* @__PURE__ */ new Error("map-recorder-subject")), []);
	let result;
	try {
		let hook = builder.makeInput().get(path);
		result = RpcPayload.fromAppReturn(new RpcPromise(hook, []));
		let devalued = Devaluator.devaluate(result.value, void 0, builder, result);
		builder.instructions.push(devalued);
		return {
			captures: [],
			instructions: [...builder.instructions]
		};
	} finally {
		builder.unregister();
		result?.dispose();
	}
}
var MapApplicator = class {
	variables;
	constructor(captures, input) {
		this.captures = captures;
		this.variables = [input];
	}
	dispose() {
		for (let variable of this.variables) variable.dispose();
	}
	apply(instructions) {
		try {
			if (instructions.length < 1) throw new Error("Invalid empty mapper function.");
			for (let instruction of instructions.slice(0, -1)) {
				let payload = new Evaluator(this).evaluateCopy(instruction);
				if (payload.value instanceof RpcStub) {
					let hook = unwrapStubNoProperties(payload.value);
					if (hook) {
						this.variables.push(hook);
						continue;
					}
				}
				this.variables.push(new PayloadStubHook(payload));
			}
			return new Evaluator(this).evaluateCopy(instructions[instructions.length - 1]);
		} finally {
			for (let variable of this.variables) variable.dispose();
		}
	}
	importStub(idx) {
		throw new Error("A mapper function cannot refer to exports.");
	}
	importPromise(idx) {
		return this.importStub(idx);
	}
	getExport(idx) {
		if (idx < 0) return this.captures[-idx - 1];
		else return this.variables[idx];
	}
	getPipeReadable(exportId) {
		throw new Error("A mapper function cannot use pipe readables.");
	}
};
function applyMapToElement(input, parent, owner, captures, instructions) {
	let mapper = new MapApplicator(captures, new PayloadStubHook(RpcPayload.deepCopyFrom(input, parent, owner)));
	try {
		return mapper.apply(instructions);
	} finally {
		mapper.dispose();
	}
}
mapImpl.applyMap = (input, parent, owner, captures, instructions) => {
	try {
		let result;
		if (input instanceof RpcPromise) throw new Error("applyMap() can't be called on RpcPromise");
		else if (input instanceof Array) {
			let payloads = [];
			try {
				for (let elem of input) payloads.push(applyMapToElement(elem, input, owner, captures, instructions));
			} catch (err) {
				for (let payload of payloads) payload.dispose();
				throw err;
			}
			result = RpcPayload.fromArray(payloads);
		} else if (input === null || input === void 0) result = RpcPayload.fromAppReturn(input);
		else result = applyMapToElement(input, parent, owner, captures, instructions);
		return new PayloadStubHook(result);
	} finally {
		for (let cap of captures) cap.dispose();
	}
};
//#endregion
//#region ../src/rpc.ts
var ImportTableEntry = class {
	constructor(session, importId, pulling) {
		this.session = session;
		this.importId = importId;
		if (pulling) this.activePull = Promise.withResolvers();
	}
	localRefcount = 0;
	remoteRefcount = 1;
	activePull;
	resolution;
	onBrokenRegistrations;
	resolve(resolution) {
		if (this.localRefcount == 0) {
			resolution.dispose();
			return;
		}
		this.resolution = resolution;
		this.sendRelease();
		if (this.onBrokenRegistrations) {
			for (let i of this.onBrokenRegistrations) {
				let callback = this.session.onBrokenCallbacks[i];
				let endIndex = this.session.onBrokenCallbacks.length;
				resolution.onBroken(callback);
				if (this.session.onBrokenCallbacks[endIndex] === callback) delete this.session.onBrokenCallbacks[endIndex];
				else delete this.session.onBrokenCallbacks[i];
			}
			this.onBrokenRegistrations = void 0;
		}
		if (this.activePull) {
			this.activePull.resolve();
			this.activePull = void 0;
		}
	}
	async awaitResolution() {
		if (!this.activePull) {
			this.session.sendPull(this.importId);
			this.activePull = Promise.withResolvers();
		}
		await this.activePull.promise;
		return this.resolution.pull();
	}
	dispose() {
		if (this.resolution) this.resolution.dispose();
		else {
			this.abort(/* @__PURE__ */ new Error("RPC was canceled because the RpcPromise was disposed."));
			this.sendRelease();
		}
	}
	abort(error) {
		if (!this.resolution) {
			this.resolution = new ErrorStubHook(error);
			if (this.activePull) {
				this.activePull.reject(error);
				this.activePull = void 0;
			}
			this.onBrokenRegistrations = void 0;
		}
	}
	onBroken(callback) {
		if (this.resolution) this.resolution.onBroken(callback);
		else {
			let index = this.session.onBrokenCallbacks.length;
			this.session.onBrokenCallbacks.push(callback);
			if (!this.onBrokenRegistrations) this.onBrokenRegistrations = [];
			this.onBrokenRegistrations.push(index);
		}
	}
	sendRelease() {
		if (this.remoteRefcount > 0) {
			this.session.sendRelease(this.importId, this.remoteRefcount);
			this.remoteRefcount = 0;
		}
	}
	__experimental_debugState() {
		return {
			id: this.importId,
			localRefcount: this.localRefcount,
			remoteRefcount: this.remoteRefcount,
			hasResolution: !!this.resolution,
			resolutionType: this.resolution?.constructor?.name ?? null,
			hasActivePull: !!this.activePull
		};
	}
};
var RpcImportHook = class RpcImportHook extends StubHook {
	entry;
	constructor(isPromise, entry) {
		super();
		this.isPromise = isPromise;
		++entry.localRefcount;
		this.entry = entry;
	}
	collectPath(path) {
		return this;
	}
	getEntry() {
		if (this.entry) return this.entry;
		else throw new Error("This RpcImportHook was already disposed.");
	}
	call(path, args) {
		let entry = this.getEntry();
		if (entry.resolution) return entry.resolution.call(path, args);
		else return entry.session.sendCall(entry.importId, path, args);
	}
	stream(path, args) {
		let entry = this.getEntry();
		if (entry.resolution) return entry.resolution.stream(path, args);
		else return entry.session.sendStream(entry.importId, path, args);
	}
	map(path, captures, instructions) {
		let entry;
		try {
			entry = this.getEntry();
		} catch (err) {
			for (let cap of captures) cap.dispose();
			throw err;
		}
		if (entry.resolution) return entry.resolution.map(path, captures, instructions);
		else return entry.session.sendMap(entry.importId, path, captures, instructions);
	}
	get(path) {
		let entry = this.getEntry();
		if (entry.resolution) return entry.resolution.get(path);
		else return entry.session.sendCall(entry.importId, path);
	}
	dup() {
		return new RpcImportHook(false, this.getEntry());
	}
	pull() {
		let entry = this.getEntry();
		if (!this.isPromise) throw new Error("Can't pull this hook because it's not a promise hook.");
		if (entry.resolution) return entry.resolution.pull();
		return entry.awaitResolution();
	}
	ignoreUnhandledRejections() {}
	dispose() {
		let entry = this.entry;
		this.entry = void 0;
		if (entry) {
			if (--entry.localRefcount === 0) entry.dispose();
		}
	}
	onBroken(callback) {
		if (this.entry) this.entry.onBroken(callback);
	}
	__experimental_debugIdentity() {
		return {
			hookType: this.constructor?.name ?? null,
			isPromise: this.isPromise,
			entry: this.entry?.__experimental_debugState() ?? null
		};
	}
};
var RpcMainHook = class extends RpcImportHook {
	session;
	constructor(entry) {
		super(false, entry);
		this.session = entry.session;
	}
	dispose() {
		if (this.session) {
			let session = this.session;
			this.session = void 0;
			session.shutdown();
		}
	}
};
function cloneRpcExpr(value) {
	return JSON.parse(JSON.stringify(value));
}
function cloneRpcProvenance(provenance) {
	return {
		expr: cloneRpcExpr(provenance.expr),
		...provenance.captures ? { captures: cloneRpcExpr(provenance.captures) } : {},
		...provenance.instructions ? { instructions: cloneRpcExpr(provenance.instructions) } : {},
		...provenance.path ? { path: cloneRpcExpr(provenance.path) } : {}
	};
}
var RpcSessionImpl = class {
	exports = [];
	reverseExports = /* @__PURE__ */ new Map();
	imports = [];
	importReplays = [];
	abortReason;
	cancelReadLoop;
	nextExportId = -1;
	onBatchDone;
	pullCount = 0;
	currentNegativeExportProvenanceExpr;
	onBrokenCallbacks = [];
	constructor(transport, mainHook, options) {
		this.transport = transport;
		this.options = options;
		this.exports.push({
			hook: mainHook,
			refcount: 1
		});
		this.imports.push(new ImportTableEntry(this, 0, false));
		const snapshot = options.__experimental_restoreSnapshot;
		if (snapshot) this.restoreFromSnapshot(snapshot);
		let rejectFunc;
		let abortPromise = new Promise((resolve, reject) => {
			rejectFunc = reject;
		});
		this.cancelReadLoop = rejectFunc;
		this.readLoop(abortPromise).catch((err) => this.abort(err));
	}
	trace(phase, detail) {
		try {
			this.options.__experimental_trace?.({
				source: "rpc",
				phase,
				...detail ? { detail } : {}
			});
		} catch (_err) {}
	}
	evaluateWithCurrentProvenance(expr) {
		const previousExpr = this.currentNegativeExportProvenanceExpr;
		this.currentNegativeExportProvenanceExpr = expr;
		try {
			return new Evaluator(this).evaluate(expr);
		} finally {
			this.currentNegativeExportProvenanceExpr = previousExpr;
		}
	}
	getMainImport() {
		return new RpcMainHook(this.imports[0]);
	}
	shutdown() {
		this.abort(/* @__PURE__ */ new Error("RPC session was shut down by disposing the main stub"), false);
	}
	exportStub(hook, path) {
		if (this.abortReason) throw this.abortReason;
		let existingExportId = this.reverseExports.get(hook);
		if (existingExportId !== void 0) {
			++this.exports[existingExportId].refcount;
			this.trace("exportStub.reuse", {
				exportId: existingExportId,
				refcount: this.exports[existingExportId].refcount
			});
			return existingExportId;
		} else {
			let exportId = this.nextExportId--;
			this.exports[exportId] = {
				hook,
				refcount: 1,
				...this.currentNegativeExportProvenanceExpr !== void 0 ? { provenance: (() => {
					let mapProgram = __experimental_recordInputPath(path ?? []);
					return {
						expr: cloneRpcExpr(this.currentNegativeExportProvenanceExpr),
						captures: mapProgram.captures,
						instructions: mapProgram.instructions
					};
				})() } : {}
			};
			this.reverseExports.set(hook, exportId);
			this.trace("exportStub.new", {
				exportId,
				hookType: hook.constructor?.name ?? null
			});
			return exportId;
		}
	}
	exportPromise(hook, path) {
		if (this.abortReason) throw this.abortReason;
		let exportId = this.nextExportId--;
		this.exports[exportId] = {
			hook,
			refcount: 1,
			...this.currentNegativeExportProvenanceExpr !== void 0 ? { provenance: (() => {
				let mapProgram = __experimental_recordInputPath(path ?? []);
				return {
					expr: cloneRpcExpr(this.currentNegativeExportProvenanceExpr),
					captures: mapProgram.captures,
					instructions: mapProgram.instructions
				};
			})() } : {}
		};
		this.reverseExports.set(hook, exportId);
		this.trace("exportPromise.new", {
			exportId,
			hookType: hook.constructor?.name ?? null
		});
		this.ensureResolvingExport(exportId);
		return exportId;
	}
	unexport(ids) {
		for (let id of ids) this.releaseExport(id, 1);
	}
	releaseExport(exportId, refcount) {
		let entry = this.exports[exportId];
		if (!entry) {
			this.trace("releaseExport.missing", {
				exportId,
				refcount
			});
			return;
		}
		if (entry.refcount < refcount) throw new Error(`refcount would go negative: ${entry.refcount} < ${refcount}`);
		entry.refcount -= refcount;
		this.trace("releaseExport", {
			exportId,
			refcount,
			remainingRefcount: entry.refcount
		});
		if (entry.refcount === 0) {
			delete this.exports[exportId];
			if (entry.hook) {
				this.reverseExports.delete(entry.hook);
				entry.hook.dispose();
			}
		}
	}
	replacePositiveExport(exportId, entry) {
		if (exportId < 0) throw new Error(`Positive export slot expected, got ${exportId}`);
		let previous = this.exports[exportId];
		if (previous?.hook) {
			this.reverseExports.delete(previous.hook);
			previous.hook.dispose();
		}
		this.exports[exportId] = entry;
	}
	onSendError(error) {
		if (this.options.onSendError) return this.options.onSendError(error);
	}
	ensureResolvingExport(exportId) {
		let exp = this.exports[exportId];
		if (!exp) {
			this.trace("ensureResolvingExport.missing", { exportId });
			return;
		}
		if (!exp.pull) {
			this.trace("ensureResolvingExport.start", {
				exportId,
				hasHook: !!exp.hook,
				hasProvenance: !!exp.provenance
			});
			let resolve = async () => {
				let hook = this.getOrRestoreExportHook(exportId);
				this.trace("ensureResolvingExport.hookReady", {
					exportId,
					hookType: hook.constructor?.name ?? null
				});
				for (;;) {
					let payload = await hook.pull();
					if (payload.value instanceof RpcStub) {
						let { hook: inner, pathIfPromise } = unwrapStubAndPath(payload.value);
						if (pathIfPromise && pathIfPromise.length == 0) {
							if (this.getImport(hook) === void 0) {
								hook = inner;
								continue;
							}
						}
					}
					return payload;
				}
			};
			let autoRelease = exp.autoRelease;
			++this.pullCount;
			exp.pull = resolve().then((payload) => {
				const previousExpr = this.currentNegativeExportProvenanceExpr;
				this.currentNegativeExportProvenanceExpr = exp.provenance?.expr ?? exp.sourceExpr;
				let value;
				try {
					value = Devaluator.devaluate(payload.value, void 0, this, payload);
				} finally {
					this.currentNegativeExportProvenanceExpr = previousExpr;
				}
				this.trace("ensureResolvingExport.resolve", {
					exportId,
					valueType: typeof payload.value
				});
				this.send([
					"resolve",
					exportId,
					value
				]);
				if (autoRelease) this.releaseExport(exportId, 1);
			}, (error) => {
				this.trace("ensureResolvingExport.reject", {
					exportId,
					error: error instanceof Error ? error.message : String(error)
				});
				this.send([
					"reject",
					exportId,
					Devaluator.devaluate(error, void 0, this)
				]);
				if (autoRelease) this.releaseExport(exportId, 1);
			}).catch((error) => {
				try {
					this.trace("ensureResolvingExport.rejectSerialization", {
						exportId,
						error: error instanceof Error ? error.message : String(error)
					});
					this.send([
						"reject",
						exportId,
						Devaluator.devaluate(error, void 0, this)
					]);
					if (autoRelease) this.releaseExport(exportId, 1);
				} catch (error2) {
					this.abort(error2);
				}
			}).finally(() => {
				if (--this.pullCount === 0) {
					if (this.onBatchDone) this.onBatchDone.resolve();
				}
			});
		}
	}
	getImport(hook) {
		if (hook instanceof RpcImportHook && hook.entry && hook.entry.session === this) return hook.entry.importId;
		else return;
	}
	importStub(idx) {
		if (this.abortReason) throw this.abortReason;
		let entry = this.imports[idx];
		if (!entry) {
			entry = new ImportTableEntry(this, idx, false);
			this.imports[idx] = entry;
		}
		return new RpcImportHook(false, entry);
	}
	importPromise(idx) {
		if (this.abortReason) throw this.abortReason;
		if (this.imports[idx]) return new ErrorStubHook(/* @__PURE__ */ new Error("Bug in RPC system: The peer sent a promise reusing an existing export ID."));
		let entry = new ImportTableEntry(this, idx, true);
		this.imports[idx] = entry;
		return new RpcImportHook(true, entry);
	}
	getExport(idx) {
		if (!this.exports[idx]) return void 0;
		return this.getOrRestoreExportHook(idx);
	}
	__experimental_snapshot() {
		const imports = [];
		for (let i in this.imports) {
			let id = Number(i);
			if (id === 0) continue;
			if (id > 0) continue;
			let entry = this.imports[i];
			if (!entry) continue;
			if (entry.resolution) continue;
			imports.push({
				id,
				remoteRefcount: entry.remoteRefcount
			});
		}
		const exports = [];
		for (let i in this.exports) {
			let id = Number(i);
			if (id >= 0) continue;
			let entry = this.exports[i];
			if (!entry) continue;
			if (!entry.provenance) {
				console.error(`[capnweb] Export ${id} is not hibernatable (hook type: ${entry.hook?.constructor?.name ?? "none"}). It will be lost on hibernation. It needs intrinsic provenance.`);
				continue;
			}
			exports.push({
				id,
				refcount: entry.refcount,
				provenance: entry.provenance,
				...entry.pull ? { pulling: true } : {}
			});
		}
		return {
			version: 2,
			nextExportId: this.nextExportId,
			exports,
			...imports.length > 0 ? { imports } : {},
			...this.importReplays.length > 0 ? { importReplays: this.importReplays } : {}
		};
	}
	getPipeReadable(exportId) {
		let entry = this.exports[exportId];
		if (!entry || !entry.pipeReadable) throw new Error(`Export ${exportId} is not a pipe or its readable end was already consumed.`);
		let readable = entry.pipeReadable;
		entry.pipeReadable = void 0;
		return readable;
	}
	createPipe(readable, readableHook) {
		if (this.abortReason) throw this.abortReason;
		let importId = this.imports.length;
		let entry = new ImportTableEntry(this, importId, false);
		this.imports.push(entry);
		this.send(["pipe", importId]);
		let hook = new RpcImportHook(false, entry);
		let writable = streamImpl.createWritableStreamFromHook(hook);
		readable.pipeTo(writable).catch(() => {}).finally(() => readableHook.dispose());
		return importId;
	}
	send(msg) {
		if (this.abortReason !== void 0) return 0;
		let msgText;
		try {
			msgText = JSON.stringify(msg);
		} catch (err) {
			try {
				this.abort(err);
			} catch (err2) {}
			throw err;
		}
		this.trace("send", {
			kind: msg instanceof Array ? msg[0] : typeof msg,
			byteLength: msgText.length
		});
		this.transport.send(msgText).catch((err) => this.abort(err, false));
		return msgText.length;
	}
	sendCall(id, path, args) {
		if (this.abortReason) throw this.abortReason;
		let value = [
			"pipeline",
			id,
			path
		];
		if (args) {
			let devalue = Devaluator.devaluate(args.value, void 0, this, args);
			value.push(devalue[0]);
		}
		const importId = this.imports.length;
		this.send([
			"push",
			importId,
			value
		]);
		const entry = new ImportTableEntry(this, importId, false);
		this.imports.push(entry);
		this.trace("sendCall", {
			importId,
			targetImportId: id,
			pathLength: path.length,
			hasArgs: !!args
		});
		return new RpcImportHook(true, entry);
	}
	sendStream(id, path, args) {
		if (this.abortReason) throw this.abortReason;
		let value = [
			"pipeline",
			id,
			path
		];
		let devalue = Devaluator.devaluate(args.value, void 0, this, args);
		value.push(devalue[0]);
		const importId = this.imports.length;
		let size = this.send([
			"stream",
			importId,
			value
		]);
		let entry = new ImportTableEntry(this, importId, true);
		entry.remoteRefcount = 0;
		entry.localRefcount = 1;
		this.imports.push(entry);
		this.trace("sendStream", {
			importId,
			targetImportId: id,
			pathLength: path.length,
			size
		});
		return {
			promise: entry.awaitResolution().then((p) => {
				p.dispose();
				delete this.imports[importId];
			}, (err) => {
				delete this.imports[importId];
				throw err;
			}),
			size
		};
	}
	sendMap(id, path, captures, instructions) {
		if (this.abortReason) {
			for (let cap of captures) cap.dispose();
			throw this.abortReason;
		}
		let value = [
			"remap",
			id,
			path,
			captures.map((hook) => {
				let importId = this.getImport(hook);
				if (importId !== void 0) return ["import", importId];
				else return ["export", this.exportStub(hook)];
			}),
			instructions
		];
		const importId = this.imports.length;
		this.send([
			"push",
			importId,
			value
		]);
		const entry = new ImportTableEntry(this, importId, false);
		this.imports.push(entry);
		this.trace("sendMap", {
			importId,
			targetImportId: id,
			pathLength: path.length,
			captureCount: captures.length
		});
		return new RpcImportHook(true, entry);
	}
	sendPull(id) {
		if (this.abortReason) throw this.abortReason;
		this.send(["pull", id]);
		this.trace("sendPull", { importId: id });
	}
	sendRelease(id, remoteRefcount) {
		if (this.abortReason) return;
		this.send([
			"release",
			id,
			remoteRefcount
		]);
		this.trace("sendRelease", {
			importId: id,
			remoteRefcount
		});
		delete this.imports[id];
	}
	abort(error, trySendAbortMessage = true) {
		if (this.abortReason !== void 0) return;
		this.cancelReadLoop(error);
		if (trySendAbortMessage) try {
			this.transport.send(JSON.stringify(["abort", Devaluator.devaluate(error, void 0, this)])).catch((err) => {});
		} catch (err) {}
		if (error === void 0) error = "undefined";
		this.abortReason = error;
		this.trace("abort", {
			error: error instanceof Error ? error.message : String(error),
			trySendAbortMessage
		});
		if (this.onBatchDone) this.onBatchDone.reject(error);
		if (this.transport.abort) try {
			this.transport.abort(error);
		} catch (err) {
			Promise.resolve(err);
		}
		for (let i in this.onBrokenCallbacks) try {
			this.onBrokenCallbacks[i](error);
		} catch (err) {
			Promise.resolve(err);
		}
		for (let i in this.imports) this.imports[i].abort(error);
		for (let i in this.exports) this.exports[i].hook?.dispose();
	}
	async readLoop(abortPromise) {
		while (!this.abortReason) {
			let msg = JSON.parse(await Promise.race([this.transport.receive(), abortPromise]));
			if (this.abortReason) break;
			this.trace("receive", {
				kind: msg instanceof Array ? msg[0] : typeof msg,
				length: msg instanceof Array ? msg.length : null
			});
			if (msg instanceof Array) switch (msg[0]) {
				case "push":
					if (msg.length > 2 && typeof msg[1] === "number") {
						let exportId = msg[1];
						let sourceExpr = cloneRpcExpr(msg[2]);
						if (containsImportedCapabilityReference(msg[2])) {
							this.importReplays.push({ expr: sourceExpr });
							this.trace("readLoop.push.recordImportReplay", {
								exportId,
								replayCount: this.importReplays.length
							});
						}
						let hook = new PayloadStubHook(this.evaluateWithCurrentProvenance(msg[2]));
						hook.ignoreUnhandledRejections();
						this.replacePositiveExport(exportId, {
							hook,
							refcount: 1,
							sourceExpr
						});
						this.trace("readLoop.push", {
							exportId,
							hookType: hook.constructor?.name ?? null
						});
						continue;
					}
					break;
				case "stream":
					if (msg.length > 2 && typeof msg[1] === "number") {
						let exportId = msg[1];
						let sourceExpr = cloneRpcExpr(msg[2]);
						let hook = new PayloadStubHook(this.evaluateWithCurrentProvenance(msg[2]));
						hook.ignoreUnhandledRejections();
						this.replacePositiveExport(exportId, {
							hook,
							refcount: 1,
							sourceExpr,
							autoRelease: true
						});
						this.trace("readLoop.stream", {
							exportId,
							hookType: hook.constructor?.name ?? null
						});
						this.ensureResolvingExport(exportId);
						continue;
					}
					break;
				case "pipe":
					if (msg.length > 1 && typeof msg[1] === "number") {
						let exportId = msg[1];
						let { readable, writable } = new TransformStream();
						let hook = streamImpl.createWritableStreamHook(writable);
						this.replacePositiveExport(exportId, {
							hook,
							refcount: 1,
							pipeReadable: readable
						});
						this.trace("readLoop.pipe", { exportId });
						continue;
					}
					break;
				case "pull": {
					let exportId = msg[1];
					if (typeof exportId == "number") {
						this.trace("readLoop.pull", { exportId });
						this.ensureResolvingExport(exportId);
						continue;
					}
					break;
				}
				case "resolve":
				case "reject": {
					let importId = msg[1];
					if (typeof importId == "number" && msg.length > 2) {
						this.trace(`readLoop.${msg[0]}`, { importId });
						let imp = this.imports[importId];
						if (imp) if (msg[0] == "resolve") imp.resolve(new PayloadStubHook(new Evaluator(this).evaluate(msg[2])));
						else {
							let payload = new Evaluator(this).evaluate(msg[2]);
							payload.dispose();
							imp.resolve(new ErrorStubHook(payload.value));
						}
						else if (msg[0] == "resolve") new Evaluator(this).evaluate(msg[2]).dispose();
						continue;
					}
					break;
				}
				case "release": {
					let exportId = msg[1];
					let refcount = msg[2];
					if (typeof exportId == "number" && typeof refcount == "number") {
						this.trace("readLoop.release", {
							exportId,
							refcount
						});
						this.releaseExport(exportId, refcount);
						continue;
					}
					break;
				}
				case "abort": {
					this.trace("readLoop.abort");
					let payload = new Evaluator(this).evaluate(msg[1]);
					payload.dispose();
					this.abort(payload, false);
					break;
				}
			}
			throw new Error(`bad RPC message: ${JSON.stringify(msg)}`);
		}
	}
	async drain() {
		if (this.abortReason) throw this.abortReason;
		if (this.pullCount > 0) {
			let { promise, resolve, reject } = Promise.withResolvers();
			this.onBatchDone = {
				resolve,
				reject
			};
			await promise;
		}
	}
	getStats() {
		let result = {
			imports: 0,
			exports: 0
		};
		for (let i in this.imports) ++result.imports;
		for (let i in this.exports) ++result.exports;
		return result;
	}
	__experimental_debugState() {
		const exports = [];
		for (let i in this.exports) {
			const id = Number(i);
			const entry = this.exports[i];
			if (!entry) continue;
			exports.push({
				id,
				refcount: entry.refcount,
				hasHook: !!entry.hook,
				hookType: entry.hook?.constructor?.name ?? null,
				hookIdentity: entry.hook ? __experimental_debugStubHookIdentity(entry.hook) : null,
				provenance: entry.provenance ?? null,
				hasPull: !!entry.pull,
				autoRelease: !!entry.autoRelease,
				hasPipeReadable: !!entry.pipeReadable
			});
		}
		const imports = [];
		for (let i in this.imports) {
			const entry = this.imports[i];
			if (!entry) continue;
			imports.push(entry.__experimental_debugState());
		}
		return {
			nextExportId: this.nextExportId,
			abortReason: this.abortReason ? String(this.abortReason) : null,
			pullCount: this.pullCount,
			exports,
			imports
		};
	}
	getOrRestoreExportHook(exportId) {
		const entry = this.exports[exportId];
		if (!entry) throw new Error(`no such export ID: ${exportId}`);
		if (!entry.hook) if (entry.provenance) {
			let payload = new Evaluator(this).evaluate(cloneRpcExpr(entry.provenance.expr));
			let hook;
			if (entry.provenance.instructions) {
				const captures = (entry.provenance.captures ?? []).map((captureExpr) => {
					const capturePayload = new Evaluator(this).evaluate(cloneRpcExpr(captureExpr));
					const captureValue = capturePayload.value;
					if (!(captureValue instanceof RpcStub)) {
						capturePayload.dispose();
						throw new Error("Map provenance capture did not evaluate to an RpcStub.");
					}
					const { hook: captureHook, pathIfPromise } = unwrapStubAndPath(captureValue);
					capturePayload.dispose();
					if (pathIfPromise && pathIfPromise.length > 0) return captureHook.get(pathIfPromise);
					else if (pathIfPromise) return captureHook.get([]);
					else return captureHook.dup();
				});
				if (payload.value instanceof RpcStub) {
					const { hook: provenanceHook, pathIfPromise } = unwrapStubAndPath(payload.value);
					hook = provenanceHook.map(pathIfPromise ?? [], captures, cloneRpcExpr(entry.provenance.instructions));
					payload.dispose();
				} else hook = mapImpl.applyMap(payload.value, void 0, payload, captures, cloneRpcExpr(entry.provenance.instructions));
			} else {
				hook = new PayloadStubHook(payload);
				if (entry.provenance.path && entry.provenance.path.length > 0) {
					let derived = hook.get(entry.provenance.path);
					hook.dispose();
					hook = derived;
				}
			}
			entry.hook = hook;
			this.reverseExports.set(entry.hook, exportId);
			this.trace("getOrRestoreExportHook.replay", {
				exportId,
				pathLength: entry.provenance.path?.length ?? 0,
				instructionCount: entry.provenance.instructions?.length ?? 0,
				hookType: entry.hook.constructor?.name ?? null
			});
		} else throw new Error(`Export ${exportId} can't be restored after hibernation because it has no provenance.`);
		return entry.hook;
	}
	restoreFromSnapshot(snapshot) {
		if (snapshot.version !== 1 && snapshot.version !== 2) throw new Error(`Unsupported RPC session snapshot version: ${snapshot.version}`);
		this.nextExportId = snapshot.nextExportId;
		const pendingPulls = [];
		this.trace("restoreFromSnapshot.begin", {
			nextExportId: snapshot.nextExportId,
			exportCount: snapshot.exports.length,
			importCount: snapshot.imports?.length ?? 0
		});
		for (let exp of snapshot.exports) {
			this.exports[exp.id] = {
				refcount: exp.refcount,
				...exp.provenance ? { provenance: exp.provenance } : {}
			};
			this.trace("restoreFromSnapshot.export", {
				exportId: exp.id,
				refcount: exp.refcount,
				hasProvenance: !!exp.provenance,
				pulling: !!exp.pulling
			});
			if (exp.pulling) pendingPulls.push(exp.id);
		}
		if (snapshot.imports) for (let imp of snapshot.imports) {
			let entry = new ImportTableEntry(this, imp.id, false);
			entry.remoteRefcount = imp.remoteRefcount;
			this.imports[imp.id] = entry;
			this.trace("restoreFromSnapshot.import", {
				importId: imp.id,
				remoteRefcount: imp.remoteRefcount
			});
		}
		if (snapshot.importReplays && snapshot.importReplays.length > 0) {
			this.importReplays = snapshot.importReplays.map(cloneRpcProvenance);
			for (let replay of this.importReplays) {
				this.trace("restoreFromSnapshot.importReplay.begin", {
					hasCaptures: !!replay.captures?.length,
					instructionCount: replay.instructions?.length ?? 0,
					pathLength: replay.path?.length ?? 0
				});
				new Evaluator(this).evaluate(cloneRpcExpr(replay.expr)).dispose();
			}
		}
		if (pendingPulls.length > 0) queueMicrotask(() => {
			for (let id of pendingPulls) this.ensureResolvingExport(id);
		});
	}
	__experimental_getImportedStub(importId) {
		const entry = this.imports[importId];
		if (!entry) throw new Error(`no such import ID: ${importId}`);
		return new RpcStub(new RpcImportHook(false, entry));
	}
};
function containsImportedCapabilityReference(value) {
	if (!(value instanceof Array)) {
		if (value && typeof value === "object") {
			for (let nested of Object.values(value)) if (containsImportedCapabilityReference(nested)) return true;
		}
		return false;
	}
	if (value.length > 0 && (value[0] === "export" || value[0] === "promise")) return true;
	for (let nested of value) if (containsImportedCapabilityReference(nested)) return true;
	return false;
}
var RpcSession = class {
	#session;
	#mainStub;
	constructor(transport, localMain, options = {}) {
		let mainHook;
		if (localMain) mainHook = new PayloadStubHook(RpcPayload.fromAppReturn(localMain));
		else mainHook = new ErrorStubHook(/* @__PURE__ */ new Error("This connection has no main object."));
		this.#session = new RpcSessionImpl(transport, mainHook, options);
		this.#mainStub = new RpcStub(this.#session.getMainImport());
	}
	getRemoteMain() {
		return this.#mainStub;
	}
	getStats() {
		return this.#session.getStats();
	}
	drain() {
		return this.#session.drain();
	}
	__experimental_snapshot() {
		return this.#session.__experimental_snapshot();
	}
	__experimental_debugState() {
		return this.#session.__experimental_debugState();
	}
	__experimental_getImportedStub(importId) {
		return this.#session.__experimental_getImportedStub(importId);
	}
};
//#endregion
//#region ../src/websocket.ts
/**
* Cloudflare Durable Object-specific helper that restores an RPC session on top of a hibernating
* WebSocket accepted via `DurableObjectState.acceptWebSocket()`.
*
* This is intentionally not a general-purpose WebSocket API. It relies on workerd's
* `serializeAttachment()` / `deserializeAttachment()` behavior and the Durable Object
* `webSocketMessage()` / `webSocketClose()` / `webSocketError()` event delivery model.
*/
async function __experimental_newHibernatableWebSocketRpcSession$1(webSocket, localMain, options) {
	let attachment = getAttachment(webSocket);
	const sessionId = options.sessionId ?? attachment?.sessionId ?? makeSessionId();
	const trace = (event) => {
		try {
			options.__experimental_trace?.(event);
		} catch (_err) {}
	};
	let snapshot = attachment?.snapshot ?? (options.sessionStore ? await options.sessionStore.load(sessionId) : void 0);
	let rpc;
	let persistScheduled = false;
	let transport = new HibernatableWebSocketTransport(webSocket, () => {
		if (!persistScheduled) {
			persistScheduled = true;
			queueMicrotask(() => {
				persistScheduled = false;
				persistSnapshot();
			});
		}
	}, trace);
	try {
		rpc = new RpcSession(transport, localMain, {
			...options,
			__experimental_restoreSnapshot: snapshot,
			__experimental_trace: (event) => trace(event)
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("no such entry on exports table")) {
			trace({
				source: "transport",
				phase: "snapshot.restore.staleSession",
				detail: {
					error: msg,
					sessionId
				}
			});
			try {
				webSocket.close(1011, "stale session");
			} catch {}
			if (options.sessionStore) await options.sessionStore.delete(sessionId);
			return;
		}
		throw err;
	}
	await persistSnapshot();
	return {
		sessionId,
		getRemoteMain() {
			return rpc.getRemoteMain();
		},
		getStats() {
			return rpc.getStats();
		},
		__experimental_snapshot() {
			return rpc.__experimental_snapshot();
		},
		__experimental_debugState() {
			return rpc.__experimental_debugState();
		},
		handleMessage(message) {
			transport.pushIncoming(message);
		},
		handleClose(code, reason, wasClean) {
			transport.notifyClosed(code, reason, wasClean);
			if (options.sessionStore) options.sessionStore.delete(sessionId).catch((err) => {
				console.error(`[capnweb] Failed to delete session ${sessionId} from store:`, err);
			});
		},
		handleError(error) {
			transport.notifyError(error);
		}
	};
	async function persistSnapshot() {
		try {
			let snap = rpc.__experimental_snapshot();
			if (options.sessionStore) await options.sessionStore.save(sessionId, snap);
			let capnwebData = options.sessionStore ? {
				sessionId,
				version: 1
			} : {
				sessionId,
				version: 1,
				snapshot: snap
			};
			let existing = webSocket.deserializeAttachment?.() ?? {};
			if (typeof existing !== "object" || existing === null) existing = {};
			webSocket.serializeAttachment?.({
				...existing,
				__capnweb: capnwebData
			});
		} catch (err) {
			transport.abort?.(err);
		}
	}
}
function getAttachment(webSocket) {
	let raw = webSocket.deserializeAttachment?.();
	let attachment = raw?.__capnweb ?? raw;
	if (attachment?.version === 1 && typeof attachment.sessionId === "string") return attachment;
}
function makeSessionId() {
	if ("crypto" in globalThis && typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
	return `capnweb-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
var HibernatableWebSocketTransport = class {
	constructor(webSocket, onActivity, trace) {
		this.webSocket = webSocket;
		this.onActivity = onActivity;
		this.trace = trace;
	}
	#sendQueue;
	#receiveResolver;
	#receiveRejecter;
	#receiveQueue = [];
	#error;
	async send(message) {
		if (this.#error) throw this.#error;
		this.trace?.({
			source: "transport",
			phase: "send.attempt",
			detail: {
				readyState: this.webSocket.readyState,
				byteLength: message.length
			}
		});
		if (this.webSocket.readyState === WebSocket.CONNECTING) {
			if (!this.#sendQueue) this.#sendQueue = [];
			this.#sendQueue.push(message);
			this.trace?.({
				source: "transport",
				phase: "send.queued",
				detail: { queuedCount: this.#sendQueue.length }
			});
			return;
		}
		if (this.#sendQueue && this.#sendQueue.length > 0) {
			for (let queued of this.#sendQueue) this.webSocket.send(queued);
			this.trace?.({
				source: "transport",
				phase: "send.flushQueue",
				detail: { queuedCount: this.#sendQueue.length }
			});
			this.#sendQueue = void 0;
		}
		this.webSocket.send(message);
		this.trace?.({
			source: "transport",
			phase: "send.sent",
			detail: {
				readyState: this.webSocket.readyState,
				byteLength: message.length
			}
		});
		this.onActivity?.();
	}
	async receive() {
		if (this.#receiveQueue.length > 0) return this.#receiveQueue.shift();
		else if (this.#error) throw this.#error;
		else return new Promise((resolve, reject) => {
			this.#receiveResolver = resolve;
			this.#receiveRejecter = reject;
		});
	}
	abort(reason) {
		let message;
		if (reason instanceof Error) message = reason.message;
		else try {
			message = JSON.stringify(reason);
		} catch {
			message = `${reason}`;
		}
		try {
			this.webSocket.close(3e3, message);
		} catch (err) {}
		this.#setError(reason);
	}
	pushIncoming(message) {
		if (this.#error) return;
		this.trace?.({
			source: "transport",
			phase: "receive.incoming",
			detail: {
				messageType: typeof message,
				byteLength: typeof message === "string" ? message.length : message.byteLength
			}
		});
		if (typeof message !== "string") {
			this.#setError(/* @__PURE__ */ new TypeError("Received non-string message from hibernatable WebSocket."));
			return;
		}
		if (this.#receiveResolver) {
			this.#receiveResolver(message);
			this.#receiveResolver = void 0;
			this.#receiveRejecter = void 0;
		} else this.#receiveQueue.push(message);
		this.onActivity?.();
	}
	notifyClosed(code, reason, wasClean) {
		this.trace?.({
			source: "transport",
			phase: "socket.closed",
			detail: {
				code: code ?? null,
				reason: reason ?? null,
				wasClean: wasClean ?? null
			}
		});
		this.#setError(new Error(`Peer closed WebSocket: ${code ?? 1005} ${reason ?? ""}`.trim()));
	}
	notifyError(error) {
		this.trace?.({
			source: "transport",
			phase: "socket.error",
			detail: { error: error instanceof Error ? error.message : String(error) }
		});
		this.#setError(error instanceof Error ? error : /* @__PURE__ */ new Error(`${error}`));
	}
	#setError(reason) {
		if (!this.#error) {
			this.#error = reason;
			if (this.#receiveRejecter) {
				this.#receiveRejecter(reason);
				this.#receiveResolver = void 0;
				this.#receiveRejecter = void 0;
			}
		}
	}
};
//#endregion
//#region ../src/streams.ts
var WritableStreamStubHook = class WritableStreamStubHook extends StubHook {
	state;
	static create(stream) {
		return new WritableStreamStubHook({
			refcount: 1,
			writer: stream.getWriter(),
			closed: false
		});
	}
	constructor(state, dupFrom) {
		super();
		this.state = state;
		if (dupFrom) ++state.refcount;
	}
	getState() {
		if (this.state) return this.state;
		else throw new Error("Attempted to use a WritableStreamStubHook after it was disposed.");
	}
	call(path, args) {
		try {
			let state = this.getState();
			if (path.length !== 1 || typeof path[0] !== "string") throw new Error("WritableStream stub only supports direct method calls");
			const method = path[0];
			if (method !== "write" && method !== "close" && method !== "abort") {
				args.dispose();
				throw new Error(`Unknown WritableStream method: ${method}`);
			}
			if (method === "close" || method === "abort") state.closed = true;
			let func = state.writer[method];
			return new PromiseStubHook(args.deliverCall(func, state.writer).then((payload) => new PayloadStubHook(payload)));
		} catch (err) {
			return new ErrorStubHook(err);
		}
	}
	map(path, captures, instructions) {
		for (let cap of captures) cap.dispose();
		return new ErrorStubHook(/* @__PURE__ */ new Error("Cannot use map() on a WritableStream"));
	}
	get(path) {
		return new ErrorStubHook(/* @__PURE__ */ new Error("Cannot access properties on a WritableStream stub"));
	}
	dup() {
		return new WritableStreamStubHook(this.getState(), this);
	}
	pull() {
		return Promise.reject(/* @__PURE__ */ new Error("Cannot pull a WritableStream stub"));
	}
	ignoreUnhandledRejections() {}
	dispose() {
		let state = this.state;
		this.state = void 0;
		if (state) {
			if (--state.refcount === 0) {
				if (!state.closed) state.writer.abort(/* @__PURE__ */ new Error("WritableStream RPC stub was disposed without calling close()")).catch(() => {});
				state.writer.releaseLock();
			}
		}
	}
	onBroken(callback) {}
};
var INITIAL_WINDOW = 256 * 1024;
var MAX_WINDOW = 1024 * 1024 * 1024;
var MIN_WINDOW = 64 * 1024;
var STARTUP_GROWTH_FACTOR = 2;
var STEADY_GROWTH_FACTOR = 1.25;
var DECAY_FACTOR = .9;
var STARTUP_EXIT_ROUNDS = 3;
var FlowController = class {
	window = INITIAL_WINDOW;
	bytesInFlight = 0;
	inStartupPhase = true;
	delivered = 0;
	deliveredTime = 0;
	firstAckTime = 0;
	firstAckDelivered = 0;
	minRtt = Infinity;
	roundsWithoutIncrease = 0;
	lastRoundWindow = 0;
	roundStartTime = 0;
	constructor(now) {
		this.now = now;
	}
	onSend(size) {
		this.bytesInFlight += size;
		let token = {
			sentTime: this.now(),
			size,
			deliveredAtSend: this.delivered,
			deliveredTimeAtSend: this.deliveredTime,
			windowAtSend: this.window,
			windowFullAtSend: this.bytesInFlight >= this.window
		};
		return {
			token,
			shouldBlock: token.windowFullAtSend
		};
	}
	onError(token) {
		this.bytesInFlight -= token.size;
	}
	onAck(token) {
		let ackTime = this.now();
		this.delivered += token.size;
		this.deliveredTime = ackTime;
		this.bytesInFlight -= token.size;
		let rtt = ackTime - token.sentTime;
		this.minRtt = Math.min(this.minRtt, rtt);
		if (this.firstAckTime === 0) {
			this.firstAckTime = ackTime;
			this.firstAckDelivered = this.delivered;
		} else {
			let baseTime;
			let baseDelivered;
			if (token.deliveredTimeAtSend === 0) {
				baseTime = this.firstAckTime;
				baseDelivered = this.firstAckDelivered;
			} else {
				baseTime = token.deliveredTimeAtSend;
				baseDelivered = token.deliveredAtSend;
			}
			let interval = ackTime - baseTime;
			let bandwidth = (this.delivered - baseDelivered) / interval;
			let growthFactor = this.inStartupPhase ? STARTUP_GROWTH_FACTOR : STEADY_GROWTH_FACTOR;
			let newWindow = bandwidth * this.minRtt * growthFactor;
			newWindow = Math.min(newWindow, token.windowAtSend * growthFactor);
			if (token.windowFullAtSend) newWindow = Math.max(newWindow, token.windowAtSend * DECAY_FACTOR);
			else newWindow = Math.max(newWindow, this.window);
			this.window = Math.max(Math.min(newWindow, MAX_WINDOW), MIN_WINDOW);
			if (this.inStartupPhase && token.sentTime >= this.roundStartTime) {
				if (this.window > this.lastRoundWindow * STEADY_GROWTH_FACTOR) this.roundsWithoutIncrease = 0;
				else if (++this.roundsWithoutIncrease >= STARTUP_EXIT_ROUNDS) this.inStartupPhase = false;
				this.roundStartTime = ackTime;
				this.lastRoundWindow = this.window;
			}
		}
		return this.bytesInFlight < this.window;
	}
};
function createWritableStreamFromHook(hook) {
	let pendingError = void 0;
	let hookDisposed = false;
	let fc = new FlowController(() => performance.now());
	let windowResolve;
	let windowReject;
	const disposeHook = () => {
		if (!hookDisposed) {
			hookDisposed = true;
			hook.dispose();
		}
	};
	return new WritableStream({
		write(chunk, controller) {
			if (pendingError !== void 0) throw pendingError;
			const payload = RpcPayload.fromAppParams([chunk]);
			const { promise, size } = hook.stream(["write"], payload);
			if (size === void 0) return promise.catch((err) => {
				if (pendingError === void 0) pendingError = err;
				throw err;
			});
			else {
				let { token, shouldBlock } = fc.onSend(size);
				promise.then(() => {
					if (fc.onAck(token) && windowResolve) {
						windowResolve();
						windowResolve = void 0;
						windowReject = void 0;
					}
				}, (err) => {
					fc.onError(token);
					if (pendingError === void 0) {
						pendingError = err;
						controller.error(err);
						disposeHook();
					}
					if (windowReject) {
						windowReject(err);
						windowResolve = void 0;
						windowReject = void 0;
					}
				});
				if (shouldBlock) return new Promise((resolve, reject) => {
					windowResolve = resolve;
					windowReject = reject;
				});
			}
		},
		async close() {
			if (pendingError !== void 0) {
				disposeHook();
				throw pendingError;
			}
			const { promise } = hook.stream(["close"], RpcPayload.fromAppParams([]));
			try {
				await promise;
			} catch (err) {
				throw pendingError ?? err;
			} finally {
				disposeHook();
			}
		},
		abort(reason) {
			if (pendingError !== void 0) return;
			pendingError = reason ?? /* @__PURE__ */ new Error("WritableStream was aborted");
			if (windowReject) {
				windowReject(pendingError);
				windowResolve = void 0;
				windowReject = void 0;
			}
			const { promise } = hook.stream(["abort"], RpcPayload.fromAppParams([reason]));
			promise.then(() => disposeHook(), () => disposeHook());
		}
	});
}
var ReadableStreamStubHook = class ReadableStreamStubHook extends StubHook {
	state;
	static create(stream) {
		return new ReadableStreamStubHook({
			refcount: 1,
			stream,
			canceled: false
		});
	}
	constructor(state, dupFrom) {
		super();
		this.state = state;
		if (dupFrom) ++state.refcount;
	}
	call(path, args) {
		args.dispose();
		return new ErrorStubHook(/* @__PURE__ */ new Error("Cannot call methods on a ReadableStream stub"));
	}
	map(path, captures, instructions) {
		for (let cap of captures) cap.dispose();
		return new ErrorStubHook(/* @__PURE__ */ new Error("Cannot use map() on a ReadableStream"));
	}
	get(path) {
		return new ErrorStubHook(/* @__PURE__ */ new Error("Cannot access properties on a ReadableStream stub"));
	}
	dup() {
		let state = this.state;
		if (!state) throw new Error("Attempted to dup a ReadableStreamStubHook after it was disposed.");
		return new ReadableStreamStubHook(state, this);
	}
	pull() {
		return Promise.reject(/* @__PURE__ */ new Error("Cannot pull a ReadableStream stub"));
	}
	ignoreUnhandledRejections() {}
	dispose() {
		let state = this.state;
		this.state = void 0;
		if (state) {
			if (--state.refcount === 0) {
				if (!state.canceled) {
					state.canceled = true;
					if (!state.stream.locked) state.stream.cancel(/* @__PURE__ */ new Error("ReadableStream RPC stub was disposed without being consumed")).catch(() => {});
				}
			}
		}
	}
	onBroken(callback) {}
};
streamImpl.createWritableStreamHook = WritableStreamStubHook.create;
streamImpl.createWritableStreamFromHook = createWritableStreamFromHook;
streamImpl.createReadableStreamHook = ReadableStreamStubHook.create;
//#endregion
//#region ../src/hibernation.ts
function __experimental_newDurableObjectSessionStore(storage, prefix = "capnweb:session:") {
	return {
		async load(sessionId) {
			return await storage.get(`${prefix}${sessionId}`);
		},
		async save(sessionId, snapshot) {
			await storage.put(`${prefix}${sessionId}`, snapshot);
		},
		async delete(sessionId) {
			await storage.delete(`${prefix}${sessionId}`);
		},
		async deleteOrphans(liveSessionIds) {
			if (!storage.list) return 0;
			const stored = await storage.list({ prefix });
			const orphanKeys = [];
			for (const key of stored.keys()) {
				const sessionId = key.slice(prefix.length);
				if (!liveSessionIds.has(sessionId)) orphanKeys.push(key);
			}
			if (orphanKeys.length > 0) await storage.delete(orphanKeys);
			return orphanKeys.length;
		}
	};
}
//#endregion
//#region ../src/index.ts
var RpcTarget = RpcTarget$1;
var __experimental_newHibernatableWebSocketRpcSession = __experimental_newHibernatableWebSocketRpcSession$1;
//#endregion
//#region src/index.ts
var DurableCounterProxy = class extends RpcTarget {
	constructor(ctx, key) {
		super();
		this.ctx = ctx;
		this.key = key;
	}
	async increment(amount = 1) {
		const next = (await this.ctx.storage.get(`counter:${this.key}`) ?? 0) + amount;
		await this.ctx.storage.put(`counter:${this.key}`, next);
		return next;
	}
	getValue() {
		return this.ctx.storage.get(`counter:${this.key}`).then((v) => v ?? 0);
	}
};
var ChatRoomProxy = class extends RpcTarget {
	constructor(env, roomName) {
		super();
		this.env = env;
		this.roomName = roomName;
	}
	async postMessage(user, text) {
		return this.env.CHAT_ROOM.getByName(this.roomName).postMessage(user, text);
	}
	async listMessages() {
		return this.env.CHAT_ROOM.getByName(this.roomName).listMessages();
	}
	async getMessageCount() {
		return this.env.CHAT_ROOM.getByName(this.roomName).getMessageCount();
	}
};
var HiddenArgProbe = class extends RpcTarget {
	#secret;
	constructor(ctx, label, secret) {
		super();
		this.ctx = ctx;
		this.label = label;
		this.#secret = secret;
	}
	async getStorageKind() {
		return this.ctx.storage.constructor?.name ?? "unknown";
	}
	getVisibleLabel() {
		return this.label;
	}
	getSecretEcho() {
		return this.#secret;
	}
	getSecretLength() {
		return this.#secret.length;
	}
};
var ChatRoomCapability = class extends RpcTarget {
	constructor(ctx, roomName) {
		super();
		this.ctx = ctx;
		this.roomName = roomName;
	}
	async postMessage(user, text) {
		const messages = await this.ctx.storage.get("messages") ?? [];
		const last = {
			user,
			text,
			at: Date.now()
		};
		messages.push(last);
		await this.ctx.storage.put("messages", messages);
		return {
			count: messages.length,
			last
		};
	}
	async listMessages() {
		return await this.ctx.storage.get("messages") ?? [];
	}
	async getMessageCount() {
		return (await this.ctx.storage.get("messages") ?? []).length;
	}
};
var ChatRoomRootTarget = class extends RpcTarget {
	constructor(ctx, roomName, host) {
		super();
		this.ctx = ctx;
		this.roomName = roomName;
		this.host = host;
	}
	getRoomCapability() {
		return new ChatRoomCapability(this.ctx, this.roomName);
	}
	getInstanceId() {
		return this.host.instanceId;
	}
};
var ChatRoomDo = class extends DurableObject {
	instanceId;
	roomSessionStore;
	roomSessions = /* @__PURE__ */ new Map();
	roomReady;
	constructor(ctx, env) {
		super(ctx, env);
		this.instanceId = crypto.randomUUID();
		this.roomSessionStore = __experimental_newDurableObjectSessionStore(ctx.storage, "room-hib:");
		console.log("[ChatRoomDo] constructor", JSON.stringify({
			instanceId: this.instanceId,
			existingSocketCount: this.ctx.getWebSockets("capnweb-room").length,
			at: (/* @__PURE__ */ new Date()).toISOString()
		}));
		this.roomReady = this.restoreRoomSessions();
	}
	async fetch(req) {
		const url = new URL(req.url);
		console.log("[ChatRoomDo] fetch", JSON.stringify({
			instanceId: this.instanceId,
			pathname: url.pathname,
			method: req.method,
			at: (/* @__PURE__ */ new Date()).toISOString()
		}));
		if (url.pathname === "/instance-id") return Response.json({ instanceId: this.instanceId });
		if (url.pathname === "/diagnostics") {
			const messages = await this.ctx.storage.get("messages") ?? [];
			return Response.json({
				instanceId: this.instanceId,
				messageCount: messages.length,
				lastMessage: messages.at(-1) ?? null
			});
		}
		if (url.pathname === "/ws") {
			if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket upgrade", { status: 426 });
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);
			this.ctx.acceptWebSocket(server, ["capnweb-room"]);
			await this.roomReady;
			await this.attachRoomSession(server);
			return new Response(null, {
				status: 101,
				webSocket: client
			});
		}
		return new Response("Not found", { status: 404 });
	}
	async postMessage(user, text) {
		const messages = await this.ctx.storage.get("messages") ?? [];
		const last = {
			user,
			text,
			at: Date.now()
		};
		messages.push(last);
		await this.ctx.storage.put("messages", messages);
		return {
			count: messages.length,
			last
		};
	}
	async listMessages() {
		return await this.ctx.storage.get("messages") ?? [];
	}
	async getMessageCount() {
		return (await this.ctx.storage.get("messages") ?? []).length;
	}
	getRoomCapability(roomName) {
		return new ChatRoomCapability(this.ctx, roomName);
	}
	async webSocketMessage(ws, message) {
		await this.roomReady;
		(await this.getOrAttachRoomSession(ws)).handleMessage(message);
	}
	async webSocketClose(ws, code, reason, wasClean) {
		await this.roomReady;
		const sid = this.getRoomSessionId(ws);
		(sid ? this.roomSessions.get(sid) : void 0)?.handleClose(code, reason, wasClean);
		if (sid) this.roomSessions.delete(sid);
	}
	async webSocketError(ws, error) {
		await this.roomReady;
		const sid = this.getRoomSessionId(ws);
		(sid ? this.roomSessions.get(sid) : void 0)?.handleError(error);
	}
	async restoreRoomSessions() {
		for (const ws of this.ctx.getWebSockets("capnweb-room")) await this.attachRoomSession(ws);
	}
	async getOrAttachRoomSession(ws) {
		const sid = this.getRoomSessionId(ws);
		if (sid && this.roomSessions.has(sid)) return this.roomSessions.get(sid);
		return this.attachRoomSession(ws);
	}
	async attachRoomSession(ws) {
		const knownSessionId = this.getRoomSessionId(ws);
		const session = await __experimental_newHibernatableWebSocketRpcSession(ws, new ChatRoomRootTarget(this.ctx, "direct-room", this), {
			sessionStore: this.roomSessionStore,
			onSendError(err) {
				return err;
			},
			sessionId: knownSessionId
		});
		this.roomSessions.set(session.sessionId, session);
		return session;
	}
	getRoomSessionId(ws) {
		const raw = ws.deserializeAttachment?.();
		const attachment = raw?.__capnweb ?? raw;
		if (attachment && attachment.version === 1 && typeof attachment.sessionId === "string") return attachment.sessionId;
	}
};
var RootTarget = class extends RpcTarget {
	constructor(ctx, env, host) {
		super();
		this.ctx = ctx;
		this.env = env;
		this.host = host;
	}
	getDurableCounter(key) {
		return new DurableCounterProxy(this.ctx, key);
	}
	getChatRoom(roomName) {
		return new ChatRoomProxy(this.env, roomName);
	}
	getHiddenArgProbe(label, secret) {
		return new HiddenArgProbe(this.ctx, label, secret);
	}
	storeClientCallback(name, callback) {
		this.host.clientCallbacks.set(name, typeof callback?.dup === "function" ? callback.dup() : callback);
		return this.host.clientCallbacks.size;
	}
	getStoredClientCallbackCount() {
		return this.host.clientCallbacks.size;
	}
	clearStoredClientCallbacks() {
		this.host.clientCallbacks.clear();
		return 0;
	}
	async invokeStoredClientCallback(name, message) {
		const callback = this.host.clientCallbacks.get(name);
		if (!callback) throw new Error(`No stored client callback named ${name}`);
		return callback.notify(message);
	}
	square(n) {
		return n * n;
	}
	echo(msg) {
		return msg;
	}
	getInstanceId() {
		return this.host.instanceId;
	}
	async delayedDurableIncrement(name, amount = 1, delayMs = 10) {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		return this.getDurableCounter(name).increment(amount);
	}
};
var HibRpcDo = class extends DurableObject {
	sessionStore;
	sessions = /* @__PURE__ */ new Map();
	ready;
	instanceId;
	restoreAttempts = 0;
	restoreSuccesses = 0;
	attachSessionCalls = 0;
	webSocketMessageCount = 0;
	reusedSessionCount = 0;
	createdSessionCount = 0;
	lastMessageKind = null;
	sessionTraces = /* @__PURE__ */ new Map();
	clientCallbacks = /* @__PURE__ */ new Map();
	constructor(ctx, env) {
		super(ctx, env);
		this.instanceId = crypto.randomUUID();
		this.sessionStore = __experimental_newDurableObjectSessionStore(ctx.storage, "hib:");
		const existingSockets = this.ctx.getWebSockets("capnweb");
		console.log("[HibRpcDo] constructor", JSON.stringify({
			instanceId: this.instanceId,
			existingSocketCount: existingSockets.length,
			wakeReason: existingSockets.length > 0 ? "hibernation-wake-or-restart-with-open-sockets" : "fresh-init",
			at: (/* @__PURE__ */ new Date()).toISOString()
		}));
		this.ready = this.restoreSessions();
	}
	async fetch(req) {
		const url = new URL(req.url);
		console.log("[HibRpcDo] fetch", JSON.stringify({
			instanceId: this.instanceId,
			pathname: url.pathname,
			method: req.method,
			upgrade: req.headers.get("Upgrade") ?? null,
			at: (/* @__PURE__ */ new Date()).toISOString()
		}));
		if (url.pathname === "/instance-id") return Response.json({ instanceId: this.instanceId });
		if (url.pathname === "/attachments") {
			const attachments = this.ctx.getWebSockets("capnweb").map((ws) => {
				const attachment = ws.deserializeAttachment?.();
				return {
					sessionId: attachment?.sessionId ?? null,
					version: attachment?.version ?? null,
					hasSnapshot: !!attachment?.snapshot,
					snapshot: attachment?.snapshot ? {
						nextExportId: attachment.snapshot.nextExportId ?? null,
						exportCount: attachment.snapshot.exports?.length ?? 0,
						importCount: attachment.snapshot.imports?.length ?? 0
					} : null
				};
			});
			return Response.json({
				instanceId: this.instanceId,
				count: attachments.length,
				attachments
			});
		}
		if (url.pathname === "/resume-diagnostics") {
			const diagnostics = this.ctx.getWebSockets("capnweb").map((ws) => {
				const attachment = ws.deserializeAttachment?.();
				const sessionId = attachment?.sessionId;
				const session = sessionId ? this.sessions.get(sessionId) : void 0;
				let snapshot = null;
				let debugState = null;
				try {
					snapshot = session?.__experimental_snapshot?.();
				} catch (err) {
					snapshot = { error: err?.message ?? `${err}` };
				}
				try {
					debugState = session?.__experimental_debugState?.() ?? null;
				} catch (err) {
					debugState = { error: err?.message ?? `${err}` };
				}
				return {
					sessionId: sessionId ?? null,
					hasAttachment: !!attachment,
					hasSnapshot: !!attachment?.snapshot,
					hasSession: !!session,
					stats: session?.getStats?.() ?? null,
					attachmentSnapshot: attachment?.snapshot ? {
						nextExportId: attachment.snapshot.nextExportId ?? null,
						exportCount: attachment.snapshot.exports?.length ?? 0,
						importCount: attachment.snapshot.imports?.length ?? 0
					} : null,
					snapshot: snapshot ? {
						nextExportId: snapshot.nextExportId ?? null,
						exportCount: snapshot.exports?.length ?? 0,
						importCount: snapshot.imports?.length ?? 0,
						error: snapshot.error ?? null
					} : null,
					debugState,
					traces: sessionId ? this.sessionTraces.get(sessionId) ?? [] : []
				};
			});
			return Response.json({
				instanceId: this.instanceId,
				sessionCount: this.sessions.size,
				counters: {
					restoreAttempts: this.restoreAttempts,
					restoreSuccesses: this.restoreSuccesses,
					attachSessionCalls: this.attachSessionCalls,
					webSocketMessageCount: this.webSocketMessageCount,
					reusedSessionCount: this.reusedSessionCount,
					createdSessionCount: this.createdSessionCount,
					lastMessageKind: this.lastMessageKind,
					clientCallbackCount: this.clientCallbacks.size
				},
				sessions: diagnostics
			});
		}
		if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket upgrade", { status: 426 });
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server, ["capnweb"]);
		await this.ready;
		await this.attachSession(server);
		return new Response(null, {
			status: 101,
			webSocket: client
		});
	}
	async webSocketMessage(ws, message) {
		await this.ready;
		this.webSocketMessageCount += 1;
		this.lastMessageKind = typeof message === "string" ? "string" : `binary(${message.byteLength})`;
		console.log("[HibRpcDo] webSocketMessage", JSON.stringify({
			instanceId: this.instanceId,
			sessionId: this.getSessionId(ws) ?? null,
			messageKind: this.lastMessageKind,
			webSocketMessageCount: this.webSocketMessageCount,
			at: (/* @__PURE__ */ new Date()).toISOString()
		}));
		(await this.getOrAttachSession(ws)).handleMessage(message);
	}
	async webSocketClose(ws, code, reason, wasClean) {
		await this.ready;
		const sid = this.getSessionId(ws);
		console.log("[HibRpcDo] webSocketClose", JSON.stringify({
			instanceId: this.instanceId,
			sessionId: sid ?? null,
			code,
			reason,
			wasClean,
			at: (/* @__PURE__ */ new Date()).toISOString()
		}));
		(sid ? this.sessions.get(sid) : void 0)?.handleClose(code, reason, wasClean);
		if (sid) this.sessions.delete(sid);
	}
	async webSocketError(ws, error) {
		await this.ready;
		const sid = this.getSessionId(ws);
		console.log("[HibRpcDo] webSocketError", JSON.stringify({
			instanceId: this.instanceId,
			sessionId: sid ?? null,
			error: error instanceof Error ? error.message : String(error),
			at: (/* @__PURE__ */ new Date()).toISOString()
		}));
		(sid ? this.sessions.get(sid) : void 0)?.handleError(error);
	}
	async restoreSessions() {
		console.log("[HibRpcDo] restoreSessions.begin", JSON.stringify({
			instanceId: this.instanceId,
			socketCount: this.ctx.getWebSockets("capnweb").length,
			at: (/* @__PURE__ */ new Date()).toISOString()
		}));
		for (const ws of this.ctx.getWebSockets("capnweb")) {
			this.restoreAttempts += 1;
			await this.attachSession(ws);
			this.restoreSuccesses += 1;
		}
		console.log("[HibRpcDo] restoreSessions.end", JSON.stringify({
			instanceId: this.instanceId,
			restoreAttempts: this.restoreAttempts,
			restoreSuccesses: this.restoreSuccesses,
			sessionCount: this.sessions.size,
			at: (/* @__PURE__ */ new Date()).toISOString()
		}));
	}
	async getOrAttachSession(ws) {
		const sid = this.getSessionId(ws);
		if (sid && this.sessions.has(sid)) {
			this.reusedSessionCount += 1;
			return this.sessions.get(sid);
		}
		this.createdSessionCount += 1;
		return this.attachSession(ws);
	}
	async attachSession(ws) {
		this.attachSessionCalls += 1;
		const knownSessionId = this.getSessionId(ws);
		console.log("[HibRpcDo] attachSession.begin", JSON.stringify({
			instanceId: this.instanceId,
			knownSessionId: knownSessionId ?? null,
			attachSessionCalls: this.attachSessionCalls,
			at: (/* @__PURE__ */ new Date()).toISOString()
		}));
		const session = await __experimental_newHibernatableWebSocketRpcSession(ws, new RootTarget(this.ctx, this.env, this), {
			sessionStore: this.sessionStore,
			onSendError(err) {
				return err;
			},
			sessionId: knownSessionId,
			__experimental_trace: (event) => {
				const sessionId = this.getSessionId(ws) ?? knownSessionId ?? "pending";
				this.pushTrace(sessionId, event);
				if (event.phase === "receive" || event.phase === "readLoop.push" || event.phase === "readLoop.pull" || event.phase === "readLoop.resolve" || event.phase === "readLoop.reject" || event.phase === "send" || event.phase === "ensureResolvingExport.start" || event.phase === "ensureResolvingExport.resolve" || event.phase === "ensureResolvingExport.reject" || event.phase === "getOrRestoreExportHook.restore") console.log("[HibRpcDo] trace", JSON.stringify({
					instanceId: this.instanceId,
					sessionId,
					source: event.source,
					phase: event.phase,
					detail: event.detail ?? null,
					at: (/* @__PURE__ */ new Date()).toISOString()
				}));
			}
		});
		this.sessions.set(session.sessionId, session);
		if (knownSessionId && knownSessionId !== session.sessionId) {
			const pending = this.sessionTraces.get(knownSessionId);
			if (pending) {
				this.sessionTraces.delete(knownSessionId);
				this.sessionTraces.set(session.sessionId, pending);
			}
		}
		this.pushTrace(session.sessionId, {
			source: "worker",
			phase: "attachSession.complete",
			detail: { knownSessionId: knownSessionId ?? null }
		});
		console.log("[HibRpcDo] attachSession.end", JSON.stringify({
			instanceId: this.instanceId,
			sessionId: session.sessionId,
			sessionCount: this.sessions.size,
			at: (/* @__PURE__ */ new Date()).toISOString()
		}));
		return session;
	}
	getSessionId(ws) {
		const raw = ws.deserializeAttachment?.();
		const attachment = raw?.__capnweb ?? raw;
		if (attachment && attachment.version === 1 && typeof attachment.sessionId === "string") return attachment.sessionId;
	}
	pushTrace(sessionId, event) {
		const current = this.sessionTraces.get(sessionId) ?? [];
		current.push({
			at: Date.now(),
			source: event.source,
			phase: event.phase,
			...event.detail ? { detail: event.detail } : {}
		});
		if (current.length > 200) current.splice(0, current.length - 200);
		this.sessionTraces.set(sessionId, current);
	}
};
//#endregion
//#region \0virtual:cloudflare/worker-entry
var worker_entry_default = { async fetch(request, env) {
	const url = new URL(request.url);
	if (url.pathname === "/ws" || url.pathname === "/instance-id" || url.pathname === "/attachments" || url.pathname === "/resume-diagnostics") return env.HIB_RPC.getByName("test").fetch(request);
	if (url.pathname === "/chat-room-instance" || url.pathname === "/chat-room-diagnostics") {
		const roomName = url.searchParams.get("room");
		if (!roomName) return new Response("Missing room query parameter", { status: 400 });
		const stub = env.CHAT_ROOM.getByName(roomName);
		const innerUrl = new URL(request.url);
		innerUrl.pathname = url.pathname === "/chat-room-instance" ? "/instance-id" : "/diagnostics";
		return stub.fetch(new Request(innerUrl.toString(), request));
	}
	if (url.pathname === "/chat-room-ws") {
		const roomName = url.searchParams.get("room");
		if (!roomName) return new Response("Missing room query parameter", { status: 400 });
		const stub = env.CHAT_ROOM.getByName(roomName);
		const innerUrl = new URL(request.url);
		innerUrl.pathname = "/ws";
		return stub.fetch(new Request(innerUrl.toString(), request));
	}
	return new Response("Not found", { status: 404 });
} };
//#endregion
export { ChatRoomDo, HibRpcDo, worker_entry_default as default };
