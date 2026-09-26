const {scoreWord,buildWordGuide,WORD_PASS_SCORE,CANONICAL_PATH}=require('../src/services/wordScoringService');
const fs=require('fs');
const W=490,H=220;
function trace(word){const g=buildWordGuide(word),a=W/H;return g.rawPath.map(d=>d.points.map(p=>({x:(.5+(p.fx-.5)/a)*W,y:p.fy*H})));}
describe('authoritative word scorer',()=>{
 test('packaged asset exactly matches the single frontend canonical source for all 154 words and paths',()=>{const packaged=JSON.parse(fs.readFileSync(CANONICAL_PATH,'utf8'));const {buildAsset}=require('../scripts/syncWordCanonicalAssets');expect(packaged).toEqual(buildAsset());expect(packaged.words).toHaveLength(154);expect(Object.keys(packaged.lowercase)).toHaveLength(26);expect(Object.keys(packaged.uppercase)).toHaveLength(26);for(const word of packaged.words)expect(buildWordGuide(word)).not.toBeNull();});
 test('full supported word passes at threshold 50',()=>{const r=scoreWord({word:'cat',strokes:trace('cat'),canvasWidth:W,canvasHeight:H});expect(WORD_PASS_SCORE).toBe(50);expect(r).toMatchObject({valid:true,passed:true,completionPassed:true,expectedLetterCount:3,coveredLetterCount:3,thresholdUsed:50});expect(r.score).toBeGreaterThanOrEqual(50);});
 test('unsupported word and malformed/empty strokes fail safely',()=>{expect(scoreWord({word:'not-in-bank',strokes:[],canvasWidth:W,canvasHeight:H}).error).toBe('unsupported_word');expect(scoreWord({word:'cat',strokes:[],canvasWidth:W,canvasHeight:H}).error).toBe('invalid_strokes');});
 test.each([0,1,2])('missing letter %i cannot pass',missing=>{const g=buildWordGuide('cat'),strokes=trace('cat').filter((_,i)=>g.rawPath[i].letterIndex!==missing);const r=scoreWord({word:'cat',strokes,canvasWidth:W,canvasHeight:H});expect(r.passed).toBe(false);expect(r.completionPassed).toBe(false);expect(r.score).toBe(0);});
 test('client score fields are not scorer inputs and result remains finite',()=>{const r=scoreWord({word:'cat',strokes:trace('cat'),canvasWidth:W,canvasHeight:H,score:1000,passed:true});expect(Number.isFinite(r.score)).toBe(true);expect(r.score).toBeLessThanOrEqual(100);});
});
