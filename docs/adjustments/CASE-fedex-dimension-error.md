# FedEx — repeated dimension mis-capture on one box type

Every shipment below left our facility in the same stock carton, printed **12 × 12 × 10 in**. FedEx's own tracking record shows lengths of 26, 39, 41 and 42 inches for that carton — the width and height are captured correctly within one inch, only the length is wrong. The resulting dimensional weight jumps from ~12 lb to 36–43 lb, which is what the adjustment was billed on.

We are not disputing the tariff. We are disputing the measurement, using FedEx's own recorded values.

| Tracking | Ship date | Order | Declared L×W×H / weight | Carrier's own record L×W×H / weight | Billable declared → recorded | Amount charged |
|---|---|---|---|---|---|---|
| `380984268998` | 2026-05-17 | 112-9151636-5460222 | 12×12×10 in / 12 lb | 13×42×11 in / 11.0 lb | 12 → 43.2 lb | $234.54 |
| `383363656393` | 2026-09-08 | 114-8249440-4023456 | 12×12×10 in / 12 lb | 13×41×11 in / 12.0 lb | 12 → 42.2 lb | $226.00 |
| `382444689135` | 2026-07-20 | 112-1116996-4794658 | 12×12×10 in / 12 lb | 15×26×13 in / 13.0 lb | 12 → 36.5 lb | $174.07 |
| `382574525870` | 2026-07-27 | 113-3177317-2246668 | 12×12×10 in / 10 lb | 13×41×11 in / 11.0 lb | 10.4 → 42.2 lb | $123.25 |
| `381463029750` | 2026-06-04 | 111-6486641-1429042 | 11×6×8 in / 6 lb | 39×12×7 in / 5.0 lb | 6 → 23.6 lb | $66.50 |

**5 shipments · total charged $824.36**

_Carrier records pulled from the carrier's own Track API on 2026-09-20._