import { createRequire } from 'node:module';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'live/package.json'));
const { build } = require('esbuild');
await mkdir(join(root, 'action/dist'), { recursive: true });
await mkdir(join(root, 'action/proto/nix_ci_build/v1'), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'action/index.mjs')], outfile: join(root, 'action/dist/index.js'),
  bundle: true, platform: 'node', target: 'node24', format: 'esm', sourcemap: false,
  banner: { js: "import { createRequire as nodeCreateRequire } from 'node:module'; const require = nodeCreateRequire(import.meta.url);" },
  legalComments: 'eof',
});
await writeFile(join(root, 'action/dist/package.json'), '{"type":"module"}\n');
await copyFile(join(root, 'proto/nix_ci_build/v1/reporting.proto'), join(root, 'action/proto/nix_ci_build/v1/reporting.proto'));
