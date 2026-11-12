"""Measure her on the dress form, the way a tailor would, for pattern drafting (drafting.py).

Writes body.json (all lengths in metres, world space, Z up):
  front            -1 or +1: which Y direction she faces
  landmarks        heights and points: neck base, shoulder points, bust, waist, high hip, hip, crotch, knee,
                   ankle; arm shoulder/elbow/wrist; leg hip/knee/ankle (left side; right is the mirror)
  circumference    neck, bust, underbust, waist, high hip, hip, thigh, knee, calf, ankle, upper arm, elbow, wrist
  torso            cross-sections every 1 cm from crotch to neck: for each, the contour around the torso as
                   (angle, radius) samples about the section's centre, angle 0 = straight in front, increasing
                   toward her left; so a pattern piece can be cut to the body's real width at every height
  arm / leg        radius along each limb, every 2 cm, measured perpendicular to the bone

Run: blender -b --factory-startup --python measure.py -- data/avatar.glb out/body.json
"""
import bpy, bmesh, json, math, pathlib, sys
from mathutils import Vector
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import dressform as df

TORSO = {'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'LeftShoulder', 'RightShoulder', 'LeftUpLeg', 'RightUpLeg'}

def dominant_groups(o):
    names = [g.name for g in o.vertex_groups]
    out = []
    for v in o.data.vertices:
        best = max(v.groups, key=lambda g: g.weight, default=None)
        out.append(names[best.group] if best else '')
    return out

def section(o, keep_faces, origin, normal):
    """Cut the mesh (only keep_faces) with a plane; returns the cut points in world space."""
    bm = bmesh.new(); bm.from_mesh(o.data); bm.transform(o.matrix_world)
    bm.faces.ensure_lookup_table()
    drop = [f for f in bm.faces if not keep_faces[f.index]]
    bmesh.ops.delete(bm, geom=drop, context='FACES')
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=origin, plane_no=normal, dist=1e-5)
    pts = [v.co.copy() for v in res['geom_cut'] if isinstance(v, bmesh.types.BMVert)]
    bm.free()
    return pts

def hull2(points):
    pts = sorted(set((round(p[0], 5), round(p[1], 5)) for p in points))
    if len(pts) < 3: return pts
    def cross(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0: hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]

def perimeter(poly):
    return sum(math.dist(poly[i], poly[(i + 1) % len(poly)]) for i in range(len(poly))) if len(poly) > 2 else 0.0

def polar(poly, centre, front, n=72):
    """Radius of the (convex) contour at n angles; angle 0 = straight in front, positive toward her left (+X)."""
    out = []
    for k in range(n):
        a = 2 * math.pi * k / n
        d = (math.sin(a), front * math.cos(a))  # direction in XY: a=0 -> front (+front Y), a=90deg -> +X (her left)
        best = 0.0
        for i in range(len(poly)):
            p, q = Vector((*poly[i], 0)), Vector((*poly[(i + 1) % len(poly)], 0))
            # ray from centre along d against segment p-q
            r = Vector((d[0], d[1], 0)); s = q - p; c = Vector((*centre, 0))
            den = r.x * s.y - r.y * s.x
            if abs(den) < 1e-12: continue
            t = ((p.x - c.x) * s.y - (p.y - c.y) * s.x) / den
            u = ((p.x - c.x) * r.y - (p.y - c.y) * r.x) / den
            if t > 0 and 0 <= u <= 1: best = max(best, t)
        out.append(round(best, 4))
    return out

def measure(rig, form):
    front = df.front_sign()
    dom = dominant_groups(form)
    torso_face = [all(dom[i] in TORSO for i in p.vertices) for p in form.data.polygons]
    any_face = [True] * len(form.data.polygons)
    b = lambda n: df.bone_head(rig, n)
    neck, hips, spine, spine1, spine2 = b('Neck'), b('Hips'), b('Spine'), b('Spine1'), b('Spine2')
    shoulder, elbow, wrist = b('LeftArm'), b('LeftForeArm'), b('LeftHand')
    hip_j, knee, ankle = b('LeftUpLeg'), b('LeftLeg'), b('LeftFoot')

    # Torso sections, every cm from just above the crotch to the neck base.
    sections = []
    z = round(hip_j.z - 0.12, 2)
    crotch = None
    while z <= neck.z + 0.005:
        pts = section(form, torso_face, Vector((0, 0, z)), Vector((0, 0, 1)))
        if pts:
            left = [p for p in pts if p.x > 0.01]; right = [p for p in pts if p.x < -0.01]; mid = [p for p in pts if abs(p.x) <= 0.01]
            # Below the crotch the section is two legs: nothing in the middle.
            if crotch is None and z < hip_j.z and not mid and left and right: z = round(z + 0.01, 2); continue
            if crotch is None: crotch = z
            poly = hull2([(p.x, p.y) for p in pts])
            cx = sum(p[0] for p in poly) / len(poly); cy = sum(p[1] for p in poly) / len(poly)
            ys = [p[1] for p in poly]; xs = [p[0] for p in poly]
            sections.append({'z': z, 'centre': [round(cx, 4), round(cy, 4)], 'girth': round(perimeter(poly), 4),
                             'width': round(max(xs) - min(xs), 4), 'depth': round(max(ys) - min(ys), 4), 'radius': polar(poly, (cx, cy), front)})
        z = round(z + 0.01, 2)
    by_z = lambda zz: min(sections, key=lambda s: abs(s['z'] - zz))
    in_range = lambda lo, hi: [s for s in sections if lo <= s['z'] <= hi]
    bust = max(in_range(spine2.z - 0.08, spine2.z + 0.12), key=lambda s: s['depth'])
    waist = min(in_range(spine.z, spine2.z), key=lambda s: s['girth'])
    hip = max(in_range(crotch + 0.02, hips.z + 0.02), key=lambda s: s['girth'])
    underbust = min(in_range(waist['z'], bust['z']), key=lambda s: abs(s['z'] - (bust['z'] - 0.07)))
    high_hip = by_z((waist['z'] + hip['z']) / 2)

    def limb(start, end, prefix):
        axis = (end - start); length = axis.length; axis.normalize()
        keep = [all(dom[i].startswith(prefix) for i in p.vertices) for p in form.data.polygons]
        out = []
        t = 0.02
        while t < length - 0.01:
            o = start + axis * t
            pts = section(form, keep, o, axis)
            pts = [p for p in pts if (p - o).length < 0.15]
            if len(pts) > 4:
                # Project into the plane, measure the convex girth and mean radius.
                u = axis.orthogonal().normalized(); v = axis.cross(u)
                flat = [((p - o).dot(u), (p - o).dot(v)) for p in pts]
                poly = hull2(flat)
                out.append({'t': round(t, 3), 'girth': round(perimeter(poly), 4), 'radius': round(perimeter(poly) / (2 * math.pi), 4)})
            t += 0.02
        return {'start': [round(c, 4) for c in start], 'end': [round(c, 4) for c in end], 'length': round(length, 4), 'profile': out}

    arm_upper = limb(shoulder, elbow, 'LeftArm')
    arm_fore = limb(elbow, wrist, 'LeftForeArm')
    leg_upper = limb(hip_j, knee, 'LeftUpLeg')
    leg_lower = limb(knee, ankle, 'LeftLeg')
    near = lambda prof, t: min(prof['profile'], key=lambda p: abs(p['t'] - t))['girth'] if prof['profile'] else 0
    neck_sec = section(form, [all(dom[i] in ('Neck', 'Spine2', 'Head') for i in p.vertices) for p in form.data.polygons], neck + Vector((0, 0, 0.03)), Vector((0, 0, 1)))
    neck_girth = perimeter(hull2([(p.x, p.y) for p in neck_sec])) if neck_sec else 0.34
    return {
        'front': front,
        'landmarks': {
            'neck_base': round(neck.z, 4), 'shoulder_point': [round(c, 4) for c in shoulder], 'bust': bust['z'], 'underbust': underbust['z'],
            'waist': waist['z'], 'high_hip': high_hip['z'], 'hip': hip['z'], 'crotch': crotch, 'knee': round(knee.z, 4), 'ankle': round(ankle.z, 4),
            'floor': 0.0, 'elbow': [round(c, 4) for c in elbow], 'wrist': [round(c, 4) for c in wrist], 'hip_joint': [round(c, 4) for c in hip_j],
            'knee_joint': [round(c, 4) for c in knee], 'ankle_joint': [round(c, 4) for c in ankle],
        },
        'circumference': {
            'neck': round(neck_girth, 4), 'bust': bust['girth'], 'underbust': underbust['girth'], 'waist': waist['girth'], 'high_hip': high_hip['girth'], 'hip': hip['girth'],
            'thigh': near(leg_upper, 0.06), 'knee': near(leg_upper, leg_upper['length'] - 0.02), 'calf': max((p['girth'] for p in leg_lower['profile']), default=0),
            'ankle': near(leg_lower, leg_lower['length'] - 0.04), 'upper_arm': near(arm_upper, 0.06), 'elbow': near(arm_fore, 0.02), 'wrist': near(arm_fore, arm_fore['length'] - 0.03),
        },
        'torso': sections,
        'arm': {'upper': arm_upper, 'fore': arm_fore},
        'leg': {'upper': leg_upper, 'lower': leg_lower},
    }

if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:]
    rig, objs = df.load_avatar(args[0])
    form = df.dress_form(rig)
    body = measure(rig, form)
    pathlib.Path(args[1]).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(args[1]).write_text(json.dumps(body))
    c, l = body['circumference'], body['landmarks']
    print('MEASURED', json.dumps({k: round(v * 100, 1) for k, v in c.items()}), 'cm')
    print('HEIGHTS', json.dumps({k: (round(v * 100, 1) if isinstance(v, (int, float)) else None) for k, v in l.items() if isinstance(v, (int, float))}), 'cm; sections', len(body['torso']))
