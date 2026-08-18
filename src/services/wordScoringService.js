'use strict';
const path = require('path');

const WORD_PASS_SCORE = 50, WORD_SCORE_VERSION = 'word_v1', DTW_CAP = 45;
const CANONICAL_PATH = path.resolve(__dirname, '../generated/wordCanonical.v1.json');
function loadCanonical() {
  const asset=require(CANONICAL_PATH);
  if(asset.version!=='word_templates_v1'||asset.words.length!==154)throw new Error('Invalid canonical word asset');
  return { lower:asset.lowercase, upper:asset.uppercase, words:new Set(asset.words) };
}
const canonical = loadCanonical();
const strokesOf = p => !p?.length ? [] : Array.isArray(p[0]) ? p : [p];
function buildWordGuide(word) {
  const clean = String(word || '').replace(/[^a-zA-Z]/g, '');
  if (!canonical.words.has(String(word).toLowerCase())) return null;
  const defs = clean.split('').map((ch,i) => strokesOf(i ? canonical.lower[ch.toLowerCase()] : canonical.upper[ch.toUpperCase()])).map(strokes => {
    const xs=strokes.flat().map(p=>p.fx); return {strokes,minX:Math.min(...xs),width:Math.max(...xs)-Math.min(...xs)};
  });
  const avg=defs.reduce((s,d)=>s+d.width,0)/defs.length, gap=avg*.22, total=defs.reduce((s,d)=>s+d.width,0)+gap*(defs.length-1);
  const rawPath=[]; let cursor=0;
  defs.forEach((d,letterIndex)=>{d.strokes.forEach(stroke=>rawPath.push({letterIndex,points:stroke.map(p=>({fx:(cursor+p.fx-d.minX)/total,fy:p.fy}))}));cursor+=d.width+gap;});
  return { rawPath, letterCount: defs.length };
}
function cleanStrokes(value) { return Array.isArray(value) ? value.map(s=>Array.isArray(s)?s.filter(p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y)):[]).filter(s=>s.length>=2) : []; }
function normalize(strokes) {
  const flat=strokes.flat(), xs=flat.map(p=>p.x), ys=flat.map(p=>p.y); if(!flat.length)return [];
  const minX=Math.min(...xs),minY=Math.min(...ys),span=Math.max(Math.max(...xs)-minX,Math.max(...ys)-minY),scale=span>1e-6?100/span:1;
  return strokes.map(s=>s.map(p=>({x:(p.x-minX)*scale,y:(p.y-minY)*scale})));
}
function templatePoints(guide,w,h) { const aspect=w/h; return guide.rawPath.flatMap(d=>d.points.map(p=>({x:(.5+(p.fx-.5)/aspect)*w,y:p.fy*h}))); }
// Extracted from scoreWord's own inline bounds/regions computation (word-
// layout-metrics task) — same math, unchanged, just named and shared so the
// new layout service reuses this instead of recomputing it a second time.
// scoreWord below now calls this too; bounds[i].min/max (x) are the exact
// same values it always used for coverage checking — minY/maxY are new,
// additive fields scoreWord doesn't read, computed from the same per-letter
// template points already being iterated.
function letterBoundsAndRegions(guide,w,h) {
  const aspect=w/h,bounds=[];
  for(let i=0;i<guide.letterCount;i++){
    const pts=guide.rawPath.filter(d=>d.letterIndex===i).flatMap(d=>d.points.map(p=>({x:(.5+(p.fx-.5)/aspect)*w,y:p.fy*h})));
    const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);
    bounds.push({min:Math.min(...xs),max:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)});
  }
  const regions=bounds.map((b,i)=>({min:i?(bounds[i-1].max+b.min)/2:-Infinity,max:i===bounds.length-1?Infinity:(b.max+bounds[i+1].min)/2}));
  return {bounds,regions};
}
function dtw(a,b){if(a.length<2||b.length<2)return null;let prev=new Float64Array(b.length),cur=new Float64Array(b.length);const dist=(x,y)=>Math.hypot(x.x-y.x,x.y-y.y);prev[0]=dist(a[0],b[0]);for(let j=1;j<b.length;j++)prev[j]=prev[j-1]+dist(a[0],b[j]);for(let i=1;i<a.length;i++){cur[0]=prev[0]+dist(a[i],b[0]);for(let j=1;j<b.length;j++)cur[j]=dist(a[i],b[j])+Math.min(cur[j-1],prev[j],prev[j-1]);[prev,cur]=[cur,prev];}return prev[b.length-1]/Math.max(a.length,b.length);}
function smoothness(strokes){const p=strokes.flat(),c=[];for(let i=1;i<p.length-1;i++){const a=p[i-1],b=p[i],d=p[i+1],l1=Math.hypot(b.x-a.x,b.y-a.y),l2=Math.hypot(d.x-b.x,d.y-b.y);if(l1&&l2)c.push(Math.acos(Math.max(-1,Math.min(1,((b.x-a.x)*(d.x-b.x)+(b.y-a.y)*(d.y-b.y))/(l1*l2)))));}return c.length?c.reduce((s,x)=>s+x,0)/c.length:0;}
function scoreWord({word,strokes,canvasWidth,canvasHeight}) {
  const guide=buildWordGuide(String(word||'').toLowerCase()), clean=cleanStrokes(strokes), w=Number(canvasWidth),h=Number(canvasHeight);
  if(!guide||!clean.length||!Number.isFinite(w)||!Number.isFinite(h)||w<=0||h<=0)return {valid:false,error:guide?'invalid_strokes':'unsupported_word'};
  const {bounds,regions}=letterBoundsAndRegions(guide,w,h);
  const covered=regions.filter(r=>{const p=clean.flat().filter(x=>x.x>=r.min&&x.x<r.max);if(p.length<2)return false;return Math.hypot(Math.max(...p.map(x=>x.x))-Math.min(...p.map(x=>x.x)),Math.max(...p.map(x=>x.y))-Math.min(...p.map(x=>x.y)))>=Math.max(6,Math.min(w,h)*.025);}).length;
  const completion=covered===guide.letterCount, distance=dtw(normalize(clean).flat(),normalize([templatePoints(guide,w,h)])[0]);
  const raw=100-(.7*(Math.min(distance??DTW_CAP,DTW_CAP)/DTW_CAP*100)+.3*smoothness(clean)*100), score=completion?Math.round(Math.max(0,Math.min(100,raw))):0;
  return {valid:true,score,passed:completion&&score>=WORD_PASS_SCORE,completionPassed:completion,expectedLetterCount:guide.letterCount,coveredLetterCount:covered,features:{dtw_distance:Number.isFinite(distance)?distance:null,smoothness:smoothness(clean)},thresholdUsed:WORD_PASS_SCORE,scoreVersion:WORD_SCORE_VERSION};
}
module.exports={scoreWord,buildWordGuide,letterBoundsAndRegions,cleanStrokes,WORD_PASS_SCORE,WORD_SCORE_VERSION,CANONICAL_PATH};
