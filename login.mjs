import { spawn } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Pi-ai writes auth.json in the current directory. Keep subscription logins
// local to this checkout rather than changing an existing Pi installation.
process.umask(0o077);
const cli = fileURLToPath(new URL('./node_modules/@earendil-works/pi-ai/dist/cli.js', import.meta.url));
const child = spawn(process.execPath, [cli, 'login', ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: 'inherit'
});
child.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', async code => {
  if (code === 0) await chmod(new URL('./auth.json', import.meta.url), 0o600);
  process.exitCode = code ?? 1;
});
