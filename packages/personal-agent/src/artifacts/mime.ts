const utf8 = new TextDecoder('utf-8', { fatal: true });
const officeTypes: Record<string, string> = {
  'word/document.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xl/workbook.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function zipType(bytes: Buffer): string {
  // Inspect the ZIP central directory without extracting or inflating any input.
  const lower = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= lower; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { eocd = offset; break; }
  }
  if (eocd < 0 || bytes.readUInt16LE(eocd + 4) || bytes.readUInt16LE(eocd + 6)) throw new Error('unsupported or malformed ZIP artifact');
  const count = bytes.readUInt16LE(eocd + 10);
  const start = bytes.readUInt32LE(eocd + 16);
  const size = bytes.readUInt32LE(eocd + 12);
  if (count > 10_000 || start + size !== eocd || bytes.readUInt16LE(eocd + 8) !== count) throw new Error('unsupported or malformed ZIP directory');
  const names = new Set<string>();
  let cursor = start;
  for (let entry = 0; entry < count; entry++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('malformed ZIP entry');
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    if (next > eocd) throw new Error('malformed ZIP entry bounds');
    const name = utf8.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name.startsWith('/') || name.includes('\\') || name.includes(':') || name.includes('\0') || name.split('/').includes('..') || names.has(name)) throw new Error('unsafe ZIP entry name');
    names.add(name);
    cursor = next;
  }
  if (cursor !== eocd) throw new Error('malformed ZIP directory size');
  if (names.has('[Content_Types].xml')) {
    const office = Object.keys(officeTypes).filter(name => names.has(name));
    if (office.length === 1) return officeTypes[office[0]!]!;
  }
  return 'application/zip';
}

/** Sniff signatures, reject arbitrary binary and validate a declared text subtype. No extension trust. */
export function sniffMime(bytes: Buffer, declared?: string): string {
  if (declared !== undefined && !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(declared)) throw new Error('invalid declared MIME type');
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString('latin1');
  if (ascii(0, 2) === 'MZ' || bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) throw new Error('executable artifacts are unsupported');
  let detected: string;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) detected = 'image/png';
  else if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) detected = 'image/jpeg';
  else if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') detected = 'image/gif';
  else if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') detected = 'image/webp';
  else if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') detected = 'audio/wav';
  else if (ascii(0, 4) === 'fLaC') detected = 'audio/flac';
  else if (ascii(0, 4) === 'OggS') detected = 'audio/ogg';
  else if (ascii(0, 3) === 'ID3' || (bytes.length >= 2 && bytes[0] === 255 && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) !== 0)) detected = 'audio/mpeg';
  else if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') detected = ascii(8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  else if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) detected = 'video/webm';
  else if (ascii(0, 5) === '%PDF-') detected = 'application/pdf';
  else if (bytes.length >= 4 && (bytes.readUInt32LE(0) === 0x04034b50 || bytes.readUInt32LE(0) === 0x06054b50)) detected = zipType(bytes);
  else {
    let text: string;
    try { text = utf8.decode(bytes); } catch { throw new Error('unsupported binary artifact MIME type'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)) throw new Error('unsupported binary artifact MIME type');
    detected = 'text/plain';
    if (declared === 'text/markdown' || declared === 'text/csv') detected = declared;
    if (declared === 'application/json') {
      try { JSON.parse(text); } catch { throw new Error('malformed JSON artifact'); }
      detected = declared;
    }
    if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/iu.test(text)) throw new Error('SVG artifacts are unsupported');
  }
  if (declared && declared !== detected) throw new Error(`artifact MIME mismatch: declared ${declared}, detected ${detected}`);
  return detected;
}
