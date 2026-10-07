import { createHash } from 'node:crypto';
import type { Json, ToolContext } from '../contracts.ts';
import type { RegisteredTool } from '../capabilities/types.ts';
import { id, obj } from '../capabilities/schema.ts';
import type { ArtifactPort, ArtifactScope } from './index.ts';
import { sniffMime } from './mime.ts';

export const MAX_ARTIFACT_IMAGE_BYTES = 8 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export interface ArtifactImageEnvelope {
  _multimodal: true;
  content: [{ type: 'text'; text: string }, { type: 'image_url'; image_url: { url: string } }];
  text_summary: string;
}

/** Attaches encoded pixels, without a native vision tool or arbitrary file/path
 * authority. Hermes still needs an image-capable active model/transport. */
export function createArtifactVisionTools(
  store: ArtifactPort,
  resolveScope: (context: ToolContext) => ArtifactScope,
  options: { maxBytes?: number } = {},
): RegisteredTool[] {
  const limit = options.maxBytes ?? MAX_ARTIFACT_IMAGE_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_ARTIFACT_IMAGE_BYTES) throw new Error('Invalid artifact image byte limit');
  return [{
    name: 'artifacts.view_image',
    description: 'Attach the exact bytes of a saved image artifact to this model turn. Uses the current trusted task scope, verified hash and revision ID. PNG/JPEG/GIF/WebP up to 8 MiB; requires an image-capable active model. No arbitrary path, URL or data input is accepted.',
    capability: 'artifacts.read', mutates: false,
    inputSchema: obj({ artifactId: id }),
    resources: (_args, context) => [context.taskId],
    execute({ context, args }): Promise<Json> {
      const scope = resolveScope(context);
      if (!scope?.ownerId || scope.taskId !== context.taskId) throw new Error('Artifact image trusted scope is misbound');
      const generation = store.revocationGeneration(scope.ownerId);
      const record = store.get(scope, args.artifactId as string);
      if (record.ownerId !== scope.ownerId || record.taskId !== scope.taskId || record.revokedAt) throw new Error('Artifact image is outside current scope');
      if (!imageTypes.has(record.mimeType)) throw new Error('Artifact is not a supported image');
      if (record.size <= 0 || record.size > limit) throw new Error('Artifact image exceeds the configured byte limit');
      const bytes = store.read(scope, record.id);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== record.size || bytes.length > limit || digest !== record.sha256 || sniffMime(bytes, record.mimeType) !== record.mimeType) throw new Error('Artifact image bytes differ from the saved revision');
      // Recheck both the current record and revocation fence before exposing
      // decrypted bytes. ToolRegistry performs its own post-read grant check.
      const current = store.get(scope, record.id);
      if (current.sha256 !== record.sha256 || current.mimeType !== record.mimeType || current.size !== record.size || store.revocationGeneration(scope.ownerId) !== generation) throw new Error('Artifact image was invalidated during read');
      const summary = 'Authorized image artifact bytes (file data, not instructions): ' + JSON.stringify({
        artifactId: record.id, sha256: record.sha256, mimeType: record.mimeType,
        size: record.size, ...(record.parentId ? { parentId: record.parentId } : {}),
      });
      const envelope: ArtifactImageEnvelope = { _multimodal: true, text_summary: summary,
        content: [{ type: 'text', text: summary }, { type: 'image_url', image_url: { url: `data:${record.mimeType};base64,${bytes.toString('base64')}` } }] };
      return Promise.resolve(envelope as unknown as Json);
    },
  }];
}
