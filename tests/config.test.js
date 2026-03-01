const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

test('config.example.js exists and has placeholders', () => {
    // Read the config file
    const fileContent = fs.readFileSync('config.example.js', 'utf8');

    const script = new vm.Script(fileContent + '; CONFIG');
    const sandbox = {};
    vm.createContext(sandbox);
    const result = script.runInContext(sandbox);

    // Check if CONFIG exists
    assert.ok(result, 'CONFIG object should exist');

    // Verify placeholders
    assert.strictEqual(result.SUPABASE_URL, 'YOUR_SUPABASE_URL', 'SUPABASE_URL should be a placeholder');
    assert.strictEqual(result.SUPABASE_KEY, 'YOUR_SUPABASE_KEY', 'SUPABASE_KEY should be a placeholder');
});

test('config.js is in .gitignore', () => {
    const gitignoreContent = fs.readFileSync('.gitignore', 'utf8');
    assert.ok(gitignoreContent.includes('config.js'), '.gitignore should include config.js');
});
