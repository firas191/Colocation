// Shapes of GET /v1/me/listings (docs/openapi.yaml: MyListingsResponse). The API computes what is missing and which
// actions apply; pages only show them.
import type { Money, PhotoUrl } from "./listing";

export interface Missing { field: "rent" | "place" | "photos"; issue: "required" | "place_not_found" }
export interface Readiness { ready: boolean; missing: Missing[]; issues: string[]; photos: number }
export interface MyListing {
  listing_id: string; status: string; number: number | null; kind: string; title: string | null; display_title: string | null;
  jurisdiction_code: string; rent: Money; rent_scope: string | null; city: string | null; neighbourhood: string | null;
  created_at: string; updated_at: string; published_at: string | null;
  analysis: { job_id: string; status: string; created_at: string; finished_at: string | null } | null;
  readiness: Readiness | null; photo_count: number; cover_photo: PhotoUrl | null;
  actions: { edit: boolean; analyze: boolean; submit: boolean; archive: boolean; republish: boolean; view: boolean };
}
export interface MyListings { items: MyListing[]; counts: { all: number; draft: number; published: number; archived: number };
  warnings: string[] }

export const TABS = ["all", "draft", "published", "archived"] as const;
