#!/usr/bin/env node

/**
 * Migration Helper Script
 *
 * Scans route files to find manual error responses that need migration
 * to structured error handling.
 */

const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, '../src/routes');

// Patterns that indicate old-style error handling
const patterns = [
  /res\.status\(\d+\)\.json\(\s*\{\s*success:\s*false/g,
  /return\s+res\.status\(/g,
  /res\.status\(40[0-9]\)/g,
  /res\.status\(50[0-9]\)/g
];

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath);
  const results = [];

  const lines = content.split('\n');

  lines.forEach((line, index) => {
    patterns.forEach(pattern => {
      if (pattern.test(line)) {
        results.push({
          file: fileName,
          line: index + 1,
          code: line.trim()
        });
      }
    });
  });

  return results;
}

function main() {
  console.log('🔍 Scanning route files for manual error responses...\n');

  const files = fs.readdirSync(routesDir)
    .filter(f => f.endsWith('.ts'))
    .map(f => path.join(routesDir, f));

  let totalIssues = 0;
  const fileResults = {};

  files.forEach(file => {
    const issues = scanFile(file);
    if (issues.length > 0) {
      fileResults[path.basename(file)] = issues;
      totalIssues += issues.length;
    }
  });

  if (totalIssues === 0) {
    console.log('✅ All route files have been migrated to structured errors!');
    return;
  }

  console.log(`Found ${totalIssues} manual error responses across ${Object.keys(fileResults).length} files:\n`);

  Object.entries(fileResults).forEach(([fileName, issues]) => {
    console.log(`📄 ${fileName} (${issues.length} issues)`);
    issues.forEach(issue => {
      console.log(`   Line ${issue.line}: ${issue.code}`);
    });
    console.log('');
  });

  console.log('\n💡 Next steps:');
  console.log('1. Import error helpers: import { throwNotFoundError, ... } from "../utils/errors"');
  console.log('2. Add NextFunction parameter to route handlers');
  console.log('3. Wrap logic in try-catch');
  console.log('4. Replace res.status().json() with throwXxxError()');
  console.log('5. Call next(error) in catch block');
  console.log('\nSee MIGRATION_PROGRESS.md for detailed examples.');
}

main();
