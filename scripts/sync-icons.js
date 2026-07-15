const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_PNG = path.join(ROOT_DIR, 'web', 'public', 'favicon.png');
const RES_DIR = path.join(ROOT_DIR, 'android', 'app', 'src', 'main', 'res');

function syncIcons() {
  console.log('Running TVVC Icon Sync from PNG...');

  if (!fs.existsSync(SRC_PNG)) {
    console.error(`Error: Source PNG not found at ${SRC_PNG}`);
    process.exit(1);
  }

  const densities = [
    { name: 'mdpi', size: 48 },
    { name: 'hdpi', size: 72 },
    { name: 'xhdpi', size: 96 },
    { name: 'xxhdpi', size: 144 },
    { name: 'xxxhdpi', size: 192 }
  ];

  // 1. Generate regular and round launcher PNGs for all densities using sips
  for (const d of densities) {
    const mipmapDir = path.join(RES_DIR, `mipmap-${d.name}`);
    if (!fs.existsSync(mipmapDir)) {
      fs.mkdirSync(mipmapDir, { recursive: true });
    }

    const launcherPng = path.join(mipmapDir, 'ic_launcher.png');
    const launcherRoundPng = path.join(mipmapDir, 'ic_launcher_round.png');
    const launcherWebp = path.join(mipmapDir, 'ic_launcher.webp');
    const launcherRoundWebp = path.join(mipmapDir, 'ic_launcher_round.webp');

    console.log(`Generating icons for mipmap-${d.name} (${d.size}x${d.size})...`);

    // Run sips to resize image to target size
    execSync(`sips -z ${d.size} ${d.size} "${SRC_PNG}" --out "${launcherPng}"`, { stdio: 'inherit' });
    execSync(`sips -z ${d.size} ${d.size} "${SRC_PNG}" --out "${launcherRoundPng}"`, { stdio: 'inherit' });

    // Clean up old webp files to avoid resource collision
    if (fs.existsSync(launcherWebp)) {
      fs.unlinkSync(launcherWebp);
    }
    if (fs.existsSync(launcherRoundWebp)) {
      fs.unlinkSync(launcherRoundWebp);
    }
  }

  // 2. Clean up adaptive icon XML configurations that would override our PNGs on API 26+
  const anyDpiDir = path.join(RES_DIR, 'mipmap-anydpi-v26');
  if (fs.existsSync(anyDpiDir)) {
    console.log('Cleaning up mipmap-anydpi-v26 adaptive icon configs...');
    const anyDpiFiles = ['ic_launcher.xml', 'ic_launcher_round.xml'];
    for (const file of anyDpiFiles) {
      const filePath = path.join(anyDpiDir, file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    try {
      fs.rmdirSync(anyDpiDir);
    } catch (e) {
      console.warn(`Could not remove ${anyDpiDir}: ${e.message}`);
    }
  }

  // 3. Clean up legacy drawable vector launcher icons
  const drawables = [
    path.join(RES_DIR, 'drawable', 'ic_launcher_background.xml'),
    path.join(RES_DIR, 'drawable', 'ic_launcher_foreground.xml')
  ];

  for (const drawable of drawables) {
    if (fs.existsSync(drawable)) {
      console.log(`Cleaning up legacy drawable: ${path.basename(drawable)}`);
      fs.unlinkSync(drawable);
    }
  }

  console.log('TVVC Icon Sync Completed Successfully!');
}

syncIcons();
