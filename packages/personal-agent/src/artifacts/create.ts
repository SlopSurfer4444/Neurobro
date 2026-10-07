import type { Json, ToolContext } from '../contracts.ts';
import type { RegisteredTool } from '../capabilities/types.ts';
import { id, obj, str } from '../capabilities/schema.ts';
import type { Schema } from '../capabilities/schema.ts';
import type { ArtifactPort, ArtifactScope } from './index.ts';

export interface CreateArtifactToolsOptions {
  store: ArtifactPort;
  /** Trusted run binding; no model argument can choose an owner or task. */
  resolveScope(context: ToolContext): ArtifactScope;
  /** UTF-8 bytes including CSV escaping and an optional BOM. Rejection never truncates. */
  maxContentBytes?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_JSON_NODES = 50_000;
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

function checkedBytes(text: string, maximum: number): Buffer {
  // Buffer's UTF-8 encoder replaces lone surrogates; reject instead of changing data.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) {
    throw new Error('artifact content contains an unpaired Unicode surrogate');
  }
  const size = Buffer.byteLength(text, 'utf8');
  if (size > maximum) throw new Error(`artifact creation exceeds UTF-8 byte limit (${maximum})`);
  return Buffer.from(text, 'utf8');
}

function validateJsonNumbers(value: Json, state: { nodes: number }, depth = 0): void {
  if (++state.nodes > MAX_JSON_NODES || depth > 12) throw new Error('JSON artifact exceeds structural limit');
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error('JSON numbers must be finite and integers safe; preserve large IDs as quoted strings');
    }
  } else if (Array.isArray(value)) {
    for (const item of value) validateJsonNumbers(item, state, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) validateJsonNumbers(item, state, depth + 1);
  }
}

function assertFields(args: Record<string, Json>, format: string): void {
  const allowed = new Set(['name', 'format', 'parentId', ...(format === 'text' ? ['text'] : format === 'json' ? ['jsonText'] : ['rows', 'columns', 'bom'])]);
  for (const field of Object.keys(args)) if (!allowed.has(field)) throw new Error(`field ${field} is unsupported for ${format} artifact creation`);
}

function csvText(rows: string[][], suppliedColumns: string[] | undefined, maximum: number, bom: boolean): string {
  const width = suppliedColumns?.length ?? rows.reduce((largest, row) => Math.max(largest, row.length), 0);
  const columns = suppliedColumns ?? Array.from({ length: width }, (_, index) => `column_${index + 1}`);
  if (rows.some(row => row.length > width)) throw new Error('CSV row contains more cells than the declared columns');
  const pieces: string[] = bom ? ['\uFEFF'] : [];
  let bytes = bom ? 3 : 0;
  const append = (cells: string[]): void => {
    const encoded: string[] = [];
    let lineBytes = 2; // CRLF
    for (let index = 0; index < cells.length; index++) {
      const value = cells[index]!;
      const quoted = (cells.length === 1 && value === '') || /[",\r\n]/u.test(value);
      let quotes = 0;
      if (quoted) for (let char = 0; char < value.length; char++) if (value.charCodeAt(char) === 34) quotes++;
      lineBytes += Buffer.byteLength(value, 'utf8') + (quoted ? quotes + 2 : 0) + (index ? 1 : 0);
      // Refuse before allocating an over-budget escaped cell or oversized line.
      if (bytes + lineBytes > maximum) throw new Error(`artifact creation exceeds UTF-8 byte limit (${maximum})`);
      encoded.push(quoted ? `"${value.replaceAll('"', '""')}"` : value);
    }
    bytes += lineBytes;
    pieces.push(encoded.join(',') + '\r\n');
  };
  if (width) append(columns);
  for (const row of rows) {
    // An explicit all-empty zero-column row has no representable CSV cell boundary.
    if (!width) throw new Error('CSV rows must contain at least one column');
    append(Array.from({ length: width }, (_, index) => row[index] ?? ''));
  }
  return pieces.join('');
}

/** Only structured file content is accepted. Filesystem paths, binary base64 and shell execution are absent. */
export function createArtifactTools(options: CreateArtifactToolsOptions): RegisteredTool[] {
  const maximum = options.maxContentBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024 * 1024) throw new Error('invalid artifact creation byte limit');
  const content: Schema = { type: 'string', minLength: 0, maxLength: maximum };
  return [{
    name: 'artifact.create',
    description: 'Create a real encrypted task artifact without computer access. format=text uses text, json uses validated jsonText unchanged, csv uses string rows and optional columns/BOM. CSV defaults to column_1... headers and CRLF; short rows have empty trailing cells. Large numeric IDs belong in quoted strings. Returns a saved artifact ID usable for staging, inspection and authorized media sending. Content is bounded UTF-8; no arbitrary path or command is accepted.',
    capability: 'artifacts.write', mutates: true,
    inputSchema: obj({
      name: str(180), format: { type: 'string', enum: ['text', 'json', 'csv'] },
      text: content, jsonText: content,
      rows: { type: 'array', maxItems: 10_000, items: { type: 'array', maxItems: 512, items: content } },
      columns: { type: 'array', maxItems: 512, items: { type: 'string', minLength: 0, maxLength: 1024 } },
      bom: { type: 'boolean' }, parentId: id,
    }, ['name', 'format']),
    resources: (_args, context) => [context.taskId],
    async execute({ context, args }) {
      const scope = options.resolveScope(context);
      if (!scope || scope.taskId !== context.taskId || !scope.ownerId) throw new Error('artifact creation trusted task scope is misbound');
      const format = args.format as 'text' | 'json' | 'csv';
      assertFields(args, format);
      let bytes: Buffer;
      let mimeType: string;
      if (format === 'text') {
        if (typeof args.text !== 'string') throw new Error('text artifact requires text');
        bytes = checkedBytes(args.text, maximum); mimeType = 'text/plain';
      } else if (format === 'json') {
        if (typeof args.jsonText !== 'string') throw new Error('JSON artifact requires jsonText');
        bytes = checkedBytes(args.jsonText, maximum);
        let value: Json;
        try { value = JSON.parse(args.jsonText) as Json; } catch { throw new Error('JSON artifact content is malformed'); }
        validateJsonNumbers(value, { nodes: 0 }); mimeType = 'application/json';
      } else if (format === 'csv') {
        if (!Array.isArray(args.rows) || args.rows.some(row => !Array.isArray(row) || row.some(cell => typeof cell !== 'string'))) throw new Error('CSV artifact requires rows containing string cells');
        bytes = checkedBytes(csvText(args.rows as string[][], args.columns as string[] | undefined, maximum, args.bom === true), maximum);
        mimeType = 'text/csv';
      } else throw new Error('unsupported artifact creation format');
      return json(options.store.put({ ...scope, name: args.name as string, bytes, mimeType,
        ...(args.parentId ? { parentId: args.parentId as string } : {}),
      }));
    },
  }];
}
