import path from "node:path"; import os from "node:os"; import fs from "node:fs"; import Module from "node:module";
const NPM=path.join(os.homedir(),".pi","agent","npm"), PKG=path.join(NPM,"node_modules","pi-voicekit");
{ const r=path.join(os.homedir(),".pi","agent","install","releases"); const x=[]; for(const v of fs.readdirSync(r).sort().reverse()) x.push(path.join(r,v,"node_modules"));
  process.env.NODE_PATH=[...(process.env.NODE_PATH?[process.env.NODE_PATH]:[]),...x].join(path.delimiter); Module._initPaths(); }
const req=Module.createRequire(path.join(NPM,"noop.cjs")); const jiti=req("jiti")(import.meta.filename);
// user presses the mic key first: voice.ts does await import("./voice/sherpa-engine") -> initSherpa()
const se=jiti(path.join(PKG,"extensions","voice","sherpa-engine.ts"));
console.log("initSherpa() ->", await se.initSherpa());
console.log("ORT resident after STT:", !!req.cache[req.resolve("onnxruntime-node")]);
// now the first reply is spoken
const eng=jiti(path.join(PKG,"extensions","voice","tts-engine.ts")); const cat=jiti(path.join(PKG,"extensions","voice","tts-local-models.ts"));
const a=await eng.synthesize({text:"Finally, a sentence spoken after the microphone was used.",model:cat.getTtsModel("paradee-8m-v1_0"),modelDir:cat.getInstalledTtsModelDir("paradee-8m-v1_0"),language:"en"});
console.log("MIC-FIRST ORDER → Paradee spoke:", a.samples.length, "samples @", a.sampleRate, "Hz :");
console.log("MIC-FIRST ORDER: PASS");
