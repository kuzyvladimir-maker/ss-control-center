import { verifyJackieAuth } from '@/lib/jackie-mcp/registry';
import { screenReview } from '@/lib/customer-hub/screen-review';
export async function POST(request:Request){
 const error=verifyJackieAuth(request.headers.get('authorization'));
 if(error)return Response.json({error},{status:401});
 try{return Response.json(await screenReview(await request.json()));}
 catch(e){return Response.json({error:e instanceof Error?e.message:'Screen review failed'},{status:400});}
}
