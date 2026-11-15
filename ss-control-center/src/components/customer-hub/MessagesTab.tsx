"use client";
import { useState, useSyncExternalStore } from 'react';
import MailInboxPanel from './MailInboxPanel';
import MessageDetail from './MessageDetail';
const subscribe=(listener:()=>void)=>{window.addEventListener('popstate',listener);return()=>window.removeEventListener('popstate',listener);};
export default function MessagesTab({ period = 30, processRequest = 0 }: { period?: number; processRequest?: number }) {
  const query=useSyncExternalStore(subscribe,()=>window.location.search,()=> '');
  const [dismissed,setDismissed]=useState(false);
  const caseId=dismissed?null:new URLSearchParams(query).get('message');
  return <><MailInboxPanel period={period} processRequest={processRequest} />{caseId&&<MessageDetail messageId={caseId} onClose={()=>setDismissed(true)} />}</>;
}
