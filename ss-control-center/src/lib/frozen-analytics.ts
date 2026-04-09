import { prisma } from "@/lib/prisma";
import { getHistoricalWeather } from "@/lib/weather";
import { zipToCoords } from "@/lib/geocoding";

// Tampa, FL — origin location
const ORIGIN_LAT = parseFloat(process.env.ORIGIN_LAT || "27.9506");
const ORIGIN_LON = parseFloat(process.env.ORIGIN_LON || "-82.4572");

function calcDays(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const d1 = new Date(from);
  const d2 = new Date(to);
  const diff = Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
  return diff;
}

/**
 * Collect frozen incident data when a C3 CS case is created.
 * Runs asynchronously — does not block the CS response.
 */
export async function collectFrozenIncidentData(
  csCaseId: string,
  orderId: string | null,
  opts?: {
    sku?: string;
    productName?: string;
    carrier?: string;
    service?: string;
    shipDate?: string;
    promisedEdd?: string;
    actualDelivery?: string;
    trackingNumber?: string;
    destZip?: string;
    destCity?: string;
    destState?: string;
    claimsProtectedBadge?: boolean;
    labelCost?: number;
    boxSize?: string;
    weightLbs?: number;
    resolution?: string;
  }
) {
  try {
    const shipDate = opts?.shipDate || new Date().toISOString().split("T")[0];
    const actualDelivery = opts?.actualDelivery || null;
    const destZip = opts?.destZip || null;

    // Geocode destination ZIP
    const destCoords = destZip ? await zipToCoords(destZip) : null;

    // Fetch origin weather (Tampa on ship date)
    const originWeather = await getHistoricalWeather(
      ORIGIN_LAT,
      ORIGIN_LON,
      shipDate
    );

    // Fetch destination weather (on delivery date)
    const destWeather =
      destCoords && actualDelivery
        ? await getHistoricalWeather(destCoords.lat, destCoords.lon, actualDelivery)
        : null;

    const daysInTransit = calcDays(shipDate, actualDelivery);
    const daysLate = calcDays(opts?.promisedEdd, actualDelivery);

    // Create incident record
    const incident = await prisma.frozenIncident.create({
      data: {
        csCaseId,
        orderId: orderId || "UNKNOWN",
        sku: opts?.sku || "UNKNOWN",
        productName: opts?.productName || "",
        boxSize: opts?.boxSize,
        weightLbs: opts?.weightLbs,
        carrier: opts?.carrier || "unknown",
        service: opts?.service || "unknown",
        shipDate,
        promisedEdd: opts?.promisedEdd,
        actualDelivery,
        daysInTransit,
        daysLate: daysLate && daysLate > 0 ? daysLate : null,
        trackingNumber: opts?.trackingNumber,
        claimsProtectedBadge: opts?.claimsProtectedBadge,
        labelCost: opts?.labelCost,
        destZip,
        destCity: destCoords?.city || opts?.destCity,
        destState: destCoords?.state || opts?.destState,
        destLat: destCoords?.lat,
        destLon: destCoords?.lon,
        originTempF: originWeather?.tempF,
        originFeelsLikeF: originWeather?.feelsLikeF,
        originTempHighF: originWeather?.highF,
        originWeatherDesc: originWeather?.description,
        destTempF: destWeather?.tempF,
        destFeelsLikeF: destWeather?.feelsLikeF,
        destTempHighF: destWeather?.highF,
        destWeatherDesc: destWeather?.description,
        outcome: "thawed",
        customerComplained: true,
        resolution: opts?.resolution,
      },
    });

    // Update SKU risk profile
    await updateSkuRiskProfile(opts?.sku || "UNKNOWN", opts?.productName || "");

    return incident;
  } catch (err) {
    console.error("Failed to collect frozen incident data:", err);
    return null;
  }
}

/**
 * Recalculate the risk profile for a given SKU based on all its incidents.
 */
export async function updateSkuRiskProfile(sku: string, productName?: string) {
  const incidents = await prisma.frozenIncident.findMany({
    where: { sku },
  });

  if (incidents.length === 0) return;

  const thawed = incidents.filter((i) => i.outcome === "thawed");
  const thawRate = incidents.length > 0 ? thawed.length / incidents.length : 0;

  const transits = incidents.map((i) => i.daysInTransit).filter((d): d is number => d !== null);
  const avgDaysInTransit = transits.length > 0 ? transits.reduce((a, b) => a + b, 0) / transits.length : null;

  const originTemps = incidents.map((i) => i.originTempF).filter((t): t is number => t !== null);
  const avgOriginTempF = originTemps.length > 0 ? originTemps.reduce((a, b) => a + b, 0) / originTemps.length : null;

  const destTemps = incidents.map((i) => i.destTempF).filter((t): t is number => t !== null);
  const avgDestTempF = destTemps.length > 0 ? destTemps.reduce((a, b) => a + b, 0) / destTemps.length : null;

  // Most common carrier
  const carrierCounts: Record<string, number> = {};
  for (const i of incidents) {
    carrierCounts[i.carrier] = (carrierCounts[i.carrier] || 0) + 1;
  }
  const mostCommonCarrier = Object.entries(carrierCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Most common service
  const serviceCounts: Record<string, number> = {};
  for (const i of incidents) {
    serviceCounts[i.service] = (serviceCounts[i.service] || 0) + 1;
  }
  const mostCommonService = Object.entries(serviceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Risk score: 0-100
  const riskScore = calculateRiskScore(thawRate, avgDaysInTransit, avgOriginTempF);
  const riskLevel = getRiskLevel(riskScore);

  const lastIncident = incidents.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )[0];

  await prisma.skuRiskProfile.upsert({
    where: { sku },
    create: {
      sku,
      productName: productName || lastIncident?.productName || "",
      totalIncidents: incidents.length,
      thawedCount: thawed.length,
      thawRate,
      avgDaysInTransit,
      avgOriginTempF,
      avgDestTempF,
      mostCommonCarrier,
      mostCommonService,
      riskScore,
      riskLevel,
      lastIncidentDate: lastIncident?.shipDate,
    },
    update: {
      productName: productName || lastIncident?.productName || undefined,
      totalIncidents: incidents.length,
      thawedCount: thawed.length,
      thawRate,
      avgDaysInTransit,
      avgOriginTempF,
      avgDestTempF,
      mostCommonCarrier,
      mostCommonService,
      riskScore,
      riskLevel,
      lastIncidentDate: lastIncident?.shipDate,
    },
  });
}

function calculateRiskScore(
  thawRate: number,
  avgDays: number | null,
  avgOriginTemp: number | null
): number {
  // Thaw rate contributes up to 50 points
  const thawPart = thawRate * 50;
  // Avg transit days: up to 30 points (5+ days = max)
  const daysPart = avgDays ? Math.min(avgDays / 5, 1) * 30 : 0;
  // Origin temp: up to 20 points (70°F baseline, 100°F = max)
  const tempPart = avgOriginTemp
    ? Math.min(Math.max(avgOriginTemp - 70, 0) / 30, 1) * 20
    : 0;

  return Math.min(Math.round(thawPart + daysPart + tempPart), 100);
}

function getRiskLevel(score: number): string {
  if (score >= 70) return "critical";
  if (score >= 40) return "high";
  if (score >= 20) return "medium";
  return "low";
}
