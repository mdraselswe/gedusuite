# GeduSuite Combo Sets

Turns an ordinary WooCommerce product into a **combo set**: a product whose
price is its own, but whose *stock* belongs to the products inside it.

The rule the whole plugin exists to keep:

> A combo never owns stock. How many sets exist is always
> `min( component stock / quantity per set )`, recalculated from the
> components — never typed in.

So the last robotic aeroplane on the shelf shows as out of stock on the
aeroplane's own page **and** on every combo that contains one, and selling it
either way empties both.

## Install

1. Copy the `gedusuite-combo` folder into `wp-content/plugins/`.
2. Activate **GeduSuite Combo Sets** in Plugins.
3. Activation schedules a nightly re-sync and builds the component index.

Requires WooCommerce with the Store API (WooCommerce Blocks) — the same
version the headless bridge already needs. No settings page.

## Making a combo

There are two ways in. The first is the normal one.

### From GeduSuite (recommended)

1. Build the combo in gedusuite: **Products → Combos → New combo**.
2. For each component, link it to the website product it stands for — the
   picker searches this shop by name, or **Match to website** guesses them all
   at once from SKU and name. Each product only ever has to be linked once.

   Several gedusuite variants may point at one product here. That is the normal
   case when this shop sells as a single listing what gedusuite tracks
   separately — a toy's colours, where the box is packed with whatever is on
   hand. gedusuite offers to link the rest of a product's variants in one go,
   and adds their quantities together before sending the recipe.
3. Press **Put on website**. gedusuite creates the product here as a **draft**
   with the price and the recipe already set, and remembers its id.
4. Open the draft in WooCommerce, add the images and description, and publish.
5. Later price or recipe changes: press **Push update** in gedusuite.

A new product is deliberately created as a draft. This writes to a live shop,
and a wrong price should be caught while reviewing rather than by a customer
paying it.

### Flexible variants from GeduSuite

Enable **Flexible variants / mixed colours** on the GeduSuite combo, then push
the update. All variants of each recipe product are available, including colours
added later. Quantities of the same product become one total: Yellow ×5 plus
Blue ×5 means any mix of ten, including Red or Green. A single Yellow ×10 row
works too. Adding a new colour does not increase the required piece count.
The product uses one shared website listing, resolved from its existing variant
links. New colours do not need separate links. Conflicting links to different
website listings must be resolved before pushing a flexible combo.
GeduSuite suggests the available mix when converting a website lead or entering
a sale, lets the seller adjust it, and saves the actual variant quantities.

Version 1.1.0 exposes `_gedu_combo_flexible_variants = yes` as
`extensions.gedushop.combo.flexible_variants`. The storefront uses it to explain
that colours/variants depend on stock. The website's existing merged component
recipe, stock reduction/restoration, pricing and free-shipping rules continue
to apply. Products without this flag keep their existing presentation.

Deploy this plugin and the storefront update, and apply GeduSuite's
`20260905000000_flexible_combo_variants` migration before deploying GeduSuite.
Existing combos default to fixed variants. No historical order is rewritten.

### By hand, in WooCommerce

For a combo gedusuite doesn't know about:

1. Create a normal product with the combo's price, images and description.
2. **Enable "Manage stock"** on it. The plugin writes the number; with stock
   management off there is nothing to write and Woo treats the combo as always
   in stock.
3. In the **Combo Set** box, list one component per line:

   ```
   412 x 1     # Robotic Aeroplane
   388 x 3     # AA battery
   ```

   The id is the product id — or the **variation id** when the component is
   one fixed variant of a variable product. Text after `#` is a note.

   Listing the same id twice is allowed; the quantities are added together
   before anything counts them.
4. Tick **Free delivery with this combo** if the set carries that promotion.
5. Save. The stock figure is written for you and updates from then on.

Either way: do not edit the combo's own stock quantity by hand — the next
component movement overwrites it.

## What it does behind the scenes

| Moment | What happens |
| --- | --- |
| A component's stock changes | Every combo containing it is recalculated |
| An order is paid | Combo lines reduce the components, not the combo |
| An order is cancelled/refunded | The components are put back |
| Cart validation | Combo demand **plus** loose demand is checked together, so 2 combos + 1 loose aeroplane can't pass with 2 in stock |
| A free-delivery combo in the cart | Shipping rates are zeroed for that order |
| Store API responses | `extensions.gedushop.combo` on both the product and the cart line |
| Nightly | Full re-sync, so anything changed outside WordPress heals itself |

### What derived stock cannot do

Availability here is only as fine-grained as this shop's own catalogue. Where
gedusuite tracks a toy's colours separately and this shop sells one listing for
all of them, a recipe naming "Red" arrives as that listing, and the shop counts
sets against the pooled figure. With Red at 0 and Blue at 8, the shop will
happily sell the set — it has never been told the two are different.

That is the accepted cost of not modelling the colours here, and it is only
safe while the colour is not a promise: the box is packed with whatever is on
hand. If a set ever has to ship a specific colour, this shop has to know about
that colour — as a variation, linked to gedusuite's variant — or the recipe has
to name something that is one thing in both places.

## The Combo Offers category

Every combo is filed under a `combo-offers` product category, created the first
time one is needed and maintained by the plugin: added when a recipe appears,
removed when it goes. It is **appended**, so a combo keeps whatever real
category it already had — the keychain set is still a Gift Box.

The storefront's `/combos` page does not read this category; it lists combos
from the recipe, which cannot drift. The category exists for the shop's own
navigation — the sidebar list and the shop filters — where a combo is
invisible unless it is filed somewhere. Nothing to tick by hand, so a combo
and the list of combos can never disagree.

## How a combo is priced

gedusuite decides what a set sells for and sends it as `_gedu_combo_price`.
This plugin decides how that price is *shown*, because it is the thing that
knows what the contents come to:

| Contents come to | What the shop shows |
| --- | --- |
| More than the set's price | contents total struck through, set price beside it |
| The same or less | just the set price, no struck figure |

Kept apart on purpose. A regular price with a sale price under it reads as a
discount and one alone does not, so those two fields are a *presentation* of a
price rather than the price itself — and they are recalculated whenever a
component's price changes, which is when a saving quoted against a stale total
would start being wrong. The struck figure and the storefront's "bought
separately" line come from the same sum, so they cannot disagree.

A combo built by hand here, with no `_gedu_combo_price`, keeps whatever prices
the shop set. Nothing is taken over that was not handed across.

## Meta keys

| Key | Meaning |
| --- | --- |
| `_gedu_combo_items` | `[{id, qty}, …]` — the recipe. Repeated ids are merged on read |
| `_gedu_combo_free_shipping` | `yes` / `no` |
| `_gedu_combo_price` | What the set sells for, as decided in gedusuite |
| `_gedu_combo_stock_reduced` | Set on an order once its combo lines have been deducted (makes the deduction idempotent) |
| `gedu_combo_index` (option) | component id → combo ids, so a stock change is O(1) to route |

## Keeping it in step with gedusuite

When a combo is pushed from gedusuite, the website product id is recorded there
automatically — nobody types an id anywhere. gedusuite's combo list then has a
**Check website** button that compares its price, line count and piece count
against this shop and says so when they have drifted apart, which is what
happens when somebody edits the price here instead of there.

A combo built by hand in WooCommerce is invisible to gedusuite unless its id is
filled into the combo's *Website product id* field there.
