// Her pupils, alive: they widen and narrow the way real ones do, all the time.
//
// The eye is one painted texture, so the pupil can't just be scaled. Instead the shader finds the
// iris in the texture (its centre, its size and how big the painted pupil is) and re-maps it
// radially: the pupil grows or shrinks and the iris fibres around it stretch or bunch up to make
// room, as a real iris does. Every other map on the eye (normals, roughness, her iris colours)
// follows the same re-mapping, so it all stays lined up.
//
// What sets the size, each frame (see pupilTarget):
//   light       bright daylight squeezes them small; night and dim rooms open them wide. The
//               light reflex is quick to tighten (~0.3 s) and slow to open back up (~3 s).
//   focus       looking at something close (whoever she's talking with) narrows them a touch
//               (the near reflex); gazing off into the distance relaxes them.
//   thinking    working something out, recalling, searching: mental effort dilates the pupils.
//   feeling     interest, excitement, surprise, fear, attraction, laughter open them; boredom,
//               tiredness and calm let them settle smaller.
//   hippus      a slow, never-still wander of a few percent, as in any living eye.

// Find the iris in an eye texture: the largest enclosed dark blob (not touching the edge).
export function findIris(pixels, width, height) {
  const count = width * height, seen = new Uint8Array(count), queue = new Uint32Array(count);
  const dark = (i) => pixels[i * 4 + 3] > 127 && Math.max(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]) < 165 &&
    (0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]) < 135;
  let best = null;
  for (let i = 0; i < count; i++) {
    if (seen[i] || !dark(i)) continue;
    let head = 0, tail = 1, minX = width, minY = height, maxX = 0, maxY = 0, border = false;
    queue[0] = i; seen[i] = 1;
    while (head < tail) {
      const at = queue[head++], x = at % width, y = Math.floor(at / width);
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border = true;
      for (const next of [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1, y > 0 ? at - width : -1, y < height - 1 ? at + width : -1]) {
        if (next < 0 || seen[next] || !dark(next)) continue;
        seen[next] = 1; queue[tail++] = next;
      }
    }
    const ratio = (maxX - minX + 1) / (maxY - minY + 1);
    if (!border && tail > count * 0.001 && tail < count * 0.4 && ratio > 0.45 && ratio < 2.2 && (!best || tail > best.size)) best = { size: tail, minX, maxX, minY, maxY };
  }
  if (!best) return null;
  const cx = (best.minX + best.maxX) / 2, cy = (best.minY + best.maxY) / 2;
  const rx = (best.maxX - best.minX + 1) / 2, ry = (best.maxY - best.minY + 1) / 2;
  // The painted pupil: the near-black core of the iris, as a fraction of the iris radius.
  let core = 0;
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    if (Math.hypot((x - cx) / rx, (y - cy) / ry) > 0.9) continue;
    const i = (y * width + x) * 4;
    if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) < 40) core++;
  }
  const p0 = Math.min(0.7, Math.max(0.15, Math.sqrt(core / (Math.PI * rx * ry))));
  return { cx, cy, rx, ry, p0 };
}

const cache = new WeakMap();
function irisOf(map) {
  const image = map?.image;
  if (!image?.width) return null;
  if (cache.has(image)) return cache.get(image);
  let found = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const f = findIris(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    // Canvas rows run top-down. glTF textures aren't flipped (flipY false), so v = row / height;
    // a flipped texture counts from the bottom.
    if (f) found = {
      center: [f.cx / canvas.width, map.flipY ? 1 - f.cy / canvas.height : f.cy / canvas.height],
      radius: [f.rx / canvas.width, f.ry / canvas.height],
      p0: f.p0,
    };
  } catch {}
  cache.set(image, found);
  return found;
}

// Give an eye material living pupils. `size` is the shared uniform ({ value: 1 } = as painted).
export function addPupils(material, size) {
  const iris = irisOf(material.map);
  if (!iris) return false;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, ...rest) => {
    previous?.call(material, shader, ...rest);
    shader.uniforms.pupilSize = size;
    shader.uniforms.irisCenter = { value: iris.center };
    shader.uniforms.irisRadius = { value: iris.radius };
    shader.uniforms.pupilPainted = { value: iris.p0 };
    shader.fragmentShader = 'uniform float pupilSize; uniform vec2 irisCenter; uniform vec2 irisRadius; uniform float pupilPainted;\n' +
      shader.fragmentShader.replace('#include <map_fragment>', `
        #ifdef USE_MAP
        // Re-map the iris radially so the pupil is pupilSize times its painted size.
        vec2 pupilOff = (vMapUv - irisCenter) / irisRadius;
        float pupilD = length(pupilOff);
        vec2 pupilUv = vMapUv;
        if (pupilD < 1.0 && pupilD > 1e-5) {
          float p = clamp(pupilPainted * pupilSize, 0.06, 0.88);
          float src = pupilD < p ? pupilD / p * pupilPainted : pupilPainted + (pupilD - p) / (1.0 - p) * (1.0 - pupilPainted);
          pupilUv = irisCenter + pupilOff / pupilD * src * irisRadius;
        }
        #define vMapUv pupilUv
        #endif
        #include <map_fragment>`);
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${key ? key() : ''}|pupils`;
  material.needsUpdate = true;
  return true;
}

// How big her pupils want to be right now, as a multiple of the painted size.
// light 0 (dark night) .. 1 (full sun); near 0 (far off) .. 1 (close, at you); effort 0..1;
// feel: her current feelings, name -> 0..1.
export function pupilTarget({ light = 0.5, near = 0.5, effort = 0, feel = {}, t = 0 }) {
  let s = 1.55 - 1.0 * light;                     // ~1.55x in the dark, ~0.55x in full sun
  s *= 1.06 - 0.12 * near;                         // the near reflex
  s *= 1 + 0.16 * effort;                          // mental effort
  const f = (n) => feel[n] || 0;
  const up = Math.max(f('excited'), f('surprised'), f('scared'), f('flirty'), f('curious') * 0.7, f('amused') * 0.6, f('joy') * 0.5, f('fond') * 0.5);
  const down = Math.max(f('bored'), f('tired') * 0.8, f('calm') * 0.4);
  s *= 1 + 0.22 * up - 0.1 * down;
  s *= 1 + 0.035 * Math.sin(t * 0.9) + 0.02 * Math.sin(t * 2.3 + 1.7); // hippus
  return Math.max(0.45, Math.min(1.8, s));
}

// Ease toward the target the way the iris muscles do: tightening fast, opening slowly.
export function easePupil(now, target, dt) {
  const tau = target < now ? 0.3 : 2.8;
  return now + (target - now) * (1 - Math.exp(-dt / tau));
}
