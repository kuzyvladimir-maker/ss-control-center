import "dotenv/config";
import { getWalmartClient } from "@/lib/walmart/client";
import {
  requestReport,
  getReportStatus,
  type InsightsReportType,
} from "@/lib/walmart/reports-insights";
async function main(){
  const client = getWalmartClient(1);
  const rawType = process.env.RTYPE || "BUYBOX";
  if (rawType !== "BUYBOX" && rawType !== "ITEM_PERFORMANCE") {
    throw new Error("RTYPE allows only BUYBOX or ITEM_PERFORMANCE; ITEM uses the owner-permitted capture engine");
  }
  const type: InsightsReportType = rawType;
  const id = await requestReport(client, type);
  console.log(`requestId(${type}) = ${id}`);
  const st = await getReportStatus(client, id);
  console.log(`status = ${st.status}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error("ERR:", e.message);process.exit(1);});
