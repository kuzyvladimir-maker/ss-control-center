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
      note: "Amazon should fund this claim. If they charged us, appeal.",
      autoRespond: true,
    };
  }

  // Delivered + proof of delivery
  if (trackingStatus === "Delivered" && data.deliveredDate) {
    return {
      type: "PROOF_OF_DELIVERY",
      confidence: "HIGH",
      note: "Delivery confirmed by the carrier.",
      autoRespond: true,
    };
  }

  // Delivered but customer says not received (possible INR fraud)
  if (trackingStatus === "Delivered" && claimType === "A_TO_Z") {
    return {
      type: "INR_DEFENSE",
      confidence: "MEDIUM",
      note: "Tracking shows it delivered. Possible fraud or a wrong address.",
      autoRespond: true,
    };
  }

  // Carrier delay
  if (trackingStatus === "Delayed" && shippedOnTime) {
    return {
      type: "CARRIER_DELAY_DEFENSE",
      confidence: claimsProtected ? "HIGH" : "MEDIUM",
      note: "We shipped on time, the carrier was late.",
      autoRespond: false,
    };
  }

  return {
    type: "MANUAL_REVIEW",
    confidence: "LOW",
    note: "Not enough data — Vladimir has to look at it.",
    autoRespond: false,
  };
}
