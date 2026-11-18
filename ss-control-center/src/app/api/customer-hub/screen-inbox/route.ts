import { screenInbox, recordScreenSnapshot } from '@/lib/customer-hub/screen-inbox';
import { verifyJackieAuth } from '@/lib/jackie-mcp/registry';
export async function GET(){return Response.json(await screenInbox(),{headers:{'Cache-Control':'no-store'}});}
export async function POST(request:Request){const error=verifyJackieAuth(request.headers.get('authorization'));if(error)return Response.json({error},{status:401});try{return Response.json(await recordScreenSnapshot(await request.json()));}catch(e){return Response.json({error:e instanceof Error?e.message:'Invalid screen evidence'},{status:400});}}
