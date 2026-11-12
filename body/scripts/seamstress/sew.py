"""Sew a pattern onto her: flat pieces -> laid around the dress form -> stitched -> draped by cloth simulation.

  blender -b --factory-startup --python sew.py -- <avatar.glb> <body.json> <pattern.json> <out dir> [resolution_m] [frames]

1. Every flat piece (pattern.json, from drafting.py) becomes a triangulated cloth panel at real size.
2. Each panel is wrapped around the region of her it belongs to (torso, skirt, an arm, a leg), a little
   off her skin, at the width the pattern needs.
3. Seams become sewing springs between matching points on the two edges (Blender cloth sewing).
4. The cloth simulation pulls the seams closed and lets the fabric fall and settle on the dress form
   (collision), with the fabric's own weight, stretch and stiffness.
5. The seams are welded, the result is skinned to her skeleton, given its fabric, and exported.

Writes into <out dir>: outfit.glb (garments + the skin they leave showing, bound to her rig), front.png,
back.png, side.png, report.json (how it went: seam closure, stretch, poke-through, timings).
"""
import bpy, bmesh, json, math, pathlib, sys, time
from mathutils import Vector, geometry
from mathutils.bvhtree import BVHTree
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
import dressform as df
from drafting import Body
import fabrics

T0 = time.time()
args = sys.argv[sys.argv.index('--') + 1:]
AVATAR, BODY_JSON, PATTERN_JSON, OUT = args[0], args[1], args[2], pathlib.Path(args[3])
RES = float(args[4]) if len(args) > 4 else 0.02
FRAMES = int(args[5]) if len(args) > 5 else 90
OUT.mkdir(parents=True, exist_ok=True)
report = {'ok': False, 'stages': {}, 'warnings': []}
def stage(name): report['stages'][name] = round(time.time() - T0, 1); print('STAGE', name, report['stages'][name], flush=True)
def fail(why):
    report['error'] = why
    (OUT / 'report.json').write_text(json.dumps(report, indent=1)); print('FAILED', why); sys.exit(3)

body = Body(json.loads(pathlib.Path(BODY_JSON).read_text(encoding='utf-8-sig')))
pattern = json.loads(pathlib.Path(PATTERN_JSON).read_text(encoding='utf-8-sig'))
FRONT = body.b['front']

# ---------------------------------------------------------------- the dress form
rig, avatar_objs = df.load_avatar(AVATAR)
skin = df.dress_form(rig)
col = skin.modifiers.new('Collision', 'COLLISION')
skin.collision.thickness_outer = 0.006
skin.collision.thickness_inner = 0.01
skin.collision.cloth_friction = 6
stage('dress form')

# ---------------------------------------------------------------- flat pieces -> panels
def resample(pts, n):
    if len(pts) < 2: fail('A pattern piece has an edge with a single point, which can\'t be sewn (the drafting cut it wrong).')
    segs = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    total = sum(segs) or 1e-9
    out, acc, i = [], 0.0, 0
    for k in range(n + 1):
        target = total * k / n
        while i < len(segs) - 1 and acc + segs[i] < target: acc += segs[i]; i += 1
        f = 0 if segs[i] == 0 else min(1, max(0, (target - acc) / segs[i]))
        out.append((pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f))
    return out

pieces = {p['id']: p for p in pattern['pieces']}
edge_n = {}
for s in pattern['seams']:
    (pa, ea), (pb, eb) = s['a'], s['b']
    la = next(e['length'] for e in pieces[pa]['edges'] if e['id'] == ea)
    lb = next(e['length'] for e in pieces[pb]['edges'] if e['id'] == eb)
    n = max(2, math.ceil(max(la, lb) / RES))
    edge_n[(pa, ea)] = max(edge_n.get((pa, ea), 0), n); edge_n[(pb, eb)] = max(edge_n.get((pb, eb), 0), n)
for s in pattern['seams']:
    (pa, ea), (pb, eb) = s['a'], s['b']
    n = max(edge_n[(pa, ea)], edge_n[(pb, eb)]); edge_n[(pa, ea)] = edge_n[(pb, eb)] = n

def inside(pt, poly):
    x, y = pt; c = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1: c = not c
    return c

def seg_dist(p, a, b):
    ax, ay = b[0] - a[0], b[1] - a[1]; L2 = ax * ax + ay * ay or 1e-12
    t = max(0, min(1, ((p[0] - a[0]) * ax + (p[1] - a[1]) * ay) / L2))
    return math.dist(p, (a[0] + ax * t, a[1] + ay * t))

panels = {}  # piece id -> {'uv': [(u,v)], 'faces': [...], 'edges': {edge: [vertex indices along it]}}
for pid, p in pieces.items():
    boundary, edge_idx = [], {}
    for e in p['edges']:
        n = edge_n.get((pid, e['id']), max(1, math.ceil(e['length'] / RES)))
        pts = resample([tuple(x) for x in e['pts']], n)
        start = len(boundary)
        boundary += pts[:-1]
        edge_idx[e['id']] = list(range(start, start + n + 1))
    nb = len(boundary)
    for k in edge_idx: edge_idx[k] = [i % nb for i in edge_idx[k]]
    xs, ys = [q[0] for q in boundary], [q[1] for q in boundary]
    interior = []
    h = RES * math.sqrt(3) / 2; row = 0; y = min(ys) + h * 0.5
    while y < max(ys):
        x = min(xs) + (RES / 2 if row % 2 else 0)
        while x < max(xs):
            q = (x, y)
            if inside(q, boundary) and min(seg_dist(q, boundary[i], boundary[(i + 1) % nb]) for i in range(nb)) > RES * 0.55: interior.append(q)
            x += RES
        y += h; row += 1
    verts = boundary + interior
    cdt = geometry.delaunay_2d_cdt([Vector(v) for v in verts], [(i, (i + 1) % nb) for i in range(nb)], [list(range(nb))], 1, 1e-7, True)
    out_v, _, out_f, orig_v = cdt[0], cdt[1], cdt[2], cdt[3]
    remap = {}
    for new, olds in enumerate(orig_v):
        for o in olds: remap[o] = new
    if any(i not in remap for i in range(nb)): fail(f'Piece {pid} could not be meshed cleanly (its outline crosses itself).')
    panels[pid] = {'uv': [tuple(v) for v in out_v], 'faces': [tuple(f) for f in out_f], 'edges': {k: [remap[i] for i in idx] for k, idx in edge_idx.items()}}
report['triangles'] = sum(len(p['faces']) for p in panels.values())
stage('panels')

# ---------------------------------------------------------------- laying the pieces around her
def poly_span(p, v):
    """Width of piece p at height v (max u - min u where a horizontal line crosses its outline)."""
    pts = [tuple(x) for e in p['edges'] for x in e['pts']]
    xs = []
    for i in range(len(pts)):
        (x1, y1), (x2, y2) = pts[i], pts[i - 1]
        if (y1 >= v) != (y2 >= v) and y1 != y2: xs.append(x1 + (x2 - x1) * (v - y1) / (y2 - y1))
    return (max(xs) - min(xs)) if len(xs) >= 2 else 0.0

L = body.L
Z_AP = L['shoulder_point'][2] - 0.085
CROTCH = L['crotch']

def contour(z):
    s = body.at(max(min(z, Z_AP), body.sec[0]['z']))
    return s['centre'], s['radius']

def walk(radius, start, dist, direction, scale):
    """Angle (deg) reached going `dist` metres along the scaled contour from `start` in `direction` (+1/-1)."""
    n = len(radius); step = 360 / n
    def r(a):
        k = (a % 360) / step; i = int(k) % n; f = k - int(k)
        return (radius[i] * (1 - f) + radius[(i + 1) % n] * f) * scale
    a, acc = start, 0.0
    for _ in range(4000):
        b = a + direction * 0.5
        seg = math.sqrt(r(a) ** 2 + r(b) ** 2 - 2 * r(a) * r(b) * math.cos(math.radians(0.5)))
        if acc + seg >= dist: return a + direction * 0.5 * (dist - acc) / (seg or 1e-9), r
        acc += seg; a = b
    return a, r

def ring_point(centre, r, angle, z):
    a = math.radians(angle)
    return Vector((centre[0] + r(angle) * math.sin(a), centre[1] + FRONT * r(angle) * math.cos(a), z))

region_width = {}
def total_width(garment, region, z):
    key = (garment, region, round(z, 3))
    if key not in region_width:
        region_width[key] = sum(poly_span(p, z) for p in pattern['pieces'] if p['garment'] == garment and p['region'] == region)
    return region_width[key]

def perim(radius):
    n = len(radius); return sum(math.sqrt(radius[i] ** 2 + radius[(i + 1) % n] ** 2 - 2 * radius[i] * radius[(i + 1) % n] * math.cos(2 * math.pi / n)) for i in range(n))

def stretch_limit(kind, z):
    """Longest edge that's still fabric, not a tear. Below the waist a skirt or dress spans the gap between her
    legs, so its triangles there are naturally long; anywhere else, four times the cloth spacing is a tear."""
    return RES * 14 if kind in ('dress', 'skirt') and z < L['waist'] else RES * 4

def reach(kind, z):
    """How far off her body a garment's fabric can really be at height z. A skirt or dress flares out from the
    waist down; anything else stays close above her hips."""
    if kind in ('dress', 'skirt') and z < L['waist']: return 0.6
    return 0.14 if z > CROTCH + 0.05 else 0.6

cones = {}
def skirt_cone(garment, gap):
    """Below her hips a skirt is laid out on the cone its flat pattern makes (a circle skirt: almost a flat disc),
    so the fabric starts unstretched and gravity drops it into folds. Wrapping the whole hem width around her as
    an upright tube instead tore the hem band off. Returns rows of (v, radius, z), from the hip down."""
    if garment in cones: return cones[garment]
    vs = [v for p in pattern['pieces'] if p['garment'] == garment and p['region'] == 'skirt' for e in p['edges'] for _, v in e['pts']]
    lo = min(vs); hip = L['hip']
    hip_sec = body.at(hip)
    r0 = max(total_width(garment, 'skirt', hip) / (2 * math.pi), perim(hip_sec['radius']) / (2 * math.pi) + gap)
    rows, z, prev_r, v = [(hip, r0, hip)], hip, r0, hip
    while v > lo - 0.01:
        v = round(v - 0.01, 4)
        r = max(prev_r, total_width(garment, 'skirt', v) / (2 * math.pi) if total_width(garment, 'skirt', v) else prev_r)
        dr = r - prev_r
        z -= math.sqrt(max(0.0, 0.01 ** 2 - dr * dr)) if dr < 0.01 else 0.0
        if dr >= 0.01: r = prev_r + 0.01  # flatter than a disc can't be laid out: a circle skirt starts as one
        rows.append((v, r, z)); prev_r = r
    cones[garment] = rows
    return rows

def place(p, u, v):
    layer = p['layer']; gap = 0.028 + 0.012 * layer
    if p['region'] == 'skirt' and v < L['hip']:
        rows = skirt_cone(p['garment'], gap)
        _, R, z = min(rows, key=lambda row: abs(row[0] - v))
        centre = body.at(L['hip'])['centre']
        a = math.radians(p['centre']) + u / R
        return Vector((centre[0] + R * math.sin(a), centre[1] + FRONT * R * math.cos(a), z))
    if p['region'] in ('torso', 'skirt'):
        z = v
        if p['region'] == 'skirt' and z < L['hip']: centre, radius = body.at(L['hip'])['centre'], body.at(L['hip'])['radius']
        else: centre, radius = contour(z)
        extra = max(0.0, v - Z_AP) * 0.6
        base = perim(radius)
        want = total_width(p['garment'], p['region'], v)
        mean_r = base / (2 * math.pi)
        scale = max((mean_r + gap + extra) / mean_r, want / base * 1.02 if want else 0)
        ang, r = walk(radius, p['centre'], abs(u), 1 if u >= 0 else -1, scale)
        return ring_point(centre, r, ang, z)  # at its true height: the shoulders sit above the armholes, as cut
    if p['region'].startswith('leg_'):
        left = p['region'] == 'leg_left'
        is_front = p['centre'] == 0.0
        side_angle = 90 if left else 270
        toward = (-1 if is_front else 1) * (1 if left else -1)
        z = v
        if z >= CROTCH:
            centre, radius = contour(z)
            want = total_width(p['garment'], 'leg_left', z) + total_width(p['garment'], 'leg_right', z)
            base = perim(radius); mean_r = base / (2 * math.pi)
            scale = max((mean_r + gap) / mean_r, want / base * 1.02 if want else 0)
            ang, r = walk(radius, side_angle, abs(u), toward, scale)
            return ring_point(centre, r, ang, z)
        hip_j, knee, ankle = [Vector(L[k]) for k in ('hip_joint', 'knee_joint', 'ankle_joint')]
        if not left: hip_j.x, knee.x, ankle.x = -hip_j.x, -knee.x, -ankle.x
        axis = hip_j.lerp(knee, (hip_j.z - z) / (hip_j.z - knee.z)) if z > knee.z else knee.lerp(ankle, (knee.z - z) / (knee.z - ankle.z))
        width = sum(poly_span(q, z) for q in pattern['pieces'] if q['garment'] == p['garment'] and q['region'] == p['region'])
        R = max(body.leg_girth(z) / (2 * math.pi) + gap, width / (2 * math.pi) * 1.02)
        ang = side_angle + toward * math.degrees(abs(u) / R)
        a = math.radians(ang)
        return Vector((axis.x + R * math.sin(a), axis.y + FRONT * R * math.cos(a), z))
    if p['region'].startswith('arm_'):
        left = p['region'] == 'arm_left'
        sh = Vector(L['shoulder_point']); wr = Vector(L['wrist'])
        if not left: sh.x, wr.x = -sh.x, -wr.x
        d = (wr - sh).normalized()
        t = -v + 0.01
        width = poly_span(p, v)
        R = max(body.arm_girth(max(0.02, t)) / (2 * math.pi) + 0.022 + 0.01 * layer, width / (2 * math.pi) * 1.03)
        theta = u / R
        up = Vector((0, 0, 1)); fwd = Vector((0, FRONT, 0))
        return sh + d * t + R * (math.cos(theta) * up + math.sin(theta) * fwd)
    fail(f'Unknown region {p["region"]}')

# ---------------------------------------------------------------- each garment: lay out, sew, drape, weld
# Garments are sewn one at a time, innermost first, each with its own fabric's physics; every finished garment
# becomes something the next one drapes over (a jacket over a top, a top's hem over the waist of a skirt).
scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, FRAMES
report['garments'] = []
finished = []  # garment objects already draped (colliders for the next)

def build_cloth(g):
    me = bpy.data.meshes.new(f'Cloth_{g["id"]}')
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new('UVMap')
    cut_layer = bm.loops.layers.uv.new('Cut')  # the flat pattern itself, in metres: how big each bit was cut
    offset, base = {}, 0
    mine = [pid for pid in panels if pieces[pid]['garment'] == g['id']]
    tile = fabrics.tile(g)
    # A gradient runs over the garment's own height (its hem to its top), not over a fixed stretch of fabric.
    vlo = vhi = 0.0
    if g.get('pattern') == 'gradient':
        allv = [v for pid in mine for (_, v) in panels[pid]['uv']]
        vlo, vhi = min(allv), max(allv)
    vmap = (lambda v: (v - vlo) / max(1e-6, vhi - vlo)) if g.get('pattern') == 'gradient' else (lambda v: v / tile)
    for pid in mine:
        p, P = pieces[pid], panels[pid]
        offset[pid] = base
        vs = [bm.verts.new(place(p, u, v)) for (u, v) in P['uv']]
        for f in P['faces']:
            try: face = bm.faces.new([vs[i] for i in f])
            except ValueError: continue
            for loop, i in zip(face.loops, f):
                u, v = P['uv'][i]; loop[uv_layer].uv = (u / tile + 0.5, vmap(v)); loop[cut_layer].uv = (u, v)
        base += len(P['uv'])
    pairs = []
    bm.verts.ensure_lookup_table()
    for s in pattern['seams']:
        (pa, ea), (pb, eb) = s['a'], s['b']
        if pa not in offset or pb not in offset: continue
        A = [offset[pa] + i for i in panels[pa]['edges'][ea]]
        B = [offset[pb] + i for i in panels[pb]['edges'][eb]]
        if len(A) != len(B): fail(f'Seam {pa}.{ea} / {pb}.{eb} has {len(A)} and {len(B)} points; it can\'t be sewn evenly.')
        fwd = sum((bm.verts[a].co - bm.verts[b].co).length for a, b in zip(A, B))
        rev = sum((bm.verts[a].co - bm.verts[b].co).length for a, b in zip(A, reversed(B)))
        if rev < fwd: B = list(reversed(B))
        for a, b in zip(A, B):
            if a != b:
                pairs.append((a, b))
                try: bm.edges.new((bm.verts[a], bm.verts[b]))
                except ValueError: pass
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(f'Garment_{g["id"]}_{g["type"]}', me)
    bpy.context.scene.collection.objects.link(o)
    for poly in me.polygons: poly.use_smooth = True
    return o, pairs

def drape(o, g):
    if FRAMES <= 1: return  # layout only: where the pieces start, before any sewing (for checking a pattern)
    mod = o.modifiers.new('Cloth', 'CLOTH')
    cs, cc = mod.settings, mod.collision_settings
    fabrics.apply_physics(cs, g, [g['fabric']])
    # Stiff fabrics need more steps per frame or they jump through her (Blender's leather preset runs at 15).
    stiff = fabrics.PHYSICS[g['fabric']]['tension']
    cs.quality = (10 if stiff < 20 else 14 if stiff < 50 else 18) + int(max(0, 0.016 - RES) * 1500)
    # A wide skirt starts as a cone or a near-flat disc and has to fall a long way into its folds: slow the fall
    # (air) and take more steps, or the falling fabric tears itself on its own folds.
    rows = cones.get(g['id'])
    flare = (rows[-1][1] / rows[0][1]) if rows else 1.0
    if flare > 1.4:
        cs.air_damping = max(cs.air_damping, 3.0 + 3.0 * min(1.0, (flare - 1.4) / 2))
        cs.quality += 6
    cs.use_sewing_springs = True
    # Seams close steadily, not with a yank (a hard pull drags a sleeve straight through her arm), then get
    # pulled tight once the pieces are in place.
    for frame, force in ((1, 2.0), (int(FRAMES * 0.3), 4.0), (int(FRAMES * 0.5), 12.0), (int(FRAMES * 0.7), 40.0)):
        cs.sewing_force_max = force; cs.keyframe_insert('sewing_force_max', frame=frame)
    cc.collision_quality = 5
    cc.distance_min = 0.003
    cc.use_self_collision = True
    cc.self_distance_min = 0.0025
    cc.self_friction = 5
    mod.point_cache.frame_start, mod.point_cache.frame_end = 1, FRAMES
    # Gravity comes in after the seams have pulled together, so pieces don't fall away before they're sewn.
    ew = cs.effector_weights
    ew.gravity = 0.0; ew.keyframe_insert('gravity', frame=1)
    ew.gravity = 0.0; ew.keyframe_insert('gravity', frame=int(FRAMES * 0.35))
    ew.gravity = 1.0; ew.keyframe_insert('gravity', frame=int(FRAMES * 0.55))
    scene.frame_set(1)
    for f in range(1, FRAMES + 1):
        scene.frame_set(f)
        if f % 30 == 0: print('FRAME', g['id'], f, round(time.time() - T0, 1), flush=True)
    deps = bpy.context.evaluated_depsgraph_get()
    done = bpy.data.meshes.new_from_object(o.evaluated_get(deps))
    o.modifiers.clear(); o.data = done
    scene.frame_set(1)

def stretch_of(o, seam_verts=frozenset()):
    """How far the fabric is pulled past its cut size, edge by edge, away from the seams (where sewing pulls)."""
    uvl = o.data.uv_layers['Cut'].data
    out = []
    for poly in o.data.polygons:
        if any(v in seam_verts for v in poly.vertices): continue
        n = len(poly.loop_indices)
        for i in range(n):
            la, lb = poly.loop_indices[i], poly.loop_indices[(i + 1) % n]
            rest = (Vector(uvl[la].uv) - Vector(uvl[lb].uv)).length
            if rest > 1e-6: out.append((o.data.vertices[o.data.loops[la].vertex_index].co - o.data.vertices[o.data.loops[lb].vertex_index].co).length / rest)
    out.sort()
    return out

def weld(o, pairs, info):
    bm = bmesh.new(); bm.from_mesh(o.data); bm.verts.ensure_lookup_table()
    gaps = sorted((bm.verts[a].co - bm.verts[b].co).length for a, b in pairs)
    open_pts = sum(1 for d in gaps if d > 0.02)
    info['seams'] = {'median_gap_mm': round(gaps[len(gaps) // 2] * 1000, 1) if gaps else 0, 'worst_gap_mm': round(gaps[-1] * 1000, 1) if gaps else 0, 'points_not_closed': open_pts, 'points': len(gaps)}
    if gaps and open_pts > len(gaps) * 0.08:
        report['warnings'].append(f'{info["type"]}: {open_pts} of {len(gaps)} seam points did not close (more than 2 cm apart): the pieces may not fit together, or the drape needs more time.')
    # Where seams meet (a shoulder, an armhole and a sleeve cap at one corner) points are sewn to several others:
    # weld each whole group to one point at its centre, never in a chain.
    parent = {}
    def find(x):
        while parent.get(x, x) != x:
            parent[x] = parent.get(parent[x], parent[x]); x = parent[x]
        return x
    for a, b in pairs:
        # A point that didn't close is left open (a small gap in the seam), never dragged across into a spike.
        if (bm.verts[a].co - bm.verts[b].co).length > 0.03: continue
        ra, rb = find(a), find(b)
        if ra != rb: parent[rb] = ra
    groups = {}
    for v in {x for pair in pairs for x in pair}: groups.setdefault(find(v), []).append(v)
    target = {}
    for root, members in groups.items():
        centre = sum((bm.verts[i].co for i in members), Vector()) / len(members)
        for i in members: bm.verts[i].co = centre
        for i in members:
            if i != root: target[bm.verts[i]] = bm.verts[root]
    # Points whose seam didn't close were stretched toward their partner by the sewing springs: settle them back
    # into the cloth around them (the seam stays open there, a small gap, but no spike).
    stuck = {bm.verts[i] for a, b in pairs if (bm.verts[a].co - bm.verts[b].co).length > 0.03 for i in (a, b)}
    for _ in range(25):
        for v in stuck:
            nb = [x for f in v.link_faces for x in f.verts if x is not v]
            calm = [x.co for x in nb if x not in stuck] or [x.co for x in nb]
            if calm: v.co = v.co * 0.3 + (sum(calm, Vector()) / len(calm)) * 0.7
    info['open_seam_points'] = len(stuck) // 2
    bmesh.ops.weld_verts(bm, targetmap=target)
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context='EDGES')
    # Welding leaves collapsed triangles and, where three pieces meet, edges shared by more than two faces;
    # subdivision turns either into a long spike. Dissolve the first, split the second.
    bmesh.ops.dissolve_degenerate(bm, dist=RES * 0.05, edges=bm.edges[:])
    crowded = [e for e in bm.edges if len(e.link_faces) > 2]
    if crowded: bmesh.ops.split_edges(bm, edges=crowded)
    info['crowded_edges_split'] = len(crowded)
    # A point the simulation flung out (one edge many times longer than the cloth's spacing) is settled back into
    # the cloth around it, with any other flung points near it.
    flung = {v for v in bm.verts if any(e.calc_length() > stretch_limit(info['type'], v.co.z) for e in v.link_edges)}
    for _ in range(30):
        for v in flung:
            calm = [e.other_vert(v).co for e in v.link_edges if e.other_vert(v) not in flung]
            if calm: v.co = v.co * 0.2 + (sum(calm, Vector()) / len(calm)) * 0.8
    # Anything still stretched far past the cloth's spacing is a tear, not fabric: those few triangles go. So does
    # fabric that ended up where no garment hangs: above her hips nothing sits more than 14 cm off her body (a
    # skirt below may flare far wider).
    def stray(f):
        for v in f.verts:
            loc = skin_tree.find_nearest(v.co)[0]
            if loc is None: continue
            limit = reach(info['type'], v.co.z)
            if (v.co - loc).length > limit: return True
        return False
    long_edge = lambda f: any(e.calc_length() > stretch_limit(info['type'], f.calc_center_median().z) for e in f.edges)
    torn = [f for f in bm.faces if long_edge(f) or stray(f)]
    bmesh.ops.delete(bm, geom=torn, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    info['spikes_fixed'] = len(flung); info['torn_triangles_removed'] = len(torn)
    if len(torn) > 40: report['warnings'].append(f'{info["type"]}: {len(torn)} torn triangles were removed; the drape was unsettled there.')
    # Hems and necklines: smooth the open edges along themselves, so a hem is a clean line, not a saw edge.
    # Taubin smoothing (a smoothing step, then a slight push back out) so a hem keeps its size and doesn't pucker in.
    for k in range(12):
        lam = 0.5 if k % 2 == 0 else -0.53
        moves = {}
        for v in bm.verts:
            if not v.is_boundary: continue
            nbrs = [e.other_vert(v) for e in v.link_edges if e.is_boundary]
            if len(nbrs) == 2: moves[v] = v.co + ((nbrs[0].co + nbrs[1].co) * 0.5 - v.co) * lam
        for v, co in moves.items(): v.co = co
    # Last word, after every smoothing step: nothing is left stretched into a spike or hanging where no garment
    # could be (the hem smoothing can fling a point at the edge of a removed tear).
    for _ in range(3):
        bad = [f for f in bm.faces if long_edge(f) or stray(f)]
        if not bad: break
        bmesh.ops.delete(bm, geom=bad, context='FACES')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        info['torn_triangles_removed'] = info.get('torn_triangles_removed', 0) + len(bad)
    bm.to_mesh(o.data); bm.free()

skin_tree = BVHTree.FromObject(skin, bpy.context.evaluated_depsgraph_get())
order = sorted(pattern['garments'], key=lambda g: {'pants': 0, 'shorts': 0, 'skirt': 0, 'top': 1, 'dress': 1, 'jacket': 2}.get(g['type'], 1))
for g in order:
    info = {'id': g['id'], 'type': g['type'], 'fabric': g['fabric']}
    o, pairs = build_cloth(g)
    info['vertices'] = len(o.data.vertices); info['seam_points'] = len(pairs)
    drape(o, g)
    st = stretch_of(o, frozenset(x for pair in pairs for x in pair))
    info['stretch'] = {'median': round(st[len(st) // 2], 3), 'p95': round(st[int(len(st) * 0.95)], 3)} if st else {}
    if st and st[int(len(st) * 0.95)] > 1.15 and not fabrics.PHYSICS[g['fabric']]['stretchy']:
        report['warnings'].append(f'{g["type"]}: the {g["fabric"]} is pulled more than 15% past its cut size in places: too tight for a fabric that doesn\'t stretch.')
    weld(o, pairs, info)
    inside = 0
    for v in o.data.vertices:
        loc, nrm, idx, dist = skin_tree.find_nearest(v.co)
        if loc is not None and (v.co - loc).dot(nrm) < -0.002: inside += 1
    info['poke_through'] = inside
    if inside > len(o.data.vertices) * 0.03: report['warnings'].append(f'{g["type"]}: {inside} points ended up inside her body.')
    # Every finished garment is something the next one drapes over.
    c = o.modifiers.new('Collision', 'COLLISION'); o.collision.thickness_outer = 0.003; o.collision.cloth_friction = 5
    finished.append((g, o))
    report['garments'].append(info)
    stage(f'sewn {g["type"]}')
for g, o in finished:
    for m in list(o.modifiers): o.modifiers.remove(m)

# ---------------------------------------------------------------- finish each garment and skin it to her
garments_objs = []
for g, o in finished:
    o.data.materials.append(fabrics.material(g, OUT))
    # The drape is simulated at a stable resolution, then subdivided and smoothed into fine fabric (the way
    # garment tools finish a simulation), keeping the folds the simulation made.
    sub = o.modifiers.new('Fine', 'SUBSURF'); sub.levels = 1; sub.render_levels = 1; sub.boundary_smooth = 'PRESERVE_CORNERS'
    # Plain offset: "even" thickness divides by the fold angle and throws a point a metre out at a tight fold.
    sol = o.modifiers.new('Thickness', 'SOLIDIFY'); sol.thickness = fabrics.PHYSICS[g['fabric']]['thickness']; sol.offset = 1; sol.use_even_offset = False
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    for m in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=m.name)
    # The finished garment, checked once more: no point where no garment could be.
    bm = bmesh.new(); bm.from_mesh(o.data)
    far = []
    for v in bm.verts:
        loc = skin_tree.find_nearest(v.co)[0]
        if loc is not None and (v.co - loc).length > reach(g['type'], v.co.z) + 0.02: far.append(v)
    if far: bmesh.ops.delete(bm, geom=far, context='VERTS')
    bm.to_mesh(o.data); bm.free()
    # Skin weights from the dress form, then eased toward her hips down a skirt so it swings, not tears between her legs.
    dt = o.modifiers.new('Weights', 'DATA_TRANSFER'); dt.object = skin
    dt.use_vert_data = True; dt.data_types_verts = {'VGROUP_WEIGHTS'}; dt.vert_mapping = 'POLYINTERP_NEAREST'
    dt.layers_vgroup_select_src = 'ALL'; dt.layers_vgroup_select_dst = 'NAME'
    bpy.ops.object.datalayout_transfer(modifier=dt.name)
    bpy.ops.object.modifier_apply(modifier=dt.name)
    if g['type'] in ('dress', 'skirt'):
        hips = o.vertex_groups.get('Hips') or o.vertex_groups.new(name='Hips')
        for v in o.data.vertices:
            f = min(0.75, max(0.0, (CROTCH + 0.04 - v.co.z) / 0.35))
            if f <= 0: continue
            for ge in v.groups: ge.weight *= (1 - f)
            hips.add([v.index], f, 'ADD')
    df.bind(o, rig)
    garments_objs.append(o)
report['vertices'] = sum(len(o.data.vertices) for o in garments_objs)
stage('finished')

# The skin that still shows: her body minus whatever the garments cover.
shown = skin.copy(); shown.data = skin.data.copy(); bpy.context.scene.collection.objects.link(shown)
for m in list(shown.modifiers):
    if m.type != 'ARMATURE': shown.modifiers.remove(m)
shown.name = 'Skin'
deps = bpy.context.evaluated_depsgraph_get()
trees = [BVHTree.FromObject(o, deps) for o in garments_objs]
bm = bmesh.new(); bm.from_mesh(shown.data)
# A bit of skin is hidden only when every corner of it is under fabric, so no gap opens at a hem or neckline.
under = {}
for v in bm.verts:
    under[v.index] = any(t.ray_cast(v.co + v.normal * 0.001, v.normal, 0.06)[0] is not None for t in trees)
covered = [f for f in bm.faces if all(under[v.index] for v in f.verts)]
bmesh.ops.delete(bm, geom=covered, context='FACES')
bm.to_mesh(shown.data); bm.free()
shown.data.materials.clear(); shown.data.materials.append(fabrics.skin_material(skin))
skin.hide_render = True
report['skin_faces_shown'] = len(shown.data.polygons)
stage('skin')

# ---------------------------------------------------------------- export and look at it
# Her whole avatar wearing it: her own rig, head, face (with every expression and mouth shape), eyes, hair and
# shoes exactly as they were; her old body and suit replaced by the skin that shows and the sewn garments.
# Her stage loads it like any avatar in her library.
KEEP = ('Head_Mesh', 'Eye_Mesh', 'EyeAO_Mesh', 'Eyelash_Mesh', 'Teeth_Mesh', 'Tongue_Mesh', 'avaturn_hair_0', 'avaturn_hair_1', 'avaturn_shoes_0')
own = [o for o in avatar_objs if o.type == 'MESH' and o.name.split('.')[0] in KEEP]
bpy.ops.object.select_all(action='DESELECT')
for o in [rig, shown, *garments_objs, *own]: o.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(filepath=str(OUT / 'avatar.glb'), export_format='GLB', use_selection=True, export_skins=True,
                          export_animations=False, export_morph=True, export_apply=False, export_yup=True)
report['glb_bytes'] = (OUT / 'avatar.glb').stat().st_size
df.setup_render()
look = [shown, *garments_objs] + [o for o in avatar_objs if o.type == 'MESH' and o.name.split('.')[0] in ('Head_Mesh', 'Eye_Mesh', 'Eyelash_Mesh', 'avaturn_hair_0', 'avaturn_hair_1', 'avaturn_shoes_0', 'Teeth_Mesh')]
for view in ('front', 'back', 'side'): df.render(OUT / f'{view}.png', look, view, zrange=(0.0, 1.9))
stage('rendered')
report['ok'] = True
report['seconds'] = round(time.time() - T0, 1)
(OUT / 'report.json').write_text(json.dumps(report, indent=1))
print('SEWN', json.dumps(report))
