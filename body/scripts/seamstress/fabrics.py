"""Fabrics: how each one hangs (cloth physics) and how it looks (material, weave, print). Used by sew.py.

Physics values follow Blender's cloth presets (cotton, denim, leather, silk, rubber) and sit between them for
the rest: mass in kg per square metre, stiffness for stretch (tension/compression), shear and bending.
Prints are drawn as tileable images at real scale (tile() metres per repeat), so a stripe is the same width
on a sleeve as on a skirt, and the grain follows each pattern piece the way it was cut.
"""
import bpy, math, pathlib
import numpy as np

PHYSICS = {
    #            mass  stretch shear  bend   air  thickness (m)
    'jersey':  dict(mass=0.22, tension=6,  shear=5,  bending=0.15, air=1.0, thickness=0.0010, stretchy=True),
    'knit':    dict(mass=0.35, tension=5,  shear=4,  bending=0.4,  air=1.0, thickness=0.0022, stretchy=True),
    'cotton':  dict(mass=0.30, tension=15, shear=15, bending=0.5,  air=1.0, thickness=0.0010, stretchy=False),
    'linen':   dict(mass=0.32, tension=20, shear=18, bending=1.2,  air=1.0, thickness=0.0011, stretchy=False),
    'silk':    dict(mass=0.15, tension=5,  shear=5,  bending=0.05, air=1.0, thickness=0.0006, stretchy=False),
    'satin':   dict(mass=0.20, tension=8,  shear=8,  bending=0.1,  air=1.0, thickness=0.0007, stretchy=False),
    'chiffon': dict(mass=0.08, tension=4,  shear=3,  bending=0.02, air=2.0, thickness=0.0004, stretchy=False),
    'denim':   dict(mass=0.80, tension=40, shear=40, bending=10,   air=1.0, thickness=0.0016, stretchy=False),
    'leather': dict(mass=0.45, tension=80, shear=80, bending=60,   air=1.0, thickness=0.0018, stretchy=False),
    'latex':   dict(mass=0.60, tension=12, shear=12, bending=4,    air=1.0, thickness=0.0008, stretchy=True),
    'velvet':  dict(mass=0.45, tension=15, shear=14, bending=2.0,  air=1.0, thickness=0.0020, stretchy=False),
    'wool':    dict(mass=0.55, tension=25, shear=22, bending=5.0,  air=1.0, thickness=0.0022, stretchy=False),
    'lace':    dict(mass=0.12, tension=5,  shear=4,  bending=0.05, air=1.5, thickness=0.0006, stretchy=True),
    'mesh':    dict(mass=0.10, tension=4,  shear=3,  bending=0.04, air=1.5, thickness=0.0005, stretchy=True),
}
LOOK = {
    #            roughness sheen coat  alpha  specular
    'jersey':  dict(rough=0.85, sheen=0.15, coat=0.0, alpha=1.0, weave='knit'),
    'knit':    dict(rough=0.9,  sheen=0.3,  coat=0.0, alpha=1.0, weave='knit'),
    'cotton':  dict(rough=0.8,  sheen=0.1,  coat=0.0, alpha=1.0, weave='plain'),
    'linen':   dict(rough=0.85, sheen=0.05, coat=0.0, alpha=1.0, weave='plain'),
    'silk':    dict(rough=0.42, sheen=0.35, coat=0.0, alpha=1.0, weave=None),
    'satin':   dict(rough=0.5,  sheen=0.3,  coat=0.0, alpha=1.0, weave=None),
    'chiffon': dict(rough=0.5,  sheen=0.3,  coat=0.0, alpha=0.55, weave=None),
    'denim':   dict(rough=0.9,  sheen=0.0,  coat=0.0, alpha=1.0, weave='twill'),
    'leather': dict(rough=0.42, sheen=0.0,  coat=0.15, alpha=1.0, weave='grain'),
    'latex':   dict(rough=0.08, sheen=0.0,  coat=0.9, alpha=1.0, weave=None),
    'velvet':  dict(rough=0.95, sheen=1.0,  coat=0.0, alpha=1.0, weave=None),
    'wool':    dict(rough=0.95, sheen=0.2,  coat=0.0, alpha=1.0, weave='twill'),
    'lace':    dict(rough=0.7,  sheen=0.1,  coat=0.0, alpha=1.0, weave=None, cutout='lace'),
    'mesh':    dict(rough=0.6,  sheen=0.0,  coat=0.0, alpha=1.0, weave=None, cutout='mesh'),
}

def tile(g):
    """Metres of fabric per repeat of its print (and of the texture)."""
    return {'pinstripe': 0.06, 'stripes': 0.12, 'gingham': 0.05, 'plaid': 0.16, 'polka': 0.08, 'houndstooth': 0.04, 'chevron': 0.10, 'gradient': 1.6}.get(g.get('pattern', 'solid'), 0.2)

def apply_physics(cs, g, fabrics_used):
    p = PHYSICS[g['fabric']]
    cs.mass = p['mass']
    cs.tension_stiffness = cs.compression_stiffness = p['tension']
    cs.shear_stiffness = p['shear']
    cs.bending_stiffness = p['bending']
    cs.air_damping = p['air']
    cs.tension_damping = cs.compression_damping = cs.shear_damping = 5
    cs.bending_damping = 0.5
    # Stretch fabrics cut with negative ease hug her: let them stretch a little more freely.
    if all(PHYSICS[f]['stretchy'] for f in fabrics_used):
        cs.tension_stiffness = cs.compression_stiffness = p['tension'] * 0.6

def hex_rgb(h, default=(0.12, 0.13, 0.16)):
    try:
        h = str(h).lstrip('#')
        if len(h) == 3: h = ''.join(c * 2 for c in h)
        rgb = tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
        return tuple(c ** 2.2 for c in rgb)  # sRGB -> linear for the shader
    except Exception:
        return default

def _print(kind, size=512):
    """A tileable mask (0..1) for the print: 1 = second colour."""
    y, x = np.mgrid[0:size, 0:size] / size
    if kind == 'stripes': return (((y * 2) % 1) < 0.5).astype(float)
    if kind == 'pinstripe': return (((y * 6) % 1) < 0.06).astype(float)
    if kind == 'gingham':
        a = ((x * 2) % 1) < 0.5; b = ((y * 2) % 1) < 0.5
        return (a.astype(float) + b.astype(float)) / 2
    if kind == 'plaid':
        bands = lambda t: np.maximum(((t * 2) % 1 < 0.22).astype(float), 0.6 * (((t * 2 + 0.37) % 1) < 0.06))
        return np.clip(0.55 * bands(x) + 0.55 * bands(y), 0, 1)
    if kind == 'polka':
        d = np.minimum(np.hypot((x * 3) % 1 - 0.5, (y * 3) % 1 - 0.5), np.hypot(((x * 3) + 0.5) % 1 - 0.5, ((y * 3) + 0.5) % 1 - 0.5))
        return (d < 0.17).astype(float)
    if kind == 'houndstooth':
        gx, gy = (x * 4) % 1, (y * 4) % 1
        check = ((np.floor(x * 4) + np.floor(y * 4)) % 2 == 0)
        tooth = (gx + gy < 0.6) & (gx > 0.25)
        return np.where(check, 1.0, tooth.astype(float))
    if kind == 'chevron':
        return ((((y * 3) + np.abs((x * 3) % 1 - 0.5)) % 1) < 0.45).astype(float)
    if kind == 'gradient': return np.repeat(np.linspace(0, 1, size)[:, None], size, 1)
    return np.zeros((size, size))

def _weave(kind, size=512):
    """A height field for the fabric's weave, turned into a normal map."""
    y, x = np.mgrid[0:size, 0:size] / size * 2 * math.pi
    if kind == 'twill': h = np.sin((x + y) * 32) * 0.6 + np.sin(x * 64) * 0.2
    elif kind == 'knit': h = np.abs(np.sin(x * 24)) * np.cos(y * 48) * 0.7
    elif kind == 'plain': h = np.sin(x * 48) * np.sin(y * 48) * 0.5
    elif kind == 'grain': h = np.sin(x * 37 + np.sin(y * 13) * 2) * np.sin(y * 29 + np.sin(x * 11) * 2) * 0.5
    else: return None
    gy, gx = np.gradient(h)
    n = np.dstack([-gx * 2, -gy * 2, np.ones_like(h)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return n * 0.5 + 0.5

def _cutout(kind, size=512):
    y, x = np.mgrid[0:size, 0:size] / size
    if kind == 'mesh':
        return (np.hypot((x * 24) % 1 - 0.5, (y * 24) % 1 - 0.5) > 0.32).astype(float)
    if kind == 'lace':
        petals = np.hypot((x * 6) % 1 - 0.5, (y * 6) % 1 - 0.5)
        ring = np.abs(petals - 0.28) < 0.07
        net = np.hypot((x * 30) % 1 - 0.5, (y * 30) % 1 - 0.5) > 0.36
        flower = petals < 0.12
        return np.clip(ring + flower + net * 0.0 + ((x * 30 % 1 < 0.12) | (y * 30 % 1 < 0.12)), 0, 1).astype(float)
    return None

def _image(name, rgba):
    h, w = rgba.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=True)
    img.pixels.foreach_set(np.ascontiguousarray(rgba, dtype=np.float32).ravel())
    img.pack()
    return img

def material(g, out_dir):
    look = LOOK[g['fabric']]
    mat = bpy.data.materials.new(f'Fabric_{g["id"]}_{g["fabric"]}')
    mat.use_nodes = True
    nt = mat.node_tree; bsdf = nt.nodes['Principled BSDF']
    c1 = hex_rgb(g.get('color', '#20232a'))
    # Without a second colour, a print is drawn in a deeper shade of her colour (a gradient that fades to white
    # turned a blue tunic white).
    c2 = hex_rgb(g['color2']) if g.get('color2') else tuple(c * 0.25 for c in c1)
    kind = g.get('pattern', 'solid')
    tex_coord = nt.nodes.new('ShaderNodeUVMap'); tex_coord.uv_map = 'UVMap'
    alpha_map = _cutout(look.get('cutout'))
    if kind != 'solid' or alpha_map is not None:
        m = _print(kind)
        rgb = (1 - m[..., None]) * np.array(c1) + m[..., None] * np.array(c2)
        a = alpha_map if alpha_map is not None else np.ones(m.shape)
        rgba = np.dstack([rgb ** (1 / 2.2), a])  # stored as sRGB
        img = _image(f'print_{g["id"]}', rgba)
        tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img
        nt.links.new(tex_coord.outputs['UV'], tex.inputs['Vector'])
        nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
        if alpha_map is not None: nt.links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
    else:
        bsdf.inputs['Base Color'].default_value = (*c1, 1)
    bsdf.inputs['Roughness'].default_value = look['rough']
    # Cloth reflects far less than the default hard-surface specular (which made everything look like vinyl):
    # matte weaves barely at all, satin and leather some, latex a lot.
    SPEC = {'latex': 0.6, 'leather': 0.35, 'satin': 0.35, 'silk': 0.3, 'velvet': 0.1, 'chiffon': 0.25}
    bsdf.inputs['Specular IOR Level'].default_value = SPEC.get(g['fabric'], 0.12)
    if look['sheen']:
        bsdf.inputs['Sheen Weight'].default_value = look['sheen']
        # Sheen in the fabric's own colour, a little lighter: velvet and satin glow in their colour, not white.
        bsdf.inputs['Sheen Tint'].default_value = (*[min(1, c * 1.5 + 0.03) for c in c1], 1)
    if look['coat']: bsdf.inputs['Coat Weight'].default_value = look['coat']
    if look['alpha'] < 1: bsdf.inputs['Alpha'].default_value = look['alpha']
    if look['alpha'] < 1 or alpha_map is not None:
        try: mat.surface_render_method = 'BLENDED'
        except Exception: pass
    weave = _weave(look.get('weave'))
    if weave is not None:
        nimg = _image(f'weave_{g["id"]}', np.dstack([weave, np.ones(weave.shape[:2])]))
        nimg.colorspace_settings.name = 'Non-Color'
        ntex = nt.nodes.new('ShaderNodeTexImage'); ntex.image = nimg
        mapping = nt.nodes.new('ShaderNodeMapping'); mapping.inputs['Scale'].default_value = (tile(g) / 0.05,) * 3
        nt.links.new(tex_coord.outputs['UV'], mapping.inputs['Vector']); nt.links.new(mapping.outputs['Vector'], ntex.inputs['Vector'])
        nmap = nt.nodes.new('ShaderNodeNormalMap'); nmap.inputs['Strength'].default_value = 0.6
        nt.links.new(ntex.outputs['Color'], nmap.inputs['Color']); nt.links.new(nmap.outputs['Normal'], bsdf.inputs['Normal'])
    if g.get('glow'):
        # The glow lights the print's lines only (its second colour), like glowing thread; on a plain fabric it's
        # a faint sheen. Lighting the whole garment washed it out to white (2026-11-09, "The Restless Discovery").
        bsdf.inputs['Emission Color'].default_value = (*hex_rgb(g['glow']), 1)
        if kind != 'solid' and kind != 'gradient':
            m = _print(kind)
            mimg = _image(f'glowmask_{g["id"]}', np.dstack([m, m, m, np.ones(m.shape)]))
            mimg.colorspace_settings.name = 'Non-Color'
            mtex = nt.nodes.new('ShaderNodeTexImage'); mtex.image = mimg
            nt.links.new(tex_coord.outputs['UV'], mtex.inputs['Vector'])
            mul = nt.nodes.new('ShaderNodeMath'); mul.operation = 'MULTIPLY'; mul.inputs[1].default_value = 1.5
            nt.links.new(mtex.outputs['Color'], mul.inputs[0]); nt.links.new(mul.outputs['Value'], bsdf.inputs['Emission Strength'])
        else:
            bsdf.inputs['Emission Strength'].default_value = 0.08
    mat.use_backface_culling = False
    return mat

def skin_material(skin):
    return skin.data.materials[0] if skin.data.materials else bpy.data.materials.new('Skin')
