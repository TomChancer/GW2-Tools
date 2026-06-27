// One-off build helper: resizes build/icon-source.png into the standard
// Windows icon sizes and packs them into build/icon.ico for electron-builder.
const fs       = require('fs');
const path     = require('path');
const sharp    = require('sharp');
const pngToIco = require('png-to-ico').default;

const SRC  = path.join(__dirname, '..', 'build', 'icon-source.png');
const OUT  = path.join(__dirname, '..', 'build', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  const buffers = await Promise.all(
    SIZES.map(size => sharp(SRC).resize(size, size, { fit: 'cover' }).png().toBuffer())
  );
  const ico = await pngToIco(buffers);
  fs.writeFileSync(OUT, ico);
  console.log(`Wrote ${OUT} (${SIZES.join(', ')}px)`);
}

main().catch(e => { console.error(e); process.exit(1); });
