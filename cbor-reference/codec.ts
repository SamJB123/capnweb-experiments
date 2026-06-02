// ───────────────────────────────────────────────────────────────────────────
// REFERENCE ARTIFACT — NOT LIVE CODE. DO NOT IMPORT.
//
// This is the evolved CBOR codec lifted verbatim from the old `cbor` branch
// (branch `cbor`, src/codec.ts @ tip 2ef670f). It is preserved here only as a
// study reference for reviving optional cbor-x support. It does NOT compile in
// this tree: its imports (`./message-types.js`, `./hibernation.js`) refer to the
// old branch's hibernation files, which intentionally do not exist here.
//
// Do not wire this up verbatim. See cbor-reference/README.md for why, and for
// the stateful-codec-vs-hibernation problem this file both illustrates and
// (naively) attempts to solve via __experimental_snapshotState/restoreState.
// ───────────────────────────────────────────────────────────────────────────

// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { Encoder, Decoder, Tag } from 'cbor-x'
import type { PropertyPath } from './core.js'
import type { MessageEncodingMode } from './message-types.js'
import type { RpcSessionSnapshot } from './hibernation.js'
import {
	MessageTypeId,
	MessageTypeById,
	ExpressionTypeId,
	ExpressionTypeById,
	type MessageTypeName,
	type ExpressionTypeName,
} from './message-types.js'


// CBOR tag for RPC messages. Using tag 39999 (unassigned private use range).
// This allows us to distinguish RPC messages from arbitrary data.
const RPC_MESSAGE_TAG = 39999

// Path reference format: first occurrence sends definition, subsequent send reference
// Definition: { _pd: id, p: path } - defines and uses path
// Reference: { _pr: id } - references previously defined path
type PathDefinition = { _pd: number; p: PropertyPath }
type PathReference = { _pr: number }

function isPathDefinition(value: unknown): value is PathDefinition {
	return (
		typeof value === 'object' &&
		value !== null &&
		'_pd' in value &&
		'p' in value &&
		typeof (value as PathDefinition)._pd === 'number' &&
		Array.isArray((value as PathDefinition).p)
	)
}

function isPathReference(value: unknown): value is PathReference {
	return (
		typeof value === 'object' &&
		value !== null &&
		'_pr' in value &&
		typeof (value as PathReference)._pr === 'number'
	)
}

// String interning format: first occurrence sends definition, subsequent send reference
// Definition: { _sd: id, s: "string" } - defines and uses string
// Reference: { _sr: id } - references previously defined string
type StringDefinition = { _sd: number; s: string }
type StringReference = { _sr: number }

// Minimum string length to intern (avoid overhead for tiny strings)
const MIN_INTERN_LENGTH = 4

function isStringDefinition(value: unknown): value is StringDefinition {
	return (
		typeof value === 'object' &&
		value !== null &&
		'_sd' in value &&
		's' in value &&
		typeof (value as StringDefinition)._sd === 'number' &&
		typeof (value as StringDefinition).s === 'string'
	)
}

function isStringReference(value: unknown): value is StringReference {
	return (
		typeof value === 'object' &&
		value !== null &&
		'_sr' in value &&
		typeof (value as StringReference)._sr === 'number'
	)
}

/**
 * CBOR codec for Cap'n Web RPC messages.
 *
 * Uses cbor-x for efficient binary serialization with sequential mode enabled.
 * Sequential mode embeds structure definitions inline in the stream, allowing
 * the decoder to learn structures automatically without prior coordination.
 *
 * Key benefits:
 * - 2-3x faster decoding (compiled structure readers)
 * - 15-50% smaller messages for repeated object shapes
 * - No manual structure coordination between encoder/decoder
 *
 * Additionally implements PropertyPath reference caching:
 * - First occurrence of a path sends the full definition with an ID
 * - Subsequent occurrences send only a compact reference
 * - Typically reduces path encoding from 15-30 bytes to 3-5 bytes
 *
 * IMPORTANT: Each RPC session should create its own CborCodec instance to
 * maintain proper structure state. The singleton `cborCodec` is only for
 * standalone/testing use.
 */
export class CborCodec {
	private encoder: Encoder
	private decoder: Decoder
	// Structures array for record encoding/decoding.
	// When sequential: true, encoder and decoder can use separate arrays because
	// structure definitions are embedded inline in the stream.
	// When sequential: false, encoder and decoder MUST share the same array
	// so the decoder can look up structures that the encoder defined.
	private encoderStructures: object[] = []
	private decoderStructures: object[] = []

	// PropertyPath reference caching
	// Encoder side: maps stringified path to assigned ID
	private encodePathRegistry = new Map<string, number>()
	// Decoder side: maps ID to path (array index = ID)
	private decodePathRegistry: PropertyPath[] = []
	private nextPathId = 0

	// String interning (session-scoped)
	// Encoder side: maps string to assigned ID
	private encodeStringRegistry = new Map<string, number>()
	// Decoder side: maps ID to string (array index = ID)
	private decodeStringRegistry: string[] = []
	private nextStringId = 0

	/**
	 * The message encoding mode for RPC type identifiers.
	 * - 'array': String type names as array first element ["push", ...]
	 * - 'object': Type name as object key {push: ...} (enables CBOR structure optimization)
	 * - 'numeric': Numeric type IDs [0, ...] (minimal overhead, MoQ-style)
	 */
	readonly messageEncodingMode: MessageEncodingMode

	// Store options for reset
	private readonly options: { sequential: boolean; pack: boolean }

	constructor(options: { sequential?: boolean; messageEncodingMode?: MessageEncodingMode; pack?: boolean } = {}) {
		this.messageEncodingMode = options.messageEncodingMode ?? 'array'
		// With sequential mode (default), maxSharedStructures is automatically set to 0,
		// which means EVERY object gets an inline structure definition (tag 0xDFFF).
		//
		// IMPORTANT: The decoder MUST have a structures array to store the inline
		// definitions it receives. Without this, it can't reconstruct objects from
		// the record format.
		const sequential = options.sequential ?? true
		const pack = options.pack ?? false
		this.options = { sequential, pack }

		// When not using sequential mode, share the structures array between
		// encoder and decoder so that structure IDs resolve correctly.
		const sharedStructures = sequential ? undefined : this.encoderStructures

		this.encoder = new Encoder({
			sequential,
			useRecords: true,
			encodeUndefinedAsNil: false,
			tagUint8Array: true,
			pack,
			structures: sharedStructures ?? this.encoderStructures,
		})

		this.decoder = new Decoder({
			sequential,
			useRecords: true,
			structures: sharedStructures ?? this.decoderStructures,
		})
	}

	/**
	 * EXPERIMENTAL (NOT YET FUNCTIONAL): Reset the codec state.
	 *
	 * Intended to clear all accumulated state (structure definitions, path cache,
	 * string interning) so the codec can communicate with a fresh peer after
	 * server hibernation.
	 *
	 * @experimental This is part of an incomplete attempt at Hibernatable WebSocket support.
	 * The hibernation feature does not yet work. May change significantly or be removed.
	 */
	__experimental_reset(): void {
		// Clear structure arrays
		this.encoderStructures.length = 0
		this.decoderStructures.length = 0

		// Clear path caching
		this.encodePathRegistry.clear()
		this.decodePathRegistry.length = 0
		this.nextPathId = 0

		// Clear string interning
		this.encodeStringRegistry.clear()
		this.decodeStringRegistry.length = 0
		this.nextStringId = 0

		// Recreate encoder/decoder with fresh state
		const sharedStructures = this.options.sequential ? undefined : this.encoderStructures

		this.encoder = new Encoder({
			sequential: this.options.sequential,
			useRecords: true,
			encodeUndefinedAsNil: false,
			tagUint8Array: true,
			pack: this.options.pack,
			structures: sharedStructures ?? this.encoderStructures,
		})

		this.decoder = new Decoder({
			sequential: this.options.sequential,
			useRecords: true,
			structures: sharedStructures ?? this.decoderStructures,
		})
	}

	__experimental_snapshotState(): RpcSessionSnapshot["codec"] {
		return {
			encodePaths: pathsFromRegistry(this.encodePathRegistry),
			decodePaths: this.decodePathRegistry.slice(),
			encodeStrings: stringsFromRegistry(this.encodeStringRegistry),
			decodeStrings: this.decodeStringRegistry.slice(),
			// With sequential: true, the encoder structures are always empty (definitions
			// are embedded inline in each message). Only the decoder accumulates structures
			// from the stream — these must be persisted so a restored server can still
			// decode messages from a client whose encoder references them.
			decoderStructures: this.decoderStructures.map(
				s => Array.isArray(s) ? [...s] as string[] : []
			),
		}
	}

	__experimental_restoreState(snapshot: RpcSessionSnapshot["codec"]): void {
		this.__experimental_reset()

		for (const path of snapshot.encodePaths) {
			this.encodePathRegistry.set(JSON.stringify(path), this.nextPathId++)
		}
		for (const path of snapshot.decodePaths) {
			this.decodePathRegistry.push(path)
		}
		this.nextPathId = Math.max(this.nextPathId, this.decodePathRegistry.length)

		for (const value of snapshot.encodeStrings) {
			this.encodeStringRegistry.set(value, this.nextStringId++)
		}
		for (const value of snapshot.decodeStrings) {
			this.decodeStringRegistry.push(value)
		}
		this.nextStringId = Math.max(this.nextStringId, this.decodeStringRegistry.length)

		// Restore cbor-x decoder structures. These must be populated in the same
		// array instance that was passed to the Decoder constructor, since cbor-x
		// holds a reference to it and mutates it in place.
		if (snapshot.decoderStructures) {
			this.decoderStructures.length = 0
			for (const struct of snapshot.decoderStructures) {
				this.decoderStructures.push([...struct])
			}
		}
	}

	/**
	 * Encodes a PropertyPath, using reference caching for repeated paths.
	 * First occurrence: returns { _pd: id, p: path } (definition)
	 * Subsequent: returns { _pr: id } (reference)
	 */
	encodePath(path: PropertyPath): PathDefinition | PathReference {
		// Empty paths are common and cheap, don't bother caching
		if (path.length === 0) {
			return { _pd: -1, p: path }
		}

		const key = JSON.stringify(path)
		const existingId = this.encodePathRegistry.get(key)

		if (existingId !== undefined) {
			// Path already registered, send reference
			return { _pr: existingId }
		}

		// New path, assign ID and send definition
		const id = this.nextPathId++
		this.encodePathRegistry.set(key, id)
		return { _pd: id, p: path }
	}

	/**
	 * Decodes a PropertyPath from either a definition or reference.
	 * Definitions are registered for future reference lookups.
	 */
	decodePath(value: unknown): PropertyPath {
		if (isPathDefinition(value)) {
			// It's a definition - register it (unless it's the empty path marker)
			if (value._pd >= 0) {
				this.decodePathRegistry[value._pd] = value.p
			}
			return value.p
		}

		if (isPathReference(value)) {
			// It's a reference - look it up
			const path = this.decodePathRegistry[value._pr]
			if (path === undefined) {
				throw new Error(`Unknown path reference: ${value._pr}`)
			}
			return path
		}

		// For backwards compatibility, also accept raw arrays
		if (Array.isArray(value)) {
			return value as PropertyPath
		}

		throw new Error(`Invalid path encoding: ${JSON.stringify(value)}`)
	}

	/**
	 * Encodes a string, using interning for repeated strings.
	 * First occurrence: returns { _sd: id, s: "string" } (definition)
	 * Subsequent: returns { _sr: id } (reference)
	 * Short strings (< MIN_INTERN_LENGTH) are returned as-is.
	 */
	private internStringEncode(str: string): string | StringDefinition | StringReference {
		// Don't intern short strings - overhead not worth it
		if (str.length < MIN_INTERN_LENGTH) {
			return str
		}

		const existingId = this.encodeStringRegistry.get(str)
		if (existingId !== undefined) {
			// String already registered, send reference
			return { _sr: existingId }
		}

		// New string, assign ID and send definition
		const id = this.nextStringId++
		this.encodeStringRegistry.set(str, id)
		return { _sd: id, s: str }
	}

	/**
	 * Decodes a string from either a definition, reference, or plain string.
	 * Definitions are registered for future reference lookups.
	 */
	private internStringDecode(value: unknown): string {
		if (typeof value === 'string') {
			return value
		}

		if (isStringDefinition(value)) {
			// It's a definition - register it
			this.decodeStringRegistry[value._sd] = value.s
			return value.s
		}

		if (isStringReference(value)) {
			// It's a reference - look it up
			const str = this.decodeStringRegistry[value._sr]
			if (str === undefined) {
				throw new Error(`Unknown string reference: ${value._sr}`)
			}
			return str
		}

		throw new Error(`Invalid string encoding: ${JSON.stringify(value)}`)
	}

	/**
	 * Encodes a value to CBOR bytes.
	 * If the value is an RPC message (array starting with message type string),
	 * it will be transformed to the configured wire format before encoding.
	 */
	encode(value: unknown): Uint8Array {
		const wireFormat = this.toWireFormat(value)
		return this.encoder.encode(wireFormat)
	}

	/**
	 * Decodes CBOR bytes to a value.
	 * If the value is an RPC message in wire format, it will be transformed
	 * back to the internal array format after decoding.
	 */
	decode(data: Uint8Array | ArrayBuffer): unknown {
		if (data instanceof ArrayBuffer) {
			data = new Uint8Array(data)
		}
		const wireFormat = this.decoder.decode(data)
		return this.fromWireFormat(wireFormat)
	}

	/**
	 * Recursively transform expression types to numeric IDs and intern strings.
	 * Walks the structure and converts ["pipeline", ...] to [6, ...] etc.
	 * Also interns strings for session-scoped deduplication.
	 */
	private transformExpressionsToNumeric(value: unknown): unknown {
		// Intern strings (but not expression type strings which become numeric)
		if (typeof value === 'string') {
			return this.internStringEncode(value)
		}

		if (!Array.isArray(value)) {
			// Pass through binary types unchanged (Uint8Array, ArrayBuffer, etc.)
			if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
				return value
			}
			// Handle objects recursively (but not Tags)
			if (value && typeof value === 'object' && !(value instanceof Tag)) {
				const obj = value as Record<string, unknown>
				const result: Record<string, unknown> = {}
				for (const key in obj) {
					result[key] = this.transformExpressionsToNumeric(obj[key])
				}
				return result
			}
			return value
		}

		// Check if this array starts with an expression type
		const first = value[0]
		if (typeof first === 'string' && first in ExpressionTypeId) {
			// Transform expression type to numeric and recurse on rest
			return [
				ExpressionTypeId[first as ExpressionTypeName],
				...value.slice(1).map(v => this.transformExpressionsToNumeric(v))
			]
		}

		// Not an expression, but still recurse into array elements
		return value.map(v => this.transformExpressionsToNumeric(v))
	}

	/**
	 * Recursively transform numeric expression IDs back to strings and decode interned strings.
	 * Walks the structure and converts [6, ...] to ["pipeline", ...] etc.
	 * Also decodes interned string references.
	 */
	private transformExpressionsFromNumeric(value: unknown): unknown {
		// Decode interned strings
		if (isStringDefinition(value) || isStringReference(value)) {
			return this.internStringDecode(value)
		}

		if (!Array.isArray(value)) {
			// Pass through binary types unchanged (Uint8Array, ArrayBuffer, etc.)
			if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
				return value
			}
			// Handle objects recursively (but not Tags)
			if (value && typeof value === 'object' && !(value instanceof Tag)) {
				const obj = value as Record<string, unknown>
				const result: Record<string, unknown> = {}
				for (const key in obj) {
					result[key] = this.transformExpressionsFromNumeric(obj[key])
				}
				return result
			}
			return value
		}

		// Check if this array starts with a numeric expression type ID
		const first = value[0]
		if (typeof first === 'number' && first in ExpressionTypeById) {
			// Transform numeric ID back to expression type string and recurse
			return [
				ExpressionTypeById[first],
				...value.slice(1).map(v => this.transformExpressionsFromNumeric(v))
			]
		}

		// Not an expression, but still recurse into array elements
		return value.map(v => this.transformExpressionsFromNumeric(v))
	}

	/**
	 * Transform internal format to wire format based on encoding mode.
	 * Internal: ["push", expr] or ["resolve", id, value] etc.
	 * Wire format varies by mode, wrapped in CBOR tag to distinguish from arbitrary data.
	 */
	private toWireFormat(value: unknown): unknown {
		// Only transform arrays that look like RPC messages
		if (!Array.isArray(value) || value.length === 0) return value

		const type = value[0]
		if (typeof type !== 'string' || !(type in MessageTypeId)) return value

		const payload = value.slice(1)

		let transformed: unknown
		switch (this.messageEncodingMode) {
			case 'array':
				// Already in correct format, just tag it
				transformed = value
				break

			case 'object':
				// {push: [payload...]}
				transformed = { [type]: payload }
				break

			case 'numeric':
				// [0, ...payload] with expressions also transformed to numeric
				const numericPayload = payload.map(v => this.transformExpressionsToNumeric(v))
				const typeId = (MessageTypeId as Partial<Record<MessageTypeName, number>>)[type as MessageTypeName]
				if (typeId === undefined) {
					return value
				}
				transformed = [typeId, ...numericPayload]
				break

			default:
				return value
		}

		// Wrap in CBOR tag to mark as RPC message
		return new Tag(transformed, RPC_MESSAGE_TAG)
	}

	/**
	 * Transform wire format back to internal format.
	 * Only transforms values wrapped in RPC_MESSAGE_TAG.
	 * Returns internal array format: ["push", expr] etc.
	 */
	private fromWireFormat(value: unknown): unknown {
		// Only transform if it's our RPC message tag
		if (!(value instanceof Tag) || value.tag !== RPC_MESSAGE_TAG) {
			return value
		}

		const taggedValue = value.value

		switch (this.messageEncodingMode) {
			case 'array':
				// Already in internal format
				return taggedValue

			case 'object':
				// Convert {push: [payload...]} to ["push", ...payload]
				if (taggedValue && typeof taggedValue === 'object' && !Array.isArray(taggedValue)) {
					const keys = Object.keys(taggedValue)
					if (keys.length === 1 && keys[0] in MessageTypeId) {
						const type = keys[0] as MessageTypeName
						const payload = (taggedValue as Record<string, unknown>)[type]
						if (Array.isArray(payload)) {
							return [type, ...payload]
						}
					}
				}
				return taggedValue

			case 'numeric':
				// Convert [0, ...payload] to ["push", ...payload] with expressions also transformed
				if (Array.isArray(taggedValue) && taggedValue.length > 0 && typeof taggedValue[0] === 'number') {
					const typeId = taggedValue[0]
					if (typeId in MessageTypeById) {
						const typeName = MessageTypeById[typeId]
						const payload = taggedValue.slice(1).map(v => this.transformExpressionsFromNumeric(v))
						return [typeName, ...payload]
					}
				}
				return taggedValue

			default:
				return taggedValue
		}
	}
}

// Singleton instance for standalone/testing use.
// Uses sequential: true (the default) which embeds structure definitions inline,
// making it compatible with independent encode/decode calls and matching RPC session behavior.
export const cborCodec = new CborCodec()

function pathsFromRegistry(registry: Map<string, number>): PropertyPath[] {
	const paths: PropertyPath[] = []
	for (const [key, id] of registry.entries()) {
		paths[id] = JSON.parse(key) as PropertyPath
	}
	return paths
}

function stringsFromRegistry(registry: Map<string, number>): string[] {
	const strings: string[] = []
	for (const [value, id] of registry.entries()) {
		strings[id] = value
	}
	return strings
}
