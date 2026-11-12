"""Convert a Microsoft Rocketbox avatar (its _facial FBX) into a GLB the avatar studio can wear.

  blender -b --factory-startup --python scripts/rocketbox-to-glb.py -- <Avatar_facial.fbx> <out.glb> [dance.fbx ...]

Optional dance FBXs (Microsoft-Rocketbox/Assets/Animations/all_animations_max_motextr_static/m_dancing_*.max.fbx,
motion capture recorded in place on the same skeleton) are baked in as clips named dance_<style> (dance_cool...),
renamed to the same bones. Only the body dances: face, eye and jaw bones are left to the studio (lip sync, gaze),
and the armature object itself never moves. The studio plays them to the music (dashboard/public/avatar-dance.js).

Matches the Rocketbox GLBs already in data/rocketbox_*:
- Face shapes get the names the studio animates: AA_VI_00_Sil -> viseme_sil (lip sync, standard viseme names),
  AK_01_BrowDownLeft -> browDownLeft (ARKit). The FACS (AU_), Headbox (HB_) and Vive (SR_) shapes keep their names.
- Bones get the humanoid (Mixamo) names the studio drives: Hips, Spine.., Left/RightEye (eyeballs turn),
  LeftHandThumb1..3 / Index / Middle / Ring / Pinky (hand gestures), LeftUpLeg.., LeftToeBase. Every joint is kept.
  Face bones (jaw, lips, brows) keep their Rocketbox names; the face shapes move them.
- Materials: body and head -> wardrobe_fabric_<name> (recolourable clothing), the hair/opacity one ->
  Hair_Material_<name>, alpha-blended. Textures are embedded (PNG), so the GLB is self-contained.
Prints a summary line; exits non-zero with why if something it needs isn't in the FBX.
"""
import bpy, re, sys

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if len(args) < 2:
    print('usage: blender -b --factory-startup --python rocketbox-to-glb.py -- <Avatar_facial.fbx> <out.glb> [dance.fbx ...]'); sys.exit(2)
SRC, OUT, DANCES = args[0], args[1], args[2:]

# The studio (dashboard/public/avatar*.js) drives bones by these humanoid (Mixamo) names: Hips and the spine for
# body motion and dance, LeftEye/RightEye to turn the eyeballs (gaze, saccades, tears), every finger joint for
# hand gestures (avatar-hands.js). Face bones (jaw, lips, brows) keep their Rocketbox names; the face shapes move them.
BODY = {'Pelvis': 'Hips', 'Spine': 'Spine', 'Spine1': 'Spine1', 'Spine2': 'Spine2', 'Neck': 'Neck', 'Head': 'Head'}
SIDE = {'Clavicle': 'Shoulder', 'UpperArm': 'Arm', 'Forearm': 'ForeArm', 'Hand': 'Hand', 'Thigh': 'UpLeg', 'Calf': 'Leg', 'Foot': 'Foot',
        'Toe0': 'ToeBase', 'Eye': 'Eye'}
FINGER = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']  # Rocketbox Finger0..4; joints Finger<n>, Finger<n>1, Finger<n>2
# Lip-sync shapes use the standard (Oculus) viseme names the studio asks for.
VISEME = {'Sil': 'sil', 'KK': 'kk'}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=SRC)
arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
if not arm or not meshes:
    print(f'FAILED: {SRC} has no armature or no mesh; is it a Rocketbox avatar FBX?'); sys.exit(3)
if not any(o.data.shape_keys for o in meshes):
    print(f'FAILED: {SRC} has no face shapes; use the _facial.fbx export of the avatar.'); sys.exit(3)

# 0. Textures: the FBX points at the artist's own drive (D:\temp\Humans\...). The same files ship beside it in
#    <avatar>/Textures, so each image is re-linked there by file name and named after it.
import os
TEX = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(SRC)), '..', 'Textures'))
missing = []
for img in bpy.data.images:
    if img.source != 'FILE' or not img.filepath:
        continue
    base = re.split(r'[\\/]', img.filepath)[-1]
    local = os.path.join(TEX, base)
    if os.path.exists(local):
        img.filepath = local
        img.name = os.path.splitext(base)[0]
        img.reload()
    else:
        missing.append(base)
if missing:
    print(f'FAILED: textures not found in {TEX}: {", ".join(sorted(set(missing)))}. The avatar would come out untextured.'); sys.exit(3)

# 0b. Dances: each FBX brings its own copy of the skeleton with the motion on it. The motion (an action keyed by
#     the same Bip01 bone names) is kept and renamed dance_<style>; the extra skeleton is deleted. Face, eye and jaw
#     bones (Bip01 L/R/M followed directly by a name, like Bip01 LEye or Bip01 MJaw) and the object's own keys
#     are dropped, so the studio keeps his face and he dances on the spot.
FACE = re.compile(r'pose\.bones\["Bip01 [LRM][A-Z]')
def fcurve_lists(act):
    lists = [act.fcurves] if hasattr(act, 'fcurves') else []
    for layer in getattr(act, 'layers', []):
        for strip in layer.strips:
            for bag in getattr(strip, 'channelbags', []):
                lists.append(bag.fcurves)
    return lists
dances = []
for path in DANCES:
    objs_before, acts_before = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=path)
    new_objs = [o for o in bpy.data.objects if o not in objs_before]
    new_acts = [a for a in bpy.data.actions if a not in acts_before]
    # The skeleton's motion is the big one (hundreds of curves; the footstep and helper tracks have a handful).
    # Its name says Bip01.001 or so, since his own skeleton is already Bip01.
    body = max(new_acts, key=lambda a: sum(len(fcs) for fcs in fcurve_lists(a)), default=None)
    if not body or sum(len(fcs) for fcs in fcurve_lists(body)) < 50:
        print(f'FAILED: {path} has no Bip01 motion in it; is it a Rocketbox animation FBX?'); sys.exit(3)
    style = re.sub(r'^[mf]_dancing_', '', os.path.basename(path).split('.')[0])
    body.name = f'dance_{style}'
    body.use_fake_user = True
    for fcs in fcurve_lists(body):
        for fc in [fc for fc in fcs if FACE.search(fc.data_path) or not fc.data_path.startswith('pose.bones')]:
            fcs.remove(fc)
    for o in new_objs:
        bpy.data.objects.remove(o, do_unlink=True)
    for a in new_acts:
        if a is not body:
            bpy.data.actions.remove(a)
    dances.append(body)

# 1. Bones to humanoid names (Blender renames the matching vertex groups and animation paths with them).
def humanoid(name):
    m = re.match(r'^Bip01 (Pelvis|Spine\d?|Neck|Head)$', name)
    if m: return BODY[m.group(1)]
    s = re.match(r'^Bip01 ([LR]) ?(Clavicle|UpperArm|Forearm|Hand|Thigh|Calf|Foot|Toe0)$', name)
    if s: return ('Left' if s.group(1) == 'L' else 'Right') + SIDE[s.group(2)]
    e = re.match(r'^Bip01 ([LR])Eye$', name)
    if e: return ('Left' if e.group(1) == 'L' else 'Right') + 'Eye'
    f = re.match(r'^Bip01 ([LR]) Finger(\d)(\d?)$', name)
    if f: return ('Left' if f.group(1) == 'L' else 'Right') + 'Hand' + FINGER[int(f.group(2))] + str(int(f.group(3) or 0) + 1)
    return None
renamed = 0
moved = {}
for bone in arm.data.bones:
    new = humanoid(bone.name)
    if new:
        moved[bone.name] = new
        bone.name = new; renamed += 1
# Blender follows a bone rename only in the action the armature is wearing; the dances are renamed by hand.
for act in dances:
    for fcs in fcurve_lists(act):
        for fc in fcs:
            m = re.match(r'^pose\.bones\["([^"]+)"\](.*)$', fc.data_path)
            if m and m.group(1) in moved:
                fc.data_path = f'pose.bones["{moved[m.group(1)]}"]{m.group(2)}'
# Each dance is worn once so it's bound to this armature, then the base pose goes back on.
if dances:
    arm.animation_data_create()
    base = arm.animation_data.action
    for act in dances:
        arm.animation_data.action = act
    arm.animation_data.action = base
needed = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftEye', 'RightEye'] + \
         [f'{s}{p}' for s in ('Left', 'Right') for p in ('Shoulder', 'Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'ToeBase')] + \
         [f'{s}Hand{f}{j}' for s in ('Left', 'Right') for f in FINGER for j in (1, 2, 3)]
absent = [n for n in needed if n not in arm.data.bones]
if absent:
    print(f'FAILED: the studio needs these bones and the rig has none by that name after renaming: {", ".join(absent)}.'); sys.exit(3)

# 2. Face shapes to the names the studio drives.
def shape_name(n):
    v = re.match(r'^AA_VI_\d+_(.+)$', n)
    if v: return 'viseme_' + VISEME.get(v.group(1), v.group(1))
    k = re.match(r'^AK_\d+_(.+)$', n)
    if k: return k.group(1)[0].lower() + k.group(1)[1:]
    return n
shapes = 0
for o in meshes:
    if o.data.shape_keys:
        for kb in o.data.shape_keys.key_blocks:
            if kb.name != 'Basis':
                kb.name = shape_name(kb.name); shapes += 1

# 3. Materials: clothing the studio can recolour, hair blended, every surface double-sided.
for o in meshes:
    for mat in o.data.materials:
        if not mat:
            continue
        hair = 'opacity' in mat.name.lower()
        mat.name = ('Hair_Material_' if hair else 'wardrobe_fabric_') + mat.name
        mat.use_backface_culling = False
        if hair:
            if hasattr(mat, 'surface_render_method'): mat.surface_render_method = 'BLENDED'
            if hasattr(mat, 'blend_method'): mat.blend_method = 'BLEND'

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_morph=True, export_skins=True,
                          export_animations=True, export_animation_mode='ACTIONS', export_image_format='AUTO', export_yup=True)
print(f'DONE {OUT}: {len(arm.data.bones)} bones ({renamed} renamed to studio names), {shapes} face shapes, '
      f'{sum(len(o.data.materials) for o in meshes)} materials, dances: {", ".join(a.name for a in dances) or "none"}')
