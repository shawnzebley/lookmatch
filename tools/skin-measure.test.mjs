import test from 'node:test';
import assert from 'node:assert/strict';
import {prepare,measure} from '../engine/measure.js';
test('solver samples omit full-image skin targets while final measurement keeps person zones',()=>{
 const width=120,height=2,n=width*height,data=new Uint8ClampedArray(n*4),skin=new Uint8Array(n).fill(255),people=new Uint8Array(n);
 for(let i=0;i<n;i++){data[i*4]=130+i%50;data[i*4+1]=95+i%40;data[i*4+2]=80+i%35;data[i*4+3]=255;people[i]=1+i%2;}
 const ps=prepare({data,width,height},{skin,skinPeople:people,skinPositions:[{id:1,x:.2,y:.5},{id:2,x:.8,y:.5}]});
 const sampled=measure(ps,ps,Uint32Array.from({length:60},(_,i)=>i*4));
 assert.equal(sampled.skinMatch,null);
 assert.ok(Number.isFinite(sampled.tone.pct[50]));
 const final=measure(ps);
 assert.equal(final.skinMatch.version,2);assert.equal(final.skinMatch.people.length,2);
 for(const person of final.skinMatch.people)assert.deepEqual(Object.keys(person.zones),['shadow','midtone','lit']);
});
