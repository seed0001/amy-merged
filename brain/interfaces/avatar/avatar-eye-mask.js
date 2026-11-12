// Locate the enclosed dark iris in an eye texture, rather than treating every shaded
// pixel of the sclera as iris. RG = iris/sclera coverage, B = radius,
// A = fine contrast from the original texture (fibers and flecks).
export function eyeRegionMask(pixels,width,height){
  const count=width*height,seen=new Uint8Array(count),queue=new Uint32Array(count);
  const dark=(i)=>pixels[i*4+3]>127 && Math.max(pixels[i*4],pixels[i*4+1],pixels[i*4+2])<165 &&
    (.299*pixels[i*4]+.587*pixels[i*4+1]+.114*pixels[i*4+2])<135;
  let best=null;
  for(let i=0;i<count;i++){
    if(seen[i]||!dark(i))continue;
    let head=0,tail=1,minX=width,minY=height,maxX=0,maxY=0,border=false;queue[0]=i;seen[i]=1;
    while(head<tail){
      const at=queue[head++],x=at%width,y=Math.floor(at/width);
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      if(x===0||y===0||x===width-1||y===height-1)border=true;
      for(const next of [x>0?at-1:-1,x<width-1?at+1:-1,y>0?at-width:-1,y<height-1?at+width:-1]){
        if(next<0||seen[next]||!dark(next))continue;seen[next]=1;queue[tail++]=next;
      }
    }
    const ratio=(maxX-minX+1)/(maxY-minY+1);
    if(!border&&tail>count*.001&&tail<count*.4&&ratio>.45&&ratio<2.2&&(!best||tail>best.size))best={size:tail,minX,maxX,minY,maxY};
  }
  if(!best)return null; // Unknown layout: leave its texture unchanged.
  const cx=(best.minX+best.maxX)/2,cy=(best.minY+best.maxY)/2;
  const rx=(best.maxX-best.minX+1)/2,ry=(best.maxY-best.minY+1)/2;
  const mask=new Uint8Array(count*4);
  const stride=width+1,integral=new Float32Array((width+1)*(height+1));
  const luminance=i=>(.299*pixels[i*4]+.587*pixels[i*4+1]+.114*pixels[i*4+2])/255;
  for(let y=0;y<height;y++){
    let row=0;for(let x=0;x<width;x++){row+=luminance(y*width+x);integral[(y+1)*stride+x+1]=integral[y*stride+x+1]+row;}
  }
  const blurRadius=Math.max(1,Math.round(Math.min(rx,ry)*.035));
  const smooth=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
  for(let i=0;i<count;i++){
    const distance=Math.hypot((i%width-cx)/rx,(Math.floor(i/width)-cy)/ry);
    const inside=1-smooth(.96,1.04,distance);
    const pupil=smooth(12,45,Math.max(pixels[i*4],pixels[i*4+1],pixels[i*4+2]));
    const x=i%width,y=Math.floor(i/width),x0=Math.max(0,x-blurRadius),x1=Math.min(width,x+blurRadius+1),y0=Math.max(0,y-blurRadius),y1=Math.min(height,y+blurRadius+1);
    const mean=(integral[y1*stride+x1]-integral[y0*stride+x1]-integral[y1*stride+x0]+integral[y0*stride+x0])/((x1-x0)*(y1-y0));
    const detail=Math.max(0,Math.min(1,.5+(luminance(i)-mean)*5));
    mask[i*4]=Math.round(255*inside*pupil);mask[i*4+1]=Math.round(255*(1-inside));
    mask[i*4+2]=Math.round(255*Math.min(1,distance));mask[i*4+3]=Math.round(255*detail);
  }
  return mask;
}

export function eyeMaskTexture(map,THREE){
  if(!map?.image)return null;
  if(map.userData.avatarEyeMask!==undefined)return map.userData.avatarEyeMask;
  const image=map.image,canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
  try{
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
    const mask=eyeRegionMask(context.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height);
    if(!mask)return map.userData.avatarEyeMask=null;
    const texture=new THREE.DataTexture(mask,canvas.width,canvas.height,THREE.RGBAFormat);
    texture.flipY=map.flipY;texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;texture.needsUpdate=true;
    return map.userData.avatarEyeMask=texture;
  }catch{return map.userData.avatarEyeMask=null;}
}
