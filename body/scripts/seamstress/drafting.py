"""Pattern drafting: a garment design + her measurements (body.json) -> flat sewing pattern pieces with seams.

This is the seamstress's cutting table. Every piece is a flat 2D outline in metres (u across, v up), cut to
her real body: a fitted side seam follows her actual width at every height (from the torso cross-sections),
a sleeve fits her real arm, a waistband her real waist, all plus the design's ease. Nothing is a stretched
shell of her skin: pieces are cut flat, sewn along named edges, and draped by sew.py (Blender cloth).

Pieces carry how to place them around her before sewing (region + centre angle), and seams name which
edge sews to which. Edges run counter-clockwise around each piece seen from outside, so two pieces that
meet at a seam run it in opposite directions.

Run (any Python 3): python drafting.py design.json body.json out/pattern.json [out/pattern.png]
"""
import json, math, sys, pathlib

# ---- the design vocabulary -------------------------------------------------------------------------
TYPES = ['top', 'dress', 'skirt', 'pants', 'shorts', 'jacket']
FIT_EASE = {'skin': -0.04, 'fitted': 0.03, 'regular': 0.08, 'relaxed': 0.15, 'oversized': 0.28}
LENGTHS_TOP = {'crop': 'underbust', 'waist': 'waist', 'hip': 'high_hip', 'tunic': 'hip_low'}
SKIRT_LENGTHS = {'micro': 0.26, 'mini': 0.36, 'above_knee': 0.48, 'knee': 0.60, 'midi': 0.78, 'maxi': 0.98, 'floor': 1.10}
SKIRT_STYLES = {'pencil': -0.06, 'a_line': 0.22, 'flared': 0.5, 'circle': 1.2}  # flare: added hem width per metre of drop, as a fraction
NECKLINES = ['crew', 'scoop', 'v', 'deep_v', 'boat', 'square', 'sweetheart', 'camisole', 'high']
SLEEVES = {'none': 0, 'cap': 0.07, 'short': 0.16, 'elbow': 0.30, 'three_quarter': 0.42, 'long': None}
SLEEVE_STYLES = ['fitted', 'puff', 'bell', 'bishop']
STRAPS = ['regular', 'wide', 'thin']
PANTS_STYLES = ['skinny', 'straight', 'wide', 'flared']
PANTS_LENGTHS = {'ankle': 0.0, 'floor': -0.07, 'capri': 0.22, 'knee': None}
SHORTS_LENGTHS = {'micro': 0.04, 'short': 0.09, 'mid': 0.17, 'bermuda': 0.30}
RISES = {'low': -0.05, 'mid': 0.0, 'high': 0.04}
FABRICS = ['jersey', 'cotton', 'linen', 'silk', 'satin', 'chiffon', 'denim', 'leather', 'latex', 'velvet', 'wool', 'knit', 'lace', 'mesh']
PATTERNS = ['solid', 'stripes', 'pinstripe', 'plaid', 'gingham', 'polka', 'gradient', 'houndstooth', 'chevron']
STRETCH = {'jersey', 'knit', 'latex', 'mesh', 'lace'}

class DesignError(ValueError):
    pass

def need(cond, why):
    if not cond: raise DesignError(why)

# ---- body helpers ----------------------------------------------------------------------------------
class Body:
    def __init__(self, b):
        self.b = b; self.L = b['landmarks']; self.C = b['circumference']
        self.arm, self.leg = b['arm'], b['leg']
        # Smooth the cross-sections, up and down (5 cm) and around (15 degrees): a tape measure doesn't follow
        # every bump, and near the underarm the raw sections jump where her arm meets her torso.
        raw = b['torso']; n = len(raw[0]['radius'])
        self.sec = []
        for i, s in enumerate(raw):
            near = raw[max(0, i - 2): i + 3]
            r = [sum(x['radius'][k] for x in near) / len(near) for k in range(n)]
            r = [(r[k - 1] + 2 * r[k] + r[(k + 1) % n]) / 4 for k in range(n)]
            self.sec.append({**s, 'radius': r})
        # Above the underarm her shoulders and arms join the sections: hold the width there to the width at the underarm.
        z_ap = self.L['shoulder_point'][2] - 0.085
        cap = min((s for s in self.sec if s['z'] <= z_ap), key=lambda s: abs(s['z'] - z_ap))
        for s in self.sec:
            if s['z'] > z_ap: s['radius'] = [min(a, b_) for a, b_ in zip(s['radius'], cap['radius'])]
    def at(self, z):
        s = self.sec
        if z <= s[0]['z']: return s[0]
        if z >= s[-1]['z']: return s[-1]
        return min(s, key=lambda x: abs(x['z'] - z))
    def arc(self, z, a0, a1, ease=0.0, gap=0.0):
        """Length around her at height z from angle a0 to a1 (degrees, 0 = front, + toward her left)."""
        r = self.at(z)['radius']; n = len(r); step = 360 / n
        def rad(a):
            k = (a % 360) / step; i = int(k) % n; f = k - int(k)
            return r[i] * (1 - f) + r[(i + 1) % n] * f + gap
        lo, hi = min(a0, a1), max(a0, a1); total, a = 0.0, lo
        while a < hi - 1e-9:
            b = min(hi, a + 2.5)
            ra, rb = rad(a), rad(b); d = math.radians(b - a)
            total += math.sqrt(ra * ra + rb * rb - 2 * ra * rb * math.cos(d)); a = b
        return total * (1 + ease)
    def z(self, name):
        if name == 'hip_low': return self.L['hip'] - 0.08
        return self.L[name]
    def arm_girth(self, t):
        up, fore = self.arm['upper'], self.arm['fore']
        prof = [(p['t'], p['girth']) for p in up['profile']] + [(up['length'] + p['t'], p['girth']) for p in fore['profile']]
        return min(prof, key=lambda p: abs(p[0] - t))[1] if prof else 0.28
    def arm_length(self): return self.arm['upper']['length'] + self.arm['fore']['length']
    def leg_girth(self, z):
        hip_j, knee = self.L['hip_joint'][2], self.L['knee_joint'][2]
        up, lo = self.leg['upper'], self.leg['lower']
        prof = [(hip_j - p['t'], p['girth']) for p in up['profile']] + [(knee - p['t'], p['girth']) for p in lo['profile']]
        return min(prof, key=lambda p: abs(p[0] - z))[1] if prof else 0.5

# ---- geometry helpers ------------------------------------------------------------------------------
def bezier(p0, p1, p2, n=10):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]) for t in (i / n for i in range(n + 1))]

def line(p0, p1): return [tuple(p0), tuple(p1)]

def mirror(pts): return [(-x, y) for x, y in pts]

def r4(pts): return [[round(x, 4), round(y, 4)] for x, y in pts]

def length(pts): return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))

class Piece:
    def __init__(self, pid, garment, region, centre=0.0, side=None, layer=0, note=''):
        self.id, self.garment, self.region, self.centre, self.side, self.layer, self.note = pid, garment, region, centre, side, layer, note
        self.edges = []
    def edge(self, name, pts):
        if self.edges: assert math.dist(self.edges[-1][1][-1], pts[0]) < 1e-6, f'{self.id}: {name} does not start where {self.edges[-1][0]} ends'
        self.edges.append((name, [tuple(p) for p in pts]))
        return self
    def close(self):
        assert math.dist(self.edges[-1][1][-1], self.edges[0][1][0]) < 1e-6, f'{self.id} is not closed'
        return self
    def json(self):
        return {'id': self.id, 'garment': self.garment, 'region': self.region, 'centre': self.centre, 'side': self.side, 'layer': self.layer,
                'note': self.note, 'edges': [{'id': n, 'pts': r4(p), 'length': round(length(p), 4)} for n, p in self.edges]}

# ---- bodice (tops, dresses, jackets) -----------------------------------------------------------------
def neckline_curve(style, np_, depth_z, back=False):
    """Front (or back) neckline from the neck point (np_) to the centre line, as a list of (u, v); u>=0 half."""
    u, v = np_
    if back: return bezier((u, v), (u * 0.9, depth_z), (0, depth_z))
    if style in ('v', 'deep_v'): return [(u, v), (0, depth_z)]
    if style == 'square': return [(u, v), (u, depth_z), (0, depth_z)]
    if style == 'sweetheart':
        mid = (u * 0.5, depth_z + (v - depth_z) * 0.18)
        return bezier((u, v), (u, depth_z), mid, 6) + bezier(mid, (u * 0.12, mid[1] + 0.012), (0, depth_z), 6)[1:]
    if style == 'boat': return bezier((u, v), (u * 0.55, depth_z), (0, depth_z))
    return bezier((u, v), (u * 0.95, depth_z), (0, depth_z))

def bodice(body, g, gid, bottom_z, open_front=False, layer=0):
    """Front and back bodice pieces from bottom_z up over the shoulders. Returns pieces, seams, named edges."""
    L = body.L
    ease = FIT_EASE[g.get('fit', 'fitted')] + (0.05 if layer else 0)
    stretch = g.get('fabric') in STRETCH
    if stretch and g.get('fit', 'fitted') in ('skin', 'fitted'): ease -= 0.02
    gap = 0.004 * layer
    neck = g.get('neckline', 'crew'); need(neck in NECKLINES, f'neckline must be one of {", ".join(NECKLINES)}')
    sleeves = g.get('sleeves', 'none'); need(sleeves in SLEEVES, f'sleeves must be one of {", ".join(SLEEVES)}')
    straps = g.get('straps', 'regular'); need(straps in STRAPS, f'straps must be one of {", ".join(STRAPS)}')
    sp = L['shoulder_point']
    z_ap = sp[2] - 0.085                      # underarm
    z_sh = sp[2] + 0.045                      # top of the shoulder at the shoulder point
    z_neck = L['neck_base'] + 0.012           # side of the neck
    over = 0.045                              # cloth needed to go over the shoulder to the seam on top
    u_np = body.C['neck'] / (2 * math.pi) + 0.012 + (0.045 if neck == 'boat' else 0) + (0.02 if neck in ('scoop', 'square', 'sweetheart') else 0)
    u_sp = abs(sp[0]) + (0.012 if sleeves != 'none' else -0.008) + ease * 0.05
    if straps == 'wide' and sleeves == 'none': u_sp = min(u_sp, u_np + 0.065)
    zs = [round(bottom_z + i * (z_ap - bottom_z) / 14, 4) for i in range(15)]
    depth_front = {'crew': 0.035, 'high': 0.01, 'scoop': 0.15, 'v': 0.17, 'deep_v': 0.27, 'boat': 0.045, 'square': 0.14, 'sweetheart': 0.17, 'camisole': 0.10}[neck]
    depth_back = float(g.get('back_depth', 0.025 if neck not in ('camisole',) else 0.12))
    z_cf = L['neck_base'] - depth_front
    z_cb = L['neck_base'] - depth_back
    pieces, seams = [], []

    def half(front):
        a0, a1 = (0, 90) if front else (180, 90)
        w = [(body.arc(z, a0, a1, ease, gap), z) for z in zs]  # side seam, bottom -> underarm
        top = z_sh + over
        if neck == 'camisole' and front:
            # A straight top edge above the bust, with a thin strap up to the shoulder.
            z_top = L['bust'] + 0.085
            su = 0.085
            arm = bezier(w[-1], (w[-1][0] - 0.01, z_top - 0.01), (su + 0.02, z_top), 6)
            strap = [(su + 0.02, z_top), (su + 0.012, top)]  # a strap 2.4 cm wide: anything thinner is lost in the cloth
            shoulder = [(su + 0.012, top), (su - 0.012, top)]
            neckl = [(su - 0.012, top), (su - 0.006, z_top), (0, z_top)]
            return w, arm + strap[1:], shoulder, neckl
        if neck == 'camisole':
            su = 0.085; z_top = L['bust'] + 0.03
            arm = bezier(w[-1], (w[-1][0] - 0.02, z_top), (su + 0.02, z_top + 0.02), 6) + [(su + 0.012, top)]
            return w, arm, [(su + 0.012, top), (su - 0.012, top)], [(su - 0.012, top), (su - 0.006, z_cb), (0, z_cb)]
        if straps == 'thin' and sleeves == 'none':
            su = u_np + 0.03
            arm = bezier(w[-1], (su + 0.03, z_ap + 0.03), (su + 0.012, top), 8)
            shoulder = [(su + 0.012, top), (su - 0.012, top)]
            nl = neckline_curve(neck, (su - 0.012, top), z_cf if front else z_cb, back=not front)
            return w, arm, shoulder, nl
        arm = bezier(w[-1], (u_sp - (0.012 if front else 0.0), z_ap + 0.04), (u_sp, top), 10)
        shoulder = [(u_sp, top), (u_np, top + 0.006)]
        nl = neckline_curve(neck, (u_np, top + 0.006), z_cf if front else z_cb, back=not front)
        return w, arm, shoulder, nl

    for front in (True, False):
        side, arm, shoulder, nl = half(front)
        name = 'front' if front else 'back'
        centre = 0.0 if front else 180.0
        if open_front and front:
            # Two front pieces with the centre front left open (a jacket or cardigan), each cut a little past
            # the centre line (lap) so the fronts meet. Her left front is the +u half; her right is its mirror.
            lap = 0.015
            z_top_cf = nl[-1][1]
            left = Piece(f'{gid}.front_left', gid, 'torso', centre, 'left', layer)
            left.edge('hem', [(-lap, bottom_z), side[0]]).edge('side', side).edge('armhole', arm).edge('shoulder', shoulder)
            left.edge('neck', nl[:-1] + [(-lap, z_top_cf)]).edge('centre_front', [(-lap, z_top_cf), (-lap, bottom_z)]).close()
            right = Piece(f'{gid}.front_right', gid, 'torso', centre, 'right', layer)
            right.edge('hem', [mirror([side[0]])[0], (lap, bottom_z)]).edge('centre_front', [(lap, bottom_z), (lap, z_top_cf)])
            right.edge('neck', [(lap, z_top_cf)] + list(reversed(mirror(nl[:-1])))).edge('shoulder', list(reversed(mirror(shoulder))))
            right.edge('armhole', list(reversed(mirror(arm)))).edge('side', list(reversed(mirror(side)))).close()
            pieces += [left, right]
            continue
        p = Piece(f'{gid}.{name}', gid, 'torso', centre, None, layer)
        # Counter-clockwise from outside. For the back seen from behind, +u is her right, so the outline is
        # drafted the same way and placed facing the other way.
        p.edge('hem', [mirror(side)[0], side[0]])
        p.edge('side_l', side)
        p.edge('armhole_l', arm)
        p.edge('shoulder_l', shoulder)
        p.edge('neck', nl + list(reversed(mirror(nl)))[1:])
        p.edge('shoulder_r', list(reversed(mirror(shoulder))))
        p.edge('armhole_r', list(reversed(mirror(arm))))
        p.edge('side_r', list(reversed(mirror(side)))).close()
        pieces.append(p)

    fr = {p.id.split('.', 1)[1]: p for p in pieces}
    def S(a, ea, b, eb): seams.append({'a': [a.id, ea], 'b': [b.id, eb]})
    back = fr['back']
    if open_front:
        fl, frt = fr['front_left'], fr['front_right']
        S(fl, 'side', back, 'side_r'); S(frt, 'side', back, 'side_l')
        S(fl, 'shoulder', back, 'shoulder_r'); S(frt, 'shoulder', back, 'shoulder_l')
        arm_edges = {'left': [(fl, 'armhole'), (back, 'armhole_r')], 'right': [(frt, 'armhole'), (back, 'armhole_l')]}
        hem_edges = [(fl, 'hem'), (back, 'hem'), (frt, 'hem')]
    else:
        f = fr['front']
        # Her left side: the front's left (u>0) meets the back's right (u<0 on the back is her left).
        S(f, 'side_l', back, 'side_r'); S(f, 'side_r', back, 'side_l')
        S(f, 'shoulder_l', back, 'shoulder_r'); S(f, 'shoulder_r', back, 'shoulder_l')
        arm_edges = {'left': [(f, 'armhole_l'), (back, 'armhole_r')], 'right': [(f, 'armhole_r'), (back, 'armhole_l')]}
        hem_edges = [(f, 'hem'), (back, 'hem')]
    return pieces, seams, arm_edges, hem_edges, ease

def pieces_by(pieces, suffix): return next(p for p in pieces if p.id.endswith(suffix))

def sleeves(body, g, gid, arm_edges, ease, layer=0):
    kind = g.get('sleeves', 'none')
    if kind == 'none': return [], []
    style = g.get('sleeve_style', 'fitted'); need(style in SLEEVE_STYLES, f'sleeve_style must be one of {", ".join(SLEEVE_STYLES)}')
    full = body.arm_length()
    L = SLEEVES[kind] if SLEEVES[kind] is not None else full + 0.01
    pieces, seams = [], []
    for side in ('left', 'right'):
        (fp, fe), (bp, be) = arm_edges[side]
        f_len = length(dict(fp.edges)[fe]); b_len = length(dict(bp.edges)[be])
        e = ease + (0.06 if g.get('fit') in ('relaxed', 'oversized') else 0.02)
        top_w = body.arm_girth(0.05) * (1 + e)
        if style == 'puff': top_w *= 1.45
        cap_h = min(0.09, max(0.04, (f_len + b_len) / 2 - top_w / 2)) if style != 'puff' else 0.09
        def width_at(t):
            w = body.arm_girth(min(t, full - 0.02)) * (1 + e)
            if style == 'bell': w *= 1 + 1.6 * max(0, t - 0.2) / max(0.2, L)
            if style == 'bishop': w *= 1 + 0.9 * (t / max(0.1, L))
            return w
        hem_w = width_at(L) if style != 'puff' else body.arm_girth(min(L, full)) * (1 + e) * 1.05
        if style == 'bishop' and kind == 'long': hem_w = body.C['wrist'] * 1.25
        h = top_w / 2; hb = hem_w / 2
        # Sleeve laid flat: v runs down the arm from the cap top (v=0) to the hem (v=-L); u around the arm.
        cap_f = bezier((h, -cap_h), (h * 0.55, -cap_h * 0.15), (0, 0), 10)   # front half of the cap: underarm -> top
        cap_b = bezier((0, 0), (-h * 0.55, -cap_h * 0.1), (-h, -cap_h), 10)
        mid_t = min(L, 0.25)
        under_l = [(-h, -cap_h), (-width_at(mid_t) / 2, -mid_t - cap_h * 0.3) if L > 0.2 else (-hb, -L), (-hb, -L)]
        if L <= 0.2: under_l = [(-h, -cap_h), (-hb, -L)]
        under_r = [(hb, -L)] + ([(width_at(mid_t) / 2, -mid_t - cap_h * 0.3)] if L > 0.2 else []) + [(h, -cap_h)]
        p = Piece(f'{gid}.sleeve_{side}', gid, f'arm_{side}', 0.0, side, layer, f'{kind} {style} sleeve')
        p.edge('cap_front', cap_f).edge('cap_back', cap_b).edge('under_back', under_l).edge('hem', [(-hb, -L), (hb, -L)]).edge('under_front', under_r).close()
        pieces.append(p)
        # Cap front sews to the front armhole (underarm -> shoulder), cap back to the back armhole.
        seams.append({'a': [p.id, 'cap_front'], 'b': [fp.id, fe]})
        seams.append({'a': [p.id, 'cap_back'], 'b': [bp.id, be]})
        seams.append({'a': [p.id, 'under_back'], 'b': [p.id, 'under_front']})
    return pieces, seams

# ---- skirts ----------------------------------------------------------------------------------------
def skirt(body, g, gid, top_z, attach=None, layer=0):
    L = body.L
    style = g.get('skirt', g.get('style', 'a_line')); need(style in SKIRT_STYLES, f'skirt style must be one of {", ".join(SKIRT_STYLES)}')
    length_name = g.get('length', 'knee'); need(length_name in SKIRT_LENGTHS, f'skirt length must be one of {", ".join(SKIRT_LENGTHS)}')
    hem_z = max(0.02, L['waist'] - SKIRT_LENGTHS[length_name])
    flare = SKIRT_STYLES[style]
    ease_w = FIT_EASE['fitted'] if attach is None else 0.0
    gap = 0.004 * layer
    slit = g.get('slit', 'none')
    pieces, seams = [], []
    hip_z = L['hip']
    for name, a0, a1, centre in (('front', 0, 90, 0.0), ('back', 180, 90, 180.0)):
        top_w = attach[name] if attach else body.arc(top_z, a0, a1, ease_w, gap)
        hip_w = body.arc(hip_z, a0, a1, 0.05, gap)
        drop = top_z - hem_z
        # The hem's real size by style (each piece here is a quarter of the way round her): a pencil skirt narrows a
        # little below the hip; an A-line and a flared skirt open out at a set angle; a circle skirt's hem is a
        # whole circle around her waist, as wide as the skirt is long.
        waist_r = (top_w * 4) / (2 * math.pi)
        hip_circ = hip_w * 4
        hem_circ = {'pencil': hip_circ * 0.9, 'a_line': hip_circ + 2 * math.pi * drop * 0.2,
                    'flared': hip_circ + 2 * math.pi * drop * 0.45, 'circle': 2 * math.pi * (waist_r + drop)}[style]
        hem_half = max(hem_circ / 4, hip_w * 0.82)
        side = []
        if style in ('pencil', 'a_line'):
            # Fitted over her hips, then the skirt's own line to the hem.
            for i in range(9):
                z = top_z - (top_z - hip_z) * i / 8
                side.append((max(body.arc(z, a0, a1, 0.05, gap), top_w + (hip_w - top_w) * i / 8), z))
            for i in range(1, 9):
                z = hip_z - (hip_z - hem_z) * i / 8
                side.append((hip_w + (hem_half - hip_w) * (i / 8), z))
        else:
            # A flared or circle skirt opens straight out from the waist; it rests on her hips and falls in folds.
            for i in range(17):
                z = top_z - drop * i / 16
                side.append((max(top_w + (hem_half - top_w) * i / 16, body.arc(min(max(z, hip_z), top_z), a0, a1, 0.05, gap) if z >= hip_z else 0), z))
        side[0] = (top_w, top_z)
        # A flared hem is curved so it hangs level: the seam corners sit higher than the middle (the arc of the
        # circle the hem lies on).
        spread = max(0.0, hem_half - top_w)
        sag = min(0.35 * drop, spread * spread / (2 * max(0.2, drop)))
        hem_r = bezier((side[-1][0], side[-1][1] + sag), (side[-1][0] * 0.5, hem_z - sag * 0.15), (0, hem_z), 10)
        side[-1] = (side[-1][0], side[-1][1] + sag)
        p = Piece(f'{gid}.skirt_{name}', gid, 'skirt', centre, None, layer, f'{style} {length_name} skirt')
        hem = mirror(hem_r) + list(reversed(hem_r))[1:]  # her right corner -> centre -> her left corner
        # Optional side slit: the bottom part of the side seam is left open.
        slit_h = {'none': 0, 'left': 0.3, 'right': 0.3, 'both': 0.3}.get(slit, 0) * (top_z - hem_z) if slit != 'none' else 0
        p.edge('hem', hem)
        right_side = list(reversed(side))  # hem -> top on her left of this piece (u>0)
        # A slit is measured up from where the side seam really ends: the hem corner, which a flared hem lifts well
        # above the centre of the hem. Both parts of the split side keep at least two points (an open part of a
        # single point crashed the sewing, 2026-11-09, "The Restless Discovery").
        def split_at(run, along):
            """Index where `along` metres of seam have been walked from the start of run (kept off either end)."""
            acc = 0.0
            for i in range(1, len(run)):
                acc += math.dist(run[i - 1], run[i])
                if acc >= along: return i
            return len(run) - 2
        if slit_h:
            k = max(1, min(split_at(right_side, slit_h), len(right_side) - 2))
            p.edge('side_l_open', right_side[:k + 1]).edge('side_l', right_side[k:])
        else:
            p.edge('side_l', right_side)
        p.edge('waist', [side[0], mirror([side[0]])[0]])
        left = list(mirror(side))
        if slit_h:
            k = len(left) - split_at(list(reversed(left)), slit_h)  # the same distance up from the hem, on this side
            k = max(2, min(k, len(left) - 1))
            p.edge('side_r', left[:k]).edge('side_r_open', left[k - 1:])  # side_r ends where the open part starts
        else:
            p.edge('side_r', left)
        p.close()
        pieces.append(p)
    f, b = pieces
    want_l = slit in ('left', 'both'); want_r = slit in ('right', 'both')
    # Side seams: front's left meets back's right. Open parts of a slit stay unsewn.
    seams.append({'a': [f.id, 'side_l'], 'b': [b.id, 'side_r']})
    seams.append({'a': [f.id, 'side_r'], 'b': [b.id, 'side_l']})
    if not want_l and any(n == 'side_l_open' for n, _ in f.edges): seams.append({'a': [f.id, 'side_l_open'], 'b': [b.id, 'side_r_open']})
    if not want_r and any(n == 'side_r_open' for n, _ in f.edges): seams.append({'a': [f.id, 'side_r_open'], 'b': [b.id, 'side_l_open']})
    return pieces, seams

# ---- pants -----------------------------------------------------------------------------------------
def pants(body, g, gid, shorts=False, layer=0):
    L, C = body.L, body.C
    style = g.get('style', 'straight')
    if shorts: style = 'straight'
    need(style in PANTS_STYLES, f'pants style must be one of {", ".join(PANTS_STYLES)}')
    rise = g.get('rise', 'mid'); need(rise in RISES, f'rise must be one of {", ".join(RISES)}')
    fit = g.get('fit', 'fitted'); ease = FIT_EASE[fit] + (0.03 if style != 'skinny' else -0.01)
    if g.get('fabric') in STRETCH and style == 'skinny': ease -= 0.03
    waist_z = L['waist'] + RISES[rise] - 0.02
    crotch_z = L['crotch'] - 0.01
    if shorts:
        ln = g.get('length', 'short'); need(ln in SHORTS_LENGTHS, f'shorts length must be one of {", ".join(SHORTS_LENGTHS)}')
        hem_z = crotch_z - SHORTS_LENGTHS[ln]
    else:
        ln = g.get('length', 'ankle'); need(ln in PANTS_LENGTHS, f'pants length must be one of {", ".join(PANTS_LENGTHS)}')
        hem_z = L['knee'] - 0.02 if ln == 'knee' else L['ankle'] + PANTS_LENGTHS[ln] - 0.01
    hip_z = L['hip']
    pieces, seams = [], []
    knee_z = L['knee']
    def leg_w(z, front):
        # Half of the leg's girth on this side, plus ease, shaped by the style below the knee.
        g_ = body.leg_girth(min(z, crotch_z - 0.03))
        base = g_ * (1 + ease) * (0.47 if front else 0.53)
        if z < knee_z:
            k = (knee_z - z) / max(0.1, knee_z - L['ankle'])
            knee_half = body.leg_girth(knee_z) * (1 + ease + 0.06) * (0.48 if front else 0.52)
            if style == 'skinny': return max(base, body.C['ankle'] * 0.62 * (0.48 if front else 0.52) * 2)
            if style == 'straight': return knee_half
            if style == 'wide': return knee_half + 0.09 * k + 0.03
            if style == 'flared': return knee_half * (1 - 0.05) + 0.10 * k
        if style == 'wide': return max(base, body.leg_girth(z) * (1 + ease + 0.2) * (0.5))
        return base
    for side in ('left', 'right'):
        for front in (True, False):
            name = 'front' if front else 'back'
            a_side, a_centre = (90, 0) if front else (90, 180)
            # Torso part: the arc from her side to her centre line (one quarter of her), down to the crotch.
            zs_top = [round(waist_z - (waist_z - crotch_z) * i / 10, 4) for i in range(11)]
            upper = [(body.arc(z, a_centre, a_side, ease, 0.004 * layer), z) for z in zs_top]  # (width from centre to side, z)
            ext = C['hip'] * (0.055 if front else 0.10)
            back_rise = 0.0 if front else 0.03
            # Outline in (u = distance from the side seam toward the centre, v = z), CCW from outside for her left leg front.
            side_line = [(0, z) for z in [waist_z + back_rise] + [z for _, z in upper[1:]]]
            # leg below the crotch
            zs_leg = [round(crotch_z - (crotch_z - hem_z) * i / 10, 4) for i in range(11)]
            out_leg = [(0, z) for z in zs_leg]
            in_leg = [(leg_w(z, front), z) for z in zs_leg]  # this side's share of the leg's girth
            cw = upper[-1][0]
            crotch_pt = (max(cw + ext, in_leg[0][0]), crotch_z)
            centre_line = [(upper[0][0], waist_z + back_rise)] + [(w, z) for w, z in upper[1:-3]] + bezier((upper[-3][0], upper[-3][1]), (upper[-1][0], crotch_z + 0.01), crotch_pt, 6)
            p = Piece(f'{gid}.{name}_{side}', gid, f'leg_{side}', 0.0 if front else 180.0, side, layer, f'{style} {"shorts" if shorts else "pants"}')
            hem = [(in_leg[-1][0], hem_z), (0, hem_z)] if front else [(0, hem_z), (in_leg[-1][0], hem_z)]
            # Draft for one orientation and mirror so every piece is CCW seen from outside.
            outline = {
                'side': list(reversed(side_line[:-1])) + out_leg if False else [(0, waist_z + back_rise)] + [(0, z) for z in zs_top[1:]] + out_leg[1:],
                'hem': [(0, hem_z), (in_leg[-1][0], hem_z)],
                'inseam': [(w, z) for w, z in reversed(in_leg[1:])] + [crotch_pt],
                'centre': list(reversed(centre_line)),
                'waist': [(upper[0][0], waist_z + back_rise), (0, waist_z + back_rise)],
            }
            order = ['side', 'hem', 'inseam', 'centre', 'waist']
            # side goes top->bottom along u=0: that's clockwise if centre is +u. Flip u for the CCW pieces.
            flip = (front and side == 'left') or (not front and side == 'right')
            sign = -1 if flip else 1
            # Build CCW: with +u toward centre, CCW order is waist(rev) ... use: side(down), hem, inseam(up), centre(up), waist(across)
            pts = {k: [(sign * u, v) for u, v in vv] for k, vv in outline.items()}
            if sign < 0:
                p.edge('side', pts['side']).edge('hem', pts['hem']).edge('inseam', pts['inseam']).edge('centre', pts['centre']).edge('waist', pts['waist']).close()
            else:
                rev = lambda k: list(reversed(pts[k]))
                p.edge('waist', rev('waist')).edge('centre', rev('centre')).edge('inseam', rev('inseam')).edge('hem', rev('hem')).edge('side', rev('side')).close()
            pieces.append(p)
    by = {p.id.split('.', 1)[1]: p for p in pieces}
    for side in ('left', 'right'):
        seams.append({'a': [by[f'front_{side}'].id, 'side'], 'b': [by[f'back_{side}'].id, 'side']})
        seams.append({'a': [by[f'front_{side}'].id, 'inseam'], 'b': [by[f'back_{side}'].id, 'inseam']})
    seams.append({'a': [by['front_left'].id, 'centre'], 'b': [by['front_right'].id, 'centre']})
    seams.append({'a': [by['back_left'].id, 'centre'], 'b': [by['back_right'].id, 'centre']})
    return pieces, seams

# ---- a whole design ---------------------------------------------------------------------------------
def draft(design, body_json):
    body = Body(body_json)
    garments = design.get('garments') or ([design] if design.get('type') else [])
    need(garments, 'A design needs at least one garment (garments: [{type: ...}]).')
    need(len(garments) <= 4, 'Up to four garments in one outfit.')
    pieces, seams, info = [], [], []
    has = {g.get('type') for g in garments}
    need(not ('dress' in has and ('skirt' in has or 'pants' in has)), 'A dress already has its skirt: don\'t add a skirt or pants under it.')
    # Every outfit covers her chest and her hips (owner, 2026-11-09): a jacket is worn over something.
    need(has & {'top', 'dress'}, 'An outfit needs something covering her chest: a top or a dress (a jacket goes over one).')
    need(has & {'dress', 'skirt', 'pants', 'shorts'}, 'An outfit needs something covering her hips: a dress, a skirt, pants or shorts.')
    # Inner layers first: bottoms, then a top or dress over their waist, a jacket outermost. sew.py drapes in this order.
    order = {'pants': 0, 'shorts': 0, 'skirt': 0, 'top': 1, 'dress': 1, 'jacket': 2}
    garments = sorted(garments, key=lambda g: order.get(g.get('type'), 1))
    for layer, g in enumerate(garments):
        t = g.get('type'); need(t in TYPES, f'garment type must be one of {", ".join(TYPES)}')
        fab = g.get('fabric', 'cotton'); need(fab in FABRICS, f'fabric must be one of {", ".join(FABRICS)}')
        pat = g.get('pattern', 'solid'); need(pat in PATTERNS, f'pattern must be one of {", ".join(PATTERNS)}')
        fit = g.get('fit', 'fitted'); need(fit in FIT_EASE, f'fit must be one of {", ".join(FIT_EASE)}')
        gid = f'g{layer}'
        L = body.L
        if t in ('top', 'jacket'):
            ln = g.get('length', 'hip' if t == 'jacket' else 'waist'); need(ln in LENGTHS_TOP, f'top length must be one of {", ".join(LENGTHS_TOP)}')
            bottom = body.z(LENGTHS_TOP[ln]) - (0.02 if ln == 'crop' else 0)
            if t == 'jacket': g.setdefault('sleeves', 'long'); g.setdefault('fit', 'regular'); g.setdefault('neckline', 'v')
            ps, ss, arms, hems, ease = bodice(body, g, gid, bottom, open_front=(t == 'jacket'), layer=layer)
            sp, sss = sleeves(body, g, gid, arms, ease, layer)
            pieces += ps + sp; seams += ss + sss
        elif t == 'dress':
            g.setdefault('fit', 'fitted')
            ps, ss, arms, hems, ease = bodice(body, g, gid, L['waist'], layer=layer)
            sp, sss = sleeves(body, g, gid, arms, ease, layer)
            front, back = pieces_by(ps, '.front'), pieces_by(ps, '.back')
            attach = {'front': length(dict(front.edges)['hem']) / 2, 'back': length(dict(back.edges)['hem']) / 2}
            kp, ks = skirt(body, g, gid, L['waist'], attach, layer)
            pieces += ps + sp + kp; seams += ss + sss + ks
            seams.append({'a': [kp[0].id, 'waist'], 'b': [front.id, 'hem']})
            seams.append({'a': [kp[1].id, 'waist'], 'b': [back.id, 'hem']})
        elif t == 'skirt':
            top = L['waist'] + {'high': 0.03, 'natural': 0.0, 'low': -0.06}.get(g.get('waist', 'natural'), 0.0)
            kp, ks = skirt(body, g, gid, top, None, layer)
            pieces += kp; seams += ks
        elif t in ('pants', 'shorts'):
            pp, psm = pants(body, g, gid, shorts=(t == 'shorts'), layer=layer)
            pieces += pp; seams += psm
        info.append({'id': gid, 'type': t, 'fabric': fab, 'pattern': pat, 'color': g.get('color', '#20232a'), 'color2': g.get('color2'),
                     'shine': g.get('shine'), 'glow': g.get('glow'), 'fit': g.get('fit', 'fitted'), 'layer': layer})
    for s in seams:
        for k in ('a', 'b'):
            pid, e = s[k]
            p = next((p for p in pieces if p.id == pid), None)
            need(p and any(n == e for n, _ in p.edges), f'internal: seam names {pid}.{e}, which doesn\'t exist')
    # Every edge must be something a needle can follow: two points at least, and some length.
    for p in pieces:
        for n, pts in p.edges:
            need(len(pts) >= 2 and length(pts) > 0.002, f'internal: {p.id}.{n} is too short to sew ({len(pts)} point(s), {length(pts) * 100:.1f} cm); the pattern was cut wrong.')
    return {'unit': 'm', 'name': design.get('name', 'Untitled'), 'garments': info, 'pieces': [p.json() for p in pieces], 'seams': seams,
            'measurements': {k: round(v * 100, 1) for k, v in body.C.items()}}

def sheet(pattern, path):
    """A pattern sheet: every piece laid out flat with its edges and seam marks, like a paper pattern."""
    from PIL import Image, ImageDraw
    pcs = pattern['pieces']; scale = 260; pad = 24
    boxes = []
    for p in pcs:
        pts = [pt for e in p['edges'] for pt in e['pts']]
        xs, ys = [x for x, _ in pts], [y for _, y in pts]
        boxes.append((min(xs), max(xs), min(ys), max(ys)))
    x = pad; y = pad; row_h = 0; placed = []; W = 1600
    for (x0, x1, y0, y1) in boxes:
        w, h = (x1 - x0) * scale, (y1 - y0) * scale
        if x + w > W - pad: x = pad; y += row_h + pad; row_h = 0
        placed.append((x - x0 * scale, y + y1 * scale)); x += w + pad; row_h = max(row_h, h)
    H = int(y + row_h + pad)
    img = Image.new('RGB', (W, max(H, 200)), (246, 242, 232)); d = ImageDraw.Draw(img)
    sewn = {(s[k][0], s[k][1]) for s in pattern['seams'] for k in ('a', 'b')}
    for p, (ox, oy) in zip(pcs, placed):
        for e in p['edges']:
            pts = [(ox + u * scale, oy - v * scale) for u, v in e['pts']]
            d.line(pts, fill=(40, 40, 40) if (p['id'], e['id']) in sewn else (190, 60, 60), width=3 if (p['id'], e['id']) in sewn else 2)
        allp = [pt for e in p['edges'] for pt in e['pts']]
        cx = ox + sum(u for u, _ in allp) / len(allp) * scale; cy = oy - sum(v for _, v in allp) / len(allp) * scale
        d.text((cx - 30, cy), p['id'].split('.', 1)[1], fill=(30, 30, 120))
    img.save(path)

def vocabulary():
    return {'types': TYPES, 'fit': list(FIT_EASE), 'top_length': list(LENGTHS_TOP), 'neckline': NECKLINES, 'sleeves': list(SLEEVES),
            'sleeve_style': SLEEVE_STYLES, 'straps': STRAPS, 'skirt': list(SKIRT_STYLES), 'skirt_length': list(SKIRT_LENGTHS),
            'slit': ['none', 'left', 'right', 'both'], 'pants_style': PANTS_STYLES, 'pants_length': list(PANTS_LENGTHS),
            'shorts_length': list(SHORTS_LENGTHS), 'rise': list(RISES), 'fabric': FABRICS, 'pattern': PATTERNS}

if __name__ == '__main__' and sys.argv[1:2] == ['--vocabulary']:
    print(json.dumps(vocabulary())); sys.exit(0)

if __name__ == '__main__':
    design = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
    body = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8-sig'))
    try:
        pat = draft(design, body)
    except DesignError as err:
        print(json.dumps({'ok': False, 'error': str(err)})); sys.exit(2)
    out = pathlib.Path(sys.argv[3]); out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(pat))
    if len(sys.argv) > 4: sheet(pat, sys.argv[4])
    print(json.dumps({'ok': True, 'pieces': len(pat['pieces']), 'seams': len(pat['seams'])}))
