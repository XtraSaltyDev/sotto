const {
  createPrivateKey,
  createPublicKey,
  sign: signBytes,
  verify: verifyBytes,
} = require('node:crypto');

const ARTIFACT_TARGETS = [
  'darwin-arm64',
  'darwin-arm64-archive',
  'win32-x64',
];
const TOP_LEVEL_FIELDS = [
  'app',
  'artifacts',
  'buildNumber',
  'bundleId',
  'channel',
  'commit',
  'publishedAt',
  'releaseKind',
  'schemaVersion',
  'version',
];
const ARTIFACT_FIELDS = [
  'downloadUrl',
  'file',
  'sha256',
  'size',
  'target',
];
const SIGNATURE_FIELDS = ['algorithm', 'keyId', 'value'];
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;

const isRecord = (value) =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const assertExactFields = (value, fields, message) => {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new TypeError(message);
  }
};

const canonicalizeJson = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON does not support non-finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`,
      )
      .join(',')}}`;
  }
  throw new TypeError('Canonical JSON contains an unsupported value.');
};

const keyObjectFor = (key, kind) => {
  const keyObject =
    typeof key === 'object' && key !== null && key.type === kind
      ? key
      : kind === 'private'
        ? createPrivateKey(key)
        : createPublicKey(key);
  if (keyObject.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(`The update ${kind} key must use Ed25519.`);
  }
  return keyObject;
};

const signReleaseManifest = (unsignedManifest, keyId, privateKey) => {
  if (!isRecord(unsignedManifest) || 'signature' in unsignedManifest) {
    throw new TypeError('The unsigned update manifest is invalid.');
  }
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    throw new TypeError('The update signing key ID is invalid.');
  }
  const signature = signBytes(
    null,
    Buffer.from(canonicalizeJson(unsignedManifest), 'utf8'),
    keyObjectFor(privateKey, 'private'),
  );
  return {
    ...unsignedManifest,
    signature: {
      algorithm: 'ed25519',
      keyId,
      value: signature.toString('base64'),
    },
  };
};

const parseArtifact = (
  value,
  target,
  manifestOrigin,
  allowInsecureHttpForTests,
) => {
  if (!isRecord(value)) {
    throw new TypeError('The update manifest artifact is invalid.');
  }
  assertExactFields(
    value,
    ARTIFACT_FIELDS,
    'The update manifest artifact is invalid.',
  );
  if (value.target !== target) {
    throw new TypeError('The update manifest artifact target is invalid.');
  }
  if (typeof value.file !== 'string' || !FILE_PATTERN.test(value.file)) {
    throw new TypeError('The update manifest artifact filename is invalid.');
  }
  if (typeof value.downloadUrl !== 'string') {
    throw new TypeError('The update manifest download URL is invalid.');
  }
  let downloadUrl;
  try {
    downloadUrl = new URL(value.downloadUrl);
  } catch {
    throw new TypeError('The update manifest download URL is invalid.');
  }
  if (
    downloadUrl.protocol !== 'https:' &&
    !(allowInsecureHttpForTests && downloadUrl.protocol === 'http:')
  ) {
    throw new TypeError('The update artifact URL must use HTTPS.');
  }
  if (
    downloadUrl.username ||
    downloadUrl.password ||
    downloadUrl.search ||
    downloadUrl.hash
  ) {
    throw new TypeError(
      'The update artifact URL must not contain credentials, a query, or a fragment.',
    );
  }
  if (downloadUrl.origin !== manifestOrigin) {
    throw new TypeError('The update artifact must come from the manifest origin.');
  }
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw new TypeError('The update manifest digest is invalid.');
  }
  if (
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > MAX_ARTIFACT_BYTES
  ) {
    throw new TypeError('The update manifest artifact size is invalid.');
  }
  return {
    target,
    file: value.file,
    downloadUrl: downloadUrl.href,
    sha256: value.sha256,
    size: value.size,
  };
};

const parseAuthenticatedManifest = (
  value,
  manifestUrl,
  allowInsecureHttpForTests,
) => {
  assertExactFields(value, TOP_LEVEL_FIELDS, 'The update manifest is invalid.');
  if (
    value.schemaVersion !== 2 ||
    value.app !== 'sotto' ||
    value.channel !== 'internal' ||
    value.releaseKind !== 'internal-ad-hoc' ||
    typeof value.version !== 'string' ||
    !VERSION_PATTERN.test(value.version) ||
    value.bundleId !== 'com.sotto.desktop' ||
    typeof value.commit !== 'string' ||
    !COMMIT_PATTERN.test(value.commit) ||
    typeof value.buildNumber !== 'number' ||
    !Number.isSafeInteger(value.buildNumber) ||
    value.buildNumber <= 0 ||
    typeof value.publishedAt !== 'string' ||
    !isRecord(value.artifacts)
  ) {
    throw new TypeError('The update manifest is invalid.');
  }
  const publishedAt = new Date(value.publishedAt);
  if (
    !Number.isFinite(publishedAt.getTime()) ||
    publishedAt.toISOString() !== value.publishedAt
  ) {
    throw new TypeError('The update manifest publication time is invalid.');
  }
  const artifactKeys = Object.keys(value.artifacts);
  if (
    artifactKeys.length === 0 ||
    artifactKeys.some((target) => !ARTIFACT_TARGETS.includes(target))
  ) {
    throw new TypeError('The update manifest artifacts are invalid.');
  }
  let parsedManifestUrl;
  try {
    parsedManifestUrl = new URL(manifestUrl);
  } catch {
    throw new TypeError('The update manifest URL is invalid.');
  }
  if (
    parsedManifestUrl.protocol !== 'https:' &&
    !(allowInsecureHttpForTests && parsedManifestUrl.protocol === 'http:')
  ) {
    throw new TypeError('The update manifest URL must use HTTPS.');
  }
  if (
    parsedManifestUrl.username ||
    parsedManifestUrl.password ||
    parsedManifestUrl.search ||
    parsedManifestUrl.hash
  ) {
    throw new TypeError(
      'The update manifest URL must not contain credentials, a query, or a fragment.',
    );
  }
  const artifacts = {};
  for (const target of artifactKeys) {
    artifacts[target] = parseArtifact(
      value.artifacts[target],
      target,
      parsedManifestUrl.origin,
      allowInsecureHttpForTests,
    );
  }
  return {
    schemaVersion: 2,
    app: 'sotto',
    channel: 'internal',
    releaseKind: 'internal-ad-hoc',
    version: value.version,
    bundleId: 'com.sotto.desktop',
    commit: value.commit,
    buildNumber: value.buildNumber,
    publishedAt: publishedAt.toISOString(),
    artifacts,
  };
};

const verifyReleaseManifest = (
  value,
  trustedKeys,
  manifestUrl,
  options = {},
) => {
  if (!isRecord(value)) {
    throw new TypeError('The update manifest is invalid.');
  }
  const { signature, ...unsignedManifest } = value;
  if (!isRecord(signature)) {
    throw new TypeError('The update manifest signature is missing.');
  }
  assertExactFields(
    signature,
    SIGNATURE_FIELDS,
    'The update manifest signature is malformed.',
  );
  if (
    signature.algorithm !== 'ed25519' ||
    typeof signature.keyId !== 'string' ||
    !KEY_ID_PATTERN.test(signature.keyId) ||
    typeof signature.value !== 'string' ||
    !BASE64_PATTERN.test(signature.value)
  ) {
    throw new TypeError('The update manifest signature is malformed.');
  }
  const signatureBytes = Buffer.from(signature.value, 'base64');
  if (signatureBytes.byteLength !== 64) {
    throw new TypeError('The update manifest signature is malformed.');
  }
  if (!isRecord(trustedKeys)) {
    throw new TypeError('Secure updates are not configured for this Sotto build.');
  }
  const trustedKey = trustedKeys[signature.keyId];
  if (typeof trustedKey !== 'string') {
    throw new TypeError('The update manifest was signed by an untrusted key.');
  }
  let publicKey;
  try {
    publicKey = keyObjectFor(trustedKey, 'public');
  } catch {
    throw new TypeError('The configured update verification key is invalid.');
  }
  const valid = verifyBytes(
    null,
    Buffer.from(canonicalizeJson(unsignedManifest), 'utf8'),
    publicKey,
    signatureBytes,
  );
  if (!valid) {
    throw new TypeError('The update manifest signature is invalid.');
  }
  return parseAuthenticatedManifest(
    unsignedManifest,
    manifestUrl,
    options.allowInsecureHttpForTests === true,
  );
};

module.exports = {
  canonicalizeJson,
  signReleaseManifest,
  verifyReleaseManifest,
};
