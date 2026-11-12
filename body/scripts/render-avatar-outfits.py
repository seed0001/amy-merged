import bpy,math,pathlib,sys
from mathutils import Vector,Matrix
root=pathlib.Path(__file__).resolve().parents[1]
outfits=[arg.split('=',1)[1] for arg in sys.argv if arg.startswith('outfit=')]
for outfit in (outfits or (['dress','dress-pleated','dress-wrap'] if 'dresses' in sys.argv else ['dress','swimsuit'])):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(root/'data/outfits'/(outfit+'.glb')))
    if 'posed' in sys.argv:
        rig=next(obj for obj in bpy.context.scene.objects if obj.type=='ARMATURE')
        for arm,fore,hand in [('LeftArm','LeftForeArm','LeftHand'),('RightArm','RightForeArm','RightHand')]:
            bpy.context.view_layer.update()
            out=1 if rig.pose.bones[fore].head.x-rig.pose.bones[arm].head.x>0 else -1
            for name,child,target in [(arm,fore,(.16*out,-.05,-1)),(fore,hand,(.1*out,-.22,-1))]:
                bpy.context.view_layer.update();bone=rig.pose.bones[name];head=bone.head.copy();direction=(rig.pose.bones[child].head-head).normalized()
                q=direction.rotation_difference(Vector(target).normalized())
                bone.matrix=Matrix.Translation(head)@q.to_matrix().to_4x4()@Matrix.Translation(-head)@bone.matrix
        bpy.context.view_layer.update()
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=24
    scene.render.resolution_x=700;scene.render.resolution_y=900;scene.render.resolution_percentage=100
    scene.world=bpy.data.worlds.new('Studio');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.35,.35,.35,1)
    for pos,power,size in [((-2,-3,4),450,4),((2,-1,2),250,3),((0,2,3),400,3)]:
        light=bpy.data.lights.new('Softbox','AREA');light.energy=power;light.shape='DISK';light.size=size
        obj=bpy.data.objects.new('Softbox',light);scene.collection.objects.link(obj);obj.location=pos;obj.rotation_euler=(Vector((0,0,1))-obj.location).to_track_quat('-Z','Y').to_euler()
    bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.012));floor=bpy.context.object
    material=bpy.data.materials.new('Floor');material.diffuse_color=(.2,.22,.25,1);floor.data.materials.append(material)
    camera=bpy.data.cameras.new('Camera');obj=bpy.data.objects.new('Camera',camera);scene.collection.objects.link(obj);scene.camera=obj
    camera.type='ORTHO';camera.ortho_scale=2.2
    for side,pos in [('front',(0,-4,1.0)),('back',(0,4,1.0))]:
        obj.location=pos;obj.rotation_euler=(Vector((0,0,.92))-obj.location).to_track_quat('-Z','Y').to_euler()
        suffix='-posed' if 'posed' in sys.argv else ''
        scene.render.filepath=str(root/'data/outfits'/(outfit+'-'+side+suffix+'.png'));bpy.ops.render.render(write_still=True)
