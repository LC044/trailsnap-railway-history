import fs from "fs";
import { getStationNames } from "./services/station_names";

getStationNames()
  .then((s) => {
    console.log("车站总数:", s.length);
    console.log("样本:", JSON.stringify(s.slice(0, 3)));
    fs.writeFileSync("dist-test/station_names.json", JSON.stringify(s, null, 2), "utf-8");
    console.log("已写入 dist-test/station_names.json");
  })
  .catch((e) => console.error("失败:", e instanceof Error ? e.message : e));
