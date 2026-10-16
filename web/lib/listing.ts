// Shapes of the listing data the API returns (docs/openapi.yaml: ListingResultV2, PublicListing) and the few
// conversions a page needs to show them. No rule lives here: amounts arrive in minor units with their exponent
// (the Money contract), and the page only turns them into the reader's number format.

export interface Money { amount_minor: number | null; currency: string | null; period?: "month" | "week" | null;
  monthly_minor?: number | null; exponent?: number | null; scope?: string | null }
export interface PhotoUrl { url: string; expires_at: string }
export interface LatLng { lat: number; lng: number }

export interface ListingCard {
  id: string; rank?: number; kind: "room" | "shared_flat" | "roommate_wanted"; title: string | null; description?: string | null;
  description_lang?: string | null;
  rent: Money | null; deposit_minor?: number | null; bills_included?: boolean | null; available_from?: string | null;
  min_stay_months?: number | null; bedrooms?: number | null; furnished?: boolean | null; current_flatmates?: number | null;
  amenities?: string[] | null; house_rules?: Record<string, string> | null; city?: string | null; neighbourhood?: string | null;
  public_location: LatLng | null; distance_m?: number | null; is_synthetic: boolean;
  photo_count?: number; cover_photo?: PhotoUrl | null; is_favourite?: boolean;
}

export interface PublicListing extends ListingCard {
  status: string; is_own: boolean; jurisdiction_code: string; bathrooms?: number | null; total_area_m2?: number | null;
  room_area_m2?: number | null; published_at?: string | null; updated_at: string;
}

/** A price in the reader's format: the minor units divided by the currency's exponent, no rounding of what is given. */
export function money(locale: string, minor: number | null | undefined, currency: string | null | undefined, exponent = 2) {
  if (minor === null || minor === undefined || !currency) return null;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: exponent })
      .format(minor / 10 ** exponent);
  } catch {
    return `${minor / 10 ** exponent} ${currency}`;
  }
}

export function place(c: Pick<ListingCard, "neighbourhood" | "city">) {
  return [c.neighbourhood, c.city].filter(Boolean).join(", ") || null;
}

export const KINDS = ["room", "shared_flat", "roommate_wanted"] as const;
export const RULES = ["smoking", "pets", "guests", "parties"] as const;
/** The amenity vocabulary of listing changes (migration 0019) and of GET /v2/search. */
export const AMENITIES = ["wifi", "washing_machine", "air_conditioning", "heating", "parking", "balcony", "terrace", "garden",
  "elevator", "dishwasher", "equipped_kitchen", "private_bathroom", "desk", "fridge", "oven", "microwave", "tv", "pool", "gym",
  "security", "concierge"] as const;
/** The ones shown first in the search form; the rest are under "more filters". */
export const MAIN_AMENITIES = ["wifi", "washing_machine", "air_conditioning", "heating", "desk", "private_bathroom"] as const;
