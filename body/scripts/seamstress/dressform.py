"""The dress form: her whole body to sew on, in Blender.

Her avatar file (data/avatar.glb) only carries the skin that shows (hands, feet, neck); Avaturn strips the rest.
The dress form is Avaturn's own female body (data/seamstress/avaturn-female-body.glb, their public authoring
template): the same 54-bone skeleton as hers to the millimetre, a closed surface, and her shape (her visible
skin sits within 2 mm of it). Its skin weights carry over to every garment sewn on it.

Imported by measure.py and sew.py (run inside Blender). Run alone to render it:
  blender -b --factory-startup --python dressform.py -- data/avatar.glb out.png
"""
import bpy, bmesh, math, pathlib, sys
from mathutils import Vector

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent.parent
BODY = ROOT / 'data' / 'seamstress' / 'avaturn-female-body.glb'

def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    return [o for o in bpy.data.objects if o not in before]

def load_avatar(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    objs = import_glb(path)
    rig = next(o for o in objs if o.type == 'ARMATURE')
    rig.name = 'Rig'
    return rig, objs

def bind(o, rig):
    o.parent = rig
    mod = o.modifiers.new('Armature', 'ARMATURE'); mod.object = rig
    return o

def dress_form(rig):
    """Her full body, welded, in world space, with the template's skin weights, bound to her rig."""
    if not BODY.exists():
        raise SystemExit(f'The dress form body is missing: {BODY}. It is Avaturn\'s public female body (assets.avaturn.me/docs/custom_assets/avatars/Avaturn-female-avatar.glb).')
    objs = import_glb(BODY)
    body = next(o for o in objs if o.type == 'MESH' and o.name.startswith('model'))
    me = body.data.copy(); me.transform(body.matrix_world)
    form = bpy.data.objects.new('Skin', me)
    bpy.context.scene.collection.objects.link(form)
    for g in body.vertex_groups: form.vertex_groups.new(name=g.name)
    for v in body.data.vertices:
        for ge in v.groups: form.vertex_groups[body.vertex_groups[ge.group].name].add([v.index], ge.weight, 'REPLACE')
    for o in objs: bpy.data.objects.remove(o, do_unlink=True)
    bm = bmesh.new(); bm.from_mesh(form.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0002)
    bm.to_mesh(form.data); bm.free()
    for p in form.data.polygons: p.use_smooth = True
    bind(form, rig)
    return form

def front_sign():
    """-1 if she faces -Y (Blender's usual glTF import), else +1: from where her eyes sit against her head."""
    eye, head = bpy.data.objects.get('Eye_Mesh'), bpy.data.objects.get('Head_Mesh')
    ey = sum((eye.matrix_world @ v.co).y for v in eye.data.vertices) / len(eye.data.vertices)
    hy = sum((head.matrix_world @ v.co).y for v in head.data.vertices) / len(head.data.vertices)
    return -1 if ey < hy else 1

def bone_head(rig, name): return rig.matrix_world @ rig.data.bones[name].head_local
def bone_tail(rig, name): return rig.matrix_world @ rig.data.bones[name].tail_local

def setup_render(size=(640, 960)):
    scene = bpy.context.scene
    # Path-traced (Cycles, denoised): real contact shadows and soft light in the folds, so she judges the
    # garment by how it would really look, not by a flat preview that makes any fabric read as plastic.
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.render.resolution_x, scene.render.resolution_y = size
    # Show colours as they are: the default view transform lifts and washes them (burgundy came out pink).
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    world = scene.world or bpy.data.worlds.new('W'); scene.world = world
    world.use_nodes = True; bg = world.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.13, 0.14, 0.17, 1); bg.inputs[1].default_value = 0.6
    s = front_sign()
    for loc, energy in (((2.5, 4 * s, 3.2), 750), ((-3, 2.5 * s, 2), 320), ((0, -4 * s, 3), 450)):
        l = bpy.data.objects.new('Light', bpy.data.lights.new('Light', 'AREA')); l.data.energy = energy; l.data.size = 3
        l.location = loc; scene.collection.objects.link(l)
        l.rotation_euler = (Vector((0, 0, 1)) - l.location).to_track_quat('-Z', 'Y').to_euler()

def render(path, show, view='front', zrange=None, size=(640, 960)):
    scene = bpy.context.scene
    for o in scene.objects:
        if o.type == 'MESH': o.hide_render = o not in show
    deps = bpy.context.evaluated_depsgraph_get()
    zs = [(o.matrix_world @ v.co).z for o in show for v in o.evaluated_get(deps).to_mesh().vertices]
    lo, hi = zrange or (min(zs), max(zs))
    cam = bpy.data.objects.get('PreviewCam')
    if not cam:
        cam = bpy.data.objects.new('PreviewCam', bpy.data.cameras.new('PreviewCam')); scene.collection.objects.link(cam)
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = (hi - lo) * 1.1
    mid, s = (lo + hi) / 2, front_sign()
    # The camera sits on the side she faces (front), behind her (back), or to her left (side).
    direction = {'front': Vector((0, s, 0)), 'back': Vector((0, -s, 0)), 'side': Vector((1, 0, 0))}[view]
    cam.location = Vector((0, 0, mid)) + direction * 6
    cam.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()  # look at her, head up
    scene.camera = cam
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)

if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:]
    rig, objs = load_avatar(args[0])
    form = dress_form(rig)
    setup_render()
    keep = [form] + [o for o in objs if o.type == 'MESH' and o.name.split('.')[0] in ('Head_Mesh', 'Eye_Mesh', 'Eyelash_Mesh', 'avaturn_hair_0', 'avaturn_hair_1')]
    render(pathlib.Path(args[1]), keep, 'front')
    print('RENDERED', args[1], 'faces', len(form.data.polygons), 'front', front_sign())
