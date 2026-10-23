import type { IStationInfo } from './model';

const HOME = 'https://www.12306.cn/index/';
const STATION_SCRIPT = 'https://kyfw.12306.cn/otn/resources/js/framework/station_name.js';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36';

export function parseStationNames(script: string): IStationInfo[] {
  const content = script.match(/(?:var\s+)?station_names\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (!content) throw new Error('Invalid station_names script');
  const records = content.split(/\|\|\|@?|@/).filter(Boolean).map(record => {
    const fields = record.split('|');
    const [at_pinyin, name, tele_code, pinyin, pinyin_short, idx, area_code, city] = fields;
    return {raw_fields: fields, at_pinyin, name, tele_code, pinyin, pinyin_short,
      idx: Number.parseInt(idx), area_code: Number.parseInt(area_code), city};
  }).filter(s => s.name && /^[A-Z]{3}$/.test(s.tele_code));
  if (!records.length) throw new Error('Empty station list');
  return records;
}

/** Two official origins; a homepage/CDN outage must not prevent fetching the station script. */
export async function getStationNames(fetcher: typeof fetch = fetch): Promise<IStationInfo[]> {
  const read = async (url: string) => {
    const response = await fetcher(url, {headers:{'User-Agent':UA}, signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`Station source HTTP ${response.status}`);
    return response.text();
  };
  try {
    const html = await read(HOME);
    const stationJs = [...html.matchAll(/<script\b[^>]*\bsrc=['"]([^'"]+)['"][^>]*>/g)]
      .map(match=>match[1]).find(src=>/station_name.*\.js/.test(src));
    if (!stationJs) throw new Error('Station script missing from homepage');
    const scriptUrl = new URL(stationJs, HOME);
    if (scriptUrl.protocol !== 'https:' || !/(^|\.)12306\.cn$/.test(scriptUrl.hostname)) {
      throw new Error('Unexpected station script origin');
    }
    return parseStationNames(await read(scriptUrl.href));
  } catch (error) {
    console.warn(`[stations] homepage source unavailable: ${error instanceof Error ? error.message : String(error)}; trying official static script`);
    return parseStationNames(await read(STATION_SCRIPT));
  }
}
