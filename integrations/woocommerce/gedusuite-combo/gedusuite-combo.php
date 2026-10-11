<?php
/**
 * Plugin Name: GeduSuite Combo Sets
 * Description: Sell several products together at one price, with the combo's stock derived from the products inside it rather than kept as a second number.
 * Version:     1.1.0
 * Author:      GeduSuite
 * Requires PHP: 7.4
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE
 *
 * A combo never holds its own stock. Its `_stock` is written, but only ever by
 * this plugin, and always as a figure computed from its components:
 *
 *     buildable = min over components of floor( component stock / qty per set )
 *
 * That is what makes the same piece sellable twice — once on its own, once
 * inside every combo containing it — without two counts that drift apart. Sell
 * the last aeroplane on its own and every combo containing one goes to zero;
 * sell that combo and the aeroplane's own listing goes to zero.
 *
 * Why the figure is STORED rather than filtered on read: the storefront asks
 * the Store API for `?stock_status=instock`, and that is a postmeta query, not
 * a runtime filter. A combo whose components had run out would keep turning up
 * in listings — filtered out one page at a time and counted in none of the
 * totals. So the number is kept true by writing it, not by intercepting reads.
 *
 * Nothing here is the source of truth for the business. GeduSuite holds that,
 * derives its own stock the same way from its own purchase and sale records,
 * and never reads these numbers. This side exists so the shop cannot sell what
 * the shelf cannot supply.
 * ---------------------------------------------------------------------------
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Wire contract with GeduSuite (do not rename): the `_gedu_combo_*` post-meta
 * keys and the `gedushop` Store API extension namespace. They are an interface,
 * not branding — existing combos and the app both depend on them.
 */
define( 'GEDU_COMBO_ITEMS_META', '_gedu_combo_items' );
define( 'GEDU_COMBO_FREE_SHIPPING_META', '_gedu_combo_free_shipping' );

/**
 * What the combo sells for, as decided in gedusuite.
 *
 * Kept apart from WooCommerce's own price fields on purpose. Those two say how
 * the price is *presented* — a regular price with a sale price under it is a
 * discount, one alone is not — and that presentation is worked out here from
 * what the contents come to. If the selling price lived only in them there
 * would be nothing left to work it out from.
 */
define( 'GEDU_COMBO_PRICE_META', '_gedu_combo_price' );
/** Guards against reducing a combo's components twice for one order. */
define( 'GEDU_COMBO_REDUCED_META', '_gedu_combo_stock_reduced' );
/** component product id => [ combo product ids ]. Rebuilt whenever a combo is saved. */
define( 'GEDU_COMBO_INDEX_OPTION', 'gedu_combo_index' );

/** The product category every combo is filed under, so the shop can list them. */
define( 'GEDU_COMBO_TERM_SLUG', 'combo-offers' );
define( 'GEDU_COMBO_TERM_NAME', 'Combo Offers' );

/* ===========================================================================
 * Reading the recipe
 * ======================================================================== */

/**
 * A combo's components, or an empty array for an ordinary product.
 *
 * Returns [ [ 'id' => int, 'qty' => int ], ... ] with each product appearing
 * once. Everything else in this file goes through here, so a malformed meta
 * value degrades to "not a combo" rather than to a fatal on the shop front,
 * and a recipe naming one product twice is counted correctly everywhere at
 * once rather than in each of the dozen places that reads a recipe.
 *
 * Repeats are real and expected. The shop that pushes these recipes tracks a
 * toy's colours as separate things and sells them here as one listing, so
 * "Red x1, Blue x2" arrives as that listing, twice. It merges to x3 before
 * anything counts it, because the arithmetic downstream takes the smallest
 * stock/qty across the rows: left as two rows, ten in stock answers
 * min(10/1, 10/2) = 5 sets when only 3 can be packed, and the shop would sell
 * the difference. Hand-written recipes in the box below can repeat a product
 * the same way, which is why this is fixed here and not only at the sender.
 */
function gedu_combo_items( $product_id ) {
	$raw = get_post_meta( $product_id, GEDU_COMBO_ITEMS_META, true );
	if ( empty( $raw ) || ! is_array( $raw ) ) {
		return array();
	}
	$items = array();
	foreach ( $raw as $row ) {
		$id  = isset( $row['id'] ) ? absint( $row['id'] ) : 0;
		$qty = isset( $row['qty'] ) ? absint( $row['qty'] ) : 0;
		// A component that no longer exists, or a zero quantity, would make the
		// buildable count meaningless. Dropping the row would quietly make the
		// combo MORE available; keeping it as an unsatisfiable line is wrong
		// too. Neither: an invalid recipe is not a combo (see below).
		if ( $id > 0 && $qty > 0 ) {
			$items[] = array(
				'id'  => $id,
				'qty' => $qty,
			);
		}
	}
	// Any bad row and the whole recipe is refused, because a partially-read
	// recipe would sell a box with something missing from it. Checked before
	// merging, while the row counts are still comparable.
	if ( count( $items ) !== count( $raw ) ) {
		return array();
	}
	$merged = array();
	foreach ( $items as $item ) {
		$id = $item['id'];
		if ( isset( $merged[ $id ] ) ) {
			$merged[ $id ]['qty'] += $item['qty'];
		} else {
			$merged[ $id ] = $item;
		}
	}
	// Values only: callers index these positionally, and array_values also
	// keeps them in the order the recipe was written.
	return array_values( $merged );
}

function gedu_is_combo( $product_id ) {
	return count( gedu_combo_items( $product_id ) ) > 0;
}

function gedu_combo_free_shipping( $product_id ) {
	return 'yes' === get_post_meta( $product_id, GEDU_COMBO_FREE_SHIPPING_META, true );
}

/* ===========================================================================
 * Derived stock
 * ======================================================================== */

/**
 * How many complete sets the components on hand can make.
 *
 * A component that does not manage stock is treated as unlimited rather than
 * as zero: WooCommerce already sells it without counting, and a combo should
 * not be the one place that suddenly starts.
 */
function gedu_combo_buildable( $product_id ) {
	$items = gedu_combo_items( $product_id );
	if ( empty( $items ) ) {
		return null;
	}
	$buildable = null;
	foreach ( $items as $item ) {
		$component = wc_get_product( $item['id'] );
		if ( ! $component ) {
			// A deleted component means the box cannot be packed at all. Zero,
			// loudly, rather than an unlimited supply of an incomplete set.
			return 0;
		}
		if ( ! $component->managing_stock() ) {
			if ( ! $component->is_in_stock() ) {
				return 0;
			}
			continue;
		}
		$have  = (int) $component->get_stock_quantity();
		$sets  = (int) floor( $have / $item['qty'] );
		$sets  = max( 0, $sets );
		$buildable = ( null === $buildable ) ? $sets : min( $buildable, $sets );
	}
	// Every component sells without counting — nothing limits the combo either.
	return null === $buildable ? null : $buildable;
}

/**
 * Write a combo's derived stock onto the combo product.
 *
 * Idempotent and authoritative: whatever WooCommerce may have done to this
 * product's `_stock` a moment earlier (it reduces the combo's own count on an
 * order like any other line) is overwritten with the figure the components
 * actually support. That is deliberate — it means the two paths cannot
 * disagree no matter which ran first.
 */
function gedu_combo_sync_stock( $combo_id ) {
	$combo = wc_get_product( $combo_id );
	if ( ! $combo || ! gedu_is_combo( $combo_id ) ) {
		return;
	}
	$buildable = gedu_combo_buildable( $combo_id );

	if ( null === $buildable ) {
		// Nothing inside is counted, so counting the combo would invent a
		// limit. Leave it uncounted and in stock.
		$combo->set_manage_stock( false );
		$combo->set_stock_status( 'instock' );
		$combo->save();
		return;
	}

	$combo->set_manage_stock( true );
	$combo->set_stock_quantity( $buildable );
	$combo->set_stock_status( $buildable > 0 ? 'instock' : 'outofstock' );
	// Never let a combo be backordered: there is no such thing as owing a set
	// whose parts do not exist, and a backorder here would sell components
	// that other orders are relying on.
	$combo->set_backorders( 'no' );
	$combo->save();

	wc_delete_product_transients( $combo_id );
}

/** Every combo that contains this product, from the index. */
function gedu_combos_containing( $product_id ) {
	$index = get_option( GEDU_COMBO_INDEX_OPTION, array() );
	if ( ! is_array( $index ) || empty( $index[ $product_id ] ) ) {
		return array();
	}
	return array_map( 'absint', (array) $index[ $product_id ] );
}

/**
 * Rebuild the component -> combos index.
 *
 * A stored index rather than a meta_query on every stock movement: the query
 * would be a LIKE over serialised postmeta, run on every sale of every product
 * in the shop. This is rebuilt only when a combo is saved or deleted, which is
 * rare, and read on every stock change, which is not.
 */
function gedu_combo_rebuild_index() {
	$index  = array();
	$combos = get_posts(
		array(
			'post_type'      => 'product',
			'post_status'    => array( 'publish', 'private', 'draft', 'pending' ),
			'posts_per_page' => -1,
			'fields'         => 'ids',
			'meta_key'       => GEDU_COMBO_ITEMS_META,
			'meta_compare'   => 'EXISTS',
		)
	);
	foreach ( $combos as $combo_id ) {
		foreach ( gedu_combo_items( $combo_id ) as $item ) {
			$index[ $item['id'] ][] = (int) $combo_id;
		}
	}
	update_option( GEDU_COMBO_INDEX_OPTION, $index, false );
	return $index;
}

/**
 * A component's stock moved — bring every combo containing it back in line.
 *
 * This is the half of the rule that handles "sell the single, the combo goes
 * out of stock". The other half — "sell the combo, the single goes out of
 * stock" — is the order hook below, which reduces components and lands back
 * here.
 */
function gedu_combo_on_component_stock_change( $product_id ) {
	static $syncing = false;
	if ( $syncing ) {
		// Syncing a combo writes that combo's own stock, which fires this hook
		// again. A combo is never a component of another combo here, so this
		// is belt and braces — but a stock loop on a live shop is not
		// something to leave to a convention.
		return;
	}
	$product_id = absint( is_object( $product_id ) ? $product_id->get_id() : $product_id );
	$combos     = gedu_combos_containing( $product_id );
	if ( empty( $combos ) ) {
		return;
	}
	$syncing = true;
	foreach ( $combos as $combo_id ) {
		gedu_combo_sync_stock( $combo_id );
	}
	$syncing = false;
}
add_action( 'woocommerce_updated_product_stock', 'gedu_combo_on_component_stock_change', 20 );
add_action( 'woocommerce_variation_set_stock', 'gedu_combo_on_component_stock_change', 20 );
add_action( 'woocommerce_product_set_stock', 'gedu_combo_on_component_stock_change', 20 );

/**
 * A recipe that arrived without anybody opening the editor.
 *
 * gedusuite writes combos over the WooCommerce REST API, so the metabox save
 * handler — which needs a form nonce — never runs for them. Without this the
 * index would not know the new combo existed and its stock figure would stay
 * whatever WooCommerce happened to leave there until the nightly sync, which
 * is to say the shop would sell a set it could not build.
 *
 * Fires after the product has been saved, for both create and update.
 */
/* ===========================================================================
 * The combo category
 * ======================================================================== */

/**
 * The Combo Offers term, created the first time it is needed.
 *
 * The storefront lists combos from the recipe, which cannot drift. This term
 * exists for a different job: the shop's own category sidebar and filters,
 * where a combo is invisible unless it is filed somewhere. Filed by the plugin
 * rather than by hand, because a category somebody has to remember to tick is
 * a category that will one day be missing from a combo that still behaves like
 * one — the listing would disagree with the product, and neither would be
 * obviously wrong.
 *
 * @return int|null Term id, or null if it could not be created.
 */
function gedu_combo_term_id() {
	$term = get_term_by( 'slug', GEDU_COMBO_TERM_SLUG, 'product_cat' );
	if ( $term && ! is_wp_error( $term ) ) {
		return (int) $term->term_id;
	}
	$created = wp_insert_term(
		GEDU_COMBO_TERM_NAME,
		'product_cat',
		array( 'slug' => GEDU_COMBO_TERM_SLUG )
	);
	if ( is_wp_error( $created ) ) {
		// Almost always "term exists" from a race between two saves.
		$existing = $created->get_error_data( 'term_exists' );
		return $existing ? (int) $existing : null;
	}
	return (int) $created['term_id'];
}

/**
 * File this product under Combo Offers, or take it out if it is not one.
 *
 * Appends rather than replaces: a combo usually belongs in a real category too
 * — the keychain set is still a Gift Box — and the shop's own navigation would
 * lose it if this became its only home.
 */
function gedu_combo_apply_category( $product_id ) {
	$product_id = absint( $product_id );
	if ( ! $product_id || 'product' !== get_post_type( $product_id ) ) {
		return;
	}
	$term_id = gedu_combo_term_id();
	if ( ! $term_id ) {
		return;
	}

	$current = wp_get_object_terms( $product_id, 'product_cat', array( 'fields' => 'ids' ) );
	if ( is_wp_error( $current ) ) {
		return;
	}
	$current = array_map( 'intval', $current );
	$has     = in_array( $term_id, $current, true );
	$should  = gedu_is_combo( $product_id );

	if ( $has === $should ) {
		return;
	}
	if ( $should ) {
		wp_set_object_terms( $product_id, array( $term_id ), 'product_cat', true );
	} else {
		wp_remove_object_terms( $product_id, array( $term_id ), 'product_cat' );
	}
	// Counts are cached per term; without this the sidebar keeps the old number
	// until something else happens to clear it.
	wp_update_term_count_now( array( $term_id ), 'product_cat' );
	wc_delete_product_transients( $product_id );
}

add_action(
	'woocommerce_rest_insert_product_object',
	function ( $object ) {
		$product_id = $object->get_id();
		gedu_combo_apply_category( $product_id );
		gedu_combo_sync_price( $product_id );
		if ( ! gedu_is_combo( $product_id ) ) {
			// It may have just STOPPED being one — an emptied recipe still has
			// to leave the index, or a component change would keep syncing a
			// product that is now an ordinary one.
			gedu_combo_rebuild_index();
			return;
		}
		gedu_combo_rebuild_index();
		gedu_combo_sync_stock( $product_id );
	},
	20,
	1
);

/**
 * The same safety net for every other way the meta could change: WP-CLI, an
 * importer, a direct update_post_meta from some other plugin.
 *
 * Deferred to shutdown rather than run in place. The meta is written from
 * inside WC_Data::save(), and recalculating stock in the middle of a save is
 * how re-entrant writes and half-written products happen. By shutdown the
 * product is whole.
 */
function gedu_combo_queue_resync( $product_id ) {
	static $queued = array();
	$product_id = absint( $product_id );
	if ( ! $product_id || isset( $queued[ $product_id ] ) ) {
		return;
	}
	$queued[ $product_id ] = true;
	add_action(
		'shutdown',
		function () use ( $product_id ) {
			gedu_combo_rebuild_index();
			gedu_combo_apply_category( $product_id );
			if ( gedu_is_combo( $product_id ) ) {
				gedu_combo_sync_price( $product_id );
				gedu_combo_sync_stock( $product_id );
			}
		}
	);
}

add_action(
	'updated_post_meta',
	function ( $meta_id, $object_id, $meta_key ) {
		if ( GEDU_COMBO_ITEMS_META === $meta_key ) {
			gedu_combo_queue_resync( $object_id );
		}
	},
	20,
	3
);
add_action(
	'added_post_meta',
	function ( $meta_id, $object_id, $meta_key ) {
		if ( GEDU_COMBO_ITEMS_META === $meta_key ) {
			gedu_combo_queue_resync( $object_id );
		}
	},
	20,
	3
);

/* ===========================================================================
 * Orders: a combo takes its components off the shelf, not itself
 * ======================================================================== */

/**
 * Reduce the components of every combo on this order.
 *
 * Runs after WooCommerce has done its own reduction. It does NOT try to stop
 * Woo reducing the combo product's own count — that number is derived, and
 * gedu_combo_sync_stock (reached through the component change above)
 * overwrites whatever Woo left there with the truth.
 *
 * The order meta guard matters: this hook fires again on a status change that
 * re-triggers reduction, and without it a retried webhook or a manual status
 * flip would take the components off the shelf twice.
 */
function gedu_combo_reduce_order_stock( $order ) {
	if ( ! $order instanceof WC_Order ) {
		return;
	}
	if ( $order->get_meta( GEDU_COMBO_REDUCED_META ) ) {
		return;
	}
	$touched = array();
	foreach ( $order->get_items() as $line ) {
		$product_id = $line->get_product_id();
		$items      = gedu_combo_items( $product_id );
		if ( empty( $items ) ) {
			continue;
		}
		$sets = max( 1, (int) $line->get_quantity() );
		foreach ( $items as $item ) {
			$component = wc_get_product( $item['id'] );
			if ( ! $component || ! $component->managing_stock() ) {
				continue;
			}
			wc_update_product_stock( $component, $item['qty'] * $sets, 'decrease' );
			$touched[] = $item['id'];
			$order->add_order_note(
				sprintf(
					/* translators: 1: component name, 2: pieces taken, 3: combo name */
					__( 'Combo stock: %1$s reduced by %2$d (part of %3$s)', 'gedusuite-combo' ),
					$component->get_name(),
					$item['qty'] * $sets,
					$line->get_name()
				)
			);
		}
	}
	if ( ! empty( $touched ) ) {
		$order->update_meta_data( GEDU_COMBO_REDUCED_META, 'yes' );
		$order->save();
	}
}
add_action( 'woocommerce_reduce_order_stock', 'gedu_combo_reduce_order_stock', 20 );

/** The same, backwards, when an order is cancelled or refunded. */
function gedu_combo_restore_order_stock( $order ) {
	if ( ! $order instanceof WC_Order ) {
		return;
	}
	if ( ! $order->get_meta( GEDU_COMBO_REDUCED_META ) ) {
		return;
	}
	foreach ( $order->get_items() as $line ) {
		$items = gedu_combo_items( $line->get_product_id() );
		if ( empty( $items ) ) {
			continue;
		}
		$sets = max( 1, (int) $line->get_quantity() );
		foreach ( $items as $item ) {
			$component = wc_get_product( $item['id'] );
			if ( ! $component || ! $component->managing_stock() ) {
				continue;
			}
			wc_update_product_stock( $component, $item['qty'] * $sets, 'increase' );
		}
	}
	$order->delete_meta_data( GEDU_COMBO_REDUCED_META );
	$order->save();
}
add_action( 'woocommerce_restore_order_stock', 'gedu_combo_restore_order_stock', 20 );

/* ===========================================================================
 * The cart: one shelf, however the pieces were picked
 * ======================================================================== */

/**
 * What this cart is asking of each component, combos expanded.
 *
 * The reason cart-level validation exists at all. Two combos each containing
 * an aeroplane, plus an aeroplane on its own, is a demand of three aeroplanes
 * — and WooCommerce checks each line against stock separately, so all three
 * lines pass while the cart as a whole cannot be packed. Per-item validation
 * cannot see this; only a sum over the whole cart can.
 *
 * Returns [ product_id => pieces wanted ].
 */
function gedu_combo_cart_demand( $cart ) {
	$demand = array();
	foreach ( $cart->get_cart() as $cart_item ) {
		$product_id = (int) $cart_item['product_id'];
		$qty        = max( 1, (int) $cart_item['quantity'] );
		$items      = gedu_combo_items( $product_id );
		if ( empty( $items ) ) {
			// A variation is its own stock-keeping thing; count it, not the parent.
			$id = ! empty( $cart_item['variation_id'] ) ? (int) $cart_item['variation_id'] : $product_id;
			$demand[ $id ] = ( isset( $demand[ $id ] ) ? $demand[ $id ] : 0 ) + $qty;
			continue;
		}
		foreach ( $items as $item ) {
			$demand[ $item['id'] ] = ( isset( $demand[ $item['id'] ] ) ? $demand[ $item['id'] ] : 0 )
				+ ( $item['qty'] * $qty );
		}
	}
	return $demand;
}

/** Components this cart wants more of than exist, as readable sentences. */
function gedu_combo_cart_shortfalls( $cart ) {
	$problems = array();
	foreach ( gedu_combo_cart_demand( $cart ) as $product_id => $wanted ) {
		$product = wc_get_product( $product_id );
		if ( ! $product || ! $product->managing_stock() ) {
			continue;
		}
		if ( 'no' !== $product->get_backorders() ) {
			continue;
		}
		$have = (int) $product->get_stock_quantity();
		if ( $wanted > $have ) {
			$problems[] = sprintf(
				/* translators: 1: product name, 2: pieces in stock, 3: pieces the cart wants */
				__( 'Only %2$d of %1$s left — your basket needs %3$d, counting what is inside your combos.', 'gedusuite-combo' ),
				$product->get_name(),
				$have,
				$wanted
			);
		}
	}
	return $problems;
}

/**
 * Store API cart validation.
 *
 * `woocommerce_store_api_cart_errors` is the cart-level hook — it runs with
 * the whole cart in hand, which is the only place the sum above can be
 * checked. The headless storefront reads the message straight out of the
 * response, so it is written for a shopper rather than for a log.
 */
add_action(
	'woocommerce_store_api_cart_errors',
	function ( $errors, $cart ) {
		foreach ( gedu_combo_cart_shortfalls( $cart ) as $message ) {
			$errors->add( 'gedu_combo_stock', $message );
		}
	},
	10,
	2
);

/**
 * The classic checkout path, for the admin's own order-editing screens and
 * anything that still goes through WC()->cart. Same sum, same sentences.
 */
add_action(
	'woocommerce_check_cart_items',
	function () {
		if ( ! function_exists( 'WC' ) || ! WC()->cart ) {
			return;
		}
		foreach ( gedu_combo_cart_shortfalls( WC()->cart ) as $message ) {
			wc_add_notice( $message, 'error' );
		}
	}
);

/**
 * Free delivery, when a combo in the basket carries it.
 *
 * Zeroing the rates rather than adding a coupon: a coupon can be removed while
 * the combo stays, and then the offer the customer was shown is not the offer
 * they get. This follows the goods.
 */
add_filter(
	'woocommerce_package_rates',
	function ( $rates, $package ) {
		$free = false;
		foreach ( $package['contents'] as $cart_item ) {
			if ( gedu_combo_free_shipping( (int) $cart_item['product_id'] ) ) {
				$free = true;
				break;
			}
		}
		if ( ! $free ) {
			return $rates;
		}
		foreach ( $rates as $rate ) {
			$rate->set_cost( 0 );
			$rate->set_taxes( array() );
		}
		return $rates;
	},
	20,
	2
);

/* ===========================================================================
 * What the storefront and the order see
 * ======================================================================== */

/** One component, as the storefront wants to render it. */
/**
 * What the contents come to when bought one by one.
 *
 * The same figure the storefront prints as "bought separately", so the crossed
 * out price and that line can never be two different numbers. In shop money,
 * not minor units.
 */
function gedu_combo_components_total( $product_id ) {
	$total = 0.0;
	foreach ( gedu_combo_items( $product_id ) as $item ) {
		$component = wc_get_product( $item['id'] );
		if ( ! $component ) {
			continue;
		}
		$total += (float) wc_get_price_to_display( $component ) * (int) $item['qty'];
	}
	return $total;
}

/**
 * Write the combo's price the way a set should read: contents struck through,
 * the set's own price beside it.
 *
 * A combo that saves nothing gets no struck price. Inventing one would mean
 * printing a number nobody was ever asked to pay, which is the kind of thing
 * that makes every other discount on the shop worth ignoring.
 */
function gedu_combo_sync_price( $combo_id ) {
	$selling = get_post_meta( $combo_id, GEDU_COMBO_PRICE_META, true );
	if ( '' === $selling || ! is_numeric( $selling ) ) {
		// Nothing has told us what it sells for — a combo built by hand here.
		// Leave whatever prices the shop set alone.
		return;
	}
	$product = wc_get_product( $combo_id );
	if ( ! $product || ! gedu_is_combo( $combo_id ) ) {
		return;
	}

	$selling = (float) $selling;
	$total   = gedu_combo_components_total( $combo_id );

	if ( $total > $selling ) {
		$product->set_regular_price( wc_format_decimal( $total ) );
		$product->set_sale_price( wc_format_decimal( $selling ) );
	} else {
		$product->set_regular_price( wc_format_decimal( $selling ) );
		$product->set_sale_price( '' );
	}
	$product->save();
	wc_delete_product_transients( $combo_id );
}

/**
 * A component's price moved — every set it belongs to is now quoting a saving
 * against a figure that has changed.
 *
 * The stock hooks above have a twin for exactly this reason; a combo derives
 * two things from its contents and this is the other one.
 */
function gedu_combo_on_component_price_change( $product_id ) {
	static $syncing = false;
	if ( $syncing ) {
		return;
	}
	$product_id = absint( is_object( $product_id ) ? $product_id->get_id() : $product_id );
	if ( ! $product_id || gedu_is_combo( $product_id ) ) {
		// Saving a combo fires this hook for the combo itself.
		return;
	}
	$combos = gedu_combos_containing( $product_id );
	if ( empty( $combos ) ) {
		return;
	}
	$syncing = true;
	foreach ( $combos as $combo_id ) {
		gedu_combo_sync_price( $combo_id );
	}
	$syncing = false;
}
add_action( 'woocommerce_update_product', 'gedu_combo_on_component_price_change', 20 );
add_action( 'woocommerce_update_product_variation', 'gedu_combo_on_component_price_change', 20 );

function gedu_combo_component_payload( $item ) {
	$product = wc_get_product( $item['id'] );
	if ( ! $product ) {
		return null;
	}
	$image_id = $product->get_image_id();
	// Minor units, and the shop's own number of them rather than an assumed
	// two: everything else the Store API sends is scaled by this, and the
	// storefront divides by currency_minor_unit to get taka back.
	$scale = pow( 10, wc_get_price_decimals() );
	return array(
		'id'    => (int) $product->get_id(),
		'name'  => wp_specialchars_decode( $product->get_name(), ENT_QUOTES ),
		'slug'  => $product->get_slug(),
		'qty'   => (int) $item['qty'],
		'price' => (int) round( (float) wc_get_price_to_display( $product ) * $scale ),
		'image' => $image_id ? wp_get_attachment_image_url( $image_id, 'woocommerce_thumbnail' ) : null,
	);
}

/**
 * `extensions.gedushop.combo` on the Store API product response.
 *
 * The storefront is a static export that talks to this API directly, so
 * everything it needs to render "what is in this combo", the saving, and the
 * cross-sell on each component's own page has to arrive here.
 */
add_action(
	'woocommerce_blocks_loaded',
	function () {
		if ( ! function_exists( 'woocommerce_store_api_register_endpoint_data' ) ) {
			return;
		}
		// The same recipe on the CART item, so the basket can say "free delivery
		// with this combo" before a district has been chosen and there is any
		// shipping figure to read it from. The storefront's free-delivery
		// progress bar is the one thing that has to know without asking.
		woocommerce_store_api_register_endpoint_data(
			array(
				'endpoint'        => Automattic\WooCommerce\StoreApi\Schemas\V1\CartItemSchema::IDENTIFIER,
				'namespace'       => 'gedushop',
				'data_callback'   => function ( $cart_item ) {
					$product_id = isset( $cart_item['product_id'] ) ? (int) $cart_item['product_id'] : 0;
					$items      = gedu_combo_items( $product_id );
					// A sibling of `combo`, not a field inside it: free delivery is
					// a plain product's own promotion just as often as a combo's,
					// and nesting it here would leave it unreachable — the
					// storefront's various "combo && …" checks exist to hide combo
					// content on a product that has none, and would have hidden
					// this along with it.
					$data = array( 'free_shipping' => gedu_combo_free_shipping( $product_id ) );
					if ( ! empty( $items ) ) {
						$names = array();
						foreach ( $items as $item ) {
							$product = wc_get_product( $item['id'] );
							if ( $product ) {
								$names[] = sprintf( '%s x%d', $product->get_name(), $item['qty'] );
							}
						}
						$data['combo'] = array(
							'flexible_variants' => 'yes' === get_post_meta( $product->get_id(), '_gedu_combo_flexible_variants', true ),
							'includes' => $names,
						);
					}
					return $data;
				},
				'schema_callback' => function () {
					return array(
						'free_shipping' => array(
							'description' => __( 'Whether this basket line ships free on its own.', 'gedusuite-combo' ),
							'type'        => 'boolean',
							'readonly'    => true,
						),
						'combo'         => array(
							'description' => __( 'Combo details for this basket line.', 'gedusuite-combo' ),
							'type'        => array( 'object', 'null' ),
							'readonly'    => true,
						),
					);
				},
			)
		);

		woocommerce_store_api_register_endpoint_data(
			array(
				'endpoint'        => Automattic\WooCommerce\StoreApi\Schemas\V1\ProductSchema::IDENTIFIER,
				'namespace'       => 'gedushop',
				'data_callback'   => function ( $product ) {
					$items         = gedu_combo_items( $product->get_id() );
					$free_shipping = gedu_combo_free_shipping( $product->get_id() );
					// Same split as the cart-item callback above: free delivery is
					// its own product-level fact, not something worth burying
					// inside `combo` where an ordinary product's page could never
					// reach it.
					$data = array( 'free_shipping' => $free_shipping );
					if ( ! empty( $items ) ) {
						$components = array();
						$total      = 0;
						foreach ( $items as $item ) {
							$payload = gedu_combo_component_payload( $item );
							if ( ! $payload ) {
								continue;
							}
							$components[] = $payload;
							// Minor units here, because everything the Store API
							// sends is in them; gedu_combo_components_total works
							// in shop money for the price fields. Same sum.
							$total       += $payload['price'] * $payload['qty'];
						}
						$data['combo'] = array(
							'items'            => $components,
							// What the same goods list for bought separately —
							// the storefront shows the difference as the saving,
							// and computing it here keeps one definition of it.
							'components_total' => $total,
							'free_shipping'    => $free_shipping,
						);
					}
					return $data;
				},
				'schema_callback' => function () {
					return array(
						'free_shipping' => array(
							'description' => __( 'Whether this product ships free on its own.', 'gedusuite-combo' ),
							'type'        => 'boolean',
							'readonly'    => true,
						),
						'combo'         => array(
							'description' => __( 'Products inside this combo set.', 'gedusuite-combo' ),
							'type'        => array( 'object', 'null' ),
							'readonly'    => true,
						),
					);
				},
			)
		);
	}
);

/**
 * What a combo line says on the order.
 *
 * Two pieces of meta, doing different jobs. `_gedu_combo` is underscore-
 * prefixed, so WooCommerce hides it from the customer AND GeduSuite's lead
 * importer skips it when it builds the readable item line — it is there for
 * the machine. `Includes` is visible, so the order email, the admin screen and
 * that same lead line all say what was in the box without anyone looking the
 * combo up.
 */
add_action(
	'woocommerce_checkout_create_order_line_item',
	function ( $line, $cart_item_key, $values, $order ) {
		$product_id = (int) $values['product_id'];
		$items      = gedu_combo_items( $product_id );
		if ( empty( $items ) ) {
			return;
		}
		$readable = array();
		$machine  = array();
		foreach ( $items as $item ) {
			$product = wc_get_product( $item['id'] );
			if ( ! $product ) {
				continue;
			}
			$readable[] = sprintf( '%s x%d', $product->get_name(), $item['qty'] );
			$machine[]  = array(
				'id'  => (int) $item['id'],
				'qty' => (int) $item['qty'],
			);
		}
		$line->add_meta_data( '_gedu_combo', wp_json_encode( $machine ), true );
		$line->add_meta_data( __( 'Includes', 'gedusuite-combo' ), implode( ', ', $readable ), true );
	},
	10,
	4
);

/* ===========================================================================
 * Admin: building a combo
 * ======================================================================== */

add_action(
	'add_meta_boxes',
	function () {
		add_meta_box(
			'gedu-combo-box',
			__( 'Combo Set', 'gedusuite-combo' ),
			'gedu_combo_render_metabox',
			'product',
			'normal',
			'default'
		);
	}
);

function gedu_combo_render_metabox( $post ) {
	wp_nonce_field( 'gedu_combo_save', 'gedu_combo_nonce' );
	$items = gedu_combo_items( $post->ID );
	$lines = array();
	foreach ( $items as $item ) {
		$product = wc_get_product( $item['id'] );
		$lines[] = sprintf(
			'%d x %d%s',
			$item['id'],
			$item['qty'],
			$product ? '   # ' . $product->get_name() : '   # (product not found)'
		);
	}
	$buildable = gedu_combo_buildable( $post->ID );
	?>
	<p>
		<strong><?php esc_html_e( 'One component per line, as', 'gedusuite-combo' ); ?></strong>
		<code>product_id x quantity</code>.
		<?php esc_html_e( 'Anything after a # is a note and is ignored. Leave this box empty for an ordinary product.', 'gedusuite-combo' ); ?>
	</p>
	<textarea name="gedu_combo_items" rows="6" style="width:100%;font-family:monospace"
		placeholder="412 x 1&#10;388 x 3"><?php echo esc_textarea( implode( "\n", $lines ) ); ?></textarea>
	<p>
		<label>
			<input type="checkbox" name="gedu_combo_free_shipping" value="yes"
				<?php checked( gedu_combo_free_shipping( $post->ID ) ); ?> />
			<?php esc_html_e( 'Free delivery with this combo', 'gedusuite-combo' ); ?>
		</label>
	</p>
	<?php if ( ! empty( $items ) ) : ?>
		<p style="padding:8px;background:#f6f7f7;border-left:4px solid #2271b1">
			<?php
			printf(
				/* translators: %s: number of complete sets, or "unlimited" */
				esc_html__( 'Sets that can be made from stock right now: %s.', 'gedusuite-combo' ),
				null === $buildable ? esc_html__( 'unlimited', 'gedusuite-combo' ) : esc_html( (string) $buildable )
			);
			?>
			<br />
			<em>
				<?php esc_html_e( "This product's own stock figure is written by the plugin and recalculated whenever a component moves. Do not edit it by hand — it will be overwritten.", 'gedusuite-combo' ); ?>
			</em>
		</p>
	<?php endif; ?>
	<?php
}

add_action(
	'save_post_product',
	function ( $post_id ) {
		if ( ! isset( $_POST['gedu_combo_nonce'] ) ) {
			return;
		}
		if ( ! wp_verify_nonce( sanitize_key( wp_unslash( $_POST['gedu_combo_nonce'] ) ), 'gedu_combo_save' ) ) {
			return;
		}
		if ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) {
			return;
		}
		if ( ! current_user_can( 'edit_product', $post_id ) ) {
			return;
		}

		$raw   = isset( $_POST['gedu_combo_items'] ) ? sanitize_textarea_field( wp_unslash( $_POST['gedu_combo_items'] ) ) : '';
		$items = array();
		foreach ( preg_split( '/\r\n|\r|\n/', $raw ) as $line ) {
			$line = trim( preg_replace( '/#.*$/', '', $line ) );
			if ( '' === $line ) {
				continue;
			}
			if ( preg_match( '/^(\d+)\s*[xX*]\s*(\d+)$/', $line, $m ) ) {
				$items[] = array(
					'id'  => absint( $m[1] ),
					'qty' => absint( $m[2] ),
				);
			}
		}

		if ( empty( $items ) ) {
			delete_post_meta( $post_id, GEDU_COMBO_ITEMS_META );
		} else {
			update_post_meta( $post_id, GEDU_COMBO_ITEMS_META, $items );
		}

		// Independent of whether this product has combo items: the checkbox
		// reads "with this combo" but gedu_combo_free_shipping() never checks
		// for one, and an ordinary product is meant to be able to use it on
		// its own. Tied to the items branch before, it saved on a combo and
		// silently discarded on anything else — checked the box, saved,
		// reload, unchecked again, with no error to say why.
		update_post_meta(
			$post_id,
			GEDU_COMBO_FREE_SHIPPING_META,
			isset( $_POST['gedu_combo_free_shipping'] ) ? 'yes' : 'no'
		);

		gedu_combo_rebuild_index();
		gedu_combo_apply_category( $post_id );
		// Sync last: the index has to know about this combo before its stock is
		// worked out, and its stock has to be right before the shop is shown.
		gedu_combo_sync_stock( $post_id );
	},
	20
);

/** A deleted combo must not stay in the index pointing at nothing. */
add_action(
	'before_delete_post',
	function ( $post_id ) {
		if ( 'product' === get_post_type( $post_id ) && gedu_is_combo( $post_id ) ) {
			delete_post_meta( $post_id, GEDU_COMBO_ITEMS_META );
			gedu_combo_rebuild_index();
		}
	}
);

/* ===========================================================================
 * Housekeeping
 * ======================================================================== */

/**
 * A nightly re-sync.
 *
 * Everything above keeps the numbers right as things happen. This is for the
 * things that happen outside it — a stock figure corrected straight in the
 * database, an import, a plugin update that ran while a hook was unhooked.
 * Cheap at this catalogue's size, and it means a drifted combo fixes itself
 * overnight instead of being discovered by a customer.
 */
add_action(
	'gedu_combo_daily_sync',
	function () {
		$index = gedu_combo_rebuild_index();
		$combos = array();
		foreach ( $index as $combo_ids ) {
			foreach ( $combo_ids as $combo_id ) {
				$combos[ $combo_id ] = true;
			}
		}
		foreach ( array_keys( $combos ) as $combo_id ) {
			gedu_combo_sync_stock( $combo_id );
			gedu_combo_sync_price( $combo_id );
			gedu_combo_apply_category( $combo_id );
		}
	}
);

register_activation_hook(
	__FILE__,
	function () {
		$index = gedu_combo_rebuild_index();
		// Catch up on combos that existed before this version: file each one
		// under Combo Offers now rather than waiting for somebody to re-save it.
		$seen = array();
		foreach ( $index as $combo_ids ) {
			foreach ( $combo_ids as $combo_id ) {
				if ( isset( $seen[ $combo_id ] ) ) {
					continue;
				}
				$seen[ $combo_id ] = true;
				gedu_combo_apply_category( $combo_id );
			}
		}
		if ( ! wp_next_scheduled( 'gedu_combo_daily_sync' ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', 'gedu_combo_daily_sync' );
		}
	}
);

register_deactivation_hook(
	__FILE__,
	function () {
		wp_clear_scheduled_hook( 'gedu_combo_daily_sync' );
	}
);
