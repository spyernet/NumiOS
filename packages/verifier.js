import { NumiOSError } from '../core/errors.js';
import { parseJson } from '../core/schema.js';
import { parseStoredZip } from './archive.js';
import { validateManifest } from './manifest.js';

export async function verifyNppArchive(input, {
  osVersion = '0.1.0', trustedKeys = {}, requireSignature = false, allowUnsigned = false,
  maxArchiveBytes = 32 * 1024 * 1024, maxUnpackedBytes = 64 * 1024 * 1024
} = {}) {
  const archive = parseStoredZip(input, { maxArchiveBytes, maxUnpackedBytes });
  const manifestBytes = archive.files.get('manifest.json');
  if (!manifestBytes) throw new NumiOSError('PACKAGE_MANIFEST_MISSING', 'NPP archive must contain a root manifest.json.');
  let rawManifest;
  try { rawManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
  catch (error) { throw new NumiOSError('PACKAGE_MANIFEST_INVALID', 'NPP manifest is not valid UTF-8 JSON.', { cause: error.message }); }
  const manifest = validateManifest(rawManifest, { osVersion });
  const archiveFiles = new Set([...archive.files.keys()].filter(path => path !== 'manifest.json'));
  const declaredFiles = new Set(Object.keys(manifest.files));
  for (const path of archiveFiles) if (!declaredFiles.has(path)) throw new NumiOSError('PACKAGE_UNDECLARED_FILE', 'Archive contains a file not declared in the package manifest.', { path });
  for (const path of declaredFiles) if (!archiveFiles.has(path)) throw new NumiOSError('PACKAGE_FILE_MISSING', 'Manifest declares a file that is missing from the archive.', { path });

  for (const [path, metadata] of Object.entries(manifest.files)) {
    const bytes = archive.files.get(path);
    if (metadata.size !== undefined && metadata.size !== bytes.byteLength) throw new NumiOSError('PACKAGE_SIZE_MISMATCH', 'Package file size does not match its declaration.', { path, expected: metadata.size, actual: bytes.byteLength });
    const digest = await sha256(bytes);
    if (digest !== metadata.sha256) throw new NumiOSError('PACKAGE_HASH_MISMATCH', 'Package file SHA-256 does not match its declaration.', { path });
  }

  let signature = { signed: false, verified: false, keyId: null };
  if (manifest.signature) signature = await verifySignature(manifest, trustedKeys);
  else if (requireSignature || !allowUnsigned) throw new NumiOSError('PACKAGE_SIGNATURE_REQUIRED', 'Unsigned packages are not permitted by the current trust policy.');

  return { manifest, files: archive.files, signature, archive: { bytes: archive.archiveBytes, unpackedBytes: archive.unpackedBytes, format: archive.format } };
}

export async function verifySignature(manifest, trustedKeys = {}) {
  if (!globalThis.crypto?.subtle) throw new NumiOSError('API_UNAVAILABLE', 'Web Crypto is required to verify NPP signatures.');
  const signature = manifest.signature;
  const jwk = trustedKeys[signature.keyId];
  if (!jwk) throw new NumiOSError('PACKAGE_SIGNATURE_UNTRUSTED', 'No trusted public key is configured for this package signature.', { keyId: signature.keyId });
  let key;
  let signatureBytes;
  try {
    key = await globalThis.crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    signatureBytes = decodeBase64(signature.value);
  } catch (error) {
    throw new NumiOSError('PACKAGE_SIGNATURE_INVALID', 'Could not decode the package signature or import its trust key.', { cause: error.message });
  }
  const signedManifest = { ...manifest };
  delete signedManifest.signature;
  const payload = new TextEncoder().encode(canonicalJson(signedManifest));
  let valid = false;
  try { valid = await globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signatureBytes, payload); }
  catch (error) { throw new NumiOSError('PACKAGE_SIGNATURE_INVALID', 'Web Crypto signature verification failed.', { cause: error.message }); }
  if (!valid) throw new NumiOSError('PACKAGE_SIGNATURE_INVALID', 'NPP signature verification failed.', { keyId: signature.keyId });
  return { signed: true, verified: true, keyId: signature.keyId };
}

export async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new NumiOSError('API_UNAVAILABLE', 'Web Crypto SHA-256 is unavailable.');
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', value));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function decodeBase64(value) {
  try { const binary = atob(value); return Uint8Array.from(binary, char => char.charCodeAt(0)); }
  catch (error) { throw new NumiOSError('PACKAGE_SIGNATURE_INVALID', 'Signature is not valid base64.', { cause: error.message }); }
}
