import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 从 Natural Earth `ne_110m_admin_0_countries.geojson`（Public Domain）
 * 栅格化生成 Web 端离线世界点阵底图 `web/src/data/world-dot-map.ts`。
 *
 * 运行：`npm run worldmap:update`
 */

const SOURCE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';

const COLS = 160;
const ROWS = 88;
const MIN_LAT = -56;
const MAX_LAT = 80;
const MIN_LON = -180;
const MAX_LON = 180;

const MANUAL_ANCHORS: Record<string, readonly [number, number]> = {
  HK: [22.3193, 114.1694],
  MO: [22.1987, 113.5439],
  SG: [1.3521, 103.8198],
  TW: [23.65, 120.87],
  BH: [26.0667, 50.5577],
  MT: [35.9375, 14.3754],
  US: [39.5, -98.5],
  RU: [61.5, 95.0],
  JP: [36.2, 138.25],
  UK: [54.2, -2.3],
};

function mercatorY(latDeg: number): number {
  const clamped = Math.min(Math.max(latDeg, -85), 85);
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
}

function inverseMercatorY(mercY: number): number {
  return (2 * Math.atan(Math.exp(mercY)) - Math.PI / 2) * (180 / Math.PI);
}

type Ring = readonly (readonly [number, number])[];
type PolygonCoords = readonly Ring[];

interface FeatureRecord {
  readonly code: string | null;
  readonly labelLat?: number;
  readonly labelLon?: number;
  readonly polygons: readonly {
    readonly bbox: readonly [number, number, number, number];
    readonly rings: PolygonCoords;
  }[];
}

function computeBBox(ring: Ring): readonly [number, number, number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const pt of ring) {
    const x = pt[0];
    const y = pt[1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, maxX, minY, maxY];
}

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0];
    const yi = ring[i]![1];
    const xj = ring[j]![0];
    const yj = ring[j]![1];
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lon: number, lat: number, poly: PolygonCoords): boolean {
  const outer = poly[0];
  if (outer === undefined || !pointInRing(lon, lat, outer)) return false;
  for (let i = 1; i < poly.length; i += 1) {
    const hole = poly[i];
    if (hole !== undefined && pointInRing(lon, lat, hole)) return false;
  }
  return true;
}

function resolveIsoCode(props: Record<string, unknown>): string | null {
  const candidates = [props['ISO_A2_EH'], props['ISO_A2']];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const upper = raw.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(upper) && upper !== 'AQ') {
      return upper === 'GB' ? 'UK' : upper;
    }
  }
  return null;
}

function encodeRle(cells: readonly string[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < cells.length) {
    const token = cells[i]!;
    let run = 1;
    while (i + run < cells.length && cells[i + run] === token) run += 1;
    parts.push(run === 1 ? token : `${run}${token}`);
    i += run;
  }
  return parts.join(',');
}

console.log(`Fetching Natural Earth 110m countries from ${SOURCE_URL}...`);
const response = await fetch(SOURCE_URL, { redirect: 'follow' });
if (!response.ok) {
  throw new Error(`Failed to fetch Natural Earth GeoJSON: HTTP ${response.status}`);
}

interface RawGeoJson {
  features: {
    properties: Record<string, unknown>;
    geometry: {
      type: 'Polygon' | 'MultiPolygon';
      coordinates: unknown;
    } | null;
  }[];
}

const geojson = (await response.json()) as RawGeoJson;
const features: FeatureRecord[] = [];
const anchors: Record<string, [number, number]> = {};

for (const feature of geojson.features) {
  if (!feature.geometry) continue;
  const code = resolveIsoCode(feature.properties);
  const labelLat = feature.properties['LABEL_Y'];
  const labelLon = feature.properties['LABEL_X'];
  if (
    code !== null &&
    typeof labelLat === 'number' &&
    typeof labelLon === 'number' &&
    Number.isFinite(labelLat) &&
    Number.isFinite(labelLon)
  ) {
    anchors[code] = [Number(labelLat.toFixed(2)), Number(labelLon.toFixed(2))];
  }

  const rawPolys =
    feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates as PolygonCoords]
      : (feature.geometry.coordinates as readonly PolygonCoords[]);

  const polygons = rawPolys
    .filter((poly) => poly.length > 0 && poly[0]!.length > 0)
    .map((rings) => ({
      bbox: computeBBox(rings[0]!),
      rings,
    }));

  // 略过南极洲避免底边出现一大条空白/陆地
  if (feature.properties['ISO_A2_EH'] === 'AQ' || feature.properties['ISO_A2'] === 'AQ') continue;

  features.push({
    code,
    ...(typeof labelLat === 'number' ? { labelLat } : {}),
    ...(typeof labelLon === 'number' ? { labelLon } : {}),
    polygons,
  });
}

for (const [code, coords] of Object.entries(MANUAL_ANCHORS)) {
  anchors[code] = [coords[0], coords[1]];
}

const topY = mercatorY(MAX_LAT);
const bottomY = mercatorY(MIN_LAT);
const cells = new Array<string>(COLS * ROWS).fill('.');
let landCount = 0;

for (let row = 0; row < ROWS; row += 1) {
  const yNorm = (row + 0.5) / ROWS;
  const lat = inverseMercatorY(topY - yNorm * (topY - bottomY));
  for (let col = 0; col < COLS; col += 1) {
    const xNorm = (col + 0.5) / COLS;
    const lon = MIN_LON + xNorm * (MAX_LON - MIN_LON);

    let matched: string | null = null;
    let isLand = false;
    for (const f of features) {
      for (const poly of f.polygons) {
        const [minX, maxX, minY, maxY] = poly.bbox;
        if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
        if (pointInPolygon(lon, lat, poly.rings)) {
          isLand = true;
          matched = f.code;
          break;
        }
      }
      if (isLand) break;
    }
    if (isLand) {
      cells[row * COLS + col] = matched ?? '#';
      landCount += 1;
    }
  }
}

const sortedAnchors = Object.fromEntries(
  Object.entries(anchors).sort(([a], [b]) => a.localeCompare(b)),
);
const rle = encodeRle(cells);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(scriptDir, '../web/src/data/world-dot-map.ts');
mkdirSync(dirname(outPath), { recursive: true });

const output = `/**
 * 离线世界点阵底图（Natural Earth ne_110m_admin_0_countries，Public Domain）。
 * 由 \`npm run worldmap:update\` 自动生成，勿手动编辑数据正文。
 */

export const WORLD_MAP_COLS = ${COLS};
export const WORLD_MAP_ROWS = ${ROWS};
export const WORLD_MAP_BOUNDS = {
  minLat: ${MIN_LAT},
  maxLat: ${MAX_LAT},
  minLon: ${MIN_LON},
  maxLon: ${MAX_LON},
} as const;

export const WORLD_COUNTRY_ANCHORS: Readonly<Record<string, readonly [number, number]>> = ${JSON.stringify(sortedAnchors)};

/**
 * RLE 编码的网格数据（按行展开共 ${COLS * ROWS} 格）：
 * \`.\` = 海洋；\`#\` = 未归属陆地；两位大写字母 = 归一化地区码（GB 已归一为 UK）。
 */
export const WORLD_GRID_RLE =
  ${JSON.stringify(rle)};

export function decodeWorldGrid(): readonly string[] {
  const out = new Array<string>(WORLD_MAP_COLS * WORLD_MAP_ROWS);
  let cursor = 0;
  for (const part of WORLD_GRID_RLE.split(',')) {
    const match = /^(\\d*)(.+)$/.exec(part);
    if (match === null) continue;
    const count = match[1] === '' ? 1 : Number.parseInt(match[1]!, 10);
    const token = match[2]!;
    for (let k = 0; k < count && cursor < out.length; k += 1) {
      out[cursor] = token;
      cursor += 1;
    }
  }
  return out;
}
`;

writeFileSync(outPath, output, 'utf8');
console.log(
  `WORLD_MAP_OK cols=${COLS} rows=${ROWS} land=${landCount}/${COLS * ROWS} countries=${Object.keys(sortedAnchors).length} bytes=${Buffer.byteLength(output, 'utf8')}`,
);
