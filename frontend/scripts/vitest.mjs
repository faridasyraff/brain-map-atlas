// Runs Vitest, passing any arguments through (`npm test -- --watch`).
//
// Why a wrapper: on Windows, when the shell's working directory has a
// lowercase drive letter (`c:\...`, which VS Code's terminal gives), Vitest
// loads its own modules twice, once as c:\ and once as C:\. Matchers added
// in the setup file (jest-dom's toHaveAttribute etc.) then land on a
// different `expect` than the tests use and fail with "Invalid Chai
// property". Starting Vitest with the drive letter uppercased avoids it.
// On macOS/Linux this simply runs Vitest.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Uppercase a Windows drive letter (c:/x -> C:/x); no-op elsewhere. */
const upperDrive = (p) =>
  process.platform === 'win32' && /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;

const cwd = upperDrive(process.cwd());
const pkgJson = createRequire(import.meta.url).resolve('vitest/package.json');
const vitestBin = upperDrive(join(dirname(pkgJson), 'vitest.mjs'));

const { status } = spawnSync(process.execPath, [vitestBin, ...process.argv.slice(2)], {
  cwd,
  stdio: 'inherit',
});
process.exit(status ?? 1);
