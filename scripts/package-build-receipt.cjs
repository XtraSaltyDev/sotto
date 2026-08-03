const RECEIPT_FIELDS = [
  'app',
  'bundleId',
  'commit',
  'schemaVersion',
  'version',
];

const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validatePackageBuildReceipt = (
  value,
  { version, commit, bundleId = 'com.sotto.desktop' },
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
    value.schemaVersion !== 1 ||
    value.app !== 'sotto' ||
    value.bundleId !== bundleId ||
    value.version !== version ||
    value.commit !== commit ||
    !/^[0-9a-f]{40}$/u.test(value.commit)
  ) {
    throw new TypeError(
      'The packaged build receipt does not match this Sotto source checkout.',
    );
  }
  return value;
};

module.exports = { validatePackageBuildReceipt };
