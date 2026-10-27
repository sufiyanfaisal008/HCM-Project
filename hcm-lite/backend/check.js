// Dev helper: requires every source file to catch syntax/reference errors early.
const { execSync } = require('child_process');
const files = execSync('find src -name "*.js"', { cwd: __dirname }).toString().trim().split('\n');
files.concat(['server.js']).forEach((f) => {
  require('./' + f); // eslint-disable-line import/no-dynamic-require
  console.log('OK', f);
});
console.log('ALL FILES LOADED');
process.exit(0);
