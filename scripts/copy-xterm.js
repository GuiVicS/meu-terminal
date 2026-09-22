#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Define source and destination paths
const nodeModulesPath = path.join(__dirname, '..', 'node_modules', '@xterm');
const publicNodeModulesPath = path.join(__dirname, '..', 'public', 'node_modules', '@xterm');

// Function to create directory recursively if it doesn't exist
function ensureDirExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`Created directory: ${dirPath}`);
  }
}

// Function to copy folder with all its content
function copyFolder(source, destination) {
  // Create destination directory if it doesn't exist
  ensureDirExists(destination);
  
  // Read all files/folders from source
  const items = fs.readdirSync(source);
  
  items.forEach(item => {
    const sourcePath = path.join(source, item);
    const destPath = path.join(destination, item);
    
    // Check if item is directory or file
    const stats = fs.statSync(sourcePath);
    
    if (stats.isDirectory()) {
      // Recursively copy subfolders
      copyFolder(sourcePath, destPath);
    } else {
      // Copy the file
      fs.copyFileSync(sourcePath, destPath);
    }
  });
  
  // console.log(`Copied from ${source} to ${destination}`);
}

// Main function to copy xterm files
function copyXtermFiles() {
  console.log('Starting to copy xterm files...');
  
  try {
    // Ensure the destination directory exists
    ensureDirExists(path.join(__dirname, '..', 'public', 'node_modules'));
    ensureDirExists(publicNodeModulesPath);
    
    // List all directories in the @xterm folder
    const xtermDirs = fs.readdirSync(nodeModulesPath);
    
    // Copy xterm main module
    if (xtermDirs.includes('xterm')) {
      copyFolder(
        path.join(nodeModulesPath, 'xterm'),
        path.join(publicNodeModulesPath, 'xterm')
      );
    }
    
    // Copy all addon directories (matching addon-*)
    xtermDirs.forEach(dir => {
      if (dir.startsWith('addon-')) {
        copyFolder(
          path.join(nodeModulesPath, dir),
          path.join(publicNodeModulesPath, dir)
        );
      }
    });
    
    console.log('Successfully copied all xterm files');
  } catch (error) {
    console.error('Error copying xterm files:', error);
    process.exit(1);
  }
}

// Execute the copy function
copyXtermFiles();