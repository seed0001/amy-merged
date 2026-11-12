"""Close the holes Avaturn left in her body where the original suit used to cover it.

Avaturn culls the body under clothing. Every outfit model is that same body with a new garment on
top, so wherever the new garment shows skin that the suit covered (the arms in a sleeveless dress),
the body has open patches. This fills them: in Body_Mesh, the boundary loops inside the chosen
regions get faces (bmesh fill), using only existing vertices, so skin weights and UVs stay. Nothing
else in the file changes. Run with Blender:

  blender --background --python scripts/fix-body-holes.py -- <in.glb> <out.glb> [region ...]

Regions (default: arms): arms, torso, legs, all. Writes a summary line to stdout.
"""
import sys
import bpy
import bmesh
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if len(argv) < 2:
    print('usage: fix-body-holes.py -- in.glb out.glb [regions]')
    sys.exit(2)
src, dst = argv[0], argv[1]
regions = set(argv[2:] or ['arms'])

def in_region(co):
    x, y, z = co.x, co.y, co.z  # glTF Y-up as imported (Blender converts to Z-up; handled below)
    return True

# The outfit builders (build-avatar-outfits.py) hide the original suit by detaching its node from the
# scene, leaving it in the file. Blender's importer puts orphans back as roots, which would dress her in
# the suit over the dress, so find the orphans first and delete them after the import.
import json, struct
with open(src, 'rb') as fh:
    header = fh.read(20)
    json_len = struct.unpack('<I', header[12:16])[0]
    doc = json.loads(fh.read(json_len))
reachable = set()
def walk(i):
    if i in reachable:
        return
    reachable.add(i)
    for c in doc['nodes'][i].get('children', []):
        walk(c)
for s in doc.get('scenes', []):
    for r in s.get('nodes', []):
        walk(r)
orphans = {n.get('name') for i, n in enumerate(doc['nodes']) if i not in reachable and n.get('mesh') is not None}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src, bone_heuristic='TEMPERANCE')
for o in list(bpy.data.objects):
    if o.type == 'MESH' and any(o.name == n or o.name.startswith(n + '.') for n in orphans):
        bpy.data.objects.remove(o, do_unlink=True)
print(f'fix-body-holes: removed detached meshes {sorted(orphans)}')

body = next((o for o in bpy.data.objects if o.type == 'MESH' and o.name.startswith('Body_Mesh')), None)
if body is None:
    print('no Body_Mesh in', src)
    sys.exit(1)

# Blender imports glTF Y-up into Z-up: glTF (x, y, z) -> Blender (x, -z, y). World-space test on Blender coords.
def region_of(world):
    x, y_up = world.x, world.z
    if y_up > 1.45 and abs(x) > 0.25:
        return 'arms'
    if y_up > 0.95:
        return 'torso'
    if y_up > 0.02:
        return 'legs'
    return 'feet'

bm = bmesh.new()
bm.from_mesh(body.data)
# The export split nearly every triangle into its own vertices (11k verts for 3.9k faces), so every
# edge looks open. Weld coincident vertices first; UVs live on face corners in Blender, so seams keep.
welded = bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
bm.verts.ensure_lookup_table()
bm.edges.ensure_lookup_table()
mw = body.matrix_world
print(f'fix-body-holes: welded body to {len(bm.verts)} verts, {len(bm.faces)} faces')

# Boundary edges whose both ends sit in a wanted region.
want = (lambda r: True) if 'all' in regions else (lambda r: r in regions)
boundary = [e for e in bm.edges if e.is_boundary and all(want(region_of(mw @ v.co)) for v in e.verts)]
before = len(boundary)

# Walk boundary loops, fill each closed loop that isn't an intended opening (neck, wrists are huge; cap by size).
MAX_LOOP = 120
visited = set()
filled = 0
skipped = 0
for e in boundary:
    if e in visited:
        continue
    loop = []
    cur, prev_v = e, e.verts[0]
    ok = True
    while True:
        visited.add(cur)
        loop.append(cur)
        nxt_v = cur.other_vert(prev_v)
        nxt = [x for x in nxt_v.link_edges if x.is_boundary and x is not cur]
        if len(nxt) != 1:
            ok = False
            break
        cur, prev_v = nxt[0], nxt_v
        if cur is e:
            break
        if len(loop) > MAX_LOOP * 4:
            ok = False
            break
    if not ok or len(loop) > MAX_LOOP:
        skipped += 1
        continue
    verts = []
    for ed in loop:
        for v in ed.verts:
            if v not in verts:
                verts.append(v)
    try:
        res = bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=loop)
        if res.get('geom'):
            filled += 1
    except Exception as err:  # a loop fill can fail on a degenerate ring; leave it
        skipped += 1

bm.to_mesh(body.data)
bm.free()
body.data.update()

bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', export_image_format='AUTO', export_texcoords=True, export_normals=True,
                          export_skins=True, export_morph=True, export_animations=False, export_yup=True, export_apply=False,
                          export_influence_nb=8, export_all_influences=False)  # the suit uses 8 bones per vertex; keep them
print(f'fix-body-holes: {src} -> {dst}: boundary edges in {sorted(regions)}: {before}; loops filled: {filled}; skipped: {skipped}')
