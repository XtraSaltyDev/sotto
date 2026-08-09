const RECEIPT_FIELDS = [
  'app',
  'bundleId',
  'commit',
  'lockfileSha256',
  'nodeVersion',
  'schemaVersion',
  'sourceDigest',
  'sourceState',
  'version',
];

const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validatePackageBuildReceipt = (
  value,
  {
    version,
    commit,
    sourceDigest,
    sourceState,
    lockfileSha256,
    nodeVersion,
    bundleId = 'com.sotto.desktop',
  },
) => {
  if (!isRecord(value)) {
    throw new TypeError(
      'The packaged build receipt does not match this Sotto source checkout.',
    );
  }
  const actualFields = Object.keys(value).sort();
  const expectedFields = [...RECEIPT_FIELDS].sort();
  if (
    actualFields.length !== expectedFields.length ||
    !actualFields.every(
      (field, index) => field === expectedFields[index],
    ) ||
    value.schemaVersion !== 2 ||
    value.app !== 'sotto' ||
    value.bundleId !== bundleId ||
    value.version !== version ||
    value.commit !== commit ||
    value.sourceDigest !== sourceDigest ||
    value.sourceState !== sourceState ||
    value.lockfileSha256 !== lockfileSha256 ||
    value.nodeVersion !== nodeVersion ||
    !/^[0-9a-f]{40}$/u.test(value.commit) ||
    !/^[0-9a-f]{64}$/u.test(value.sourceDigest) ||
    !/^[0-9a-f]{64}$/u.test(value.lockfileSha256) ||
    !['clean', 'dirty'].includes(value.sourceState) ||
    !/^v\d+\.\d+\.\d+$/u.test(value.nodeVersion)
  ) {
    throw new TypeError(
      'The packaged build receipt does not match this Sotto source checkout.',
    );
  }
  return value;
};

module.exports = { validatePackageBuildReceipt };
