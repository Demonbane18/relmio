// Derive the standard acceptance workflow without credentials or cloud calls.
// Generate into a private evidence directory outside the public checkout.
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

async function resolveDestination(path) {
  const missing = [];
  let parent = path;
  for (;;) {
    try {
      return resolve(await realpath(parent), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(parent) === parent) throw error;
      missing.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}

const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const destination = process.argv[2] && await resolveDestination(resolve(process.argv[2]));
const relation = destination && relative(repository, destination);
if (!destination || !(relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation))) {
  throw new Error('Provide an evidence directory outside the checkout.');
}
const workflow = JSON.parse(await readFile(new URL('../acceptance/relmio-release-acceptance.json', import.meta.url), 'utf8'));
workflow.id = 'RelmioWindowsLocalAcceptance';
workflow.active = false;
const enabled = new Set(['Run acceptance', 'Settings', 'Local Model Chain', 'Local Chat Model', 'Before you run', 'Expected results']);
for (const node of workflow.nodes) {
  if (!enabled.has(node.name)) node.disabled = true;
  if (node.credentials) delete node.credentials;
  if (node.name === 'Before you run') node.parameters.content += '\n\nWindows local-only fixture: all provider/image checks are disabled and NOT-RUN. No OAuth grant or cloud request. Bind only Local Chat Model to the private local-model credential before execution. Restore the canonical workflow for explicitly approved provider checks.';
}
await mkdir(destination, { recursive: true });
await writeFile(join(destination, 'relmio-release-acceptance-local-model.json'), `${JSON.stringify(workflow, null, 2)}\n`, { flag: 'wx' });
console.log('Prepared credential-free local-only derivative of the standard acceptance workflow; provider checks remain disabled.');
