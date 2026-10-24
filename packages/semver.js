import { NumiOSError } from '../core/errors.js';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseVersion(version) {
  if (typeof version !== 'string') throw new NumiOSError('SEMVER_INVALID', 'Version must be a string.', { version });
  const match = SEMVER.exec(version);
  if (!match) throw new NumiOSError('SEMVER_INVALID', `Invalid semantic version: ${version}`, { version });
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ? match[4].split('.') : [], build: match[5] || '' };
}

export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left;
  const b = typeof right === 'string' ? parseVersion(right) : right;
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.prerelease[i]; const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function satisfiesVersion(version, range = '*') {
  const target = parseVersion(version);
  if (typeof range !== 'string' || !range.trim()) throw new NumiOSError('SEMVER_RANGE_INVALID', 'Version range must be a non-empty string.');
  const alternatives = range.split('||').map(value => value.trim()).filter(Boolean);
  return alternatives.some(alternative => alternative.split(/\s+/).every(token => satisfiesToken(target, token)));
}

function satisfiesToken(version, token) {
  if (token === '*' || token.toLowerCase() === 'x') return true;
  const op = token.match(/^(>=|<=|>|<|=|\^|~)?(.*)$/);
  const operator = op[1] || '=';
  const raw = op[2];
  if (!raw) throw new NumiOSError('SEMVER_RANGE_INVALID', `Invalid version range token: ${token}`);
  if (raw.includes('x') || raw.includes('*')) {
    const parts = raw.split('.');
    if (parts.length > 3) throw new NumiOSError('SEMVER_RANGE_INVALID', `Invalid wildcard range: ${token}`);
    const nums = parts.map(part => /^[0-9]+$/.test(part) ? Number(part) : null);
    for (let i = 0; i < nums.length; i += 1) if (nums[i] !== null && version[['major', 'minor', 'patch'][i]] !== nums[i]) return false;
    return true;
  }
  const candidate = parseVersion(raw);
  const cmp = compareVersions(version, candidate);
  if (operator === '>=') return cmp >= 0;
  if (operator === '<=') return cmp <= 0;
  if (operator === '>') return cmp > 0;
  if (operator === '<') return cmp < 0;
  if (operator === '^') {
    if (cmp < 0) return false;
    if (candidate.major > 0) return version.major === candidate.major;
    if (candidate.minor > 0) return version.major === 0 && version.minor === candidate.minor;
    return version.major === 0 && version.minor === 0 && version.patch === candidate.patch;
  }
  if (operator === '~') return cmp >= 0 && version.major === candidate.major && version.minor === candidate.minor;
  return cmp === 0;
}

export function highestSatisfying(versions, range = '*') {
  return [...versions].filter(version => satisfiesVersion(version, range)).sort(compareVersions).at(-1) || null;
}
