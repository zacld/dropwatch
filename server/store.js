import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// JSON file store. Single process; every mutation is synchronous and saved before the response,
// so the attempt lock cannot be taken twice.
export function createStore(file) {
  mkdirSync(dirname(file), { recursive: true });
  const data = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { watches: [], notifications: [], nextId: 1 };
  return {
    data,
    save() {
      const tmp = file + '.tmp';
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, file);
    },
  };
}
