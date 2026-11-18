import { join, resolve } from 'node:path';
import { downloadAndCompileGeoDatabases } from '../src/server/geo.ts';

const dataDir = resolve(process.env['STARTRAILS_DATA_DIR'] ?? './data');
const geoDir = resolve(process.env['STARTRAILS_GEO_DIR'] ?? join(dataDir, 'geo'));

console.log(`Downloading and compiling offline IP databases into ${geoDir}...`);
const status = await downloadAndCompileGeoDatabases(geoDir);
console.log(
  `GEO_DB_READY countryV4=${status.counts.countryV4} countryV6=${status.counts.countryV6} asnV4=${status.counts.asnV4} asnV6=${status.counts.asnV6} bytes=${status.bytes}`,
);
