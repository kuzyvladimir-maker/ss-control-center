(async () => {
  if (location.origin !== 'https://sellercentral.amazon.com' || !document.body.innerText.includes('Salutem Solutions')) throw Error('Salutem account not loaded');
  const scannedAt = new Date().toISOString();
  const get = async (path) => {
    const response = await fetch(path, {method:'GET', credentials:'same-origin', cache:'no-store', signal:AbortSignal.timeout(20000)});
    if (!response.ok) throw Error(`Inbox GET ${response.status}`);
    return response.json();
  };
  const folder = async (query) => {
    const cases = [], tokens = new Set();
    let next = '';
    for (let page = 0; page < 150; page++) {
      const data = await get('/messaging/api/global/cases?' + query + (next ? '&nextToken=' + encodeURIComponent(next) : ''));
      if (!Array.isArray(data.cases) || typeof data.nextToken !== 'string') throw Error('Incomplete folder response');
      for (const row of data.cases) {
        if (row.merchantId !== 'A3A7A0RDFUSGBS') throw Error('Account mismatch');
        if (cases.some(x => x.caseId === row.caseId)) throw Error('Duplicate page');
        cases.push(row);
      }
      if (!data.nextToken) return cases;
      if (tokens.has(data.nextToken)) throw Error('Repeated pagination token');
      tokens.add(data.nextToken); next = data.nextToken;
    }
    throw Error('Pagination limit: scan incomplete');
  };
  const neededQuery = 'filterList=ACTION_NEEDED&sortDirection=ASCENDING';
  const needed = await folder(neededQuery);
  const resolved = await folder('filterList=STATUS&searchInput=SOLVED&sortDirection=DESCENDING');
  const map = row => ({
    caseId:row.caseId, orderId:row.orders?.[0] || row.mostRecentBuyerSellerOrderId || row.subject?.match(/\d{3}-\d{7}-\d{7}/)?.[0] || null,
    buyerName:row.buyerName, subject:row.subject, receivedAt:new Date(row.lastUpdatedDate).toISOString(),
    deadline:row.actionNeeded ? new Date(row.actionNeeded).toISOString() : null,
    overSla:row.isOverSla === true, status:row.status, resolvedAt:row.resolveDate ? new Date(row.resolveDate).toISOString() : null,
  });
  const items=[];
  for (const row of needed) {
    const detail = await get('/messaging/api/global/cases/' + encodeURIComponent(row.caseId) + '?marketplaceId=' + encodeURIComponent(row.marketplaceId));
    if (detail.partyCase?.merchantId !== 'A3A7A0RDFUSGBS') throw Error('Thread account mismatch');
    const latest = (detail.partyCase.caseArtifacts || []).filter(x=>x.creator?.partyRole === 'BUYER' && x.message?.messageBody).sort((a,b)=>b.createdDate-a.createdDate)[0];
    const item=map(row);
    if (!item.orderId || !latest) throw Error('Missing order or buyer message');
    items.push({...item, text:latest.message.messageBody, receivedAt:new Date(latest.createdDate).toISOString()});
  }
  const check = await folder(neededQuery);
  const fingerprint = rows => JSON.stringify(rows.map(x=>[x.caseId,x.lastUpdatedDate]).sort());
  if (fingerprint(check) !== fingerprint(needed)) throw Error('Inbox changed during scan; defer reconciliation');
  return JSON.stringify({storeIndex:1,accountName:'Salutem Solutions',source:'SELLER_CENTRAL_VPS_GET',complete:true,scannedAt,finishedAt:new Date().toISOString(),items,resolved:resolved.map(map)});
})()
