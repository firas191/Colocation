// Shapes of the P4 answers (docs/openapi.yaml: Conversation, Message, Visit, Application). Display only.
export interface UserRef { user_id: string; display_name: string | null }
export interface Conversation { conversation_id: string; kind: string; listing: { listing_id: string; title: string | null; status: string } | null;
  other: UserRef | null; blocked: boolean; unread: number; last_message: { mine: boolean; excerpt: string | null; created_at: string } | null;
  last_message_at: string }
export interface Message { id: number; mine: boolean; body: string | null; deleted?: boolean; hidden?: boolean; created_at: string;
  warnings?: string[] }
export interface Visit { visit_id: string; listing: { listing_id: string; title: string | null } | null; role: "owner" | "seeker";
  other: UserRef; starts_at: string; status: string; note: string | null; waiting_for: "me" | "other" | null;
  actions: Record<"confirm" | "propose" | "decline" | "cancel" | "done" | "no_show", boolean> }
export interface Application { application_id: string; listing: { listing_id: string; title: string | null } | null;
  role: "owner" | "applicant"; other: UserRef; status: string; message: string | null; move_in_from: string | null;
  shared_profile: { declared_preferences?: Record<string, string>; languages?: string[]; move_in_from?: string;
    budget?: { max_minor?: number | null; currency?: string | null } } | null;
  compatibility?: { score: number | null; members: number } | null;
  created_at: string; actions: Record<"accept" | "decline" | "withdraw", boolean> }
