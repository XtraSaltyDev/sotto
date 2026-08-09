const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const git = (root, args, options = {}) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding,
    maxBuffer: 64 * 1024 * 1024,
  });

const createSourceProvenance = (projectRoot) => {
  const root = path.resolve(projectRoot);
  const commit = git(root, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const diff = git(root, ['diff', '--binary', 'HEAD']);
  const sourceHash = createHash('sha256')
    .update('sotto-source-v1\0')
    .update(commit)
    .update('\0')
    .update(status)
    .update('\0')
    .update(diff);

  const untracked = status
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3))
    .sort();
  for (const relativePath of untracked) {
    sourceHash.update('\0untracked\0').update(relativePath).update('\0');
    sourceHash.update(readFileSync(path.join(root, relativePath)));
  }

  return {
    commit,
    sourceState: status.length === 0 ? 'clean' : 'dirty',
    sourceDigest: sourceHash.digest('hex'),
  };
};

module.exports = { createSourceProvenance };
