const { createPublicKey } = require('node:crypto');
const { readFile } = require('node:fs/promises');

const CONFIG_FIELDS = ['keys', 'manifestUrl', 'schemaVersion'];
const CONFIG_FIELDS_WITH_MODEL = [...CONFIG_FIELDS, 'modelUrl'];
const CONFIG_KEY_FIELDS = ['algorithm', 'keyId', 'publicKey'];
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactFields = (value, fields) => {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  );
};

const parseUpdateConfiguration = (value) => {
  if (
    !isRecord(value) ||
    (!hasExactFields(value, CONFIG_FIELDS) &&
      !hasExactFields(value, CONFIG_FIELDS_WITH_MODEL)) ||
    value.schemaVersion !== 1 ||
    typeof value.manifestUrl !== 'string' ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0
  ) {
    throw new TypeError('The embedded Sotto update configuration is invalid.');
  }
  let manifestUrl;
  try {
    manifestUrl = new URL(value.manifestUrl);
  } catch {
    throw new TypeError('The embedded update manifest URL is invalid.');
  }
  if (manifestUrl.protocol !== 'https:') {
    throw new TypeError('The embedded update manifest URL must use HTTPS.');
  }
  if (
    manifestUrl.username ||
    manifestUrl.password ||
    manifestUrl.search ||
    manifestUrl.hash
  ) {
    throw new TypeError(
      'The embedded update manifest URL must not contain credentials, a query, or a fragment.',
    );
  }
  let modelUrl;
  if (value.modelUrl !== undefined) {
    try {
      modelUrl = new URL(value.modelUrl);
    } catch {
      throw new TypeError('The embedded model URL is invalid.');
    }
    if (
      modelUrl.protocol !== 'https:' ||
      modelUrl.username ||
      modelUrl.password ||
      modelUrl.search ||
      modelUrl.hash ||
      modelUrl.origin !== manifestUrl.origin
    ) {
      throw new TypeError(
        'The embedded model URL must use the update origin over HTTPS without credentials, a query, or a fragment.',
      );
    }
  }
  const trustedManifestKeys = {};
  for (const entry of value.keys) {
    if (
      !isRecord(entry) ||
      !hasExactFields(entry, CONFIG_KEY_FIELDS) ||
      entry.algorithm !== 'ed25519' ||
      typeof entry.keyId !== 'string' ||
      !KEY_ID_PATTERN.test(entry.keyId) ||
      typeof entry.publicKey !== 'string' ||
      trustedManifestKeys[entry.keyId] !== undefined
    ) {
      throw new TypeError('The embedded update verification key is invalid.');
    }
    let publicKey;
    try {
      publicKey = createPublicKey(entry.publicKey);
    } catch {
      throw new TypeError('The embedded update verification key is invalid.');
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new TypeError('The embedded update verification key must use Ed25519.');
    }
    trustedManifestKeys[entry.keyId] = entry.publicKey;
  }
  return {
    manifestUrl: manifestUrl.href,
    ...(modelUrl ? { modelUrl: modelUrl.href } : {}),
    trustedManifestKeys,
  };
};

const loadUpdateConfiguration = async (filePath) => {
  if (filePath === null) return null;
  let contents;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return parseUpdateConfiguration(JSON.parse(contents));
};

module.exports = {
  loadUpdateConfiguration,
  parseUpdateConfiguration,
};
