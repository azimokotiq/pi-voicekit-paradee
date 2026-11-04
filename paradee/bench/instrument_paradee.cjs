// Temporarily instrument the LIVE tts-paradee.ts so a real pi process tells us
// what actually happens at extension load: does primeOnnxRuntime() run, does it
// succeed, and is sherpa already resident when it runs?
const fs = require("node:fs");
const p = process.argv[2];
let s = fs.readFileSync(p, "utf8");

const diag = [
	"function diag(msg: string): void {",
	"\ttry {",
	"\t\tconst M = (process as any).getBuiltinModule?.(\"module\");",
	"\t\tconst cache: string[] = M ? Object.keys(M._cache ?? {}) : [];",
	"\t\tconst resident = (n: string) => cache.some((k) => k.includes(n));",
	"\t\tfs.appendFileSync(",
	"\t\t\t\"<home>/ttsdbg/ort_diag.log\",",
	"\t\t\t\"[\" + new Date().toISOString() + \"] pid=\" + process.pid + \" \" + msg +",
	"\t\t\t\t\" sherpaResident=\" + resident(\"sherpa-onnx-node\") + \" ortResident=\" + resident(\"onnxruntime-node\") + String.fromCharCode(10)",
	"\t\t);",
	"\t} catch {}",
	"}",
	"",
	"function diagStack(tag: string): void {",
	"\ttry {",
	"\t\tfs.appendFileSync(\"<home>/ttsdbg/ort_diag.log\", tag + String.fromCharCode(10) + new Error().stack + String.fromCharCode(10));",
	"\t} catch {}",
	"}",
	"",
].join("\n");

const marker = "let ortPrimed = false;";
if (!s.includes(marker)) throw new Error("marker not found — upstream moved");
s = s.replace(marker, diag + marker);
s = s.replace(
	"\tif (ortPrimed) return;\n\tortPrimed = true;",
	"\tif (ortPrimed) return;\n\tortPrimed = true;\n\tdiag(\"prime: before loadDep\");\n\tdiagStack(\"prime stack:\");"
);
s = s.replace(
	'\t\tloadDep("onnxruntime-node");\n\t} catch (err) {',
	'\t\tloadDep("onnxruntime-node");\n\t\tdiag("prime: ORT loaded OK");\n\t} catch (err) {\n\t\tdiag("prime: FAILED " + (err as Error).message.slice(0, 160));'
);
fs.writeFileSync(p, s);
console.log("instrumented:", s.includes('diag("prime: before loadDep")'), s.includes("ORT loaded OK"));
