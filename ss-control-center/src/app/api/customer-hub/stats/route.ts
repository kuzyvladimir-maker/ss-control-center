import { NextRequest, NextResponse } from 'next/server';
import { screenInbox } from '@/lib/customer-hub/screen-inbox';
import { prisma } from '@/lib/prisma';
import { activeClaimsWhere } from '@/lib/customer-hub/live-counts';
export async function GET(request: NextRequest) {
  const store=request.nextUrl.searchParams.get('store');
  const storeFilter=store && /^\d+$/.test(store) ? {storeIndex:Number(store)} : {};
  const [mail,atoz,chargebacks,feedback]=await Promise.allSettled([
    screenInbox(),
    Promise.all([prisma.atozzClaim.count({where:activeClaimsWhere('A_TO_Z',storeFilter)}),prisma.atozzClaim.count({where:{claimType:'A_TO_Z',...storeFilter}}),prisma.atozzClaim.findFirst({where:{claimType:'A_TO_Z',...storeFilter},orderBy:{createdAt:'desc'},select:{createdAt:true}})]),
    Promise.all([prisma.atozzClaim.count({where:activeClaimsWhere('CHARGEBACK',storeFilter)}),prisma.atozzClaim.count({where:{claimType:'CHARGEBACK',...storeFilter}}),prisma.atozzClaim.findFirst({where:{claimType:'CHARGEBACK',...storeFilter},orderBy:{createdAt:'desc'},select:{createdAt:true}})]),
    Promise.all([prisma.sellerFeedback.count({where:{status:'NEW'}}),prisma.sellerFeedback.count()]),
  ]);
  const errors:Record<string,string>={};
  for(const [name,result] of [['mail',mail],['atoz',atoz],['chargebacks',chargebacks],['feedback',feedback]] as const) if(result.status==='rejected') errors[name]=`${name} data unavailable; retry refresh`;
  const claimMeta=(result: typeof atoz)=>result.status==='fulfilled'?{storedTotal:result.value[1],latestStoredAt:result.value[2]?.createdAt.toISOString()??null,definition:'Active statuses created in the last 60 days. Stored imports, not a live Amazon check.'}:null;
  return NextResponse.json({
    unreadMessages:mail.status==='fulfilled'&&!mail.value.stale?mail.value.metrics.responseNeeded:null,
    totalConversations:null,
    queue:mail.status==='fulfilled'?mail.value:null,
    urgentMessages:null,
    activeAtoz:atoz.status==='fulfilled'?atoz.value[0]:null,
    activeChargebacks:chargebacks.status==='fulfilled'?chargebacks.value[0]:null,
    newFeedback:feedback.status==='fulfilled'?feedback.value[0]:null,
    metadata:{atoz:claimMeta(atoz),chargebacks:claimMeta(chargebacks),feedback:{storedTotal:feedback.status==='fulfilled'?feedback.value[1]:null,definition:'Automatic feedback import is not implemented. Manual records only; 0 does not mean no Amazon feedback.'}},
    errors, generatedAt:new Date().toISOString(),
  },{headers:{'Cache-Control':'no-store'}});
}
