import type { Json } from '../contracts.ts';

export type Schema = { type: 'string'; minLength?: number; maxLength?: number; enum?: string[]; pattern?: string } |
  { type: 'number' | 'integer'; minimum?: number; maximum?: number; integer?: boolean } |
  { type: 'boolean' } | { type: 'array'; items: Schema; minItems?: number; maxItems?: number } |
  { type: 'object'; properties: Record<string, Schema>; required: string[]; additionalProperties: false };
export const str = (maxLength = 4096): Schema => ({ type: 'string', minLength: 1, maxLength });
export const id: Schema = { type: 'string', minLength: 1, maxLength: 128 };
export const int = (minimum: number, maximum: number): Schema => ({ type: 'integer', minimum, maximum });
export const obj = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false });
export function validate(schema: Schema, value: unknown, path = 'args', depth = 0): asserts value is Json {
  if (depth > 12) throw new Error(`${path}: nesting limit`);
  if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 65536) || /[\u0000]/u.test(value)) throw new Error(`${path}: invalid string`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: unsupported value`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) throw new Error(`${path}: invalid format`);
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || ((schema.type === 'integer' || schema.integer) && !Number.isSafeInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(`${path}: invalid number`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${path}: expected boolean`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 128)) throw new Error(`${path}: invalid array`);
    value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`, depth + 1));
  } else if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${path}: expected plain object`);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || !Object.hasOwn(schema.properties, key)) throw new Error(`${path}.${key}: unknown field`);
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !('value' in descriptor)) throw new Error(`${path}.${key}: accessor forbidden`);
      validate(schema.properties[key]!, descriptor.value, `${path}.${key}`, depth + 1);
    }
    for (const key of schema.required) if (!Object.hasOwn(record, key)) throw new Error(`${path}.${key}: required`);
  } else throw new Error(`${path}: unknown schema`);
}
