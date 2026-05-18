# Phase 2.6.1 — Failed AMZCOM Listings Content Analysis

**Generated:** 2026-05-18T20:42:54.919Z
**Scan:** `cmpaisoq80000wlfz4llxuo5k`
**Failure mode:** Amazon PDP code 99300 — "false/promotional claims or external links"

All 10 AMZCOM listings in the 2026-05-19 safety test were rejected by Amazon's PDP classifier during VALIDATION_PREVIEW (before any real PATCH). Since SP-API PATCH replaces the FULL `bullet_point[]` and `product_description` arrays, Amazon validates everything we send — not just our added disclaimer. The disclaimer text itself is defensive (no claims, no URLs), so the trigger must be in the existing content this dump exposes.

## 1. `B0F794DNK5` · AMZCOM

**Title:** Salutem Vita – Bun Length Franks Hot Dogs, Gift Set  – Pack of 4
**SKU:** `742259727733`

### Risk context
- **Reasons (2):**
  - Missing curator/assembler disclaimer
  - Foreign logos detected in main image: Oscar Mayer
- **detected_brands:** —
- **detected_logos:** `Oscar Mayer`

### Original bullets (5)

**1.**
```
• ✅ Includes 8 Oscar Mayer Bun Length Franks for perfect grilling 
•  🍽️ Ideal for family barbecues and gatherings
```
**2.**
```
•  🎁 Comes in a convenient pack for easy storage 
•  💚 Made with quality ingredients for a delicious taste
```
**3.**
```
•  🧊 Keep refrigerated for optimal freshness 
•  ✅ Quick and easy to prepare for any meal
```
**4.**
```
•  🍽️ Perfect size for standard hot dog buns 
•  🎁 Great gift for food lovers and grill enthusiasts
```
**5.**
```
•  💚 No added fillers or by-products 
•  ✅ Trusted brand for quality and taste.
```
### Original description (raw, length=790)

```
<p>Introducing the ultimate frozen food Gift Set, perfect for any occasion! This delightful set features Oscar Mayer Bun-Length Franks Hot Dogs, offering a convenient and delicious meal option for you and your loved ones.</p>

<ul>
  <li>Includes a variety of premium Oscar Mayer Bun-Length Franks Hot Dogs.</li>
  <li>Shipped in insulated packaging with ice packs, ensuring suitability for frozen delivery.</li>
  <li>Enjoy the convenience of easy storage and quick meal preparation.</li>
  <li>Perfect for family gatherings, barbecues, or a quick meal solution.</li>
  <li>High-quality packaging maintains product integrity during transit.</li>
</ul>

<p>Order this frozen food Gift Set today and experience the ease and convenience of having delicious meals ready at your fingertips!</p>
```

### Heuristic analysis — what might trigger PDP code 99300

- **Bullets emoji count:** 10 — `✅ 🍽 🎁 💚 🧊`
- **Bullets URLs:** 0
- **Bullets promotional words:** 3 — `perfect`, `delicious`, `ideal`
- **Bullets health-claim words:** 0
- **Bullets HTML tags:** 0
- **Description emoji count:** 0
- **Description URLs:** 0
- **Description promotional words:** 4 — `ultimate`, `perfect`, `delicious`, `delightful`
- **Description health-claim words:** 0
- **Description HTML tags:** li×10, p×4, ul×2

**Likely 99300 triggers:**
- Emojis present — Amazon's automated PDP classifier sometimes treats them as decoration violating bullet-point guidelines (which require plain factual text).
- Promotional language present — Amazon's policy explicitly bans 'subjective claims' (perfect/ultimate/incredible/etc.) in bullets and descriptions.
- HTML tags present in description (p, ul, li). Limited HTML is allowed in product_description for some product types; for others it's stripped; in either case the validation classifier may treat unbalanced/disallowed tags as a 99300.

---

## 2. `B0F74PMKBH` · AMZCOM

**Title:** Salutem Vita – Bun Length Wieners Hot Dogs, Gift Set – Pack of 14
**SKU:** `742259727306`

### Risk context
- **Reasons (2):**
  - Missing curator/assembler disclaimer
  - Foreign logos detected in main image: Salutem Solutions, Oscar Mayer
- **detected_brands:** —
- **detected_logos:** `Salutem Solutions`, `Oscar Mayer`

### Original bullets (5)

**1.**
```
• ✅ Includes 8 Oscar Mayer Bun-Length Wieners for perfect grilling 
• 🍽️ Ideal for family barbecues and gatherings
```
**2.**
```
• 🎁 Comes in a convenient pack for easy storage 
• 💚 Made with quality meats for a delicious taste
```
**3.**
```
• 🧊 Keep refrigerated for optimal freshness 
• ✅ Ready to cook for quick meal prep
```
**4.**
```
• 🍽️ Perfect size for standard buns 
• 🎁 Great gift set for hot dog lovers
```
**5.**
```
• 💚 No artificial flavors or colors 
• ✅ Easy to transport for picnics and tailgates
```
### Original description (raw, length=1044)

```
<p>Discover the ultimate convenience with our Frozen Food Gift Set, perfect for any occasion. This delightful set includes a variety of delicious products, ensuring there's something for everyone to enjoy.</p>

<ul>
<li>Includes a selection of premium Oscar Mayer Bun-Length Wieners Hot Dogs, ideal for quick and easy meals.</li>
<li>Shipped in insulated packaging with ice packs, ensuring your gift set arrives in perfect condition, ready for frozen delivery.</li>
<li>Enjoy the convenience of having a variety of products on hand, perfect for family gatherings or spontaneous cookouts.</li>
<li>High-quality packaging ensures optimal storage, maintaining the quality of each item until you're ready to enjoy.</li>
<li>Easy to prepare and serve, making meal times hassle-free and enjoyable.</li>
</ul>

<p>This Frozen Food Gift Set is a thoughtful and practical choice, offering a delightful assortment of products that cater to all tastes and preferences. Order now and experience the convenience and quality of this exceptional gift set.</p>
```

### Heuristic analysis — what might trigger PDP code 99300

- **Bullets emoji count:** 10 — `✅ 🍽 🎁 💚 🧊`
- **Bullets URLs:** 0
- **Bullets promotional words:** 3 — `perfect`, `delicious`, `ideal`
- **Bullets health-claim words:** 0
- **Bullets HTML tags:** 0
- **Description emoji count:** 0
- **Description URLs:** 0
- **Description promotional words:** 5 — `ultimate`, `perfect`, `delicious`, `delightful`, `ideal`
- **Description health-claim words:** 0
- **Description HTML tags:** li×10, p×4, ul×2

**Likely 99300 triggers:**
- Emojis present — Amazon's automated PDP classifier sometimes treats them as decoration violating bullet-point guidelines (which require plain factual text).
- Promotional language present — Amazon's policy explicitly bans 'subjective claims' (perfect/ultimate/incredible/etc.) in bullets and descriptions.
- HTML tags present in description (p, ul, li). Limited HTML is allowed in product_description for some product types; for others it's stripped; in either case the validation classifier may treat unbalanced/disallowed tags as a 99300.

---

## 3. `B0F79HNZCM` · AMZCOM

**Title:** Salutem Vita – Center Cut Original Bacon, Premium Quality Pork, Gift Set  – Pack of 8
**SKU:** `742259727580`

### Risk context
- **Reasons (2):**
  - Missing curator/assembler disclaimer
  - Foreign logos detected in main image: Oscar Mayer, Salutem Solutions
- **detected_brands:** —
- **detected_logos:** `Oscar Mayer`, `Salutem Solutions`

### Original bullets (5)

**1.**
```
• ✅ Includes Oscar Mayer Center Cut Original Bacon, 12 Oz Pack 
•  🍽️ Perfect for breakfast, lunch, or dinner recipes
```
**2.**
```
•  🎁 Ideal gift set for bacon lovers 
•  💚 High-quality, center-cut slices for premium taste
```
**3.**
```
•  🧊 Conveniently packaged for easy storage in the fridge 
•  ✅ Ready to cook for quick meal prep
```
**4.**
```
•  🍽️ Versatile ingredient for various dishes 
•  🎁 Attractive packaging for gifting
```
**5.**
```
•  💚 No added preservatives for a natural taste 
•  ✅ Easy to open and reseal for freshness.
```
### Original description (raw, length=851)

```
<p>Discover the ultimate gift for bacon lovers with our Oscar Mayer Center Cut Original Bacon Gift Set. Perfect for any occasion, this set is sure to delight with its premium selection and thoughtful presentation.</p>

<ul>
    <li>Includes a variety of Oscar Mayer Center Cut Original Bacon, offering a delicious experience for every taste.</li>
    <li>Shipped in insulated packaging with ice packs, ensuring it arrives in perfect condition, ready for frozen delivery.</li>
    <li>Convenient and easy to store, making it a hassle-free addition to any kitchen.</li>
    <li>Enjoy the quality packaging that maintains the integrity of the products, providing a seamless experience from delivery to consumption.</li>
    <li>Ideal for gifting, this set combines convenience and quality, making it a standout choice for any bacon enthusiast.</li>
</ul>
```

### Heuristic analysis — what might trigger PDP code 99300

- **Bullets emoji count:** 10 — `✅ 🍽 🎁 💚 🧊`
- **Bullets URLs:** 0
- **Bullets promotional words:** 2 — `perfect`, `ideal`
- **Bullets health-claim words:** 1 — `natural`
- **Bullets HTML tags:** 0
- **Description emoji count:** 0
- **Description URLs:** 0
- **Description promotional words:** 4 — `ultimate`, `perfect`, `delicious`, `ideal`
- **Description health-claim words:** 0
- **Description HTML tags:** li×10, p×2, ul×2

**Likely 99300 triggers:**
- Emojis present — Amazon's automated PDP classifier sometimes treats them as decoration violating bullet-point guidelines (which require plain factual text).
- Promotional language present — Amazon's policy explicitly bans 'subjective claims' (perfect/ultimate/incredible/etc.) in bullets and descriptions.
- Health/wellness words present — for grocery + supplements categories these can trigger FDA-related compliance flags inside Amazon's classifier.
- HTML tags present in description (p, ul, li). Limited HTML is allowed in product_description for some product types; for others it's stripped; in either case the validation classifier may treat unbalanced/disallowed tags as a 99300.

---

## Cross-listing patterns

Aggregating across the 3 sample listings:
- **All bullets+description emoji count:** 30 — `✅ 🍽 🎁 💚 🧊`
- **All bullets+description URLs:** 0
- **All bullets+description promotional words:** 5 — `ultimate`, `perfect`, `delicious`, `delightful`, `ideal`
- **All bullets+description health-claim words:** 1 — `natural`
- **All bullets+description HTML tags:** li×30, p×10, ul×6

If the same heuristic categories (emojis, promotional words, HTML tags) fire on all three, that's a strong signal the AMZCOM seed content was generated by the same template/tool — and a single content sanitiser (Phase 2.6.2 Title/Content rewrite) would fix the whole cohort. If the categories diverge per listing, sanitisation needs to be per-listing rather than templated.

---

# SECTION B — SALUTEM samples (for comparison)

**Generated:** 2026-05-18T23:25:40.057Z
**Source:** 5 evenly-spaced rows from the 998 SALUTEM `plan` rows for scan `cmpaisoq80000wlfz4llxuo5k`. Purpose: confirm or refute the AMZCOM template fingerprint (5 emojis, manual `•` bullets, promotional adjectives, HTML in description) on the Brand-Registry cohort before deciding scrub scope.

## B1. `B0F749MFQT` · SALUTEM

**Title:** Salutem Vita - Reusable Ice Gel Packs |Pack of 50 (7 x 4 inches)| Leakproof, Food-Safe Cold Packs for Shipping Frozen Food, Lunch Boxes, Coolers & Storage
**SKU:** `N50`

### Risk context
- **Reasons (1):**
  - Missing curator/assembler disclaimer
- **detected_brands:** —
- **detected_logos:** —

### Original bullets (1)

**1.**
```
ice gel packs, reusable ice packs, cold therapy gel, freezer packs, food shipping ice, lunch box cooler, cold storage solution, insulated shipping, gel pack for injuries, dry ice alternative
```
### Original description (raw, length=1446)

```
<p>🧊 <strong>Salutem Vita Reusable Ice Gel Packs</strong> offer a safe, efficient way to keep your frozen and perishable goods cold during shipping. Designed for use with lunch boxes, coolers, and insulated containers, these packs maintain a consistent low temperature for extended periods.</p>

<ul>
  <li>✅ <strong>Food-safe and BPA-free:</strong> Made from leakproof, non-toxic materials approved for direct contact with food products.</li>
  <li>♻️ <strong>Reusable design:</strong> Fill once with water, freeze, and reuse — ideal for both commercial and personal use.</li>
  <li>🧊 <strong>Long-lasting cooling:</strong> Each pack (7 x 4 inches) weighs approximately 0.8 lbs after filling and ensures reliable temperature control during transit.</li>
  <li>📦 <strong>Perfect for shipping:</strong> Great for frozen meals, meat, seafood, grocery boxes, and insulated food delivery kits.</li>
  <li>🔒 <strong>Leakproof & condensation-free:</strong> Stays dry, won't leak or damage packaging contents.</li>
  <li>🌱 <strong>Eco-conscious packaging:</strong> Product ships in a protective film wrap without unnecessary boxes — reducing waste and storage volume.</li>
</ul>

<p>📌 Whether you're a business delivering frozen goods or a family packing meals for travel, these gel packs provide reliable cold retention and peace of mind.</p>

<p>❄️ Cold chain friendly — freeze before use and maintain proper temperature throughout delivery.</p>
```

### Heuristic analysis

- **Combined (bullets + description) emoji count:** 9 — `🧊 ✅ ♻ 📦 🔒 🌱 📌 ❄`
- **Combined (bullets + description) manual bullet markers:** 0
- **Combined (bullets + description) URLs:** 0
- **Combined (bullets + description) promotional words:** 2 — `perfect`, `ideal`
- **Combined (bullets + description) health-claim words:** 0
- **Combined (bullets + description) HTML tags:** strong×14, li×12, p×6, ul×2

---

## B2. `B0F93YVWZB` · SALUTEM

**Title:** Salutem Vita – Frozen Veggie Made Cheddar Mac & Cheese, 10 oz, Gift Set – Pack of 16
**SKU:** `742259729928`

### Risk context
- **Reasons (2):**
  - Missing curator/assembler disclaimer
  - Foreign logos detected in main image: Birds Eye
- **detected_brands:** —
- **detected_logos:** `Birds Eye`

### Original bullets (5)

**1.**
```
• ✅ Includes Birds Eye Frozen Veggie Made Cheddar Mac & Cheese - 10oz 
• 🍽️ Made with real cheddar cheese for a rich, creamy taste
```
**2.**
```
• 💚 Packed with veggies for a nutritious twist on a classic dish 
• 🧊 Conveniently frozen to lock in flavor and nutrients
```
**3.**
```
• 🎁 Perfect gift set for busy families or college students 
• ✅ Quick and easy to prepare in minutes
```
**4.**
```
• 🍽️ Ideal for lunch, dinner, or a snack 
• 💚 No artificial flavors or preservatives
```
**5.**
```
• 🧊 Stays fresh in the freezer 
• 🎁 Great for gifting or personal use.
```
### Original description (raw, length=1009)

```
<p>Discover the ultimate convenience with our Birds Eye Frozen Veggie Made Cheddar Mac & Cheese Gift Set. Perfect for those who love delicious, easy-to-prepare meals, this gift set is a delightful addition to any kitchen.</p>

<p>Our gift set includes a variety of Birds Eye's popular frozen meals, ensuring you have a range of options to satisfy your cravings. Each meal is crafted with care, providing a tasty and convenient solution for busy days.</p>

<ul>
<li>Includes a variety of Birds Eye frozen meals</li>
<li>Shipped in insulated packaging with ice packs, ensuring suitability for frozen delivery</li>
<li>Convenient and easy to prepare, perfect for quick meals</li>
<li>High-quality packaging ensures optimal storage and longevity</li>
</ul>

<p>Whether you're looking for a thoughtful gift or a convenient meal solution, our Birds Eye Frozen Veggie Made Cheddar Mac & Cheese Gift Set is the perfect choice. Enjoy the ease of preparation and the delicious taste of these expertly crafted meals.</p>
```

### Heuristic analysis

- **Combined (bullets + description) emoji count:** 10 — `✅ 🍽 💚 🧊 🎁`
- **Combined (bullets + description) manual bullet markers:** 10
- **Combined (bullets + description) URLs:** 0
- **Combined (bullets + description) promotional words:** 5 — `ultimate`, `perfect`, `delicious`, `delightful`, `ideal`
- **Combined (bullets + description) health-claim words:** 0
- **Combined (bullets + description) HTML tags:** li×8, p×6, ul×2

---

## B3. `B0D675ZKW8` · SALUTEM

**Title:** Salutem Vita™ Liquid Advanced Formula Detox - Detox Kit with Test Cup: Liquid Dietary Supplement for Total Body Cleanse - Supplement for Toxin Removal - 3 Pack - 2 Fl Oz (20 Servings)
**SKU:** `WS-BODK-JOBV`

### Risk context
- **Reasons (2):**
  - Missing curator/assembler disclaimer
  - Foreign logos detected in main image: Salutem Vita, DiscoverPlus, FDA, GMP
- **detected_brands:** —
- **detected_logos:** `Salutem Vita`, `DiscoverPlus`, `FDA`, `GMP`

### Original bullets (8)

**1.**
```
👅 Delicious Raspberry Flavor: Salutem Vita™ Advanced Formula Detox stands out with its delightful raspberry flavor, making your detox experience not only effective but also enjoyable. Unlike other detox supplements, our formula offers a pleasing taste sensation, enhancing your overall cleansing journey.
```
**2.**
```
🌿 Comprehensive Detox Support: Our carefully crafted formula contains a blend of powerful ingredients, including vitamins, minerals, herbal extracts, and amino acids, designed to support your body's detoxification processes from head to toe.
```
**3.**
```
💧 Fast-Acting Liquid Formula: Experience the benefits of rapid absorption. Our liquid supplement ensures that essential nutrients and antioxidants are quickly delivered to where they are needed most, helping your body eliminate toxins efficiently.
```
**4.**
```
🍃 Gentle and Digestion-Friendly: Say goodbye to swallowing large pills. Our liquid supplement is gentle on the digestive system and is a perfect choice for those who prefer an easy-to-take, convenient option.
```
**5.**
```
💦 Hydration Support: Proper hydration is key to effective detoxification. Our formula includes hydrating ingredients to help you maintain optimal fluid balance during your detox journey.
```
**6.**
```
📐 Customizable Dosage: Easily adjust your dosage to suit your individual needs and preferences, allowing you to tailor your detox regimen for the best results.
```
**7.**
```
🌟 Revitalize Your Health: By choosing our Liquid Dietary Supplement for Total Body Cleanse, you're taking a significant step toward renewed energy, vitality, and overall well-being. Start your journey to a cleaner, healthier you today!
```
**8.**
```
🩺 Always consult with a healthcare professional before beginning any detox program or using dietary supplements, especially if you have underlying health conditions or are taking medications. Your health and safety are our top priorities.
```
### Original description (raw, length=1213)

```
<p>✔ <strong>Fast Absorption</strong>: Salutem Vita™ Liquid supplements are quickly absorbed by the body, allowing for faster and more efficient delivery of detoxifying nutrients and antioxidants.</p>

<p>✔ <strong>Comprehensive Detox Support</strong>: Salutem Vita™ Advanced Formula Detox - Liquid formulations combine a variety of detoxifying ingredients such as vitamins, minerals, herbal extracts, and amino acids to provide comprehensive support for various detox pathways.</p>

<p>✔ <strong>Gentle and Convenient</strong>: Liquid supplements Advanced Formula Detox are generally gentler on the digestive system compared to pills or capsules. They are also convenient and suitable for individuals who may have difficulty swallowing pills.</p>

<p>✔ <strong>Hydration Boost</strong>: Salutem Vita™ Advanced Formula Detox liquid detox supplements include water and hydrating ingredients, helping to maintain proper hydration levels during the detox process, which is essential for flushing out toxins.</p>

<p>✔ <strong>Customizable Dosage</strong>: Salutem Vita™ Liquid supplements allow for easy adjustment of dosage, making it simpler to tailor your detox regimen to your specific needs and preferences.</p>
```

### Heuristic analysis

- **Combined (bullets + description) emoji count:** 13 — `👅 🌿 💧 🍃 💦 📐 🌟 🩺 ✔`
- **Combined (bullets + description) manual bullet markers:** 0
- **Combined (bullets + description) URLs:** 0
- **Combined (bullets + description) promotional words:** 4 — `best`, `perfect`, `delicious`, `delightful`
- **Combined (bullets + description) health-claim words:** 3 — `boost`, `energy`, `detox`
- **Combined (bullets + description) HTML tags:** p×10, strong×10

---

## B4. `B0FG34274Y` · SALUTEM

**Title:** Commercial Walk-In Freezer Refrigeration Unit/System, Monoblock Unit, Cooling Capacity: 3 HP (5.75 kW / 19,630 BTU / 1.63 Tons), Plug-in, 110V/220V, R404a, No Installation Required
**SKU:** `743269731468`

### Risk context
- **Reasons (1):**
  - Missing curator/assembler disclaimer
- **detected_brands:** —
- **detected_logos:** —

### Original bullets (6)

**1.**
```
🔌 Plug-and-Play Installation – No Setup Required
Just plug it into a 110V/220V outlet — no external condenser, no piping, and no technicians. Fully integrated design for quick deployment.
```
**2.**
```
🧱 All-in-One Monoblock Cooling Unit
Compressor, condenser, and evaporator combined in a single compact body. Saves space and simplifies operation with zero external components.
```
**3.**
```
💪 Cooling Capacity: 3 HP (5.75 kW / 19,630 BTU / 1.63 Tons) Performance + R404a Refrigerant
Powerful commercial-grade cooling using industry-standard refrigerant. Handles large cold rooms with ease and stability.
```
**4.**
```
❄️ –4°F to 46°F Range + Low Noise Operation
Wide cooling range ideal for frozen foods, meat, drinks, and perishables. Operates quietly with minimal vibration — perfect for busy environments.
```
**5.**
```
🛠 Durable, Low Maintenance & Built for Business
Rugged construction, overload protection, and easy access make it ideal for restaurants, warehouses, logistics, and retail storage.
```
**6.**
```
All-in-One Design with Dual Voltage: Plug-and-play monoblock system supports both 110V/60Hz and 220V/50Hz for easy setup.
```
### Original description (raw, length=1534)

```
<h2>Commercial Walk-In Freezer Refrigeration Unit – Model SY3S</h2>

<p>This all-in-one monoblock refrigeration system is engineered for professional cold storage environments, including walk-in freezers and low-temperature cold rooms. With powerful performance and flexible voltage support, it delivers consistent cooling from –4°F to 46°F (–20°C to +8°C).</p>

<h3>Main Features:</h3>
<ul>
  <li>Temperature range: –4°F to 46°F (–20°C to +8°C)</li>
  <li>Cooling capacity: 5.75 kW / 19,630 BTU / 1.63 Tons</li>
  <li>Evaporator area: 258 ft² (24 m²)</li>
  <li>Voltage: 110V/60Hz or 220V/50Hz</li>
  <li>Compressor type: Scroll-type inverter</li>
  <li>Refrigerant: R404a</li>
  <li>Net weight: 238 lbs (108 kg)</li>
  <li>Dimensions: 53" × 26" × 30"</li>
</ul>

<h3>Configuration:</h3>
<ul>
  <li><strong>Model:</strong> SY3S</li>
  <li><strong>Compressor Type:</strong> Scroll-type inverter</li>
  <li><strong>Throttling Mode:</strong> Electronic expansion valve</li>
  <li><strong>Refrigerant:</strong> R404a</li>
  <li><strong>Voltage/Frequency:</strong> 110V/60Hz or 220V/50Hz (dual compatible)</li>
  <li><strong>Maximum Operating Current:</strong> 18 A</li>
  <li><strong>Charge Capacity:</strong> 3.5 kg</li>
  <li><strong>Condensation Temperature:</strong> 95°F (35°C)</li>
</ul>

<h3>Common Applications:</h3>
<ul>
  <li>Walk-in freezers</li>
  <li>Cold rooms and food warehouses</li>
  <li>Meat and seafood facilities</li>
  <li>Grocery and commercial kitchens</li>
  <li>Floral and pharmaceutical cold storage</li>
</ul>
```

### Heuristic analysis

- **Combined (bullets + description) emoji count:** 5 — `🔌 🧱 💪 ❄ 🛠`
- **Combined (bullets + description) manual bullet markers:** 0
- **Combined (bullets + description) URLs:** 0
- **Combined (bullets + description) promotional words:** 2 — `perfect`, `ideal`
- **Combined (bullets + description) health-claim words:** 0
- **Combined (bullets + description) HTML tags:** li×42, strong×16, h3×6, ul×6, h2×2, p×2

---

## B5. `B0FD73JMG8` · SALUTEM

**Title:** Salutem Vita – Deluxe Beef Stroganoff Pasta Meal Kit, 5.5 oz, Gift Set – Pack of 6
**SKU:** `742259734182`

### Risk context
- **Reasons (2):**
  - Missing curator/assembler disclaimer
  - Foreign logos detected in main image: Salutem Solutions, Hamburger Helper
- **detected_brands:** —
- **detected_logos:** `Salutem Solutions`, `Hamburger Helper`

### Original bullets (5)

**1.**
```
• ✅ Includes 6.4 oz box of Hamburger Helper Pasta Stroganoff • 🍽️ Quick and easy meal solution for busy nights
```
**2.**
```
• 💚 Made with real herbs and spices for authentic flavor • 🎁 Perfect gift set for college students or new homeowners
```
**3.**
```
• 🧊 Store conveniently in your pantry for a ready-to-cook meal • ✅ Just add ground beef and water for a complete dish
```
**4.**
```
• 🍽️ Serves a family of five in under 30 minutes • 💚 No artificial flavors or colors
```
**5.**
```
• 🎁 Ideal for gifting during holidays • 🧊 Enjoy a comforting meal anytime!
```
### Original description (raw, length=893)

```
<p>Discover the ultimate convenience with our Gift Set, perfect for those who love quick and delicious meals. This set includes a variety of Hamburger Helper Deluxe Beef Stroganoff Pasta, ensuring a delightful dining experience.</p> <ul>
<li>Gift Set includes a selection of Hamburger Helper Deluxe Beef Stroganoff Pasta.</li>
<li>Shipped in insulated packaging with ice packs, ensuring optimal condition upon arrival.</li>
<li>Perfect for easy storage in your freezer, ready whenever you need a quick meal solution.</li>
<li>Enjoy the convenience of a quick and easy meal preparation, ideal for busy lifestyles.</li>
<li>High-quality packaging ensures your products arrive in excellent condition.</li>
</ul> <p>Whether you're shopping for yourself or looking for the perfect gift, this Gift Set is a fantastic choice for anyone who appreciates the ease and variety of ready-to-cook meals.</p>
```

### Heuristic analysis

- **Combined (bullets + description) emoji count:** 10 — `✅ 🍽 💚 🎁 🧊`
- **Combined (bullets + description) manual bullet markers:** 5
- **Combined (bullets + description) URLs:** 0
- **Combined (bullets + description) promotional words:** 5 — `ultimate`, `perfect`, `delicious`, `delightful`, `ideal`
- **Combined (bullets + description) health-claim words:** 0
- **Combined (bullets + description) HTML tags:** li×10, p×4, ul×2

---

## Cross-listing aggregate (5 SALUTEM samples)

- **All SALUTEM samples emoji count:** 47 — `🧊 ✅ ♻ 📦 🔒 🌱 📌 ❄ 🍽 💚 🎁 👅 🌿 💧 🍃 💦 📐 🌟 🩺 ✔ 🔌 🧱 💪 🛠`
- **All SALUTEM samples manual bullet markers:** 15
- **All SALUTEM samples URLs:** 0
- **All SALUTEM samples promotional words:** 6 — `ultimate`, `best`, `perfect`, `delicious`, `delightful`, `ideal`
- **All SALUTEM samples health-claim words:** 3 — `boost`, `energy`, `detox`
- **All SALUTEM samples HTML tags:** li×72, strong×40, p×28, ul×12, h3×6, h2×2

## VERDICT — A

SALUTEM has SAME template as AMZCOM (emojis + manual bullets + promo + HTML) — apply UNIVERSAL scrub to all 1038 listings.

**Evidence:** SALUTEM samples (5 listings) show emojis=47; manualBullets=15; promo=6; html=p×28,strong×40,ul×12,li×72,h2×2,h3×6. AMZCOM samples (3 failed listings, Section A) showed emojis=30 (5 unique), promo=5, HTML=46 tag instances. Patterns align → universal scrub.

Persisted as the `SCRUB_VERDICT` constant used by `scripts/disclaimer-injection-plan.ts` (and replan).
