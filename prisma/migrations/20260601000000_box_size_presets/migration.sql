-- BoxSizePreset — operator-editable list of box sizes shown on the
-- shipping module's PackingProfileDialog and SkuDataDialog. Seeded with
-- the previously-hardcoded set; custom sizes typed into the picker get
-- added here automatically.

CREATE TABLE "BoxSizePreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "length" REAL NOT NULL,
    "width" REAL NOT NULL,
    "height" REAL NOT NULL,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "BoxSizePreset_label_key" ON "BoxSizePreset"("label");
