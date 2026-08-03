/**
 * The sample file offered on the products import dialog, and the example
 * printed inside it — deliberately the same value, so what someone downloads
 * is exactly what the documentation shows.
 *
 * It is also a real import: every product here passes the import schema and
 * creates cleanly, which makes "download it, change the values, upload it"
 * the shortest path to a working file. Between them the four products cover
 * every accepted field.
 */
export const PRODUCT_IMPORT_SAMPLE = [
  {
    // Multi-variant: attributeNames declares the dimensions, and each variant
    // supplies a value for each one.
    name: "Baby Romper",
    category: "Baby Clothing",
    sku: "ROM-001",
    barcode: "8901234567890",
    lowStockThreshold: 5,
    attributeNames: ["Size", "Color"],
    variants: [
      {
        attributes: [
          { name: "Size", value: "0-3M" },
          { name: "Color", value: "Pink" },
        ],
        sku: "ROM-001-03P",
        salePrice: 450,
        unitCost: 300,
      },
      {
        attributes: [
          { name: "Size", value: "3-6M" },
          { name: "Color", value: "Blue" },
        ],
        sku: "ROM-001-36B",
        barcode: "8901234567891",
        description: "Full-sleeve, winter fabric",
        salePrice: 480,
        unitCost: 320,
        lowStockThreshold: 10,
      },
    ],
  },
  {
    // Bought by the pack, sold by the piece.
    name: "Delivery Packet 8x12",
    category: "Packaging Material",
    unitsPerPack: 100,
    lowStockThreshold: 200,
    variants: [{ salePrice: 4, unitCost: 2.65 }],
  },
  {
    // Perishable — expiryTracked turns on the expiry date and its alerts.
    name: "Baby Wipes 120pcs",
    category: "Baby Care",
    expiryTracked: true,
    variants: [{ salePrice: 320, unitCost: 240 }],
  },
  // The shortest valid product: name is the only required field. One default
  // variant with no attributes is created for it.
  { name: "Marker Pen" },
];

/** Pretty-printed, because a human reads this before editing it. */
export const PRODUCT_IMPORT_SAMPLE_JSON = JSON.stringify(PRODUCT_IMPORT_SAMPLE, null, 2);

export const PRODUCT_IMPORT_SAMPLE_FILENAME = "gedushop-products-sample.json";
