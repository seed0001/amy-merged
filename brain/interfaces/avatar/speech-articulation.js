// Shared, dependency-free audio/phoneme solver. Runs once per clip; rendering samples
// a sparse cue track in O(log phonemes), without inference or audio analysis per frame.
export const SPEECH_SHAPES=['viseme_PP','viseme_FF','viseme_TH','viseme_DD','viseme_kk','viseme_CH','viseme_SS','viseme_nn','viseme_RR','viseme_aa','viseme_E','viseme_I','viseme_O','viseme_U','jawOpen'];
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
const POSES={PP:[.92,0],FF:[.78,.045],TH:[.68,.08],DD:[.62,.09],kk:[.55,.12],CH:[.72,.08],SS:[.67,.035],nn:[.55,.07],RR:[.62,.12],aa:[.76,.22],E:[.72,.13],I:[.67,.09],O:[.72,.15],U:[.68,.09]};
export function audioFeatures(samples,rate,frameMs=20){
  const step=Math.max(1,Math.floor(rate/16000)),effectiveRate=rate/step;
  const size=Math.max(1,Math.round(rate*frameMs/1000)),frames=[];
  const frequencies=[400,1000,2200,4000],coefficients=frequencies.map(f=>2*Math.cos(2*Math.PI*f/effectiveRate));
  for(let start=0;start<samples.length;start+=size){
    let sum=0,difference=0,previous=0,count=0;const s1=[0,0,0,0],s2=[0,0,0,0];
    for(let i=start;i<Math.min(samples.length,start+size);i+=step){
      const x=samples[i];sum+=x*x;difference+=(x-previous)**2;previous=x;count++;
      for(let b=0;b<4;b++){const value=x+coefficients[b]*s1[b]-s2[b];s2[b]=s1[b];s1[b]=value;}
    }
    const bands=s1.map((s,b)=>Math.max(0,s*s+s2[b]*s2[b]-coefficients[b]*s*s2[b]));
    const total=bands.reduce((a,b)=>a+b,0)+1e-10;
    const bright=clamp(.6*(bands[2]+bands[3])/total+.2*difference/(sum+1e-10));
    frames.push({rms:Math.sqrt(sum/Math.max(count,1)),bright,round:clamp((bands[0]+bands[1])/total)});
  }
  const levels=frames.map(frame=>frame.rms).sort((a,b)=>a-b);
  const peak=Math.max(.012,levels[Math.floor(levels.length*.95)]||0),floor=Math.min(.006,peak*.06);
  for(const frame of frames){frame.open=clamp((frame.rms-floor)/(peak-floor)*.85);frame.wide=frame.open*frame.bright;frame.round*=frame.open;}
  return {frames,frameMs,durationMs:samples.length/rate*1000};
}
function alignmentCost(phone,frame){
  if(phone.viseme==='sil')return frame.open*1.2;
  if(phone.viseme==='PP'&&phone.phone!=='m')return frame.open*.35;
  if(['FF','TH','SS','CH'].includes(phone.viseme))return Math.abs(frame.bright-.65)*.4+(frame.open<.02?.3:0);
  return frame.bright*.25+(frame.open<.02?.55:0);
}
export function alignPhones(phones,frames,frameMs){
  if(!phones.length||!frames.length)return [];
  let first=frames.findIndex(frame=>frame.open>.025);if(first<0)return [];
  let last=frames.length-1;while(last>first&&frames[last].open<=.025)last--;
  const m=last-first+1,n=phones.length,total=phones.reduce((sum,phone)=>sum+phone.weight,0);
  let cumulative=0;const centers=phones.map(phone=>{const center=(cumulative+phone.weight/2)/total;cumulative+=phone.weight;return center;});
  // Very long clips and degenerate short audio have a bounded proportional fallback.
  if(m<n||m*n>3000000){
    let at=first*frameMs;return phones.map(phone=>{const start=at;at+=m*frameMs*phone.weight/total;return {start,end:at,viseme:phone.viseme};});
  }
  let previous=new Float64Array(n).fill(Infinity),next=new Float64Array(n);
  const trace=new Uint8Array(m*n);
  previous[0]=alignmentCost(phones[0],frames[first]);
  for(let t=1;t<m;t++){
    next.fill(Infinity);const progress=t/Math.max(1,m-1);
    const low=Math.max(0,n-(m-t)),high=Math.min(n-1,t);
    for(let i=low;i<=high;i++){
      const advance=i>0?previous[i-1]:Infinity,stay=previous[i];
      const moved=advance<=stay;trace[t*n+i]=moved?1:0;
      const timing=(progress-centers[i])*3;
      next[i]=(moved?advance:stay)+alignmentCost(phones[i],frames[first+t])+timing*timing;
    }
    [previous,next]=[next,previous];
  }
  let index=n-1;const labels=new Uint16Array(m);
  for(let t=m-1;t>=0;t--){labels[t]=index;if(t>0&&trace[t*n+index])index--;}
  const cues=[];let begin=0;
  for(let t=1;t<=m;t++)if(t===m||labels[t]!==labels[begin]){
    cues.push({start:(first+begin)*frameMs,end:(first+t)*frameMs,viseme:phones[labels[begin]].viseme});begin=t;
  }
  return cues;
}
export function compileArticulation(samples,rate,phones){
  const features=audioFeatures(samples,rate);
  return {version:2,...features,cues:alignPhones(phones||[],features.frames,features.frameMs),timing:'audio-guided estimate'};
}
function findCue(cues,time){
  let low=0,high=cues.length-1;
  while(low<=high){const middle=(low+high)>>1,cue=cues[middle];if(time<cue.start)high=middle-1;else if(time>=cue.end)low=middle+1;else return middle;}
  return -1;
}
export function sampleArticulation(track,time){
  const mouth={};
  if(!track||time<0||time>=track.durationMs+60)return {mouth,level:0,closure:0,active:false};
  const position=time/track.frameMs,i=Math.floor(position),a=track.frames[i],b=track.frames[i+1]||a;
  if(!a)return {mouth,level:0,closure:0,active:false};
  const level=a.open+(b.open-a.open)*(position-i),gate=smooth(.012,.075,level);
  const current=findCue(track.cues,time);if(current<0)return {mouth,level,closure:0,active:true};
  const cue=track.cues[current],mixes=[[cue.viseme,1]];
  const next=track.cues[current+1],previous=track.cues[current-1];
  if(next){const blend=Math.min(cue.viseme==='PP'?14:45,(cue.end-cue.start)*.35,(next.end-next.start)*.35);if(time>cue.end-blend){const weight=.5*smooth(cue.end-blend,cue.end,time);mixes[0][1]-=weight;mixes.push([next.viseme,weight]);}}
  if(previous){const blend=Math.min(cue.viseme==='PP'?14:45,(cue.end-cue.start)*.35,(previous.end-previous.start)*.35);if(time<cue.start+blend){const weight=.5*(1-smooth(cue.start,cue.start+blend,time));mixes[0][1]-=weight;mixes.push([previous.viseme,weight]);}}
  let closure=0;
  const fade=1-smooth(track.durationMs-35,track.durationMs+25,time);
  for(const [viseme,weight]of mixes){
    const pose=POSES[viseme];if(!pose)continue;
    const movement=(viseme==='PP'?1:gate*(.38+.62*level))*weight*fade;
    mouth['viseme_'+viseme]=(mouth['viseme_'+viseme]||0)+pose[0]*movement;
    mouth.jawOpen=(mouth.jawOpen||0)+pose[1]*movement;
    if(viseme==='PP')closure+=weight;
  }
  return {mouth,level,closure,active:true};
}
export function smoothSpeech(current,target,velocity,dt,speed=1){
  // Critically damped spring: frame-rate independent and fast enough for consonant closures.
  const omega=(target>current?40:48)*speed,t=Math.min(.1,Math.max(0,dt)),decay=Math.exp(-omega*t);
  const delta=current-target,temp=(velocity+omega*delta)*t;
  return [clamp(target+(delta+temp)*decay),(velocity-omega*temp)*decay];
}
