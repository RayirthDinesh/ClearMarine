/**
 * @tensorflow-models/coco-ssd ships a min bundle with //# sourceMappingURL=...
 * but omits the .map file from npm. CRA's source-map-loader then warns on every build.
 * Write a minimal valid map so the loader succeeds (debugging coco-ssd internals is rare).
 */
const fs = require('fs');
const path = require('path');

const mapPath = path.join(
  __dirname,
  '..',
  'node_modules',
  '@tensorflow-models',
  'coco-ssd',
  'dist',
  'coco-ssd.es2017.esm.min.js.map'
);

const stub = JSON.stringify({
  version: 3,
  file: 'coco-ssd.es2017.esm.min.js',
  sources: [],
  names: [],
  mappings: '',
});

function main() {
  const dir = path.dirname(mapPath);
  if (!fs.existsSync(dir)) {
    process.stderr.write('ensure-coco-ssd-sourcemap: coco-ssd dist missing; skip\n');
    return;
  }
  if (fs.existsSync(mapPath)) return;
  fs.writeFileSync(mapPath, stub, 'utf8');
  process.stdout.write('ensure-coco-ssd-sourcemap: wrote stub ' + mapPath + '\n');
}

main();
