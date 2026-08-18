'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT=path.resolve(__dirname,'../..');
const pathsFile=path.join(ROOT,'auriva-frontend/src/constants/wordPaths.js');
const wordsFile=path.join(ROOT,'auriva-frontend/src/constants/wordData.js');
const outputFile=path.resolve(__dirname,'../src/generated/wordCanonical.v1.json');
function extractObject(source,name){const start=source.indexOf(`const ${name} = `),objectStart=source.indexOf('{',start);if(start<0||objectStart<0)throw new Error(`Missing ${name}`);let depth=0,end=-1;for(let i=objectStart;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0){end=i+1;break;}}if(end<0)throw new Error(`Malformed ${name}`);return vm.runInNewContext(`(${source.slice(objectStart,end)})`,Object.create(null),{timeout:1000});}
function buildAsset(){const source=fs.readFileSync(pathsFile,'utf8');return{version:'word_templates_v1',words:[...fs.readFileSync(wordsFile,'utf8').matchAll(/word:\s*'([^']+)'/g)].map(m=>m[1]),lowercase:extractObject(source,'LOWERCASE_LETTER_PATHS'),uppercase:extractObject(source,'UPPERCASE_LETTER_PATHS')};}
if(require.main===module){fs.mkdirSync(path.dirname(outputFile),{recursive:true});fs.writeFileSync(outputFile,`${JSON.stringify(buildAsset(),null,2)}\n`);console.log(`Wrote ${outputFile}`);}
module.exports={buildAsset,outputFile};
