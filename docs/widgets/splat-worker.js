// Background worker for the splat demos.
// 1. "decode": unpacks a .spz or .ply file and packs every blob's numbers into
//    GPU-ready arrays, so the page never freezes while a file is unpacked.
// 2. "sort": orders blobs back to front for the current camera, because
//    see-through blobs only blend correctly when drawn far-to-near.

const SH_C0 = 0.28209479177387814;
const ANGLE_COLOR_BYTES_PER_BLOB = 48; // up to 15 coefficients x rgb, padded to 12 RGBA texels

let sortCenters = null;
let sortGeneration = -1;

self.onmessage = async (event) => {
  const message = event.data;
  if (message.type === 'decode') {
    try {
      const splats = message.fileName.toLowerCase().endsWith('.ply')
        ? parsePly(message.buffer)
        : await parseSpz(message.buffer);
      const packed = packForGpu(splats, message.textureWidth, message.maxTextureSize);
      sortCenters = splats.positions.slice();
      sortGeneration = message.generation;
      const transfers = [packed.centerData.buffer, packed.covarianceDataA.buffer, packed.covarianceDataB.buffer,
        packed.colorData.buffer, splats.positions.buffer, splats.opacities.buffer];
      if (packed.angleColorData) transfers.push(packed.angleColorData.buffer);
      self.postMessage({
        type: 'decoded', generation: message.generation, count: splats.count,
        angleColorDegree: packed.angleColorDegree, textureWidth: message.textureWidth,
        centerData: packed.centerData, covarianceDataA: packed.covarianceDataA, covarianceDataB: packed.covarianceDataB,
        colorData: packed.colorData, angleColorData: packed.angleColorData,
        // Positions and opacities stay available on the page for framing the camera.
        positions: splats.positions, opacities: splats.opacities,
      }, transfers);
    } catch (error) {
      self.postMessage({ type: 'error', generation: message.generation, message: error.message });
    }
  } else if (message.type === 'sort') {
    if (message.generation !== sortGeneration || !sortCenters) {
      self.postMessage({ type: 'sorted', generation: message.generation, order: null });
      return;
    }
    const order = sortBackToFront(sortCenters, message.modelView);
    self.postMessage({ type: 'sorted', generation: message.generation, order }, [order.buffer]);
  }
};

// 16-bit counting sort by camera depth. Most negative z (farthest) is drawn first.
function sortBackToFront(centers, m) {
  const count = centers.length / 3;
  const depths = new Float32Array(count);
  let minDepth = Infinity, maxDepth = -Infinity;
  for (let i = 0; i < count; i++) {
    const z = m[2] * centers[i * 3] + m[6] * centers[i * 3 + 1] + m[10] * centers[i * 3 + 2] + m[14];
    depths[i] = z;
    if (z < minDepth) minDepth = z;
    if (z > maxDepth) maxDepth = z;
  }
  const bucketCount = 65536;
  const scale = (bucketCount - 1) / Math.max(1e-9, maxDepth - minDepth);
  const keys = new Uint32Array(count);
  const counts = new Uint32Array(bucketCount);
  for (let i = 0; i < count; i++) {
    const key = Math.floor((depths[i] - minDepth) * scale);
    keys[i] = key;
    counts[key]++;
  }
  const starts = new Uint32Array(bucketCount);
  for (let b = 1; b < bucketCount; b++) starts[b] = starts[b - 1] + counts[b - 1];
  const order = new Float32Array(count);
  for (let i = 0; i < count; i++) order[starts[keys[i]]++] = i;
  return order;
}

// Packs blobs into texture-shaped arrays (one row of texels per textureWidth blobs):
//   center:  x, y, z, random rank (for "show N% of blobs")
//   covA:    spread xx, xy, xz, yy        covB: spread yz, zz, opacity, unused
//   color:   base r, g, b                 angle color: 12 RGBA8 texels per blob
function packForGpu(splats, textureWidth, maxTextureSize) {
  const { count } = splats;
  const rowsFor = texelsPerBlob => Math.max(1, Math.ceil(count * texelsPerBlob / textureWidth));
  const paddedLength = texelsPerBlob => textureWidth * rowsFor(texelsPerBlob) * 4;

  const centerData = new Float32Array(paddedLength(1));
  const covarianceDataA = new Float32Array(paddedLength(1));
  const covarianceDataB = new Float32Array(paddedLength(1));
  const colorData = new Float32Array(paddedLength(1));

  for (let i = 0; i < count; i++) {
    centerData[i * 4] = splats.positions[i * 3];
    centerData[i * 4 + 1] = splats.positions[i * 3 + 1];
    centerData[i * 4 + 2] = splats.positions[i * 3 + 2];
    centerData[i * 4 + 3] = Math.random();

    // Spread (covariance) = R · S² · Rᵀ, with R built from the quaternion (x, y, z, w).
    const x = splats.rotations[i * 4], y = splats.rotations[i * 4 + 1], z = splats.rotations[i * 4 + 2], w = splats.rotations[i * 4 + 3];
    const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y);
    const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
    const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
    const sx = splats.scales[i * 3] ** 2, sy = splats.scales[i * 3 + 1] ** 2, sz = splats.scales[i * 3 + 2] ** 2;
    covarianceDataA[i * 4] = r00 * r00 * sx + r01 * r01 * sy + r02 * r02 * sz;
    covarianceDataA[i * 4 + 1] = r00 * r10 * sx + r01 * r11 * sy + r02 * r12 * sz;
    covarianceDataA[i * 4 + 2] = r00 * r20 * sx + r01 * r21 * sy + r02 * r22 * sz;
    covarianceDataA[i * 4 + 3] = r10 * r10 * sx + r11 * r11 * sy + r12 * r12 * sz;
    covarianceDataB[i * 4] = r10 * r20 * sx + r11 * r21 * sy + r12 * r22 * sz;
    covarianceDataB[i * 4 + 1] = r20 * r20 * sx + r21 * r21 * sy + r22 * r22 * sz;
    covarianceDataB[i * 4 + 2] = splats.opacities[i];

    colorData[i * 4] = splats.baseColors[i * 3];
    colorData[i * 4 + 1] = splats.baseColors[i * 3 + 1];
    colorData[i * 4 + 2] = splats.baseColors[i * 3 + 2];
    colorData[i * 4 + 3] = 1;
  }

  let angleColorData = null;
  let angleColorDegree = 0;
  if (splats.angleColorBytes && rowsFor(12) <= maxTextureSize) {
    angleColorData = new Uint8Array(paddedLength(12));
    angleColorData.set(splats.angleColorBytes);
    angleColorDegree = splats.angleColorDegree;
  }
  return { centerData, covarianceDataA, covarianceDataB, colorData, angleColorData, angleColorDegree };
}

// ---------------------------------------------------------------------------
// File readers. Both return plain arrays: positions (xyz), scales (xyz, linear),
// rotations (xyzw), opacities (0..1), baseColors (rgb), angleColorBytes
// (coefficient-major rgb bytes, value = byte / 128 - 1), angleColorDegree.
// ---------------------------------------------------------------------------
async function parseSpz(buffer) {
  const decompressed = new Uint8Array(await new Response(
    new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  ).arrayBuffer());
  const view = new DataView(decompressed.buffer);
  if (view.getUint32(0, true) !== 0x5053474e) throw new Error('This does not look like an SPZ file.');
  const version = view.getUint32(4, true);
  if (version < 2) throw new Error(`SPZ version ${version} is not supported.`);
  const count = view.getUint32(8, true);
  const angleColorDegree = decompressed[12];
  const fractionalBits = decompressed[13];
  let offset = 16;

  const positions = new Float32Array(count * 3);
  const positionScale = 1 / (1 << fractionalBits);
  for (let i = 0; i < count * 3; i++, offset += 3) {
    let value = decompressed[offset] | (decompressed[offset + 1] << 8) | (decompressed[offset + 2] << 16);
    if (value & 0x800000) value -= 0x1000000;
    positions[i] = value * positionScale;
  }
  const opacities = new Float32Array(count);
  for (let i = 0; i < count; i++) opacities[i] = decompressed[offset++] / 255;
  const baseColors = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) baseColors[i] = 0.5 + SH_C0 * ((decompressed[offset++] / 255 - 0.5) / 0.15);
  const scales = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) scales[i] = Math.exp(decompressed[offset++] / 16 - 10);

  const rotations = new Float32Array(count * 4);
  if (version >= 3) {
    // "Smallest three": 2 bits for the largest component's index, then three
    // 10-bit values (9-bit magnitude + sign bit).
    const magnitudeMask = (1 << 9) - 1;
    for (let i = 0; i < count; i++, offset += 4) {
      let packed = (decompressed[offset] | (decompressed[offset + 1] << 8) |
                   (decompressed[offset + 2] << 16) | (decompressed[offset + 3] << 24)) >>> 0;
      const largestIndex = packed >>> 30;
      let sumOfSquares = 0;
      for (let component = 3; component >= 0; component--) {
        if (component === largestIndex) continue;
        const magnitude = packed & magnitudeMask;
        const isNegative = (packed >>> 9) & 1;
        packed >>>= 10;
        let value = Math.SQRT1_2 * magnitude / magnitudeMask;
        if (isNegative) value = -value;
        rotations[i * 4 + component] = value;
        sumOfSquares += value * value;
      }
      rotations[i * 4 + largestIndex] = Math.sqrt(Math.max(0, 1 - sumOfSquares));
    }
  } else {
    for (let i = 0; i < count; i++, offset += 3) {
      const x = decompressed[offset] / 127.5 - 1, y = decompressed[offset + 1] / 127.5 - 1, z = decompressed[offset + 2] / 127.5 - 1;
      rotations[i * 4] = x; rotations[i * 4 + 1] = y; rotations[i * 4 + 2] = z;
      rotations[i * 4 + 3] = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    }
  }

  let angleColorBytes = null;
  if (angleColorDegree > 0) {
    const coefficients = (angleColorDegree + 1) ** 2 - 1;
    angleColorBytes = new Uint8Array(count * ANGLE_COLOR_BYTES_PER_BLOB).fill(128);
    for (let i = 0; i < count; i++) {
      angleColorBytes.set(decompressed.subarray(offset, offset + coefficients * 3), i * ANGLE_COLOR_BYTES_PER_BLOB);
      offset += coefficients * 3;
    }
  }
  return { count, positions, scales, rotations, opacities, baseColors, angleColorBytes, angleColorDegree };
}

function parsePly(buffer) {
  const bytes = new Uint8Array(buffer);
  const headerProbe = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const headerEnd = headerProbe.indexOf('end_header');
  if (!headerProbe.startsWith('ply') || headerEnd < 0) throw new Error('This does not look like a PLY file.');
  const dataStart = headerProbe.indexOf('\n', headerEnd) + 1;
  const headerLines = headerProbe.slice(0, headerEnd).split('\n').map(line => line.trim());
  if (!headerLines.some(line => line.startsWith('format binary_little_endian'))) {
    throw new Error('Only binary little-endian PLY files are supported.');
  }
  const TYPE_SIZES = { char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
                       int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  const elementsInFile = [];
  for (const line of headerLines) {
    const parts = line.split(/\s+/);
    if (parts[0] === 'element') elementsInFile.push({ name: parts[1], count: Number(parts[2]), properties: [] });
    if (parts[0] === 'property') {
      if (parts[1] === 'list') throw new Error('PLY list properties are not supported.');
      elementsInFile[elementsInFile.length - 1].properties.push({ type: parts[1], name: parts[2] });
    }
  }
  if (elementsInFile.some(element => element.name === 'chunk')) {
    throw new Error('This is a compressed PLY. Please use the standard (uncompressed) PLY instead.');
  }
  let elementOffset = dataStart;
  let vertexElement = null;
  for (const element of elementsInFile) {
    let propertyOffset = 0;
    for (const property of element.properties) { property.offset = propertyOffset; propertyOffset += TYPE_SIZES[property.type]; }
    element.stride = propertyOffset;
    element.byteOffset = elementOffset;
    if (element.name === 'vertex') vertexElement = element;
    elementOffset += element.stride * element.count;
  }
  if (!vertexElement) throw new Error('No vertex data in this PLY.');

  const view = new DataView(buffer);
  const readers = {
    char: o => view.getInt8(o), int8: o => view.getInt8(o), uchar: o => view.getUint8(o), uint8: o => view.getUint8(o),
    short: o => view.getInt16(o, true), int16: o => view.getInt16(o, true), ushort: o => view.getUint16(o, true), uint16: o => view.getUint16(o, true),
    int: o => view.getInt32(o, true), int32: o => view.getInt32(o, true), uint: o => view.getUint32(o, true), uint32: o => view.getUint32(o, true),
    float: o => view.getFloat32(o, true), float32: o => view.getFloat32(o, true), double: o => view.getFloat64(o, true), float64: o => view.getFloat64(o, true),
  };
  const propertyByName = Object.fromEntries(vertexElement.properties.map(property => [property.name, property]));
  const makeGetter = (name, fallback) => {
    const property = propertyByName[name];
    if (!property) return () => fallback;
    const read = readers[property.type];
    const offset = property.offset;
    return base => read(base + offset);
  };
  const count = vertexElement.count;
  const restCount = vertexElement.properties.filter(p => p.name.startsWith('f_rest_')).length;
  const coefficientsPerChannel = restCount / 3;
  const angleColorDegree = coefficientsPerChannel >= 15 ? 3 : coefficientsPerChannel >= 8 ? 2 : coefficientsPerChannel >= 3 ? 1 : 0;
  const usedCoefficients = Math.min(15, coefficientsPerChannel);

  const getPosition = ['x', 'y', 'z'].map(name => makeGetter(name, 0));
  const hasGaussianColor = !!propertyByName.f_dc_0;
  const getDc = [0, 1, 2].map(i => makeGetter(`f_dc_${i}`, 0));
  const getRgb = ['red', 'green', 'blue'].map(name => makeGetter(name, 200));
  const getOpacity = makeGetter('opacity', 10);
  const getScale = [0, 1, 2].map(i => makeGetter(`scale_${i}`, Math.log(0.01)));
  const getRotation = [0, 1, 2, 3].map(i => makeGetter(`rot_${i}`, i === 0 ? 1 : 0));
  const getRest = Array.from({ length: restCount }, (_, i) => makeGetter(`f_rest_${i}`, 0));

  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const opacities = new Float32Array(count);
  const baseColors = new Float32Array(count * 3);
  const angleColorBytes = angleColorDegree > 0 ? new Uint8Array(count * ANGLE_COLOR_BYTES_PER_BLOB).fill(128) : null;
  for (let i = 0; i < count; i++) {
    const base = vertexElement.byteOffset + i * vertexElement.stride;
    for (let axis = 0; axis < 3; axis++) {
      positions[i * 3 + axis] = getPosition[axis](base);
      scales[i * 3 + axis] = Math.exp(getScale[axis](base));
    }
    // PLY stores rotation as (w, x, y, z); we keep (x, y, z, w).
    const w = getRotation[0](base), x = getRotation[1](base), y = getRotation[2](base), z = getRotation[3](base);
    const length = Math.hypot(w, x, y, z) || 1;
    rotations[i * 4] = x / length; rotations[i * 4 + 1] = y / length; rotations[i * 4 + 2] = z / length; rotations[i * 4 + 3] = w / length;
    opacities[i] = 1 / (1 + Math.exp(-getOpacity(base)));
    for (let channel = 0; channel < 3; channel++) {
      baseColors[i * 3 + channel] = hasGaussianColor ? 0.5 + SH_C0 * getDc[channel](base) : getRgb[channel](base) / 255;
    }
    if (angleColorBytes) {
      // PLY is channel-major (all red coefficients, then green, then blue).
      for (let coefficient = 0; coefficient < usedCoefficients; coefficient++) {
        for (let channel = 0; channel < 3; channel++) {
          const value = getRest[channel * coefficientsPerChannel + coefficient](base);
          angleColorBytes[i * ANGLE_COLOR_BYTES_PER_BLOB + coefficient * 3 + channel] = Math.max(0, Math.min(255, Math.round(value * 128 + 128)));
        }
      }
    }
  }
  return { count, positions, scales, rotations, opacities, baseColors, angleColorBytes, angleColorDegree };
}
