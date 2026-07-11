const fs = require('fs');
const path = require('path');

// Paths relative to project root
const ROOT_DIR = path.resolve(__dirname, '..');
const SVG_PATH = path.join(ROOT_DIR, 'web', 'public', 'favicon.svg');
const ANDROID_RES_PATH = path.join(ROOT_DIR, 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_launcher_foreground.xml');

function syncIcons() {
  console.log('Running TVVC Icon Sync...');
  
  if (!fs.existsSync(SVG_PATH)) {
    console.error(`Error: Source SVG not found at ${SVG_PATH}`);
    process.exit(1);
  }

  const svgContent = fs.readFileSync(SVG_PATH, 'utf8');
  
  // Extract path data (d attribute value)
  const dMatch = svgContent.match(/\bd="([^"]+)"/);
  if (!dMatch) {
    console.error('Error: Could not find path data (d attribute) in the source SVG.');
    process.exit(1);
  }
  
  const pathData = dMatch[1];
  console.log('Successfully extracted path data from SVG.');

  // Construct Android Vector Drawable XML
  const androidXml = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108.0"
    android:viewportHeight="108.0">
    <path
        android:fillColor="#FFFFFF"
        android:fillType="evenOdd"
        android:pathData="${pathData}" />
</vector>
`;

  // Make sure the target directory exists
  const targetDir = path.dirname(ANDROID_RES_PATH);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Write XML
  fs.writeFileSync(ANDROID_RES_PATH, androidXml, 'utf8');
  console.log(`Successfully generated Android vector drawable at ${ANDROID_RES_PATH}`);
}

syncIcons();
