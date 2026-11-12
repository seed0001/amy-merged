"""Build a fitted two-piece bikini for avatar.glb, using the same pipeline as the
existing dress/swimsuit outfits (body surface + skin weights, Wardrobe_ mesh,
Wardrobe_fabric_ material). The body stays visible between the top and bottom.
Run: python scripts/build-bikini.py data/avatar.glb PATH_TO_AVATURN_TEMPLATE.glb
Then: node scripts/install-bikini.mjs
"""
import copy, hashlib, json, math, pathlib, struct, sys, io
from PIL import Image
import numpy as np
from scipy.spatial import cKDTree

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'data' / 'avatar.glb'
OUT = ROOT / 'data' / 'outfits'
raw = SOURCE.read_bytes()
json_size = struct.unpack_from('<I', raw, 12)[0]
original = json.loads(raw[20:20 + json_size])
binary = raw[28 + json_size:]

components = {5121: ('B', 1), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
sizes = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

def read_accessor(index):
    a = original['accessors'][index]
    v = original['bufferViews'][a['bufferView']]
    code, size = components[a['componentType']]
    n = sizes[a['type']]
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = v.get('byteStride', n * size)
    return [struct.unpack_from('<' + code * n, binary, start + i * stride) for i in range(a['count'])]

body_node = next(n for n in original['nodes'] if n.get('name') == 'Body_Mesh')
primitive = original['meshes'][body_node['mesh']]['primitives'][0]
attributes = {key: read_accessor(index) for key, index in primitive['attributes'].items()}
body_tris = [x[0] for x in read_accessor(primitive['indices'])]

# Recover full body connectivity from the public Avaturn female authoring template.
if len(sys.argv) < 3:
    raise SystemExit('Pass the public Avaturn female template GLB as the second argument.')
donor_raw = pathlib.Path(sys.argv[2]).read_bytes()
donor_n = struct.unpack_from('<I', donor_raw, 12)[0]
donor = json.loads(donor_raw[20:20 + donor_n])
donor_bin = donor_raw[28 + donor_n:]

def donor_accessor(index):
    a = donor['accessors'][index]
    v = donor['bufferViews'][a['bufferView']]
    code, size = components[a['componentType']]
    n = sizes[a['type']]
    return [struct.unpack_from('<' + code * n, donor_bin,
                              v.get('byteOffset', 0) + a.get('byteOffset', 0) + i * v.get('byteStride', n * size))
            for i in range(a['count'])]

dp = donor['meshes'][0]['primitives'][0]
donor_positions = np.array(donor_accessor(dp['attributes']['POSITION']))
dist, mapping = cKDTree(np.array(attributes['POSITION'])).query(donor_positions)
recovered = set()
for t in np.array(donor_accessor(dp['indices'])).reshape(-1, 3):
    if max(donor_positions[t, 1]) > 1.565 or max(dist[t]) > .045:
        continue
    mapped = [int(mapping[x]) for x in t]
    if len(set(mapped)) < 3:
        continue
    positions = [np.array(attributes['POSITION'][i]) for i in mapped]
    if max(np.linalg.norm(a - b) for a, b in zip(positions, positions[1:] + positions[:1])) > .13:
        continue
    recovered.add(tuple(mapped))
tris = [i for t in recovered for i in t]
print('Recovered', len(recovered), 'body triangles using original avatar vertices')

def vertex(i):
    return {'p': list(attributes['POSITION'][i]), 'n': list(attributes['NORMAL'][i]),
            'uv': list(attributes['TEXCOORD_0'][i]),
            'weights': dict(zip(attributes['JOINTS_0'][i], attributes['WEIGHTS_0'][i]))}

def interpolate(a, b, t):
    return {'p': [x + (y - x) * t for x, y in zip(a['p'], b['p'])],
            'n': [x + (y - x) * t for x, y in zip(a['n'], b['n'])],
            'uv': [x + (y - x) * t for x, y in zip(a['uv'], b['uv'])],
            'weights': {j: a['weights'].get(j, 0) * (1 - t) + b['weights'].get(j, 0) * t
                        for j in a['weights'].keys() | b['weights'].keys()}}

def clip(poly, plane):
    if not poly:
        return []
    result = []
    for a, b in zip(poly, poly[1:] + poly[:1]):
        da, db = plane(a['p']), plane(b['p'])
        if da >= 0:
            result.append(a)
        if (da >= 0) != (db >= 0):
            result.append(interpolate(a, b, da / (da - db)))
    return result

def keep_band(kind):
    """Return clip planes for the given band, keeping y between lo and hi (with a
    soft side/lift curve so the top scoops and the brief lifts at the hips)."""
    if kind == 'top':
        # Bandeau top across the bust.
        lo, hi = 1.10, 1.32
        return [lambda p, lo=lo: p[1] - lo, lambda p, hi=hi: hi - p[1]]
    # Low-rise brief near the hip.
    lo, hi = .69, .99
    return [lambda p, lo=lo: p[1] - lo, lambda p, hi=hi: hi - p[1]]

def bikini():
    vertices = []
    indices = []
    for kind in ('top', 'bottom'):
        bands = keep_band(kind)
        for i in range(0, len(tris), 3):
            base = [vertex(j) for j in tris[i:i + 3]]
            inside = base
            for plane in bands:
                inside = clip(inside, plane)
                if len(inside) < 3:
                    break
            if len(inside) < 3:
                continue
            start = len(vertices)
            for v in inside:
                norm = math.sqrt(sum(x * x for x in v['n'])) or 1
                v['n'] = [x / norm for x in v['n']]
                v['p'] = [x + n * .0045 for x, n in zip(v['p'], v['n'])]
                v['uv'] = [v['uv'][0] * 2.4, (1.6 - v['p'][1]) * 2.5]
                vertices.append(v)
            for j in range(1, len(inside) - 1):
                indices.extend([start, start + j, start + j + 1])
    fabric_normals(vertices, indices)
    return vertices, indices

def fabric_normals(vertices, indices):
    sums = {}
    keys = [tuple(round(x, 5) for x in v['p']) for v in vertices]
    for offset in range(0, len(indices), 3):
        tri = indices[offset:offset + 3]
        a, b, c = [np.array(vertices[i]['p']) for i in tri]
        normal = np.cross(b - a, c - a)
        if np.dot(normal, np.array(vertices[tri[0]]['n'])) < 0:
            normal = -normal
        for i in tri:
            sums[keys[i]] = sums.get(keys[i], np.zeros(3)) + normal
    for i, v in enumerate(vertices):
        normal = sums.get(keys[i], np.array(v['n']))
        length = np.linalg.norm(normal)
        if length > 1e-9:
            v['n'] = (normal / length).tolist()

def fabric_maps():
    size = 256
    y, x = np.mgrid[:size, :size]
    u = x * 2 * math.pi / 4
    v = y * 2 * math.pi / 4
    weave = .5 + .22 * np.sin(u) * np.sin(v) + .08 * np.sin(u * 2 + v)
    dx = .12 * np.cos(u) * np.sin(v)
    dy = .12 * np.sin(u) * np.cos(v)
    normals = np.stack([-dx, -dy, np.ones_like(dx)], axis=2)
    normals /= np.linalg.norm(normals, axis=2, keepdims=True)
    normal_image = Image.fromarray(np.uint8(np.clip((normals * .5 + .5) * 255, 0, 255)))
    packed = np.zeros((size, size, 3), dtype=np.uint8)
    packed[:, :, 0] = 255
    packed[:, :, 1] = np.uint8(220 + 25 * weave)
    result = []
    for image in [normal_image, Image.fromarray(packed)]:
        stream = io.BytesIO()
        image.save(stream, format='PNG')
        result.append(stream.getvalue())
    return result

def bikini():
    vertices = []
    indices = []
    for kind in ('top', 'bottom'):
        bands = keep_band(kind)
        for i in range(0, len(tris), 3):
            base = [vertex(j) for j in tris[i:i + 3]]
            inside = base
            for plane in bands:
                inside = clip(inside, plane)
                if len(inside) < 3:
                    break
            if len(inside) < 3:
                continue
            start = len(vertices)
            for v in inside:
                norm = math.sqrt(sum(x * x for x in v['n'])) or 1
                v['n'] = [x / norm for x in v['n']]
                v['p'] = [x + n * .0045 for x, n in zip(v['p'], v['n'])]
                v['uv'] = [v['uv'][0] * 2.4, (1.6 - v['p'][1]) * 2.5]
                vertices.append(v)
            for j in range(1, len(inside) - 1):
                indices.extend([start, start + j, start + j + 1])
    fabric_normals(vertices, indices)
    return vertices, indices

def uncovered_body():
    """Keep the skin except where the two bands sit, so cloth doesn't fight the skin."""
    top_bands = keep_band('top')
    bottom_bands = keep_band('bottom')
    kept_tris = []
    for i in range(0, len(tris), 3):
        tri = tris[i:i + 3]
        verts = [vertex(j) for j in tri]
        # Fully clipped by both planes -> triangle lies inside that band.
        def inside_band(planes):
            poly = verts
            for plane in planes:
                poly = clip(poly, plane)
                if len(poly) < 3:
                    return False
            return True
        if inside_band(top_bands) or inside_band(bottom_bands):
            continue
        kept_tris.append(tri)
    verts_out = []
    idx_out = []
    for tri in kept_tris:
        start = len(verts_out)
        for j in tri:
            verts_out.append(vertex(j))
        idx_out.extend([start, start + 1, start + 2])
    return verts_out, idx_out

def make():
    document = copy.deepcopy(original)
    blob = bytearray(binary)

    def accessor(values, type_, component=5126, bounds=False):
        while len(blob) % 4:
            blob.append(0)
        code, _ = components[component]
        data = b''.join(struct.pack('<' + code * len(v), *v) for v in values)
        view = len(document['bufferViews'])
        document['bufferViews'].append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)})
        blob.extend(data)
        acc = {'bufferView': view, 'componentType': component, 'count': len(values), 'type': type_}
        if bounds:
            acc.update(min=[min(v[i] for v in values) for i in range(len(values[0]))],
                       max=[max(v[i] for v in values) for i in range(len(values[0]))])
        document['accessors'].append(acc)
        return len(document['accessors']) - 1

    kind = 'bikini'
    color = [.82, .16, .26, 1]   # hot red/coral default; recolourable via avatar_outfit
    roughness = .55
    sheen = [.95, .55, .65]
    sheen_roughness = .35
    textures = []
    for data in fabric_maps():
        while len(blob) % 4:
            blob.append(0)
        view = len(document['bufferViews'])
        document['bufferViews'].append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)})
        blob.extend(data)
        image = len(document['images'])
        document['images'].append({'bufferView': view, 'mimeType': 'image/png'})
        sampler = len(document.setdefault('samplers', []))
        document['samplers'].append({'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497})
        texture = len(document['textures'])
        document['textures'].append({'source': image, 'sampler': sampler})
        textures.append(texture)

    material_def = {
        'name': 'Wardrobe_fabric_' + kind, 'doubleSided': True,
        'pbrMetallicRoughness': {'baseColorFactor': color, 'metallicFactor': 0,
                                 'roughnessFactor': roughness,
                                 'metallicRoughnessTexture': {'index': textures[1]}},
        'normalTexture': {'index': textures[0], 'scale': .25},
        'extensions': {'KHR_materials_sheen': {'sheenColorFactor': sheen,
                                               'sheenRoughnessFactor': sheen_roughness}},
    }
    if 'KHR_materials_sheen' not in document.setdefault('extensionsUsed', []):
        document['extensionsUsed'].append('KHR_materials_sheen')
    material = len(document['materials'])
    document['materials'].append(material_def)

    verts, indices = bikini()
    joints = []
    weights = []
    for v in verts:
        top = sorted(v['weights'].items(), key=lambda item: item[1], reverse=True)[:4]
        top += [(0, 0)] * (4 - len(top))
        total = sum(w for j, w in top) or 1
        joints.append([j for j, w in top])
        weights.append([w / total for j, w in top])

    mesh = {'name': 'Wardrobe_' + kind, 'primitives': [{
        'attributes': {
            'POSITION': accessor([v['p'] for v in verts], 'VEC3', bounds=True),
            'NORMAL': accessor([v['n'] for v in verts], 'VEC3'),
            'TEXCOORD_0': accessor([v['uv'] for v in verts], 'VEC2'),
            'JOINTS_0': accessor(joints, 'VEC4', 5123),
            'WEIGHTS_0': accessor(weights, 'VEC4')},
        'indices': accessor([(i,) for i in indices], 'SCALAR', 5125),
        'material': material}]}
    mesh_index = len(document['meshes'])
    document['meshes'].append(mesh)

    # Keep most of the body, remove only the band-covered triangles.
    skin, skin_indices = uncovered_body()
    skin_joints = []
    skin_weights = []
    for v in skin:
        top = sorted(v['weights'].items(), key=lambda item: item[1], reverse=True)[:4]
        top += [(0, 0)] * (4 - len(top))
        total = sum(w for j, w in top) or 1
        skin_joints.append([j for j, w in top])
        skin_weights.append([w / total for j, w in top])
    document['meshes'][body_node['mesh']]['primitives'] = [{
        'attributes': {
            'POSITION': accessor([v['p'] for v in skin], 'VEC3', bounds=True),
            'NORMAL': accessor([v['n'] for v in skin], 'VEC3'),
            'TEXCOORD_0': accessor([v['uv'] for v in skin], 'VEC2'),
            'JOINTS_0': accessor(skin_joints, 'VEC4', 5123),
            'WEIGHTS_0': accessor(skin_weights, 'VEC4')},
        'indices': accessor([(i,) for i in skin_indices], 'SCALAR', 5125),
        'material': primitive['material']}]

    node_index = len(document['nodes'])
    document['nodes'].append({'name': 'Wardrobe_' + kind, 'mesh': mesh_index, 'skin': body_node['skin']})
    remove = {i for i, n in enumerate(document['nodes']) if n.get('name') == 'avaturn_look_0'
              or n.get('name') == 'avaturn_shoes_0'}
    for n in document['nodes']:
        if 'children' in n:
            n['children'] = [i for i in n['children'] if i not in remove]
    parent = next(n for n in document['nodes']
                  if any(document['nodes'][i].get('name') == 'Body_Mesh' for i in n.get('children', [])))
    parent['children'].append(node_index)

    while len(blob) % 4:
        blob.append(0)
    document['buffers'][0]['byteLength'] = len(blob)
    document.setdefault('extras', {})['wardrobe'] = {'outfit': kind,
                                                     'baseSha256': hashlib.sha256(raw).hexdigest(),
                                                     'generatedGeometry': True}
    encoded = json.dumps(document, separators=(',', ':')).encode()
    encoded += b' ' * ((-len(encoded)) % 4)
    output = (struct.pack('<4sII', b'glTF', 2, 28 + len(encoded) + len(blob))
              + struct.pack('<I4s', len(encoded), b'JSON') + encoded
              + struct.pack('<I4s', len(blob), b'BIN\0') + blob)
    target = OUT / (kind + '.glb')
    target.write_bytes(output)
    print(target, len(verts), 'clothing vertices', len(skin), 'skin vertices', len(output), 'bytes')

OUT.mkdir(parents=True, exist_ok=True)
make()