'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const entry = path.join(
  __dirname,
  '..',
  'src',
  'main',
  'transcription',
  'speaker-evaluation-cli.ts',
);

require(entry).runSpeakerEvaluationCli(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown speaker evaluation error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
