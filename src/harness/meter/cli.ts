// Usage:
//   node scripts/model-meter.mjs --port 47800 --log meter.jsonl --route nvidia=https://integrate.api.nvidia.com/v1 [--route ...]
//   node scripts/model-meter.mjs --summary meter.jsonl
// Point a provider's baseUrl at http://127.0.0.1:<port>/<route> (in a copy of config/models.json) and rerun setup.
import { appendFileSync, readFileSync } from 'node:fs';
import { startMeter, summarise, type MeterRecord } from './meter';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

export function readMeterLog(file: string): MeterRecord[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as MeterRecord);
}

const summaryFile = opt('--summary');
if (summaryFile) {
  console.log(JSON.stringify(summarise(readMeterLog(summaryFile)), null, 2));
} else {
  const routes: Record<string, string> = {};
  argv.forEach((a, i) => {
    if (a !== '--route') return;
    const [name, ...url] = String(argv[i + 1]).split('=');
    if (name && url.length) routes[name] = url.join('=');
  });
  if (!Object.keys(routes).length) {
    console.error('at least one --route name=https://upstream/v1 is required');
    process.exit(1);
  }
  const log = opt('--log') ?? 'model-meter.jsonl';
  void startMeter({ port: Number(opt('--port') ?? 47800), routes, onRecord: (r) => appendFileSync(log, `${JSON.stringify(r)}\n`) }).then((m) => {
    console.log(`model meter on http://127.0.0.1:${m.port} → ${Object.entries(routes).map(([k, v]) => `${k}=${new URL(v).origin}`).join(', ')}; log ${log}`);
    const stop = () => void m.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
