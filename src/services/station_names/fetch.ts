import { IStationInfo } from "./model";

/**
 * 获取车站名称（重写版：直接用原生 fetch 抓 HTML/JS 文本，
 * 原实现的 request() 强制按 JSON 解析导致 HTML 变空串，且 matchAll 缺 g 标志）
 */
export const getStationNames = async (): Promise<IStationInfo[]> => {
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

  // 1. 拉首页 HTML，找 station_name js 文件
  const htmlRsp = await fetch("https://www.12306.cn/index/", {
    headers: { "User-Agent": UA },
  });
  if (!htmlRsp.ok) throw new Error(`首页请求失败 HTTP ${htmlRsp.status}`);
  const html = await htmlRsp.text();

  const jsMatches = [...html.matchAll(/<script src="([^"]+)"[^>]*>/g)];
  const stationJs = jsMatches
    .map((m) => m[1])
    .find((src) => /station_name.*\.js/.test(src));
  if (!stationJs) throw new Error("未在首页找到 station_name js 文件");

  // 2. 拉车站 JS 内容
  const jsUrl = stationJs.startsWith("http")
    ? stationJs
    : `https://www.12306.cn/index/${stationJs.replace("./", "")}`;
  const jsRsp = await fetch(jsUrl, { headers: { "User-Agent": UA } });
  if (!jsRsp.ok) throw new Error(`车站js请求失败 HTTP ${jsRsp.status}`);
  const jsContent = await jsRsp.text();

  // 3. 解析: var station_names = 'bjb|北京北|VAP|beijingbei|bjb|0|0105|北京|...'
  const dataContent = jsContent.match(/=\s*['"]([^'"]+)['"]/)?.[1];
  if (!dataContent) throw new Error("车站js内容解析失败");

  return dataContent.split("|||").map((d) => {
    const [at_pinyin, name, tele_code, pinyin, pinyin_short, idx, area_code, city] =
      d.split("|");
    return {
      at_pinyin,
      name,
      tele_code,
      pinyin,
      pinyin_short,
      idx: parseInt(idx),
      area_code: parseInt(area_code),
      city,
    } satisfies IStationInfo;
  });
};
