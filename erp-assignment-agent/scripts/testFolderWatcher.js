/**
 * Test script to verify folder watcher debounce and detection
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../src/config/env');
const { startFolderWatcher, stopFolderWatcher } = require('../src/scanner/folderWatcher');

async function testWatcher() {
  console.log('=== TESTING REAL-TIME FOLDER WATCHER ===\n');

  const watchDir = config.paths.collegeAssignments;
  console.log(`Watching: ${watchDir}`);

  startFolderWatcher(watchDir);

  const testFile = path.join(watchDir, 'TEST_WATCHER_TEMP.pdf');

  console.log(`Writing test file: ${testFile}`);
  fs.writeFileSync(testFile, 'Test PDF content for watcher');

  console.log('Waiting 6 seconds for debounce to elapse...');
  await new Promise((r) => setTimeout(r, 6500));

  // Clean up
  if (fs.existsSync(testFile)) {
    fs.unlinkSync(testFile);
    console.log('Cleaned up test file.');
  }

  stopFolderWatcher();
  console.log('\n=== FOLDER WATCHER TEST COMPLETED ===');
}

testWatcher();
