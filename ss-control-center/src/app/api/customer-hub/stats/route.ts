import { NextRequest, NextResponse } from 'next/server';
import { screenInbox } from '@/lib/customer-hub/screen-inbox';
import { prisma } from '@/lib/prisma';
import { activeClaimsWhere } from '@/lib/customer-hub/live-counts';
export async function GET(request: NextRequest) {
  const store=request.nextUrl.searchParams.get('store');
  const storeFilter=store && /^\d+$/.test(store) ? {storeIndex:Number(store)} : {};
  const [screen,atoz,chargebacks,feedback]=await Promise.allSettled([
    screenInbox(),
    Promise.all([prisma.atozzClaim.count({where:activeClaimsWhere('A_TO_Z',storeFilter)}),prisma.atozzClaim.count({where:{claimType:'A_TO_Z',...storeFilter}}),prisma.atozzClaim.findFirst({where:{claimType:'A_TO_Z',...storeFilter},orderBy:{createdAt:'desc'},select:{createdAt:true}})]),
    Promise.all([prisma.atozzClaim.count({where:activeClaimsWhere('CHARGEBACK',storeFilter)}),prisma.atozzClaim.count({where:{claimType:'CHARGEBACK',...storeFilter}}),prisma.atozzClaim.findFirst({where:{claimType:'CHARGEBACK',...storeFilter},orderBy:{createdAt:'desc'},select:{createdAt:true}})]),
    Promise.all([prisma.sellerFeedback.count({where:{status:'NEW'}}),prisma.sellerFeedback.count()]),
  ]);
  const errors:Record<string,string>={};
  for(const [name,result] of [['screen',screen],['atoz',atoz],['chargebacks',chargebacks],['feedback',feedback]] as const) if(result.status==='rejected') errors[name]=`${name} data unavailable; retry refresh`;
  const claimMeta=(result: typeof atoz)=>result.status==='fulfilled'?{storedTotal:result.value[1],latestStoredAt:result.value[2]?.createdAt.toISOString()??null,definition:'Not verified: no current Seller Central source. Stored imports are history only.'}:null;
  return NextResponse.json({
    responseNeeded:(!store || store==='all' || store==='1') && screen.status==='fulfilled'&&!screen.value.stale?screen.value.metrics.responseNeeded:null,
    unreadMessages:(!store || store==='all' || store==='1') && screen.status==='fulfilled'&&!screen.value.stale?screen.value.metrics.unread:null,
    totalConversations:null,
    queue:screen.status==='fulfilled'?screen.value:null,
    urgentMessages:null,
    activeAtoz:null,
    activeChargebacks:null,
    newFeedback:null,
    metadata:{atoz:claimMeta(atoz),chargebacks:claimMeta(chargebacks),feedback:{storedTotal:feedback.status==='fulfilled'?feedback.value[1]:null,definition:'Automatic feedback import is not implemented. Manual records only; 0 does not mean no Amazon feedback.'}},
    errors, generatedAt:new Date().toISOString(),
  },{headers:{'Cache-Control':'no-store'}});
}
