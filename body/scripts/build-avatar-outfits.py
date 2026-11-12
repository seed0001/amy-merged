"""Create fitted clothing variants without re-exporting or changing the avatar's face/rig.
All geometry is original, generated from this avatar's own body surface and skin weights.
Body connectivity source: https://assets.avaturn.me/docs/custom_assets/avatars/Avaturn-female-avatar.glb
Authoring guide: https://docs.avaturn.me/docs/ux_customization/assets/intro/
Run: python scripts/build-avatar-outfits.py data/avatar.glb PATH_TO_TEMPLATE.glb
Then: node scripts/install-avatar-outfits.mjs
"""
import copy, hashlib, json, math, pathlib, struct, sys, io
from PIL import Image
import numpy as np
from scipy.spatial import cKDTree

ROOT=pathlib.Path(__file__).resolve().parents[1]
SOURCE=pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'data/avatar.glb'
OUT=ROOT/'data/outfits'
raw=SOURCE.read_bytes(); json_size=struct.unpack_from('<I',raw,12)[0]
original=json.loads(raw[20:20+json_size]); binary=raw[28+json_size:]
components={5121:('B',1),5123:('H',2),5125:('I',4),5126:('f',4)}
sizes={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}

def read_accessor(index):
    a=original['accessors'][index];v=original['bufferViews'][a['bufferView']]
    code,size=components[a['componentType']];n=sizes[a['type']]
    start=v.get('byteOffset',0)+a.get('byteOffset',0);stride=v.get('byteStride',n*size)
    return [struct.unpack_from('<'+code*n,binary,start+i*stride) for i in range(a['count'])]

body_node=next(n for n in original['nodes'] if n.get('name')=='Body_Mesh')
primitive=original['meshes'][body_node['mesh']]['primitives'][0]
attributes={key:read_accessor(index) for key,index in primitive['attributes'].items()}
triangles=[x[0] for x in read_accessor(primitive['indices'])]

# Suit exports retain the complete body vertices but omit covered triangles. Recover
# their connectivity from Avaturn's public female authoring template, snapping its
# topology to this avatar's own positions, UVs and skin weights.
if len(sys.argv)<3:raise SystemExit('Pass the public Avaturn female template GLB as the second argument.')
donor_raw=pathlib.Path(sys.argv[2]).read_bytes();donor_n=struct.unpack_from('<I',donor_raw,12)[0]
donor=json.loads(donor_raw[20:20+donor_n]);donor_bin=donor_raw[28+donor_n:]
def donor_accessor(index):
    a=donor['accessors'][index];v=donor['bufferViews'][a['bufferView']];code,size=components[a['componentType']];n=sizes[a['type']]
    return [struct.unpack_from('<'+code*n,donor_bin,v.get('byteOffset',0)+a.get('byteOffset',0)+i*v.get('byteStride',n*size)) for i in range(a['count'])]
dp=donor['meshes'][0]['primitives'][0];donor_positions=np.array(donor_accessor(dp['attributes']['POSITION']))
dist,mapping=cKDTree(np.array(attributes['POSITION'])).query(donor_positions)
recovered=set()
for t in np.array(donor_accessor(dp['indices'])).reshape(-1,3):
    if max(donor_positions[t,1])>1.565 or max(dist[t])>.045:continue
    mapped=[int(mapping[x]) for x in t]
    if len(set(mapped))<3:continue
    positions=[np.array(attributes['POSITION'][i]) for i in mapped]
    if max(np.linalg.norm(a-b) for a,b in zip(positions,positions[1:]+positions[:1]))>.13:continue
    recovered.add(tuple(mapped))
triangles=[i for t in recovered for i in t]
print('Recovered',len(recovered),'body triangles using original avatar vertices')

def vertex(i):
    return {'p':list(attributes['POSITION'][i]),'n':list(attributes['NORMAL'][i]),
            'uv':list(attributes['TEXCOORD_0'][i]),
            'weights':dict(zip(attributes['JOINTS_0'][i],attributes['WEIGHTS_0'][i]))}

def interpolate(a,b,t):
    return {'p':[x+(y-x)*t for x,y in zip(a['p'],b['p'])],
            'n':[x+(y-x)*t for x,y in zip(a['n'],b['n'])],
            'uv':[x+(y-x)*t for x,y in zip(a['uv'],b['uv'])],
            'weights':{j:a['weights'].get(j,0)*(1-t)+b['weights'].get(j,0)*t for j in a['weights'].keys()|b['weights'].keys()}}

def clip(poly,plane):
    if not poly:return []
    result=[]
    for a,b in zip(poly,poly[1:]+poly[:1]):
        da,db=plane(a['p']),plane(b['p'])
        if da>=0:result.append(a)
        if (da>=0)!=(db>=0):result.append(interpolate(a,b,da/(da-db)))
    return result

def coverage_planes(kind,sign):
    planes=[lambda p,s=sign:s*p[0],lambda p:.198-p[0],lambda p:.198+p[0],lambda p,s=sign:1.405+.62*s*p[0]-p[1]]
    planes.append((lambda p:p[1]-1.125) if kind.startswith('dress') else (lambda p,s=sign:p[1]-.905-.30*s*p[0]))
    return planes

def hem(kind,angle):
    if kind=='dress-pleated':return .47
    if kind=='dress-wrap':return .615+.045*math.cos(angle+.35)
    return .60

def uncovered_body(kind):
    vertices=[];indices=[]
    for i in range(0,len(triangles),3):
        polygons=[[vertex(j) for j in triangles[i:i+3]]]
        regions=[coverage_planes(kind,s) for s in [-1,1]]
        if kind.startswith('dress'):regions.append([lambda p:p[1]-(.665 if kind=='dress-wrap' else hem(kind,0)-.005),lambda p:1.15-p[1],lambda p:.34-p[0],lambda p:.34+p[0]])
        for planes in regions:
            remaining=[]
            for polygon in polygons:
                inside=polygon
                for plane in planes:
                    outside=clip(inside,lambda p,f=plane:-f(p))
                    if len(outside)>=3:remaining.append(outside)
                    inside=clip(inside,plane)
                    if len(inside)<3:break
            polygons=remaining
        for polygon in polygons:
            start=len(vertices);vertices.extend(polygon)
            for j in range(1,len(polygon)-1):indices.extend([start,start+j,start+j+1])
    return vertices,indices

def bodice(kind):
    vertices=[];indices=[]
    for i in range(0,len(triangles),3):
        base=[vertex(j) for j in triangles[i:i+3]]
        # Split left/right at center to get a clean, modest V neckline and leg openings.
        for sign in [-1,1]:
            planes=coverage_planes(kind,sign)
            poly=base
            for plane in planes:poly=clip(poly,plane)
            if len(poly)<3:continue
            start=len(vertices)
            for v in poly:
                norm=math.sqrt(sum(x*x for x in v['n'])) or 1
                v['n']=[x/norm for x in v['n']]
                v['p']=[x+n*.0045 for x,n in zip(v['p'],v['n'])]
                vertices.append(v)
            for j in range(1,len(poly)-1):indices.extend([start,start+j,start+j+1])
    return vertices,indices

def skirt(kind):
    # Three distinct silhouettes with continuous folds and smooth surface normals.
    profile=[(1.145,.145,.108),(1.10,.172,.125),(1.025,.203,.150),(.95,.222,.158),(.84,.237,.168),(.72,.255,.178),(.60,.275,.19)]
    if kind=='dress-pleated':profile=[(1.145,.146,.11),(1.10,.175,.13),(1.025,.207,.152),(.94,.23,.16),(.82,.255,.177),(.69,.282,.195),(.56,.31,.213),(.47,.33,.225)]
    if kind=='dress-wrap':profile=[(1.145,.146,.11),(1.10,.173,.128),(1.025,.205,.152),(.95,.216,.158),(.84,.222,.165),(.72,.226,.17),(.615,.235,.18)]
    # More rings make the wrinkle shading follow actual geometry rather than a smooth cone.
    rings=[]
    for a,b in zip(profile,profile[1:]):
        for t in [0,.25,.5,.75]:rings.append(tuple(x+(y-x)*t for x,y in zip(a,b)))
    rings.append(profile[-1])
    vertices=[];indices=[];segments=128
    for row,(y,rx,rz) in enumerate(rings):
        t=row/(len(rings)-1)
        for i in range(segments+1):
            angle=i/segments*2*math.pi
            amplitude=.045 if kind=='dress' else .095 if kind=='dress-pleated' else .023
            pleat=1+amplitude*math.sin(math.pi*t/2)*math.cos(angle*(18 if kind=='dress-pleated' else 12)+.16*math.sin(t*5))
            ripple=.0015*math.sin(angle*7+y*39)*math.exp(-((y-1.04)/.13)**2)
            actual_y=y+(hem(kind,angle)-profile[-1][0])*t**3
            p=[math.cos(angle)*(rx*pleat+ripple),actual_y,.012+math.sin(angle)*(rz*pleat+ripple)]
            n=[math.cos(angle),.2,math.sin(angle)];length=math.sqrt(sum(v*v for v in n));n=[v/length for v in n]
            vertices.append({'p':p,'n':n,'uv':[i/segments,(1.6-actual_y)*2.5],'weights':{0:1}})
    for row in range(len(rings)-1):
        for i in range(segments):
            a=row*(segments+1)+i;b=a+1;c=(row+1)*(segments+1)+i;d=c+1
            indices.extend([a,b,c,b,d,c])
    return vertices,indices

def fabric_normals(vertices,indices):
    # Weld duplicated triangle vertices for smooth seam shading, while retaining skin weights.
    sums={};keys=[tuple(round(x,5) for x in v['p']) for v in vertices]
    for offset in range(0,len(indices),3):
        tri=indices[offset:offset+3];a,b,c=[np.array(vertices[i]['p']) for i in tri]
        normal=np.cross(b-a,c-a)
        if np.dot(normal,np.array(vertices[tri[0]]['n']))<0:normal=-normal
        for i in tri:sums[keys[i]]=sums.get(keys[i],np.zeros(3))+normal
    for i,v in enumerate(vertices):
        normal=sums.get(keys[i],np.array(v['n']));length=np.linalg.norm(normal)
        if length>1e-9:v['n']=(normal/length).tolist()

def fabric_maps():
    size=256;y,x=np.mgrid[:size,:size];u=x*2*math.pi/4;v=y*2*math.pi/4
    weave=.5+.22*np.sin(u)*np.sin(v)+.08*np.sin(u*2+v)
    dx=.12*np.cos(u)*np.sin(v);dy=.12*np.sin(u)*np.cos(v)
    normals=np.stack([-dx,-dy,np.ones_like(dx)],axis=2);normals/=np.linalg.norm(normals,axis=2,keepdims=True)
    normal_image=Image.fromarray(np.uint8(np.clip((normals*.5+.5)*255,0,255)))
    packed=np.zeros((size,size,3),dtype=np.uint8);packed[:,:,0]=255;packed[:,:,1]=np.uint8(220+25*weave)
    result=[]
    for image in [normal_image,Image.fromarray(packed)]:
        stream=io.BytesIO();image.save(stream,format='PNG');result.append(stream.getvalue())
    return result

def make(kind):
    document=copy.deepcopy(original);blob=bytearray(binary)
    def accessor(values,type_,component=5126,bounds=False):
        while len(blob)%4:blob.append(0)
        code,_=components[component];data=b''.join(struct.pack('<'+code*len(v),*v) for v in values)
        view=len(document['bufferViews']);document['bufferViews'].append({'buffer':0,'byteOffset':len(blob),'byteLength':len(data)})
        blob.extend(data)
        acc={'bufferView':view,'componentType':component,'count':len(values),'type':type_}
        if bounds:acc.update(min=[min(v[i] for v in values) for i in range(len(values[0]))],max=[max(v[i] for v in values) for i in range(len(values[0]))])
        document['accessors'].append(acc);return len(document['accessors'])-1
    styles={'dress':([.018,.16,.17,1],.72,[.18,.28,.28],.65),
            'dress-pleated':([.012,.025,.085,1],.46,[.20,.25,.40],.48),
            'dress-wrap':([.13,.009,.028,1],.56,[.30,.12,.16],.52)}
    color,roughness,sheen,sheen_roughness=styles.get(kind,([.025,.045,.13,1],.7,[0,0,0],1))
    material_def={'name':'Wardrobe_fabric_'+kind,'doubleSided':True,'pbrMetallicRoughness':{'baseColorFactor':color,'metallicFactor':0,'roughnessFactor':roughness}}
    if kind.startswith('dress'):
        textures=[]
        for data in fabric_maps():
            while len(blob)%4:blob.append(0)
            view=len(document['bufferViews']);document['bufferViews'].append({'buffer':0,'byteOffset':len(blob),'byteLength':len(data)});blob.extend(data)
            image=len(document['images']);document['images'].append({'bufferView':view,'mimeType':'image/png'})
            sampler=len(document.setdefault('samplers',[]));document['samplers'].append({'magFilter':9729,'minFilter':9987,'wrapS':10497,'wrapT':10497})
            texture=len(document['textures']);document['textures'].append({'source':image,'sampler':sampler});textures.append(texture)
        material_def['normalTexture']={'index':textures[0],'scale':.25}
        material_def['pbrMetallicRoughness']['metallicRoughnessTexture']={'index':textures[1]}
        material_def['extensions']={'KHR_materials_sheen':{'sheenColorFactor':sheen,'sheenRoughnessFactor':sheen_roughness}}
        if 'KHR_materials_sheen' not in document.setdefault('extensionsUsed',[]):document['extensionsUsed'].append('KHR_materials_sheen')
    material=len(document['materials']);document['materials'].append(material_def)
    verts,indices=bodice(kind)
    if kind.startswith('dress'):
        for vertex_ in verts:
            x,y,z=vertex_['p'];angle=math.atan2(z-.012,x)
            gather=.0008*math.sin(angle*12+y*42)*math.exp(-((y-1.18)/.08)**2)
            if kind=='dress-wrap' and z>.015:gather-=.0015*math.exp(-((x-.55*(y-1.27))/.012)**2)
            vertex_['p']=[p+n*gather for p,n in zip(vertex_['p'],vertex_['n'])]
            vertex_['uv']=[angle/(2*math.pi)+.5,(1.6-y)*2.5]
        extra,extra_indices=skirt(kind);offset=len(verts);verts.extend(extra);indices.extend([x+offset for x in extra_indices])
        fabric_normals(verts,indices)
    joints=[];weights=[]
    for v in verts:
        top=sorted(v['weights'].items(),key=lambda item:item[1],reverse=True)[:4]
        top += [(0,0)]*(4-len(top));total=sum(w for j,w in top) or 1
        joints.append([j for j,w in top]);weights.append([w/total for j,w in top])
    mesh={'name':'Wardrobe_'+kind,'primitives':[{'attributes':{
        'POSITION':accessor([v['p'] for v in verts],'VEC3',bounds=True),
        'NORMAL':accessor([v['n'] for v in verts],'VEC3'),
        'JOINTS_0':accessor(joints,'VEC4',5123),'WEIGHTS_0':accessor(weights,'VEC4')},
        'indices':accessor([(i,) for i in indices],'SCALAR',5125),'material':material}]}
    if kind.startswith('dress'):mesh['primitives'][0]['attributes']['TEXCOORD_0']=accessor([v['uv'] for v in verts],'VEC2')
    mesh_index=len(document['meshes']);document['meshes'].append(mesh)
    skin,skin_indices=uncovered_body(kind)
    skin_joints=[];skin_weights=[]
    for v in skin:
        top=sorted(v['weights'].items(),key=lambda item:item[1],reverse=True)[:4];top += [(0,0)]*(4-len(top));total=sum(w for j,w in top) or 1
        skin_joints.append([j for j,w in top]);skin_weights.append([w/total for j,w in top])
    document['meshes'][body_node['mesh']]['primitives']=[{'attributes':{
        'POSITION':accessor([v['p'] for v in skin],'VEC3',bounds=True),'NORMAL':accessor([v['n'] for v in skin],'VEC3'),
        'TEXCOORD_0':accessor([v['uv'] for v in skin],'VEC2'),'JOINTS_0':accessor(skin_joints,'VEC4',5123),'WEIGHTS_0':accessor(skin_weights,'VEC4')},
        'indices':accessor([(i,) for i in skin_indices],'SCALAR',5125),'material':primitive['material']}]
    node_index=len(document['nodes']);document['nodes'].append({'name':'Wardrobe_'+kind,'mesh':mesh_index,'skin':body_node['skin']})
    remove={i for i,n in enumerate(document['nodes']) if n.get('name')=='avaturn_look_0' or (kind=='swimsuit' and n.get('name')=='avaturn_shoes_0')}
    for n in document['nodes']:
        if 'children' in n:n['children']=[i for i in n['children'] if i not in remove]
    parent=next(n for n in document['nodes'] if any(document['nodes'][i].get('name')=='Body_Mesh' for i in n.get('children',[])))
    parent['children'].append(node_index)
    while len(blob)%4:blob.append(0)
    document['buffers'][0]['byteLength']=len(blob)
    document.setdefault('extras',{})['wardrobe']={'outfit':kind,'baseSha256':hashlib.sha256(raw).hexdigest(),'generatedGeometry':True}
    encoded=json.dumps(document,separators=(',',':')).encode();encoded+=b' '*((-len(encoded))%4)
    output=struct.pack('<4sII',b'glTF',2,28+len(encoded)+len(blob))+struct.pack('<I4s',len(encoded),b'JSON')+encoded+struct.pack('<I4s',len(blob),b'BIN\0')+blob
    target=OUT/(kind+'.glb');target.write_bytes(output);print(target,len(verts),'clothing vertices',len(output),'bytes')

OUT.mkdir(parents=True,exist_ok=True)
for kind in ['dress','dress-pleated','dress-wrap','swimsuit']:make(kind)
