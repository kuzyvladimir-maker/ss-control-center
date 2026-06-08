import "dotenv/config";
import { getWalmartClient } from "@/lib/walmart/client";
import { requestReport, getReportStatus } from "@/lib/walmart/reports-insights";
async function main(){
  const client = getWalmartClient(1);
  const type = (process.env.RTYPE as any) || "BUYBOX";
  const id = await requestReport(client, type);
  console.log(`requestId(${type}) = ${id}`);
  const st = await getReportStatus(client, id);
  console.log(`status = ${st.status}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error("ERR:", e.message);process.exit(1);});
