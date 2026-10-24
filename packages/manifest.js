import { NumiOSError } from '../core/errors.js';
import { validateRelativeFilePath } from '../fs/path.js';
import { parseVersion, satisfiesVersion } from './semver.js';

export function validateManifest(value, { osVersion = '0.1.0' } = {}) {
  if (!isObject(value)) throw new NumiOSError('PACKAGE_MANIFEST_INVALID', 'Package manifest must be a JSON object.');
  const allowed = new Set(['format', 'formatVersion', 'id', 'name', 'version', 'type', 'entry', 'runtime', 'minimumOSVersion', 'dependencies', 'capabilities', 'files', 'resources', 'signature', 'hooks']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new NumiOSError('PACKAGE_MANIFEST_INVALID', 'Package manifest contains an unsupported field.', { key });
  const required = ['format', 'formatVersion', 'id', 'name', 'version', 'type', 'entry', 'runtime', 'minimumOSVersion', 'dependencies', 'capabilities', 'files'];
  for (const key of required) if (!Object.hasOwn(value, key)) throw new NumiOSError('PACKAGE_MANIFEST_INVALID', `Package manifest is missing '${key}'.`, { key });
  if (value.format !== 'NPP' || value.formatVersion !== 1) throw new NumiOSError('PACKAGE_FORMAT_UNSUPPORTED', 'Only NPP format version 1 is supported.');
  if (typeof value.id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(value.id) || value.id.length > 128) throw new NumiOSError('PACKAGE_MANIFEST_INVALID', 'Package id is invalid.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160) throw new NumiOSError('PACKAGE_MANIFEST_INVALID', 'Package name is invalid.');
  parseVersion(value.version);
  parseVersion(value.minimumOSVersion);
  if (!satisfiesVersion(osVersion, `>=${value.minimumOSVersion}`)) throw new NumiOSError('PACKAGE_OS_INCOMPATIBLE', 'Package requires a newer NumiOS version.', { minimumOSVersion: value.minimumOSVersion, current: osVersion });
  if (!['application', 'library'].includes(value.type)) throw new NumiOSError('PACKAGE_MANIFEST_INVALID', 'Package type must be application or library.');
  if (value.runtime !== 'numios-js') throw new NumiOSError('PACKAGE_RUNTIME_UNSUPPORTED', 'Only the numios-js runtime is supported.');
  const entry = validateRelativeFilePath(value.entry);
  if (!isObject(value.dependencies)) throw new NumiOSError('PACKAGE_MANIFEST_INVALID', 'Package dependencies must be an object.');
  for (const [id, range] of Object.entries(value.dependencies)) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(id) || typeof range !== 'string') throw new NumiOSError('PACKAGE_DEPENDENCY_INVALID', 'Package dependency is invalid.', { id });
    satisfiesVersion('0.0.0', range);
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.some(capability => typeof capability !== 'string' || !/^[a-z][a-z0-9]*(?:[._][a-zA-Z0-9-]+)+$/.test(capability))) {
    throw new NumiOSError('PACKAGE_MANIFEST_INVALID', 'Package capabilities must be valid unique capability names.');
  }
  if (new Set(value.capabilities).size !== value.capabilities.length) throw new NumiOSError('PACKAGE_MANIFEST_INVALID', 'Package capabilities must not contain duplicates.');
  if (!isObject(value.files) || Object.keys(value.files).length === 0) throw new NumiOSError('PACKAGE_MANIFEST_INVALID', 'Package manifest files map must be a non-empty object.');
  const files = {};
  for (const [path, metadata] of Object.entries(value.files)) {
    const safePath = validateRelativeFilePath(path);
    if (safePath === 'manifest.json') throw new NumiOSError('PACKAGE_MANIFEST_INVALID', 'manifest.json is not listed in its own files map.');
    if (!isObject(metadata) || typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new NumiOSError('PACKAGE_MANIFEST_INVALID', 'Every package file requires a lowercase SHA-256 digest.', { path });
    if (metadata.size !== undefined && (!Number.isSafeInteger(metadata.size) || metadata.size < 0)) throw new NumiOSError('PACKAGE_MANIFEST_INVALID', 'Package file size must be a non-negative integer.', { path });
    files[safePath] = { sha256: metadata.sha256, ...(metadata.size === undefined ? {} : { size: metadata.size }) };
  }
  if (value.type === 'application' && !Object.hasOwn(files, entry)) throw new NumiOSError('PACKAGE_ENTRY_MISSING', 'Application entry module is not declared in the files map.', { entry });
  if (value.hooks !== undefined && (!isObject(value.hooks) || Object.keys(value.hooks).length > 0)) throw new NumiOSError('PACKAGE_HOOKS_UNSUPPORTED', 'NPP installation hooks are not supported; packages cannot execute install scripts.');
  if (value.signature !== undefined) {
    if (!isObject(value.signature) || value.signature.algorithm !== 'ECDSA-P256-SHA256' || typeof value.signature.keyId !== 'string' || typeof value.signature.value !== 'string') {
      throw new NumiOSError('PACKAGE_SIGNATURE_INVALID', 'Package signature metadata is malformed.');
    }
  }
  return { ...value, entry, dependencies: { ...value.dependencies }, capabilities: [...value.capabilities], files };
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
