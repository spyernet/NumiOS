import { NumiOSError } from '../core/errors.js';
import { normalizePath } from '../fs/path.js';

export const LIBRARY_MAP = Object.freeze({
  '@numios/sdk': '/sdk/index.js',
  '@numios/libsys': '/lib/libsys/index.js',
  '@numios/libc': '/lib/libc/index.js',
  '@numios/libfs': '/lib/libfs/index.js',
  '@numios/libipc': '/lib/libipc/index.js',
  '@numios/libservice': '/lib/libservice/index.js',
  '@numios/libpackage': '/lib/libpackage/index.js',
  '@numios/libcrypto': '/lib/libcrypto/index.js',
  '@numios/liblog': '/lib/liblog/index.js',
  '@numios/libconfig': '/lib/libconfig/index.js',
  '@numios/libprocess': '/lib/libprocess/index.js',
  '@numios/libnet': '/lib/libnet/index.js'
});

export class ModuleLoader {
  constructor({ baseUrl = globalThis.location?.href, version = '1.0.0' } = {}) {
    this.baseUrl = baseUrl;
    this.version = version;
  }

  resolve(specifier, importerUrl = this.baseUrl) {
    if (typeof specifier !== 'string' || !specifier) throw new NumiOSError('MODULE_SPECIFIER_INVALID', 'Module specifier must be a non-empty string.');
    if (Object.hasOwn(LIBRARY_MAP, specifier)) return new URL(LIBRARY_MAP[specifier], this.baseUrl).href;
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const resolved = new URL(specifier, importerUrl);
      if (resolved.origin !== new URL(this.baseUrl).origin) throw new NumiOSError('MODULE_ORIGIN_DENIED', 'Cross-origin module imports are not allowed by the NumiOS resolver.');
      return resolved.href;
    }
    if (specifier.startsWith('/')) {
      const normalized = normalizePath(specifier);
      return new URL(normalized, this.baseUrl).href;
    }
    throw new NumiOSError('MODULE_NOT_FOUND', 'Bare module specifier is not in the NumiOS SDK map.', { specifier });
  }

  assertCompatible(requiredVersion, { minimum = this.version, maximumExclusive = null } = {}) {
    const parse = value => value.split('.').map(Number);
    const compare = (left, right) => { const a = parse(left); const b = parse(right); for (let i = 0; i < 3; i += 1) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0) ? -1 : 1; return 0; };
    if (compare(requiredVersion, minimum) < 0 || (maximumExclusive && compare(requiredVersion, maximumExclusive) >= 0)) throw new NumiOSError('SDK_VERSION_INCOMPATIBLE', 'Application requires an incompatible SDK version.', { requiredVersion, supported: this.version });
    return true;
  }
}
