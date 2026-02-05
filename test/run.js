const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

console.log('UhCut Basic Tests\n');

// 1. Web assets exist
console.log('[Web Assets]');
assert(fs.existsSync(path.join(__dirname, '..', 'www', 'index.html')), 'index.html exists');
assert(fs.existsSync(path.join(__dirname, '..', 'www', 'script.js')), 'script.js exists');
assert(fs.existsSync(path.join(__dirname, '..', 'www', 'style.css')), 'style.css exists');
assert(fs.existsSync(path.join(__dirname, '..', 'www', 'manifest.json')), 'manifest.json exists');

// 2. Capacitor config
console.log('\n[Capacitor Config]');
const capConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capacitor.config.json'), 'utf8'));
assert(capConfig.appId === 'com.uhcut.app', 'appId is com.uhcut.app');
assert(capConfig.appName === 'UhCut', 'appName is UhCut');
assert(capConfig.webDir === 'www', 'webDir is www');

// 3. Package dependencies
console.log('\n[Dependencies]');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
assert(pkg.dependencies['@capacitor/core'], '@capacitor/core is a dependency');
assert(pkg.dependencies['@capacitor/android'], '@capacitor/android is a dependency');
assert(pkg.dependencies['@capacitor/ios'], '@capacitor/ios is a dependency');

// 4. HTML structure validation
console.log('\n[HTML Validation]');
const html = fs.readFileSync(path.join(__dirname, '..', 'www', 'index.html'), 'utf8');
assert(html.includes('<script'), 'index.html includes script tag');
assert(html.includes('script.js'), 'index.html references script.js');

// Results
console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
