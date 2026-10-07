import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { absolute, hashFile, noLinks, OpsError } from './paths.ts';

export const CRON_PATCH_ID = 'neurobro-hermes-cron-bridge-v2';
export const CRON_SOURCE_PIN = '8d5e3e412138342e8bf30443e72bd4e6a9abd057';
/** Exact reviewed native-overlay-v2-final; another generation requires explicit admission. */
export const CRON_PATCH_FILES: Readonly<Record<string, { sourceBlob: string; patchedSha256: string }>> = {
  'cron/jobs.py': { sourceBlob: '2e421c7af328f7e9e259713e03c8880e35ccf793', patchedSha256: 'e21f8045839cc46be098585b6f01c1d4589538da34b0664741bf2fbbf0de4886' },
  'cron/scheduler.py': { sourceBlob: '4082d766f35ccf9b546654fae8ba8dba4d563747', patchedSha256: '92ca67b103d989b03a5e2baf88caae477d8156b908b5db4a80df1a4bedfb83ad' },
  'cron/executions.py': { sourceBlob: 'b6afa0d3797975cb1d5a5c6e7be45e8b9aea4006', patchedSha256: 'c2aa3fa92023d53ddc3ee52dab9c2b772d2320c1d00aae08a76ba0a5a5d347d6' },
  'hermes_cli/plugins.py': { sourceBlob: '4fbf7394c85980177b2e3139526bfa4fd45d58cc', patchedSha256: 'e7c7ceb615bf191e2365fc97168da5f023a1a3c078968fb4b648bf8bd5a892e1' },
  'hermes_cli/plugins_dispatch.py': { sourceBlob: '78c3927fc4fc39d2ae523749238e110504fefe47', patchedSha256: '5a8297b7c87d78532b7e101b21039f177bc59db80eb4aa5b1883bdabca5c3ac9' },
};

export async function verifyCronPatch(sourceRoot: string, receiptPath: string): Promise<{ path: string; sha256: string }[]> {
  absolute(sourceRoot); absolute(receiptPath); await noLinks(sourceRoot); await noLinks(receiptPath);
  let receipt: { patchId: string; hermesPin: string; kind: string; files: Record<string, { sourceBlob: string; patchedSha256: string }> };
  try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); }
  catch { throw new OpsError('cron_patch_receipt_required'); }
  if (receipt.patchId !== CRON_PATCH_ID || receipt.hermesPin !== CRON_SOURCE_PIN || receipt.kind !== 'native-source-overlay' ||
      !receipt.files || Object.keys(receipt.files).sort().join('\n') !== Object.keys(CRON_PATCH_FILES).sort().join('\n')) throw new OpsError('cron_patch_receipt_mismatch');
  const evidence = [{ path: receiptPath, sha256: await hashFile(receiptPath) }];
  for (const [relative, expected] of Object.entries(CRON_PATCH_FILES)) {
    const claimed = receipt.files[relative];
    if (claimed?.sourceBlob !== expected.sourceBlob || claimed?.patchedSha256 !== expected.patchedSha256) throw new OpsError('cron_patch_receipt_mismatch');
    const path = join(sourceRoot, relative);
    if (await hashFile(path) !== expected.patchedSha256) throw new OpsError('cron_patch_not_applied_or_modified');
    evidence.push({ path, sha256: expected.patchedSha256 });
  }
  return evidence;
}
