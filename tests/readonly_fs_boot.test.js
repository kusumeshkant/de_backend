/**
 * The production entry point must boot on a read-only filesystem.
 *
 * Vercel runs functions from /var/task, which is read-only. On 2026-09-29 the
 * release crashed every cold start because orderService required
 * utils/logger (winston), whose File transport does mkdir('logs') at import:
 *   Error: ENOENT: no such file or directory, mkdir 'logs'
 * Local runs and every other test missed it, because a dev machine's disk is
 * writable and the other suites mock the logger.
 *
 * This test loads the REAL api/graphql.js module graph (no module mocks) with
 * every filesystem write made to throw, as it would on Vercel.
 */

const fs = require('fs');
const path = require('path');

const WINSTON_LOGGER = path.resolve(__dirname, '../src/utils/logger.js');
const WRITE_FNS = ['mkdirSync', 'writeFileSync', 'appendFileSync', 'mkdir', 'writeFile', 'appendFile', 'createWriteStream'];

describe('api/graphql.js boots on a read-only filesystem (Vercel /var/task)', () => {
  let attemptedWrites;
  let originals;
  let originalCwd;

  beforeAll(() => {
    // Boot from an empty directory, as /var/task has no logs/ — a leftover
    // logs/ folder in the checkout would let winston skip its mkdir and hide
    // the crash (exactly how local runs missed it).
    originalCwd = process.cwd();
    process.chdir(fs.mkdtempSync(path.join(require('os').tmpdir(), 'dq-readonly-boot-')));
    // Satisfy the startup env check without real credentials; nothing connects.
    process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:1/readonly-boot-test';
    process.env.FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT || '';
    attemptedWrites = [];
    originals = {};
    for (const fn of WRITE_FNS) {
      originals[fn] = fs[fn];
      fs[fn] = (target) => {
        attemptedWrites.push(`${fn}(${target})`);
        const err = new Error(`EROFS: read-only file system, ${fn} '${target}'`);
        err.code = 'EROFS';
        throw err;
      };
    }
  });

  afterAll(() => {
    for (const fn of WRITE_FNS) fs[fn] = originals[fn];
    process.chdir(originalCwd);
  });

  it('loads the module without throwing and exports the request handler', () => {
    let handler;
    jest.isolateModules(() => {
      expect(() => { handler = require('../api/graphql.js'); }).not.toThrow();
    });
    expect(typeof handler).toBe('function');
    expect(attemptedWrites).toEqual([]);
  });

  it('never loads the winston file logger (src/utils/logger.js) on the production path', () => {
    // Jest keeps its own module registry (require.cache stays empty), so use a
    // sentinel: the factory runs only if something on the path requires it.
    let winstonLoggerRequired = false;
    jest.isolateModules(() => {
      jest.doMock(WINSTON_LOGGER, () => {
        winstonLoggerRequired = true;
        return { info() {}, warn() {}, error() {}, debug() {} };
      });
      require('../api/graphql.js');
    });
    expect(winstonLoggerRequired).toBe(false);
  });
});
