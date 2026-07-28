// Defense strategy determination for A-to-Z and Chargeback claims

export interface EvidenceData {
  claimsProtected: boolean | null;
  shippedOnTime: boolean | null;
  trackingStatus: string | null; // Delivered | Delayed | InTransit | Lost
  deliveredDate: string | null;
  claimType: string; // A_TO_Z | CHARGEBACK
}

export interface DefenseStrategy {
  type: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  note: string;
  autoRespond: boolean;
}

export function determineDefenseStrategy(data: EvidenceData): DefenseStrategy {
  const { claimsProtected, shippedOnTime, trackingStatus, claimType } = data;

  // Strongest: Buy Shipping Protection
  if (claimsProtected && shippedOnTime) {
    return {
      type: "BUY_SHIPPING_PROTECTION",
      confidence: "HIGH",
      note: "Amazon должен финансировать этот claim. Если списал — апеллировать.",
      autoRespond: true,
    };
  }

  // Delivered + proof of delivery
  if (trackingStatus === "Delivered" && data.deliveredDate) {
    return {
      type: "PROOF_OF_DELIVERY",
      confidence: "HIGH",
      note: "Доставка подтверждена перевозчиком.",
      autoRespond: true,
    };
  }

  // Delivered but customer says not received (possible INR fraud)
  if (trackingStatus === "Delivered" && claimType === "A_TO_Z") {
    return {
      type: "INR_DEFENSE",
      confidence: "MEDIUM",
      note: "Tracking показывает доставку. Возможно мошенничество или неверный адрес.",
      autoRespond: true,
    };
  }

  // Carrier delay
  if (trackingStatus === "Delayed" && shippedOnTime) {
    return {
      type: "CARRIER_DELAY_DEFENSE",
      confidence: claimsProtected ? "HIGH" : "MEDIUM",
      note: "Мы отправили вовремя, задержал перевозчик.",
      autoRespond: false,
    };
  }

  return {
    type: "MANUAL_REVIEW",
    confidence: "LOW",
    note: "Недостаточно данных — требуется проверка Владимира.",
    autoRespond: false,
  };
}
