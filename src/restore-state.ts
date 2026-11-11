import {execFileSync} from 'node:child_process';
import {restoreCollectorState} from './history/collector-state';

try {
  restoreCollectorState((program, args) => execFileSync(program, args, {encoding: 'utf8'}));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
