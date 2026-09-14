import { Api } from "telegram";
import bigInt from "big-integer";
export type StandingMediaFileReader = (request: Api.upload.GetFile, dcId: number) => Promise<unknown>;

export type StandingInputImage = Readonly<{ messageId: number; mimeType: "image/jpeg" | "image/png"; bytes: Buffer }>;
const MAX_BYTES = 8 * 1024 * 1024, MAX_DIMENSION = 4096, CHUNK = 512 * 1024;
const refuse = (): never => { throw new Error("STANDING_INPUT_IMAGE_UNAVAILABLE"); };
type Descriptor = { photo: Api.Photo | Api.Document; type: string; width: number; height: number; size: number; mimeType?: "image/jpeg" | "image/png" };
function descriptor(message: Api.Message): Descriptor | undefined {
  if (!(message instanceof Api.Message) || !Number.isSafeInteger(message.id) || message.id <= 0) return undefined;
  if (message.media instanceof Api.MessageMediaDocument) {
    const document = message.media.document;
    if (message.media.ttlSeconds != null || !(document instanceof Api.Document) ||
        !["image/jpeg", "image/png"].includes(document.mimeType) || !Buffer.isBuffer(document.fileReference) ||
        !document.fileReference.length || document.fileReference.length > 4096 || !Number.isSafeInteger(document.dcId) || document.dcId <= 0 ||
        document.attributes.length > 16 || document.attributes.some(a => !(a instanceof Api.DocumentAttributeImageSize || a instanceof Api.DocumentAttributeFilename))) return undefined;
    const dimensions = document.attributes.filter((a): a is Api.DocumentAttributeImageSize => a instanceof Api.DocumentAttributeImageSize);
    if (dimensions.length !== 1 || ![dimensions[0]!.w, dimensions[0]!.h].every(n => Number.isSafeInteger(n) && n > 0 && n <= MAX_DIMENSION)) return undefined;
    const size = Number(document.size.toString());
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES) return undefined;
    return { photo: document, type: "", width: dimensions[0]!.w, height: dimensions[0]!.h, size, mimeType: document.mimeType as "image/jpeg" | "image/png" };
  }
  if (!(message.media instanceof Api.MessageMediaPhoto) || message.media.ttlSeconds != null ||
      !(message.media.photo instanceof Api.Photo)) return undefined;
  const photo = message.media.photo;
  if (!Buffer.isBuffer(photo.fileReference) || photo.fileReference.length === 0 || photo.fileReference.length > 4096 ||
      !Number.isSafeInteger(photo.dcId) || photo.dcId <= 0 || photo.sizes.length > 64) return undefined;
  const sizes: Descriptor[] = [];
  for (const size of photo.sizes) {
    if (!(size instanceof Api.PhotoSize || size instanceof Api.PhotoSizeProgressive) || !/^[mxyw]$/.test(size.type)) continue;
    if (![size.w, size.h].every(n => Number.isSafeInteger(n) && n > 0 && n <= MAX_DIMENSION)) continue;
    let count: number;
    if (size instanceof Api.PhotoSizeProgressive) {
      if (!size.sizes.length || size.sizes.length > 64 || size.sizes.some((n, i) => !Number.isSafeInteger(n) || n <= 0 || (i > 0 && n <= size.sizes[i - 1]!))) continue;
      count = size.sizes[size.sizes.length - 1]!;
    } else count = size.size;
    if (!Number.isSafeInteger(count) || count <= 0 || count > MAX_BYTES) continue;
    sizes.push({ photo, type: size.type, width: size.w, height: size.h, size: count });
  }
  return sizes.sort((a, b) => b.width * b.height - a.width * a.height || b.size - a.size || a.type.localeCompare(b.type))[0];
}

/** Internal source comparison only; the adapter separately authenticates peer,
 * sender and exact message. References may refresh without changing the image. */
export function inputImageIdentity(message: Api.Message): string | undefined {
  const d = descriptor(message);
  return d && JSON.stringify([message.id, d.photo.id.toString(), d.photo.accessHash.toString(), d.photo.dcId, d.type, d.width, d.height, d.size,
    d.photo instanceof Api.Photo ? "photo" : "document", d.mimeType ?? null]);
}

/** Bounded JPEG container validation, not pixel decoding. */
function jpeg(bytes: Buffer, width: number, height: number): void {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return refuse();
  let offset = 2, markers = 0, frame = false, scan = false;
  while (offset < bytes.length && ++markers <= 4096) {
    if (bytes[offset++] !== 255) return refuse();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217) { if (!frame || !scan || offset !== bytes.length) return refuse(); return; }
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215) || offset + 2 > bytes.length) return refuse();
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || size > bytes.length - offset) return refuse();
    if ([192, 193, 194].includes(marker)) {
      if (frame || size < 8 || bytes.readUInt16BE(offset + 5) !== width || bytes.readUInt16BE(offset + 3) !== height) return refuse();
      const components = bytes[offset + 7]!;
      if (![1, 3, 4].includes(components) || size !== 8 + 3 * components || bytes[offset + 2] !== 8) return refuse();
      frame = true;
    }
    offset += size;
    if (marker === 218) {
      if (!frame || size < 6) return refuse();
      scan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || (next !== undefined && next >= 208 && next <= 215)) { offset += 2; continue; }
        if (next === 255) { offset++; continue; }
        break;
      }
    }
  }
  return refuse();
}

/** PNG framing and dimensions, not decompression or pixel validation. */
function png(bytes: Buffer, width: number, height: number): void {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return refuse();
  let offset = 8, count = 0, data = false, endedData = false;
  while (offset + 12 <= bytes.length && ++count <= 4096) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
    if (length > bytes.length - offset - 12 || !/^[A-Za-z]{4}$/.test(type)) return refuse();
    if (count === 1) {
      if (type !== "IHDR" || length !== 13 || bytes.readUInt32BE(offset + 8) !== width || bytes.readUInt32BE(offset + 12) !== height) return refuse();
      const depths: Record<number, readonly number[]> = { 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] };
      if (!depths[bytes[offset + 17]!]?.includes(bytes[offset + 16]!) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || ![0,1].includes(bytes[offset + 20]!)) return refuse();
    } else if (type === "IHDR") return refuse();
    if (["acTL", "fcTL", "fdAT"].includes(type)) return refuse();
    if (type === "IDAT") { if (endedData) return refuse(); if (length > 0) data = true; }
    else if (data) endedData = true;
    offset += length + 12;
    if (type === "IEND") { if (!data || length !== 0 || offset !== bytes.length) return refuse(); return; }
  }
  return refuse();
}

/** Fresh caller-authenticated photo or static image document. Caller owns admission, cancellation
 * and joining this promise. This helper never opens clients, writes files,
 * retries expired references, migrates DCs or follows CDN redirects. */
export async function downloadStandingInputImage(message: Api.Message, invoke: StandingMediaFileReader, check: () => void, maxBytes = MAX_BYTES): Promise<StandingInputImage> {
  check();
  const d = descriptor(message);
  if (!d || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES || d.size > maxBytes) return refuse();
  const messageId = message.id;
  const locationFields = { id: d.photo.id, accessHash: d.photo.accessHash, fileReference: Buffer.from(d.photo.fileReference), thumbSize: d.type };
  const location = d.photo instanceof Api.Photo ? new Api.InputPhotoFileLocation(locationFields) : new Api.InputDocumentFileLocation(locationFields);
  const chunks: Buffer[] = [];
  let bytes: Buffer | undefined;
  try {
  for (let offset = 0; offset < d.size; offset += CHUNK) {
    check();
    const response = await invoke(new Api.upload.GetFile({ location, offset: bigInt(offset), limit: CHUNK, cdnSupported: false }), d.photo.dcId);
    check();
    if (!(response instanceof Api.upload.File) || !Buffer.isBuffer(response.bytes) || response.bytes.length !== Math.min(CHUNK, d.size - offset)) return refuse();
    chunks.push(Buffer.from(response.bytes));
  }
  bytes = Buffer.concat(chunks, d.size);
  const mimeType = bytes[0] === 137 ? "image/png" : "image/jpeg";
  if (d.mimeType && d.mimeType !== mimeType) return refuse();
  if (mimeType === "image/png") png(bytes, d.width, d.height);
  else jpeg(bytes, d.width, d.height);
  check();
  return { messageId, mimeType, bytes };
  } catch (error) {
    bytes?.fill(0);
    throw error;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}
