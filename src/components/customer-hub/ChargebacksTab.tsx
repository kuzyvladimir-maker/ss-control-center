"use client";

import AtozTab from "./AtozTab";

export default function ChargebacksTab({
  period,
  store,
}: {
  period?: number;
  store?: string;
}) {
  return <AtozTab claimType="CHARGEBACK" period={period} store={store} />;
}
